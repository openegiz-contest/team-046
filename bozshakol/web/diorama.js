// Схема рудника — единственная сцена: расстояния сжаты в 2 раза, здания в реальном размере (core/diorama.json).
// Места узлов дорог и объектов — core/diorama.json (генератор core/tools/make_diorama.py). Здесь —
// перенос реальных координат (м, geometry.json и двойники) в схему и одна функция высоты поверхности.
//
//   const dio = await loadDiorama(THREE, geometry, terrainApi)
//   dio.toScene(x, y, z)  -> THREE.Vector3   реальные координаты → точка сцены в схеме
//   dio.groundAt(x, y)    -> м               «земля» в реальных координатах, согласованная с toScene:
//                                            toScene(x, y, groundAt(x, y)) лежит на поверхности схемы
//   dio.mapXY(x, y)       -> [xs, ys]        место в схеме (единицы; x — восток, y — север)
//   dio.edgeAt(e, t)      -> [xs, ys, zs, tx, ty]   точка ребра на доле пути t (съезды — по трассе diorama.json paths)
//   dio.edgeNearest(e, xs, ys) -> {d, t, z}  ближайшая точка оси ребра в схеме
//   dio.surfaceAt(xs, ys) -> zs              ЕДИНАЯ высота поверхности: степь, бермы и стенки уступов, съезды,
//                                            дороги и площадки. Из неё строятся земля, карьер и дороги,
//                                            по ней ставится вся техника (ctx.groundAt)
//   buildDiorama(THREE, dio, models, colors) -> { group, labels: [[obj, text, opts]], glows: [sprite], setWeather, setQuality, update(dt) }
//
// Правила переноса (toScene):
//   • точка у дороги (до 20 м от ребра geometry.edges) — проекция на схематичное ребро с той же долей пути,
//     боковой сдвиг ×0,4 (экскаватор встаёт рядом с забоем, а не на дороге); самосвал едет точно по дороге;
//   • точка на трассе конвейера — на схематичной трассе с той же долей пути;
//   • точка в карьере — по «отступу от борта»: реальный уступ → уступ схемы (13 уступов → 7);
//   • остальная поверхность — плавная интерполяция по опорным точкам (узлы, объекты, борт, края макета);
//   • высота: поверхность схемы (или дорога) + подъём над землёй в метрах (z − groundAt), 1 м ≈ 1 единица.
// Объекты с точным местом в diorama.json (здания, склады, экскаваторы) встают ровно туда.

const ROAD_NEAR = 20, ROAD_BLEND = 35, SIDE_K = 0.4;   // м, м, множитель бокового сдвига у дороги
// Врезка дорог и съездов в уступы: полотно (ширина ROAD_W) лежит на ровной полосе ±CORRIDOR от оси,
// дальше за CORRIDOR_BLEND поверхность плавно возвращается к уступам — край полотна никогда не под землёй
export const ROAD_W = 28;                                // единицы: две полосы самосвала (ширина ≈ 10) + зазоры
const CORRIDOR = ROAD_W / 2 + 4, CORRIDOR_BLEND = 10;    // единицы
const FACE_PAD = 30;                                     // единицы: радиус рабочей площадки у забоя (сверх CORRIDOR)
const RAMP_GAP = 6, RAMP_SMOOTH = 16;                    // единицы: за откосом съезда — ровный склон борта, дальше уступы проступают плавно
const FACE_PAD_BENCH = 16;                               // единицы: то же у забоя на уступе (врезана в борт у площадки съезда)

export async function loadDiorama(THREE, geometry, terrainApi) {
  const r = await fetch('/diorama.json');
  if (!r.ok) throw new Error('diorama.json: HTTP ' + r.status);
  return createDiorama(THREE, geometry, terrainApi, await r.json());
}

