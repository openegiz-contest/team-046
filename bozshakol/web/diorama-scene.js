// Схема рудника — единственная сцена: расстояния сжаты в 2 раза, здания и площадки — в реальном размере, степь до
// горизонта: мягкие пятна и утрамбованные площадки у объектов (текстура рисуется кодом), дымка вдали,
// карьер — 13 уступов с бермами и врезанными съездами, хвостохранилище, ограждение, мачты освещения, ЛЭП.
// Все поверхности (земля, карьер, дороги) строятся из одной функции высоты dio.surfaceAt.
// Единица сцены: по карте — 2 м местности (core/diorama.json, scale), для размеров моделей — 1 м.
//
//   buildDiorama(THREE, dio, models, colors, glowTexture) ->
//     { group, anchors: {pitName, pitFloor, tailings}, setQuality(high), setLook({cheap, night}), glowAt, update(dt) }
//   roadRibbons(THREE, dio) -> { 'дорога|материал': BufferGeometry }   полотно и обочины дорог по поверхности

const GROUND = 0xd6c896;      // цвет степи за пределами текстуры (совпадает с фоном текстуры)
const FAR = 40000;            // степь до горизонта: квадрат ±FAR единиц
const PIT_SEG = 640;          // точек на кольцо карьера (равный шаг по длине борта ≈ 7 единиц)

// Лента от дробилки идёт в подземной галерее и выходит из портала за площадкой разгрузки — дальше от первой точки
// трассы на CONVEYOR_GALLERY единиц (там разворачиваются самосвалы); то же место — в слое переработки (ctx.conveyorGallery)
export const CONVEYOR_GALLERY = 24;
// точка трассы (схема) на расстоянии d от её начала
export function alongPath(path, d) {
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1], L = Math.hypot(bx - ax, by - ay);
    if (d <= L || i === path.length - 2) { const t = L > 0 ? Math.min(1, d / L) : 0; return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / (L || 1), (by - ay) / (L || 1)]; }
    d -= L;
  }
  return [path[0][0], path[0][1], 1, 0];
}

