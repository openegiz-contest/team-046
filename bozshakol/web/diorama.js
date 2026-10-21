// Схема-макет рудника (режим «Схема», по умолчанию): компактный макет ≈ 600 × 400 единиц сцены на подставке.
// Места узлов дорог и объектов — core/diorama.json (генератор core/tools/make_diorama.py). Здесь —
// перенос реальных координат (м, geometry.json и двойники) в схему и постройка макета.
//
//   const dio = await loadDiorama(THREE, geometry, terrainApi)
//   dio.toScene(x, y, z)  -> THREE.Vector3   реальные координаты → точка сцены в схеме
//   dio.groundAt(x, y)    -> м               «земля» в реальных координатах, согласованная с toScene:
//                                            toScene(x, y, groundAt(x, y)) лежит на поверхности схемы
//   dio.mapXY(x, y)       -> [xs, ys]        место в схеме (единицы; x — восток, y — север)
//   dio.surfaceAt(xs, ys) -> zs              высота поверхности схемы (уступы карьера, съезды)
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
const CORRIDOR = 7.5, CORRIDOR_BLEND = 5;                // единицы: врезка съездов в уступы схемы
const FACE_PAD = 8;                                     // единицы: радиус рабочей площадки у забоя (сверх CORRIDOR)

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

  // --- рёбра дорог: реальные и схематичные концы
  const edges = [];
  for (const e of geometry.edges) {
    const ra = geometry.nodes[e.from], rb = geometry.nodes[e.to], sa = D.nodes[e.from], sb = D.nodes[e.to];
    if (!ra || !rb || !sa || !sb) continue;
    edges.push({ road: e.road, from: e.from, to: e.to, ra, rb, sa, sb, pit: sa[2] < -0.01 || sb[2] < -0.01 });
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
  function surfaceAt(xs, ys) {
    const ds = schemaInset(xs, ys);
    if (ds < 0) return 0;
    let z = benchProfile(ds);
    let best = Infinity, zr = 0;
    for (const e of pitEdges) {
      const dx = e.sb[0] - e.sa[0], dy = e.sb[1] - e.sa[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((xs - e.sa[0]) * dx + (ys - e.sa[1]) * dy) / L2));
      const d = Math.hypot(xs - (e.sa[0] + dx * t), ys - (e.sa[1] + dy * t));
      if (d < best) { best = d; zr = e.sa[2] + (e.sb[2] - e.sa[2]) * t; }
    }
    // рабочие площадки у забоев: ровный круг на уровне забоя (там стоят экскаватор и самосвал под погрузкой)
    for (const [fx, fy, fz] of facePads) {
      const d = Math.hypot(xs - fx, ys - fy) - FACE_PAD;
      if (d < best) { best = d; zr = fz; }
    }
    if (best < CORRIDOR) return zr;
    if (best < CORRIDOR + CORRIDOR_BLEND) { const w = smooth((best - CORRIDOR) / CORRIDOR_BLEND); return zr + (z - zr) * w; }
    return z;
  }

  // --- полный перенос точки: место в схеме, высота дороги/поверхности, «земля» в реальных координатах
  const clampX = (v) => Math.max(bx0 + 3, Math.min(bx1 - 3, v)), clampY = (v) => Math.max(by0 + 3, Math.min(by1 - 3, v));
  function resolve(x, y) {
    const cv = onConveyor(x, y);
    if (cv) return { xs: clampX(cv[0]), ys: clampY(cv[1]), base: surfaceAt(cv[0], cv[1]), ground: terrainApi.groundAt(x, y) };
    const ne = nearestEdge(x, y);
    const ex = exactAt(x, y);
    let xs, ys, base, ground;
    let road = null;
    if (ne && ne.d < ROAD_BLEND) {
      const { e, t } = ne;
      road = {
        xs: e.sa[0] + (e.sb[0] - e.sa[0]) * t + ne.ox * SIDE_K,
        ys: e.sa[1] + (e.sb[1] - e.sa[1]) * t + ne.oy * SIDE_K,
        zs: e.sa[2] + (e.sb[2] - e.sa[2]) * t,
        zr: e.ra[2] + (e.rb[2] - e.ra[2]) * t,
      };
    }
    const realGround = () => terrainApi.groundAt(x, y);
    if (road && ne.d < ROAD_NEAR) {
      xs = road.xs; ys = road.ys; base = road.zs; ground = road.zr;
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
    D, toScene, groundAt, mapXY, surfaceAt, schemaInset, benchProfile, pitMap, nearestEdge, edges,
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