export function createDiorama(THREE, geometry, terrainApi, D) {
  const gp = geometry.pit;
  const [A, B] = gp.semi_axes_top;
  const Dr = gp.bench_count * gp.inset_per_bench;
  const P = D.pit;
  const [cx, cy] = P.center, [a, b] = P.semi_axes;
  const Ds = P.benches * P.inset, depthS = P.benches * P.bench_height, kz = P.z_scale;
  const [bx0, by0, bx1, by1] = D.bounds;

  // --- рёбра дорог: реальные и схематичные концы; у съездов — трасса (спираль вдоль борта) из diorama.json paths
  const edges = [];
  for (const e of geometry.edges) {
    const ra = geometry.nodes[e.from], rb = geometry.nodes[e.to], sa = D.nodes[e.from], sb = D.nodes[e.to];
    if (!ra || !rb || !sa || !sb) continue;
    const ed = { road: e.road, from: e.from, to: e.to, ra, rb, sa, sb, pit: sa[2] < -0.01 || sb[2] < -0.01 };
    const pl = D.paths && D.paths[e.from + '>' + e.to];
    if (pl && pl.length > 1) {
      ed.path = pl; ed.cum = [0];
      for (let i = 1; i < pl.length; i++) ed.cum.push(ed.cum[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]));
      ed.len = ed.cum[pl.length - 1] || 1;
      // рамки кусков по 16 отрезков — быстрый отсев далёких кусков в edgeNearest
      ed.chunks = [];
      for (let i = 0; i < pl.length - 1; i += 16) {
        const j = Math.min(pl.length - 1, i + 16);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = i; k <= j; k++) { x0 = Math.min(x0, pl[k][0]); y0 = Math.min(y0, pl[k][1]); x1 = Math.max(x1, pl[k][0]); y1 = Math.max(y1, pl[k][1]); }
        ed.chunks.push([i, j, x0, y0, x1, y1]);
      }
    }
    edges.push(edgeProfile(ed));
  }
  // точка ребра на доле пути t: [x, y, z, tx, ty] (tx, ty — направление хода)
  function edgeAt(e, t) {
    t = Math.max(0, Math.min(1, t));
    if (!e.path) {
      const dx = e.sb[0] - e.sa[0], dy = e.sb[1] - e.sa[1], l = Math.hypot(dx, dy) || 1;
      return [e.sa[0] + dx * t, e.sa[1] + dy * t, e.zAt(t), dx / l, dy / l];
    }
    const L = t * e.len, c = e.cum, pl = e.path;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= L) lo = m; else hi = m; }
    const seg = c[hi] - c[lo] || 1, f = (L - c[lo]) / seg, p = pl[lo], q = pl[hi];
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    return [p[0] + dx * f, p[1] + dy * f, p[2] + (q[2] - p[2]) * f, dx / l, dy / l];
  }
  // ближайшая точка оси ребра (в схеме): расстояние, доля пути, высота полотна; дальше maxD точно не ищем
  function edgeNearest(e, xs, ys, maxD = Infinity) {
    if (!e.path) {
      const dx = e.sb[0] - e.sa[0], dy = e.sb[1] - e.sa[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((xs - e.sa[0]) * dx + (ys - e.sa[1]) * dy) / L2));
      return { d: Math.hypot(xs - (e.sa[0] + dx * t), ys - (e.sa[1] + dy * t)), t, z: e.zAt(t) };
    }
    let best = { d: Infinity, t: 0, z: e.path[0][2] };
    const pl = e.path, c = e.cum;
    for (const [i0, i1, x0, y0, x1, y1] of e.chunks) {
      const bx = Math.max(x0 - xs, 0, xs - x1), by = Math.max(y0 - ys, 0, ys - y1);
      if (Math.hypot(bx, by) > Math.min(best.d, maxD)) continue;
      for (let i = i0; i < i1; i++) {
        const p = pl[i], q = pl[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy || 1;
        const f = Math.max(0, Math.min(1, ((xs - p[0]) * dx + (ys - p[1]) * dy) / L2));
        const d = Math.hypot(xs - (p[0] + dx * f), ys - (p[1] + dy * f));
        if (d < best.d) best = { d, t: (c[i] + (c[i + 1] - c[i]) * f) / e.len, z: p[2] + (q[2] - p[2]) * f };
      }
    }
    return best;
  }
  // Профиль высоты ребра в схеме: обычно — линейно между узлами; ребро съезда, которое пересекает борт карьера,
  // поднимается до уровня земли ровно на борту (дальше — по земле), иначе его край уходил бы под ровную степь
  function edgeProfile(e) {
    if (e.path) { e.zAt = (t) => edgeAt(e, t)[2]; return e; }   // съезд: высота — по трассе (уклон и площадки)
    const inPit = (p) => ((p[0] - cx) / a) ** 2 + ((p[1] - cy) / b) ** 2 < 1;
    const ia = inPit(e.sa), ib = inPit(e.sb);
    e.zAt = (t) => e.sa[2] + (e.sb[2] - e.sa[2]) * t;
    if (ia === ib || !e.pit) return e;
    let lo = 0, hi = 1;                                       // точка пересечения борта (доля пути)
    const Ls = Math.hypot(e.sb[0] - e.sa[0], e.sb[1] - e.sa[1]) || 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2, p = [e.sa[0] + (e.sb[0] - e.sa[0]) * m, e.sa[1] + (e.sb[1] - e.sa[1]) * m];
      if (inPit(p) === ia) lo = m; else hi = m;
    }
    // съезд выходит на уровень борта чуть раньше пересечения (на ширину дороги с откосом): борт пересекается
    // наискосок, и край полотна иначе оказывался бы на 12 единиц ниже степи рядом с ним (ступенька)
    const m = Math.min(0.4, (ROAD_W + CORRIDOR_BLEND) * 1.5 / Ls);
    const tc = ia ? Math.max(0.2, (lo + hi) / 2 - m) : Math.min(0.8, (lo + hi) / 2 + m);
    e.zAt = ia ? (t) => (t < tc ? e.sa[2] * (1 - t / tc) : 0) : (t) => (t > tc ? e.sb[2] * (t - tc) / (1 - tc) : 0);
    return e;
  }
  function nearestEdge(x, y) {
    let best = null;
    for (const e of edges) {
      const dx = e.rb[0] - e.ra[0], dy = e.rb[1] - e.ra[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - e.ra[0]) * dx + (y - e.ra[1]) * dy) / L2));
      const px = e.ra[0] + dx * t, py = e.ra[1] + dy * t, d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { e, t, d, ox: x - px, oy: y - py };
    }
    return best;
  }

  // --- карьер: реальная точка → схема по отступу от борта
  function realInset(x, y) {              // -1 — вне карьера; Dr+ — дно
    const f = (d) => (x / (A - d)) ** 2 + (y / (B - d)) ** 2 - 1;
    if (f(0) >= 0) return -1;
    if (f(Dr) <= 0) return Dr + 1;
    let lo = 0, hi = Dr;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  function pitMap(x, y) {
    const d = realInset(x, y);
    if (d > Dr) return [cx + x * (a - Ds) / (A - Dr), cy + y * (b - Ds) / (B - Dr)];
    const t = Math.atan2(y / (B - d), x / (A - d)), ds = d * Ds / Dr;
    return [cx + (a - ds) * Math.cos(t), cy + (b - ds) * Math.sin(t)];
  }
  // отступ от борта в схеме (для высоты уступов)
  function schemaInset(xs, ys) {
    const u = xs - cx, v = ys - cy;
    const f = (d) => (u / (a - d)) ** 2 + (v / (b - d)) ** 2 - 1;
    if (f(0) >= 0) return -1;
    if (f(Ds) <= 0) return Ds + 1;
    let lo = 0, hi = Ds;
    for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  // профиль уступа: берма (ровно), затем крутая стенка до следующей бермы
  function benchProfile(ds) {
    if (ds < 0) return 0;
    if (ds >= Ds) return -depthS;
    const k = Math.floor(ds / P.inset), u = ds - k * P.inset;
    return u < P.berm ? -k * P.bench_height : -k * P.bench_height - P.bench_height * (u - P.berm) / (P.inset - P.berm);
  }

  // --- поверхность: аффинное приближение по опорным точкам + поправки с весом 1/d² (точно в опорных точках)
  const anchors = D.anchors.map((q) => q.slice());
  for (let i = 0; i < 36; i++) {
    const t = i / 36 * Math.PI * 2;
    anchors.push([A * Math.cos(t), B * Math.sin(t), cx + a * Math.cos(t), cy + b * Math.sin(t)]);
  }
  const aff = fitAffine(anchors);
  const res = anchors.map(([x, y, xs, ys]) => [x, y, xs - (aff[0] * x + aff[1] * y + aff[2]), ys - (aff[3] * x + aff[4] * y + aff[5])]);
  function surfaceMap(x, y) {
    let sw = 0, rx = 0, ry = 0;
    for (const [ax, ay, dx, dy] of res) {
      const d2 = (x - ax) ** 2 + (y - ay) ** 2;
      if (d2 < 1e-6) return [aff[0] * x + aff[1] * y + aff[2] + dx, aff[3] * x + aff[4] * y + aff[5] + dy];
      const w = 1 / d2; sw += w; rx += w * dx; ry += w * dy;
    }
    return [aff[0] * x + aff[1] * y + aff[2] + rx / sw, aff[3] * x + aff[4] * y + aff[5] + ry / sw];
  }
  const generalMap = (x, y) => (realInset(x, y) >= 0 ? pitMap(x, y) : surfaceMap(x, y));

  // --- трассы конвейеров: точка на трассе (до 5 м) — на схематичной трассе с той же долей пути (раньше дорог:
  //     в жизни конвейер идёт вдоль дороги по борту, и «прилипание» к дороге ломало бы его зигзагом)
  const conveyors = [];
  for (const o of geometry.objects || []) {
    const s = D.objects[o.id];
    if (!o.path || !s || !s.path || s.path.length !== o.path.length) continue;
    for (let i = 0; i < o.path.length - 1; i++) conveyors.push({ ra: o.path[i], rb: o.path[i + 1], sa: s.path[i], sb: s.path[i + 1] });
  }
  function onConveyor(x, y) {
    for (const c of conveyors) {
      const dx = c.rb[0] - c.ra[0], dy = c.rb[1] - c.ra[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - c.ra[0]) * dx + (y - c.ra[1]) * dy) / L2));
      if (Math.hypot(x - c.ra[0] - dx * t, y - c.ra[1] - dy * t) < 5) return [c.sa[0] + (c.sb[0] - c.sa[0]) * t, c.sa[1] + (c.sb[1] - c.sa[1]) * t];
    }
    return null;
  }

  // --- точные места объектов из diorama.json (по реальному месту geometry.objects)
  const exact = [];
  for (const o of geometry.objects || []) {
    const s = D.objects[o.id];
    if (o.position && s && s.position) exact.push([o.position[0], o.position[1], s.position[0], s.position[1]]);
  }
  const exactAt = (x, y) => { for (const q of exact) if (Math.abs(q[0] - x) < 3 && Math.abs(q[1] - y) < 3) return q; return null; };

  // --- высота поверхности схемы: уступы, врезанные в них съезды и дороги карьера
  const pitEdges = edges.filter((e) => e.pit);
  const facePads = Object.entries(D.nodes).filter(([n]) => n.startsWith('face-')).map(([, p]) => p);
  // Внутри карьера: полотно (±HW от оси) и площадка забоя — ровно на своей высоте; между двумя близкими полосами
  // (витки съезда, съезд и площадка) — ровный откос от края одной до края другой, без обрыва посередине;
  // дальше — плавный возврат к уступам
  const HW = ROAD_W / 2 + 2, NEAR2 = 2 * (CORRIDOR + CORRIDOR_BLEND - HW), RIM_FADE = 18;
  function surfaceAt(xs, ys) {
    const ds = schemaInset(xs, ys);
    if (ds < 0) return 0;
    // все близкие полосы (рёбра карьера и площадки) — с весом 1/d²: высота меняется плавно, без обрыва на середине
    // между витками съезда; на самой полосе её вес подавляет остальные
    let num = 0, den = 0, amin = Infinity;
    const take = (d, zz) => {
      if (d >= NEAR2) return;
      const w = smooth((NEAR2 - d) / 8) / ((Math.max(d, 0) + 0.4) ** 2);   // у границы дальности вес плавно → 0
      num += w * zz; den += w; if (d < amin) amin = d;
    };
    const span = CORRIDOR + CORRIDOR_BLEND - HW;
    let aRamp = Infinity;   // расстояние от края полотна съезда
    for (const e of pitEdges) {
      const n = edgeNearest(e, xs, ys, HW + Math.max(NEAR2, span + RAMP_GAP + RAMP_SMOOTH));
      take(n.d - HW, n.z);
      if (e.path) aRamp = Math.min(aRamp, n.d - HW);
    }
    // уступы; у съезда за откосом — ровный средний склон борта (ещё RAMP_GAP), дальше уступы проступают плавно
    // (RAMP_SMOOTH): откос встречает ровный склон, а уступы растут вдоль своих кромок — без ступенек и зубцов
    const zStep = benchProfile(ds), zAvg = -depthS * Math.min(1, ds / Ds);
    const z = zAvg + (zStep - zAvg) * smooth((aRamp - span - RAMP_GAP) / RAMP_SMOOTH);
    // рабочие площадки у забоев: ровный круг на уровне забоя (там стоят экскаватор и самосвал под погрузкой);
    // забой на уступе — у площадки на съезде, круг меньше (уступ узкий)
    for (const [fx, fy, fz] of facePads) take(Math.hypot(xs - fx, ys - fy) - (fz > -depthS + 1 ? FACE_PAD_BENCH : FACE_PAD), fz);
    if (den < 1e-9) return z;
    // у самого борта врезка сходит на нет: на кромке поверхность всегда на уровне степи (без обрыва у края)
    const rim = smooth(ds / RIM_FADE);
    const zr = z + (num / den - z) * rim;
    if (amin <= 0) return num / den;   // на полотне и площадке — их высота (у борта тоже: съезд врезан в борт)
    return amin < span ? zr + (z - zr) * smooth(amin / span) : z;
  }

  // доля уступов у съезда (0 — ровный средний склон борта, 1 — уступы как есть), как в surfaceAt: для цвета карьера
  function stepBlend(xs, ys) {
    const span = CORRIDOR + CORRIDOR_BLEND - HW;
    let a = Infinity;
    for (const e of pitEdges) if (e.path) a = Math.min(a, edgeNearest(e, xs, ys, HW + span + RAMP_GAP + RAMP_SMOOTH).d - HW);
    return smooth((a - span - RAMP_GAP) / RAMP_SMOOTH);
  }

  // --- полный перенос точки: место в схеме, высота дороги/поверхности, «земля» в реальных координатах
  const clampX = (v) => Math.max(bx0 + 3, Math.min(bx1 - 3, v)), clampY = (v) => Math.max(by0 + 3, Math.min(by1 - 3, v));
  function resolve(x, y) {
    const ne0 = nearestEdge(x, y);
    const cv = ne0 && ne0.d < 2 ? null : onConveyor(x, y);   // на самой дороге — дорога главнее трассы конвейера
    if (cv) return { xs: clampX(cv[0]), ys: clampY(cv[1]), base: surfaceAt(cv[0], cv[1]), ground: terrainApi.groundAt(x, y) };
    const ne = ne0;
    const ex = exactAt(x, y);
    let xs, ys, base, ground;
    let road = null;
    if (ne && ne.d < ROAD_BLEND) {
      const { e, t } = ne;
      if (e.path) {   // съезд: точка трассы на той же доле пути, боковой сдвиг — поперёк трассы в этом месте
        const q = edgeAt(e, t), rdx = e.rb[0] - e.ra[0], rdy = e.rb[1] - e.ra[1], rl = Math.hypot(rdx, rdy) || 1;
        const lat = (rdx * ne.oy - rdy * ne.ox) / rl * SIDE_K;
        road = { xs: q[0] - q[4] * lat, ys: q[1] + q[3] * lat, zs: q[2], zr: e.ra[2] + (e.rb[2] - e.ra[2]) * t };
      } else {
        road = {
          xs: e.sa[0] + (e.sb[0] - e.sa[0]) * t + ne.ox * SIDE_K,
          ys: e.sa[1] + (e.sb[1] - e.sa[1]) * t + ne.oy * SIDE_K,
          zs: e.zAt(t),
          zr: e.ra[2] + (e.rb[2] - e.ra[2]) * t,
        };
      }
    }
    const realGround = () => terrainApi.groundAt(x, y);
    if (road && ne.d < ROAD_NEAR) {
      xs = road.xs; ys = road.ys; base = surfaceAt(clampX(xs), clampY(ys)); ground = road.zr;   // высота — единая функция
    } else {
      const [gx, gy] = generalMap(x, y);
      const gb = surfaceAt(gx, gy), gg = realGround();
      if (road) {
        const w = smooth((ne.d - ROAD_NEAR) / (ROAD_BLEND - ROAD_NEAR));
        xs = road.xs + (gx - road.xs) * w; ys = road.ys + (gy - road.ys) * w;
        base = road.zs + (gb - road.zs) * w; ground = road.zr + (gg - road.zr) * w;
      } else { xs = gx; ys = gy; base = gb; ground = gg; }
    }
    if (ex) { xs = ex[2]; ys = ex[3]; }
    return { xs: clampX(xs), ys: clampY(ys), base, ground };
  }
  function toScene(x, y, z) {
    const r = resolve(x, y);
    const lift = Math.max(0, (Number(z) || 0) - r.ground);
    return new THREE.Vector3(r.xs, r.base + lift, -r.ys);
  }
  const groundAt = (x, y) => resolve(x, y).ground;
  const mapXY = (x, y) => { const r = resolve(x, y); return [r.xs, r.ys]; };

  return {
    faceOre: Object.fromEntries((geometry.objects || []).filter((o) => o.kind === 'face').map((o) => [o.id, o.ore_type])),
    D, toScene, groundAt, mapXY, surfaceAt, schemaInset, benchProfile, pitMap, nearestEdge, edges, edgeAt, edgeNearest,
    roadW: ROAD_W, roadHalf: HW, corridor: CORRIDOR + CORRIDOR_BLEND, stepBlend,
    // точка на кольце карьера: отступ от борта ds (единицы), угол t эллипса
    ringPoint: (ds, t) => [cx + (a - ds) * Math.cos(t), cy + (b - ds) * Math.sin(t)],
    pit: { cx, cy, a, b, Ds, depth: depthS, inset: P.inset, berm: P.berm, benchHeight: P.bench_height, benches: P.benches },
    bounds: { minX: bx0, minY: by0, maxX: bx1, maxY: by1 },
    // в сцене: x — восток, y — вверх, z = −север
    s: (xs, ys, zs) => new THREE.Vector3(xs, zs, -ys),
  };
}

function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

// аффинное преобразование по методу наименьших квадратов: xs = p0·x + p1·y + p2, ys = p3·x + p4·y + p5
function fitAffine(pts) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], vx = [0, 0, 0], vy = [0, 0, 0];
  for (const [x, y, xs, ys] of pts) {
    const r = [x, y, 1];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) M[i][j] += r[i] * r[j]; vx[i] += r[i] * xs; vy[i] += r[i] * ys; }
  }
  return [...solve3(M, vx), ...solve3(M, vy)];
}
function solve3(M, v) {
  const m = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r][c] / m[c][c]; for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}