export function buildDiorama(THREE, dio, models, colors, glowTexture) {
  const group = new THREE.Group();
  group.name = 'diorama';
  const { D, pit } = dio;
  const B = dio.bounds;
  const S = dio.s;
  const K = D.scale || 2;             // м местности на единицу карты
  const u = (m) => m / K;             // расстояние по карте: метры → единицы
  const glows = [];
  const ts = pitParams(dio, PIT_SEG, 3), tsLow = pitParams(dio, PIT_SEG / 2, 10);

  // --- степь до горизонта: внешнее поле одного цвета, внутри области рудника — текстура с пятнами и площадками
  const x0 = B.minX, x1 = B.maxX, y0 = B.minY, y1 = B.maxY;
  // подложка под всей землёй (ниже на 1,5 единицы) с отверстием чуть меньше карьера: на любых стыках сеток
  // вместо щели видна степь, а под первой бермой карьера подложка не видна
  const outer = new THREE.Shape();
  outer.moveTo(-FAR, -FAR); outer.lineTo(FAR, -FAR); outer.lineTo(FAR, FAR); outer.lineTo(-FAR, FAR); outer.closePath();
  const farHole = new THREE.Path();
  farHole.absellipse(pit.cx, pit.cy, pit.a - 8, pit.b - 8, 0, Math.PI * 2, true, 0);   // и под выходом съезда из карьера
  outer.holes.push(farHole);
  const far = new THREE.Mesh(new THREE.ShapeGeometry(outer, 160), new THREE.MeshLambertMaterial({ color: GROUND }));
  far.rotation.x = -Math.PI / 2; far.position.y = -1.5; far.receiveShadow = true; far.name = 'diorama-far';
  group.add(far);

  // земля вокруг карьера: отверстие — ровно по верхнему кольцу сетки карьера (те же точки, без щелей)
  const shape = new THREE.Shape();
  shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
  const hole = new THREE.Path();
  for (let i = ts.length - 1; i >= 0; i--) { const [hx, hy] = dio.ringPoint(0, ts[i]); if (i === ts.length - 1) hole.moveTo(hx, hy); else hole.lineTo(hx, hy); }
  hole.closePath();
  shape.holes.push(hole);
  const groundGeo = new THREE.ShapeGeometry(shape);
  const uv = groundGeo.attributes.uv, gp = groundGeo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (gp.getX(i) - x0) / (x1 - x0), (gp.getY(i) - y0) / (y1 - y0));
  const groundTex = steppeTexture(THREE, dio, [x0, y0, x1, y1], u);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }));
  ground.rotation.x = -Math.PI / 2;      // ShapeGeometry в плоскости XY: y → −z сцены (север)
  ground.receiveShadow = true;
  ground.name = 'diorama-ground';
  group.add(ground);

  // --- россыпь камней по степи и у борта карьера (один InstancedMesh): не на дорогах и не на площадках
  group.add(rocks(THREE, dio, [x0, y0, x1, y1], u));

  // --- карьер: кольца по отступу от борта, высоты — dio.surfaceAt (уступы и врезанные съезды); съезды — отдельная
  //     точная лента (полотно и откосы) по трассе, сетка карьера под лентой чуть опущена (не проступает сквозь неё)
  const colorAt = pitColorer(THREE, dio, colors, u);
  const pitMesh = buildPitMesh(THREE, dio, colorAt, ts);
  const pitLow = buildPitMesh(THREE, dio, colorAt, tsLow);   // «Обычное»: вдвое меньше точек на кольцо
  pitLow.material = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xf0f0f0 });
  pitLow.visible = false;
  const ramp = rampBands(THREE, dio, colorAt);
  group.add(pitMesh, pitLow, ramp);

  // --- хвостохранилище (реальный размер): светлый пляж, гладкая вода с бликом, насыпная дамба
  const tl = D.extra && D.extra.tailings;
  const anchors = {};
  if (tl) {
    const [tx, ty] = tl.center, [rx, ry] = tl.radii;
    const beach = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.MeshLambertMaterial({ color: 0xdcd2b2 }));
    beach.scale.set(rx + 50, ry + 50, 1); beach.rotation.x = -Math.PI / 2; beach.position.copy(S(tx, ty, 0.12));
    const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.MeshStandardMaterial({ color: 0x7fa3b4, roughness: 0.12, metalness: 0 }));
    pond.scale.set(rx - 20, ry - 20, 1); pond.rotation.x = -Math.PI / 2; pond.position.copy(S(tx, ty, 2.5));
    pond.name = 'tailings-pond';
    const w = 40 / 2, h = 12;
    const damShape = new THREE.Shape();
    damShape.moveTo(-w, 0); damShape.lineTo(w, 0); damShape.lineTo(w * 0.45, h); damShape.lineTo(-w * 0.45, h); damShape.closePath();
    const pts = [];
    for (let i = 0; i <= 160; i++) { const t = i / 160 * Math.PI * 2; pts.push(new THREE.Vector3((rx + 2) * Math.cos(t), 0, (ry + 2) * Math.sin(t))); }
    const dam = new THREE.Mesh(new THREE.ExtrudeGeometry(damShape, { steps: 160, bevelEnabled: false, extrudePath: new THREE.CatmullRomCurve3(pts, true) }),
      new THREE.MeshLambertMaterial({ color: 0xa48f6e, flatShading: true }));
    dam.position.copy(S(tx, ty, 0)); dam.name = 'tailings-dam';
    group.add(beach, pond, dam);
    anchors.tailings = new THREE.Object3D(); anchors.tailings.position.copy(S(tx, ty, 14)); group.add(anchors.tailings);
  }

  // --- ограждение промплощадки сульфидной фабрики (реальный размер: корпус 320 × 170 м + сгустители)
  const plant = D.objects['plant-sulphide'] && D.objects['plant-sulphide'].position;
  if (plant) {
    const [px, py] = plant, hx = 230, hyS = 220, hyN = 150;
    group.add(fence(THREE, S, [[px - hx, py - hyS], [px + hx, py - hyS], [px + hx, py + hyN], [px - hx, py + hyN]]));
  }

  // --- дробилка: подземная галерея под конвейер (на поверхности — бетонная полоса вровень с землёй) и портал,
  //     из которого лента выходит наверх — начало конвейера (модель дробилки — слой переработки, models.crusher:
  //     площадка разгрузки на уровне земли, бункер в центре, корпус к востоку)
  const crp = D.objects['crusher-01'] && D.objects['crusher-01'].position, cvp = D.objects['conveyor-01'] && D.objects['conveyor-01'].path;
  if (crp && cvp && cvp.length > 1) {
    const concrete = new THREE.MeshLambertMaterial({ color: 0xbdb7aa }), dark = new THREE.MeshLambertMaterial({ color: 0x2f3236 });
    const along = (ax, ay, bx, by, w, h, y0, mat) => {
      const L = Math.hypot(bx - ax, by - ay), m = new THREE.Mesh(new THREE.BoxGeometry(w, h, L), mat);
      m.position.copy(S((ax + bx) / 2, (ay + by) / 2, y0 + h / 2)); m.rotation.y = Math.atan2(bx - ax, -(by - ay));
      return m;
    };
    const p0 = cvp[0], [px, py, dx, dy] = alongPath(cvp, CONVEYOR_GALLERY);   // портал — за площадкой разгрузки
    const gal = new THREE.Group(); gal.name = 'crusher-gallery';
    gal.add(along(crp[0], crp[1], p0[0], p0[1], 4, 0.3, 0, concrete));                                // крыша галереи
    gal.add(along(p0[0], p0[1], px - dx * 7, py - dy * 7, 4, 0.3, 0, concrete));                      // крыша галереи до портала
    const portal = along(px - dx * 7, py - dy * 7, px, py, 6.5, 4.6, 0, concrete);                    // портал
    portal.userData.solid = 'портал конвейера';                                                       // для проверки наездов
    gal.add(portal);
    gal.add(along(px - dx * 0.2, py - dy * 0.2, px + dx * 0.05, py + dy * 0.05, 3.2, 2.4, 1.6, dark));   // проём под ленту
    group.add(gal);
  }

  // --- сгустители у фабрик (круглые резервуары с мостом, ≈ 60 м) — окружение схемы, не двойники
  if (models && models.building) {
    const tk = (xs, ys, d, name) => { const g = models.building('thickener', { size: [d, d, 6] }); g.position.copy(S(xs, ys, 0)); if (name) g.name = name; group.add(g); };
    if (plant) { tk(plant[0] - 90, plant[1] - 150, 60); tk(plant[0] + 10, plant[1] - 150, 60); }
    const pc = D.objects['plant-clay'] && D.objects['plant-clay'].position;
    if (pc) tk(pc[0] + 125, pc[1] - 10, 50, 'clay-thickener');
  }

  // --- мачты освещения по борту карьера (прожекторы — ореолы); мачта 30 м
  for (let i = 0; i < 14; i++) {
    const t = (i + 0.5) / 14 * Math.PI * 2;
    const [xs, ys] = dio.ringPoint(-u(60), t);
    let m;
    if (models && models.lightMast) m = models.lightMast(30);
    else { m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 30, 6), new THREE.MeshLambertMaterial({ color: 0xbfc4c8 })); m.position.y = 15; }
    const holder = new THREE.Group(); holder.add(m);
    holder.userData.pole = 2.2;   // радиус основания мачты (для проверки наездов, motion_check)
    holder.position.copy(S(xs, ys, 0));
    holder.rotation.y = Math.atan2(pit.cx - xs, -(pit.cy - ys)) + Math.PI;   // прожекторы — к карьеру
    group.add(holder);
    glowAt(S(xs, ys, 31), 0xfff1c4, 40);
  }

  // --- ЛЭП: от края области к подстанции и от подстанции к фабрике (опоры ≈ 250 м)
  const sub = D.objects['power-grid'] && D.objects['power-grid'].position;
  if (sub && models && models.powerLine) {
    const line = (from, to, step) => {
      const n = Math.max(2, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / step)), pts = [];
      for (let i = 0; i <= n; i++) pts.push(S(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n, 0));
      group.add(models.powerLine(pts, { height: 20 }));
    };
    line([sub[0] - u(1800), sub[1] - u(1500)], sub, 125);   // ЛЭП приходит с юго-запада
    if (plant) line(sub, [plant[0] + 170, plant[1] - 60], 80);
    // от подстанции вдоль конвейера (южнее его трассы) к дробилке, с ответвлением к глинистой фабрике;
    // опоры — не на дорогах, площадках и трассе конвейера (такой пролёт просто длиннее)
    const free = poleFree(dio);
    const route = (pts, step) => {
      const out = [];
      for (let k = 0; k + 1 < pts.length; k++) {
        const [a, b] = [pts[k], pts[k + 1]], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let i = k ? 1 : 0; i <= n; i++) {
          const x = a[0] + (b[0] - a[0]) * i / n, y = a[1] + (b[1] - a[1]) * i / n;
          const end = (k === 0 && i === 0) || (k === pts.length - 2 && i === n);
          const first = k === 0 && i === 0, last = k === pts.length - 2 && i === n;
          if (last || (first && pts[0] !== sub)) { const f = nearFree(x, y); out.push(S(f[0], f[1], 0)); }   // концы линии — тоже не на дороге
          else if (end || free(x, y)) out.push(S(x, y, 0));
        }
      }
      if (out.length >= 2) group.add(models.powerLine(out, { height: 20 }));
    };
    const cr = D.objects['crusher-01'] && D.objects['crusher-01'].position, pc = D.objects['plant-clay'] && D.objects['plant-clay'].position;
    const nearFree = (x, y) => {   // ближайшее свободное место по спирали (до 60 единиц)
      for (let r = 0; r <= 60; r += 6) for (let a = 0; a < 12; a++) {
        const qx = x + Math.cos(a * Math.PI / 6) * r, qy = y + Math.sin(a * Math.PI / 6) * r;
        if (free(qx, qy)) return [qx, qy];
      }
      return [x, y];
    };
    // южнее заправки и стоянки (провода не над ними), к восточному краю дробилки
    const w1 = [sub[0] + 70, sub[1] + 100], w2 = [-330, -470], w3 = [-60, -470];
    if (cr) route([sub, w1, w2, w3, [cr[0] + 60, cr[1] - 35]], 90);
    if (pc) route([w2, [pc[0] - 95, pc[1] - 75]], 90);
  }

  // --- ж/д ветка к складу концентрата у сульфидной фабрики: концентрат вывозят по железной дороге
  //     (KAZ Minerals, data/SOURCES.md); положение ветки и склада — допущение схемы
  const railZ = plant ? -plant[1] + 330 : null;
  const onRail = (x, y) => railZ !== null && x > plant[0] - 1520 && x < plant[0] + 120 && Math.abs(-y - railZ) < 40;
  // --- живая степь: куртины кустиков (полынь, караганник) и пучки ковыля — по одному InstancedMesh на вид
  group.add(...steppeLife(THREE, dio, [x0, y0, x1, y1], onRail));
  const rail = railSiding(THREE, dio, models, plant);
  if (rail) { group.add(rail.group); anchors.concentrate = rail.anchor; }

  // --- подписи карьера
  anchors.pitName = new THREE.Object3D(); anchors.pitName.position.copy(S(pit.cx, pit.cy + pit.b, 6)); group.add(anchors.pitName);
  anchors.pitFloor = new THREE.Object3D(); anchors.pitFloor.position.copy(S(pit.cx, pit.cy, -pit.depth + 3)); group.add(anchors.pitFloor);

  function glowAt(position, color, size) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    sp.position.copy(position); sp.scale.set(size, size, 1); sp.userData.glow = true;
    group.add(sp); glows.push(sp);
    return sp;
  }
  // Земля в «Обычном» — без расчёта освещения (ровная степь освещена одинаково): заметно быстрее без видеокарты.
  // Цвет подобран под освещённую днём землю; ночью — тёмный; в «Высоком» — обычный материал (тени от солнца)
  // карьер в «Обычном» — цвета вершин уже с освещением от солнца (стенки на теневой стороне темнее), без расчёта света
  const litMats = new Map([[ground, ground.material], [far, far.material], [pitMesh, pitMesh.material], [ramp, ramp.material]]);
  const flatMats = new Map([[ground, new THREE.MeshBasicMaterial({ map: groundTex })], [far, new THREE.MeshBasicMaterial({ color: GROUND })],
    [pitMesh, new THREE.MeshBasicMaterial({ vertexColors: true })],
    [ramp, new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })]]);
  function setLook({ cheap = false, night = false } = {}) {
    for (const [mesh, lit] of litMats) {
      const flat = flatMats.get(mesh);
      flat.color.setHex(night ? 0x46506a : (mesh === far ? 0xf2e2ac : mesh === pitMesh || mesh === ramp ? 0xf0f0f0 : 0xffffff));
      mesh.material = cheap ? flat : lit;
    }
    pitMesh.visible = !cheap; pitLow.visible = cheap;
    pitLow.material.color.setHex(night ? 0x46506a : 0xf0f0f0);
  }
  return {
    group, anchors, glowAt, setLook,
    setQuality(high) { for (const s of glows) s.visible = !!high; },
    update() {},
  };
}

// Углы точек на кольцах карьера: равный шаг по длине верхнего борта (у длинных боков эллипса точек больше);
// там, где по борту идёт съезд, — мелкий шаг fine (откосы у полотна ровные, без зубцов)
const FINE_ARC = 120;   // единицы вдоль борта: мелкий шаг сетки вокруг трассы съезда (у бровки уступы проступают далеко от неё)
function pitParams(dio, SEG, fine) {
  const { a, b, cx, cy } = dio.pit, N = 8192, cum = [0];
  for (let i = 1; i <= N; i++) {
    const t0 = (i - 1) / N * Math.PI * 2, t1 = i / N * Math.PI * 2;
    cum.push(cum[i - 1] + Math.hypot(a * (Math.cos(t1) - Math.cos(t0)), b * (Math.sin(t1) - Math.sin(t0))));
  }
  const total = cum[N], step = total / SEG;
  const arcAt = (x, y) => {
    const ds = Math.max(0, Math.min(dio.pit.Ds - 1, dio.schemaInset(x, y)));
    let t = Math.atan2((y - cy) / (b - ds), (x - cx) / (a - ds)); if (t < 0) t += Math.PI * 2;
    return cum[Math.min(N, Math.round(t / (Math.PI * 2) * N))];
  };
  const marks = [];
  for (const e of dio.edges) if (e.path) for (const p of e.path) marks.push(arcAt(p[0], p[1]));
  marks.sort((u, v) => u - v);
  const near = (L) => {   // точка трассы съезда в пределах FINE_ARC единиц по длине борта (вся зона проявления уступов)
    let lo = 0, hi = marks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (marks[m] < L) lo = m + 1; else hi = m; }
    for (const k of [lo - 1, lo]) if (k >= 0 && k < marks.length) { const d = Math.abs(marks[k] - L); if (Math.min(d, total - d) < FINE_ARC) return true; }
    return marks.length && (Math.min(Math.abs(marks[0] - L + total), Math.abs(marks[marks.length - 1] - L - total)) < FINE_ARC);
  };
  const ts = [];
  let j = 0;
  for (let L = 0; L < total - 0.5;) {
    while (cum[j + 1] < L) j++;
    ts.push((j + (L - cum[j]) / ((cum[j + 1] - cum[j]) || 1)) / N * Math.PI * 2);
    L += fine && near(L) ? fine : step;
  }
  return ts;
}

// Цвет точки карьера: берма — светлая, стенка — темнее (на теневой стороне ещё темнее), полотно — светлое,
// откосы выемки и насыпи у дорог и площадок — землистые, дно с приглушёнными пятнами руды у забоев
function pitColorer(THREE, dio, colors, u) {
  const { pit, D } = dio;
  const berm = new THREE.Color(0xe4d6b6), road = new THREE.Color(0xddd0b2), floor = new THREE.Color(0xb3a78f);
  const cut = new THREE.Color(0xbfa27e), fill = new THREE.Color(0xcdb894);   // выемка — светлее: откос у въезда не тёмный клин
  const slope = cut.clone().lerp(berm, 0.3);   // ровный склон борта у съезда (уступы проступают из него плавно)
  const rust = new THREE.Color(0x9b6a47), grey = new THREE.Color(0x7d756e);   // стенки уступов: порода видна, не чёрные
  const sun = [-0.85, -0.53];   // солнце с юго-запада (в плане)
  const ore = { sulphide: new THREE.Color(colors.sulphide), clay: new THREE.Color(colors.clay), waste: new THREE.Color(colors.waste) };
  const faces = Object.entries(D.objects).filter(([id, o]) => id.startsWith('face-') && o.position);
  // ins — отступ от борта (< 0 или ≥ Ds — дно), onRoad — точка на полотне
  return (xs, ys, z, ins, out, onRoad = false) => {
    if (onRoad) return out.copy(road);
    if (ins < 0 || ins >= pit.Ds) {
      out.copy(floor);
      for (const [id, o] of faces) {
        const d = Math.hypot(xs - o.position[0], ys - o.position[1]);
        const c = ore[(dio.faceOre && dio.faceOre[id]) || 'sulphide'];
        const R = u(160);   // зона руды ≈ 160 м вокруг забоя
        if (d < R && c) out.lerp(c, 0.32 * (1 - d / R));
      }
      return out;
    }
    // поверхность без дорог: уступы, у съезда — ровный средний склон (sb — доля уступов, dio.stepBlend); точка ниже
    // или выше неё — откос выемки или насыпи; ровный склон у съезда — цвета выемки, уступы и их цвета проступают плавно
    const sb = dio.stepBlend(xs, ys), zAvg = -pit.depth * Math.min(1, ins / pit.Ds);
    const prof = zAvg + (dio.benchProfile(ins) - zAvg) * sb;
    if (Math.abs(z - prof) > 0.8) return out.copy(z < prof ? cut : fill);
    const k = Math.floor(ins / pit.inset), uu = ins - k * pit.inset;
    if (uu < pit.berm - 0.01) out.copy(berm);
    else {
      const t = Math.atan2((ys - pit.cy) / (pit.b - ins), (xs - pit.cx) / (pit.a - ins));
      const nx = -Math.cos(t) / pit.a, ny = -Math.sin(t) / pit.b, n = Math.hypot(nx, ny) || 1;
      const lit = Math.max(0, (nx / n) * sun[0] + (ny / n) * sun[1]);
      out.copy(rust).lerp(grey, k / Math.max(1, pit.benches - 1)).multiplyScalar(0.8 + 0.4 * lit);
    }
    return sb < 1 ? out.lerp(slope, 1 - sb) : out;
  };
}
const smooth01 = (v) => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); };
const BAND = 34;                  // единицы: лента съезда — полотно ±16, откос до 28 и ровный склон до 34 (уступы дальше — сетка карьера)
const SINK_IN = 28, SINK_OUT = 31; // сетка карьера под полотном и откосами (ближе 28 от оси) опущена на 3, до 31 — плавно к поверхности

// Карьер: кольца точно по кромкам уступов (начало бермы, середина бермы, низ стенки), высоты — dio.surfaceAt;
// под лентой съезда (rampBands) сетка опущена, чтобы её крупные треугольники не проступали сквозь ленту
function buildPitMesh(THREE, dio, colorAt, ts) {
  const { pit } = dio;
  const SEG = ts.length;
  const rampEdges = dio.edges.filter((e) => e.path);
  const sink = (xs, ys) => {
    let d = Infinity;
    for (const e of rampEdges) d = Math.min(d, dio.edgeNearest(e, xs, ys, SINK_OUT).d);
    return d >= SINK_OUT ? 0 : 3 * (1 - smooth01((d - SINK_IN) / (SINK_OUT - SINK_IN)));
  };
  const insets = [];
  const wall = pit.inset - pit.berm;
  for (let k = 0; k < pit.benches; k++) {
    const o = k * pit.inset;
    insets.push(o, o + pit.berm * 0.5, o + pit.berm, o + pit.berm + wall * 0.5);
  }
  insets.push(pit.Ds);
  for (const f of [0.85, 0.7, 0.55, 0.4, 0.25, 0.1]) insets.push(-f);   // дно: доли полуосей эллипса дна
  const ringPt = (ins, t) => {
    if (ins >= 0) return dio.ringPoint(ins, t);
    const f = -ins; return [pit.cx + (pit.a - pit.Ds) * f * Math.cos(t), pit.cy + (pit.b - pit.Ds) * f * Math.sin(t)];
  };
  const tmp = new THREE.Color(), floorColor = new THREE.Color(0xb3a78f);
  const pos = [], col = [], idx = [];
  for (let r = 0; r < insets.length; r++) {
    const ins = insets[r];
    for (let i = 0; i < SEG; i++) {
      const t = ts[i];
      const [xs, ys] = ringPt(ins, t);
      const z = dio.surfaceAt(xs, ys);
      pos.push(xs, z - sink(xs, ys), -ys);
      colorAt(xs, ys, z, ins >= 0 && ins < pit.Ds ? ins : -1, tmp);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  // диагональ каждого четырёхугольника — по меньшему перепаду высот: без острых «клиньев» на врезках съездов
  const Y = (i) => pos[i * 3 + 1];
  for (let r = 0; r < insets.length - 1; r++) {
    for (let i = 0; i < SEG; i++) {
      const a0 = r * SEG + i, a1 = r * SEG + (i + 1) % SEG, b0 = a0 + SEG, b1 = a1 + SEG;
      if (Math.abs(Y(a0) - Y(b1)) <= Math.abs(Y(a1) - Y(b0))) idx.push(a0, b0, b1, a0, b1, a1);
      else idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  // центр дна
  const c0 = pos.length / 3;
  pos.push(pit.cx, dio.surfaceAt(pit.cx, pit.cy), -pit.cy); col.push(floorColor.r, floorColor.g, floorColor.b);
  const lastRing = (insets.length - 1) * SEG;
  for (let i = 0; i < SEG; i++) idx.push(lastRing + i, c0, lastRing + (i + 1) % SEG);
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }   // лицевая сторона — вверх
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  m.receiveShadow = true;
  m.name = 'diorama-pit';
  return m;
}

// Лента съезда: поперечины в каждой точке трассы (через ≈ 4 единицы), на каждой 19 точек от −BAND до +BAND
// (полотно ±16 ровное, откосы до 28, дальше — ровный склон борта: уступы за ним рисует сетка карьера вдоль своих
// колец, без зубцов), высоты — dio.surfaceAt. На крутом повороте у торца
// карьера внутренний край ленты короче (не ближе 8 единиц к центру поворота) — без вырожденных треугольников.
// Сетка карьера под лентой опущена (buildPitMesh), а сама лента чуть сдвинута к камере (polygonOffset)
const BAND_OFFS = [-34, -31, -28, -25.5, -23, -20.5, -18, -15.5, -8, 0, 8, 15.5, 18, 20.5, 23, 25.5, 28, 31, 34];   // ±15,5 — край полотна
const BAND_LIFT = 0.15;           // лента чуть выше сетки карьера (вместе с polygonOffset — без ряби там, где они совпадают)
function rampBands(THREE, dio, colorAt) {
  const pos = [], col = [], idx = [], out = [], tmp = new THREE.Color();
  const HW = dio.roadHalf;
  for (const e of dio.edges) {
    if (!e.path) continue;
    // внутри карьера и чуть за бровкой (там лента уходит под землю): опущенная под съездом сетка карьера
    // у бровки закрыта лентой до самого края, без провала; подход к верхнему узлу — обычная лента дороги
    const pl = [];   // точки трассы ближе 1,5 единицы к предыдущей (у узла) пропускаем — без вырожденных треугольников
    for (const p of e.path) {
      const q = pl[pl.length - 1];
      if (dio.schemaInset(p[0], p[1]) > -10 && !(q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5)) pl.push(p);
    }
    const n = pl.length, base = pos.length / 3, K = BAND_OFFS.length;
    if (n < 2) continue;
    // радиус поворота трассы в каждой точке и сторона центра поворота (+1 — слева); берём наименьший радиус
    // в окне ±3 точки — сжатие внутреннего края меняется плавно, без перекошенных треугольников
    const Rr = [], Sr = [];
    for (let i = 0; i < n; i++) {
      let R = Infinity, side = 0;
      if (i > 0 && i < n - 1) {
        const p = pl[i - 1], q = pl[i + 1];
        const ax = pl[i][0] - p[0], ay = pl[i][1] - p[1], bx = q[0] - pl[i][0], by = q[1] - pl[i][1];
        const cr = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        const ang = Math.asin(Math.max(-1, Math.min(1, cr / ((la * lb) || 1))));
        if (Math.abs(ang) > 1e-4) { R = (la + lb) / 2 / Math.abs(ang); side = Math.sign(cr); }
      }
      Rr.push(R); Sr.push(side);
    }
    for (let i = 0; i < n; i++) {
      const p = pl[Math.max(0, i - 1)], q = pl[Math.min(n - 1, i + 1)];
      let tx = q[0] - p[0], ty = q[1] - p[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      let R = Infinity, side = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (Rr[j] < R) { R = Rr[j]; side = Sr[j]; }
      for (const o of BAND_OFFS) {
        let off = o;
        if (side && Math.sign(o) === side && Math.abs(o) > HW && R - 8 < BAND) {   // откос сжат, точки не сливаются
          const k = Math.max(0.15, Math.min(1, (R - 8 - HW) / (BAND - HW)));
          off = Math.sign(o) * (HW + (Math.abs(o) - HW) * k);
        }
        const xs = pl[i][0] - ty * off, ys = pl[i][1] + tx * off;   // слева от хода — положительный сдвиг
        const z = Math.abs(o) <= HW ? pl[i][2] : dio.surfaceAt(xs, ys);
        const ins = dio.schemaInset(xs, ys), outside = ins < 0;
        // за бортом откос ленты не нужен (там степь — сетка земли): уходит под землю, без штриховки с землёй вдали
        pos.push(xs, outside ? z - 0.6 : z + BAND_LIFT, -ys);
        out.push(outside);
        if (ins < 0 && Math.abs(o) > HW) tmp.setHex(0xd6c896);   // за бортом — степь
        else colorAt(xs, ys, z, ins >= dio.pit.Ds ? -1 : ins, tmp, Math.abs(o) <= HW);
        col.push(tmp.r, tmp.g, tmp.b);
      }
      if (i === 0) continue;
      for (let k = 0; k < K - 1; k++) {
        const a0 = base + (i - 1) * K + k, a1 = a0 + 1, b0 = base + i * K + k, b1 = b0 + 1;
        if (out[a0] && out[a1] && out[b0] && out[b1]) continue;   // целиком за бортом
        idx.push(a0, b0, b1, a0, b1, a1);
      }
    }
  }
  // лицевая сторона каждого треугольника — вверх
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [P(idx[i]), P(idx[i + 1]), P(idx[i + 2])];
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
  m.receiveShadow = true;
  m.name = 'diorama-ramp';
  return m;
}

// Полотно дорог — лента по поверхности: точки через ≈ 4 единицы, высота каждой поперечины — dio.surfaceAt
// (максимум по оси и краям) + подъём; обочина — шире и чуть ниже. Ключ результата — 'дорога|материал'
// Площадки развилок у бровки и у пунктов: где сходятся три дороги или две под углом меньше 100°, самосвал на
// повороте выходит за край полотна — там ровная площадка радиусом JUNCTION_R (полотно с обочиной), только вне карьера.
// Те же площадки видит проверка движения (motion_check, «вне дороги»).
export const JUNCTION_R = 34;
export function junctionPads(dio) {
  const out = [];
  for (const [node, p] of Object.entries(dio.D.nodes)) {
    if (dio.schemaInset(p[0], p[1]) >= 0) continue;   // в карьере — нет
    const dirs = [];
    for (const e of dio.edges) {
      if (e.from !== node && e.to !== node) continue;
      const pts = e.path ? e.path : [e.sa, e.sb], seq = e.from === node ? pts : pts.slice().reverse();
      let q = seq[seq.length - 1];
      for (const s of seq) if (Math.hypot(s[0] - p[0], s[1] - p[1]) > 20) { q = s; break; }
      dirs.push(Math.atan2(q[0] - p[0], q[1] - p[1]));
    }
    let acute = false;
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      let d = Math.abs(dirs[i] - dirs[j]); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < 100 * Math.PI / 180) acute = true;
    }
    if (dirs.length >= 3 || (dirs.length === 2 && acute)) out.push([p[0], p[1], JUNCTION_R, node]);
  }
  return out;
}

export function roadRibbons(THREE, dio) {
  const W = dio.roadW, out = {};
  const ROAD_OFFS = [W / 2, -W / 2], SHOULDER_OFFS = [W / 2 + 3, W / 2, -W / 2, -W / 2 - 3];   // поперёк: слева направо
  const parts = {};
  const add = (key, arr) => (parts[key] || (parts[key] = [])).push(...arr);
  for (const e of dio.edges) {
    const isRamp = /^road-ramp/.test(e.road);
    if (e.path) { pathRibbon(e, isRamp, add); continue; }
    const [ax, ay] = e.sa, [bx, by] = e.sb;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.01) continue;
    const dx = (bx - ax) / L, dy = (by - ay) / L, nx = -dy, ny = dx;
    // концы продлены на полширины: на стыках рёбер нет щелей (у забоя — не продлеваем: дальше стенка забоя)
    const ext0 = /^face-/.test(e.from) ? 0 : W / 2, ext1 = /^face-/.test(e.to) ? 0 : W / 2;
    const n = Math.max(1, Math.ceil((L + ext0 + ext1) / 4));
    for (const [mat, offs, lift] of [[isRamp ? 'ramp' : 'open', ROAD_OFFS, 0.45], ['shoulder', SHOULDER_OFFS, 0.2]]) {
      const tri = [];
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const s = -ext0 + (L + ext0 + ext1) * i / n;
        const cxp = ax + dx * s, cyp = ay + dy * s;
        // край полотна — на поверхности под ним; дорога в карьере (дно, подъезд к забою) — ровно на своей высоте,
        // и не ниже поверхности под краем; обочина под полотном — на его высоте, за краем полотна — по поверхности
        const zc = e.pit ? e.zAt(Math.max(0, Math.min(1, s / L))) : null;
        const cur = [];
        for (const o of offs) {
          const x = cxp + nx * o, y = cyp + ny * o, sf = dio.surfaceAt(x, y);
          cur.push(x, (zc !== null && Math.abs(o) <= W / 2 ? Math.max(zc, sf) : sf) + lift, -y);
        }
        if (prev) strip(tri, prev, cur);
        prev = cur;
      }
      add(e.road + '|' + mat, tri);
    }
  }
  // площадки развилок: веер треугольников по поверхности (полотно чуть выше обочины), до бровки карьера
  for (const [cx, cy, R] of junctionPads(dio)) {
    for (const [mat, rad, lift] of [['open', R, 0.45], ['shoulder', R + 3, 0.2]]) {
      const tri = [], N = 40, rim = [];
      for (let k = 0; k <= N; k++) {
        const a = k / N * Math.PI * 2, dx = Math.sin(a), dy = Math.cos(a);
        let r = rad;
        while (r > 2 && dio.schemaInset(cx + dx * r, cy + dy * r) >= -2) r -= 2;   // не заходит в карьер
        const x = cx + dx * r, y = cy + dy * r;
        rim.push([x, dio.surfaceAt(x, y) + lift, -y]);
      }
      const c = [cx, dio.surfaceAt(cx, cy) + lift, -cy];
      for (let k = 0; k < N; k++) tri.push(...c, ...rim[k + 1], ...rim[k]);
      add('junction|' + mat, tri);
    }
  }
  for (const [key, arr] of Object.entries(parts)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    out[key] = g;
  }
  return out;
  // полоса между двумя поперечинами (точки поперёк — слева направо)
  function strip(tri, prev, cur) {
    for (let k = 0; k + 3 < cur.length; k += 3) {
      const a0 = prev.slice(k, k + 3), a1 = prev.slice(k + 3, k + 6), b0 = cur.slice(k, k + 3), b1 = cur.slice(k + 3, k + 6);
      tri.push(...a0, ...a1, ...b0, ...b0, ...a1, ...b1);
    }
  }
  // съезд по трассе: полотно — на высоте трассы (оно ровное поперёк), обочина — по поверхности; концы продлены
  function pathRibbon(e, isRamp, addTo) {
    const pl = e.path, n = pl.length, ext = W / 2;
    const pts = pl.map((p) => p.slice());
    const d0 = [pl[0][0] - pl[1][0], pl[0][1] - pl[1][1]], l0 = Math.hypot(...d0) || 1;
    const d1 = [pl[n - 1][0] - pl[n - 2][0], pl[n - 1][1] - pl[n - 2][1]], l1 = Math.hypot(...d1) || 1;
    pts.unshift([pl[0][0] + d0[0] / l0 * ext, pl[0][1] + d0[1] / l0 * ext, pl[0][2]]);
    pts.push([pl[n - 1][0] + d1[0] / l1 * ext, pl[n - 1][1] + d1[1] / l1 * ext, pl[n - 1][2]]);
    for (const [mat, offs, lift] of [[isRamp ? 'ramp' : 'open', ROAD_OFFS, 0.45], ['shoulder', SHOULDER_OFFS, 0.2]]) {
      const tri = [];
      let prev = null;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
        let tx = q[0] - p[0], ty = q[1] - p[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        // полотно (и обочина под ним) ровное на высоте трассы, но не ниже поверхности под краем (у дуги и на
        // продлении за узел); обочина за краем полотна — по поверхности: она не поднимается поверх полотна
        const cur = [];
        for (const o of offs) {
          const x = pts[i][0] - ty * o, y = pts[i][1] + tx * o, sf = dio.surfaceAt(x, y);
          cur.push(x, (Math.abs(o) <= W / 2 ? Math.max(pts[i][2], sf) : sf) + lift, -y);
        }
        if (prev) strip(tri, prev, cur);
        prev = cur;
      }
      addTo(e.road + '|' + mat, tri);
    }
  }
}

// Текстура степи: мягкие пятна трёх-четырёх тонов с гладкими краями и утрамбованные площадки у объектов
function steppeTexture(THREE, dio, [x0, y0, x1, y1], u) {
  const W = 2048, H = Math.round(W * (y1 - y0) / (x1 - x0));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const px = (x) => (x - x0) / (x1 - x0) * W, py = (y) => (1 - (y - y0) / (y1 - y0)) * H, pr = (r) => r / (x1 - x0) * W;
  g.fillStyle = '#d6c896'; g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const tones = ['rgba(201,184,128,', 'rgba(224,212,166,', 'rgba(190,176,122,', 'rgba(214,196,140,'];
  // пятна цвета земли (бурый суглинок, солончак) и серо-зелёной полыни — живее с общего вида
  const soil = ['rgba(168,142,98,', 'rgba(150,148,104,', 'rgba(184,160,112,', 'rgba(226,220,196,', 'rgba(140,140,96,'];
  for (let i = 0; i < 140; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0), r = u(120) + rnd() * u(420);
    const gr = g.createRadialGradient(px(x), py(y), 0, px(x), py(y), pr(r));
    const t = soil[i % soil.length];
    gr.addColorStop(0, t + '0.42)'); gr.addColorStop(0.55, t + '0.22)'); gr.addColorStop(1, t + '0)');
    g.fillStyle = gr;
    g.save(); g.translate(px(x), py(y)); g.rotate(rnd() * Math.PI); g.scale(1, 0.35 + rnd() * 0.6); g.translate(-px(x), -py(y));
    g.beginPath(); g.arc(px(x), py(y), pr(r), 0, Math.PI * 2); g.fill(); g.restore();
  }
  for (let i = 0; i < 160; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0), r = u(200) + rnd() * u(600);
    const gr = g.createRadialGradient(px(x), py(y), 0, px(x), py(y), pr(r));
    const t = tones[i % tones.length];
    gr.addColorStop(0, t + '0.55)'); gr.addColorStop(0.6, t + '0.35)'); gr.addColorStop(1, t + '0)');
    g.fillStyle = gr;
    g.save(); g.translate(px(x), py(y)); g.scale(1, 0.65 + rnd() * 0.5); g.translate(-px(x), -py(y));
    g.beginPath(); g.arc(px(x), py(y), pr(r), 0, Math.PI * 2); g.fill(); g.restore();
  }
  // утрамбованные площадки: светлый грунт с мягким краем (размеры — реальные, единицы = метры)
  const pad = (x, y, w, h, r) => {
    g.save(); g.shadowColor = 'rgba(200,186,150,0.9)'; g.shadowBlur = pr(5);
    g.fillStyle = '#ddd0b0';
    roundRect(g, px(x - w / 2), py(y + h / 2), pr(w), pr(h), pr(r)); g.fill(); g.restore();
  };
  const O = dio.D.objects;
  const at = (id) => O[id] && O[id].position;
  const plant = at('plant-sulphide');
  if (plant) pad(plant[0], plant[1] - 35, 460, 370, 20);
  const sp = at('stockpile-coarse'); if (sp) pad(sp[0], sp[1], 170, 160, 50);
  const cr = at('crusher-01'); if (cr) pad(cr[0], cr[1] - 20, 120, 110, 20);
  const fs = at('fuel-station'); if (fs) pad(fs[0], fs[1], 90, 70, 15);
  const pc = at('plant-clay'); if (pc) pad(pc[0] + 30, pc[1], 270, 160, 20);
  const sc = at('stockpile-clay'); if (sc) pad(sc[0], sc[1], 150, 140, 40);
  const sub = at('power-grid'); if (sub) pad(sub[0], sub[1], 110, 90, 12);
  const dump = at('dump-waste-1');
  if (dump) {   // подошва отвала — серый грунт с мягким краем
    const gr = g.createRadialGradient(px(dump[0]), py(dump[1]), pr(380), px(dump[0]), py(dump[1]), pr(480));
    gr.addColorStop(0, 'rgba(176,170,160,0.9)'); gr.addColorStop(1, 'rgba(176,170,160,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(px(dump[0]), py(dump[1]), pr(480), 0, Math.PI * 2); g.fill();
  }
  // светлый пояс вокруг борта карьера
  const p = dio.pit;
  g.save(); g.strokeStyle = 'rgba(228,214,178,0.9)'; g.lineWidth = pr(u(40)); g.shadowColor = 'rgba(228,214,178,0.8)'; g.shadowBlur = pr(u(15));
  g.beginPath(); g.ellipse(px(p.cx), py(p.cy), pr(p.a + u(15)), pr(p.b + u(15)), 0, 0, Math.PI * 2); g.stroke(); g.restore();
  // край текстуры плавно переходит в ровную степь вокруг (без видимой границы)
  const edge = Math.min(W, H) * 0.08;
  for (const [x, y, w, h, gx0, gy0, gx1, gy1] of [[0, 0, W, edge, 0, 0, 0, edge], [0, H - edge, W, edge, 0, H, 0, H - edge],
    [0, 0, edge, H, 0, 0, edge, 0], [W - edge, 0, edge, H, W, 0, W - edge, 0]]) {
    const lg = g.createLinearGradient(gx0, gy0, gx1, gy1);
    lg.addColorStop(0, '#d6c896'); lg.addColorStop(1, 'rgba(214,200,150,0)');
    g.fillStyle = lg; g.fillRect(x, y, w, h);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

function rocks(THREE, dio, [x0, y0, x1, y1], u) {
  const { pit, D } = dio;
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const segDist = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
  };
  const busy = Object.entries(D.objects).filter(([id, o]) => o.position && !/^(face|excavator|drill)-/.test(id)).map(([, o]) => o.position);
  const keep = (x, y) => {
    const e = ((x - pit.cx) / (pit.a + 10)) ** 2 + ((y - pit.cy) / (pit.b + 10)) ** 2;
    if (e < 1) return false;                                                   // не в карьере
    for (const ed of dio.edges) if ((ed.path ? dio.edgeNearest(ed, x, y, 31).d : segDist(x, y, ed.sa, ed.sb)) < 30) return false;   // не на дорогах
    for (const p of busy) if (Math.hypot(x - p[0], y - p[1]) < 280) return false;  // не на площадках
    const tl = D.extra && D.extra.tailings;
    if (tl && ((x - tl.center[0]) / (tl.radii[0] + 80)) ** 2 + ((y - tl.center[1]) / (tl.radii[1] + 80)) ** 2 < 1) return false;
    return true;
  };
  const pts = [];
  for (let i = 0; i < 6000 && pts.length < 380; i++) {
    let x, y;
    if (i % 3 === 0) {   // треть — у борта карьера
      const t = rnd() * Math.PI * 2, r = 1.03 + rnd() * 0.1;
      x = pit.cx + pit.a * r * Math.cos(t); y = pit.cy + pit.b * r * Math.sin(t);
    } else { x = x0 + 6 + rnd() * (x1 - x0 - 12); y = y0 + 6 + rnd() * (y1 - y0 - 12); }
    if (keep(x, y)) pts.push([x, y, 0.8 + rnd() * rnd() * 4, rnd() * Math.PI]);
  }
  const geo = new THREE.IcosahedronGeometry(1, 0);
  geo.scale(1, 0.62, 1);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const tones = [0x9a6a4a, 0x8a5c40, 0xb08463, 0x7c6a5a];
  pts.forEach(([x, y, s, r], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r);
    m.compose(new THREE.Vector3(x, s * 0.3, -y), q, new THREE.Vector3(s, s, s));
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, c.setHex(tones[i % tones.length]));
  });
  inst.raycast = () => {};
  inst.name = 'rocks';
  return inst;
}

// свободное место в степи: не в карьере (с запасом), не на дорогах, не у объектов, не в пруду хвостохранилища
function steppeFree(dio, roadGap, busyR) {
  const { pit, D } = dio;
  const busy = Object.entries(D.objects).filter(([id, o]) => o.position && !/^(face|excavator|drill)-/.test(id)).map(([, o]) => o.position);
  const segDist = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
  };
  const tl = D.extra && D.extra.tailings;
  const round = Object.values(D.objects).filter((o) => o.position && o.radius).map((o) => [o.position, o.radius + 60]);
  const cv = Object.values(D.objects).find((o) => o.kind === 'conveyor' && o.path);
  return (x, y) => {
    if (((x - pit.cx) / (pit.a + 25)) ** 2 + ((y - pit.cy) / (pit.b + 25)) ** 2 < 1) return false;
    for (const [p, r] of round) if (Math.hypot(x - p[0], y - p[1]) < r) return false;
    if (cv) for (let i = 0; i + 1 < cv.path.length; i++) if (segDist(x, y, cv.path[i], cv.path[i + 1]) < 25) return false;
    for (const ed of dio.edges) if ((ed.path ? dio.edgeNearest(ed, x, y, roadGap + 1).d : segDist(x, y, ed.sa, ed.sb)) < roadGap) return false;
    for (const p of busy) if (Math.hypot(x - p[0], y - p[1]) < busyR) return false;
    if (tl && ((x - tl.center[0]) / (tl.radii[0] + 90)) ** 2 + ((y - tl.center[1]) / (tl.radii[1] + 90)) ** 2 < 1) return false;
    return true;
  };
}
// опора ЛЭП: не на дороге и не у объекта (трасса конвейера — тоже объект с путём)
function poleFree(dio) {
  const free = steppeFree(dio, 22, 75);
  const cv = Object.values(dio.D.objects).find((o) => o.kind === 'conveyor' && o.path);
  return (x, y) => {
    if (!free(x, y)) return false;
    if (cv) for (let i = 0; i + 1 < cv.path.length; i++) {
      const a = cv.path[i], b = cv.path[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
      if (Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t) < 18) return false;
    }
    return true;
  };
}
// куртины кустиков и пучки ковыля: куртина 6–14 кустов в круге ≈ 15 единиц — видна и с общего вида
function steppeLife(THREE, dio, [x0, y0, x1, y1], avoid) {
  const base = steppeFree(dio, 26, 240), free = (x, y) => base(x, y) && !avoid(x, y);
  let seed = 23;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const bush = [], grass = [];
  for (let i = 0; i < 4000 && bush.length < 300; i++) {   // бюджет кадров без видеокарты: ≈ 30 куртин
    const cx = x0 + 20 + rnd() * (x1 - x0 - 40), cy = y0 + 20 + rnd() * (y1 - y0 - 40);
    if (!free(cx, cy)) continue;
    const n = 6 + Math.floor(rnd() * 9);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, r = rnd() * 15, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      bush.push([x, y, 1.4 + rnd() * 2.6, rnd() * Math.PI]);
    }
    for (let k = 0; k < 5; k++) {
      const a = rnd() * Math.PI * 2, r = 8 + rnd() * 30, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (free(x, y)) grass.push([x, y, 0.8 + rnd() * 1.1, rnd() * Math.PI]);
    }
  }
  const make = (geo, pts, tones, name, lift) => {
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    pts.forEach(([x, y, s, r], i) => {
      q.setFromAxisAngle(up, r);
      m.compose(new THREE.Vector3(x, dio.surfaceAt(x, y) + s * lift, -y), q, new THREE.Vector3(s, s, s));
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, c.setHex(tones[i % tones.length]));
    });
    inst.raycast = () => {};
    inst.name = name;
    return inst;
  };
  const bg = new THREE.OctahedronGeometry(1, 0); bg.scale(1.3, 0.62, 1.3);   // простая форма: без видеокарты дорог каждый куст
  const gg = new THREE.ConeGeometry(0.5, 1.6, 4, 1, true); gg.translate(0, 0.8, 0);
  return [make(bg, bush, [0x7f8c55, 0x6f7c4a, 0x939d68, 0x8a8a5a, 0x76844c], 'steppe-bushes', 0.35),
    make(gg, grass, [0xc9b77a, 0xb9a865, 0xd6c68e, 0xa99a5e], 'steppe-grass', 0)];
}
// коробки [ширина, высота, длина, цвет, x, y, z] → одна геометрия с цветами вершин
function boxesGeometry(THREE, boxes) {
  const pos = [], nor = [], col = [], c = new THREE.Color();
  for (const [w, hh, l, color, x, y, z] of boxes) {
    const g = new THREE.BoxGeometry(w, hh, l).toNonIndexed(); g.translate(x, y, z);
    c.setHex(color);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.r, c.g, c.b); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}
// ж/д ветка с запада к складу концентрата у сульфидной фабрики: насыпь, рельсы, шпалы, хопперы под концентрат
function railSiding(THREE, dio, models, plant) {
  if (!plant) return null;
  const grp = new THREE.Group(); grp.name = 'rail-siding';
  const z = -plant[1] + 330, xA = plant[0] - 1500, xB = plant[0] + 40;   // ветка южнее фабрики (схема: y на юг — минус)
  const len = xB - xA, cx = (xA + xB) / 2, h = (x) => dio.surfaceAt(x, -z);
  // насыпь и рельсы — одна геометрия с цветами вершин (один вызов отрисовки)
  grp.add(new THREE.Mesh(boxesGeometry(THREE, [[len, 1.2, 7, 0x9b9384, 0, 0.3, 0], [len, 0.3, 0.2, 0x5b5f66, 0, 1.25, -0.76],
    [len, 0.3, 0.2, 0x5b5f66, 0, 1.25, 0.76]]), new THREE.MeshLambertMaterial({ vertexColors: true })));
  grp.children[grp.children.length - 1].position.set(cx, h(cx), z);
  const nSl = Math.floor(len / 8);
  const sl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.2, 2.6), new THREE.MeshLambertMaterial({ color: 0x6a5a48 }), nSl);
  const m = new THREE.Matrix4();
  for (let i = 0; i < nSl; i++) { const x = xA + 4 + i * 8; m.makeTranslation(x, h(cx) + 1.0, z); sl.setMatrixAt(i, m); }
  sl.name = 'rail-sleepers';   // шпалы — только в «Высоком» (сцена скрывает их без видеокарты)
  grp.add(sl);
  // хопперы-вагоны под концентрат у склада: корпус и крыша, 12 вагонов по 14 м
  const nW = 12, wagons = new THREE.InstancedMesh(boxesGeometry(THREE, [[13.2, 3.4, 3.1, 0x5f6f62, 0, 0, 0], [13.2, 0.5, 2.4, 0x48524a, 0, 1.95, 0]]),
    new THREE.MeshLambertMaterial({ vertexColors: true }), nW);   // кузов и крыша — одна геометрия
  for (let i = 0; i < nW; i++) { m.makeTranslation(xB - 70 - i * 14.2, h(cx) + 3.4, z); wagons.setMatrixAt(i, m); }
  grp.add(wagons);
  // склад концентрата с погрузкой в вагоны (крытый склад у конца ветки)
  const shed = models && models.building ? models.building('warehouse', { size: [70, 26, 16] }) : null;
  const anchor = new THREE.Object3D();
  if (shed) { shed.position.set(xB - 20, h(xB), z - 22); grp.add(shed); anchor.position.set(xB - 20, h(xB) + 24, z - 22); }
  else anchor.position.set(xB - 20, h(xB) + 10, z);
  grp.add(anchor);
  grp.traverse((o) => { if (o.isMesh) o.raycast = () => {}; });
  return { group: grp, anchor };
}

// ограждение: тонкие светлые столбики и полупрозрачная сетка между ними (забор 2,2 м, столбы через 15 м)
export function fence(THREE, S, corners) {
  const grp = new THREE.Group(); grp.name = 'fence';
  const postMat = new THREE.MeshLambertMaterial({ color: 0xd9dde0 });
  const netMat = new THREE.MeshBasicMaterial({ color: 0xc9ced2, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const H = 2.2, STEP = 15;
  const posts = [], net = [];
  for (let s = 0; s < corners.length; s++) {
    const [ax, ay] = corners[s], [bx, by] = corners[(s + 1) % corners.length];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
    for (let i = 0; i < n; i++) posts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
    const A = S(ax, ay, 0), Bv = S(bx, by, 0);
    net.push(A.x, 0.15, A.z, Bv.x, 0.15, Bv.z, Bv.x, H, Bv.z, A.x, 0.15, A.z, Bv.x, H, Bv.z, A.x, H, A.z);
  }
  const pg = new THREE.CylinderGeometry(0.1, 0.1, H, 5); pg.translate(0, H / 2, 0);
  const inst = new THREE.InstancedMesh(pg, postMat, posts.length);
  const m = new THREE.Matrix4();
  posts.forEach(([x, y], i) => { const p = S(x, y, 0); m.makeTranslation(p.x, p.y, p.z); inst.setMatrixAt(i, m); });
  const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(net, 3));
  grp.add(inst, new THREE.Mesh(ng, netMat));
  return grp;
}
