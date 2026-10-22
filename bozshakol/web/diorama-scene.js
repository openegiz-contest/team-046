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

export function buildDiorama(THREE, dio, models, colors, glowTexture) {
  const group = new THREE.Group();
  group.name = 'diorama';
  const { D, pit } = dio;
  const B = dio.bounds;
  const S = dio.s;
  const K = D.scale || 2;             // м местности на единицу карты
  const u = (m) => m / K;             // расстояние по карте: метры → единицы
  const glows = [];
  const ts = pitParams(dio);

  // --- степь до горизонта: внешнее поле одного цвета, внутри области рудника — текстура с пятнами и площадками
  const x0 = B.minX, x1 = B.maxX, y0 = B.minY, y1 = B.maxY;
  const outer = new THREE.Shape();
  outer.moveTo(-FAR, -FAR); outer.lineTo(FAR, -FAR); outer.lineTo(FAR, FAR); outer.lineTo(-FAR, FAR); outer.closePath();
  const rectHole = new THREE.Path();
  rectHole.moveTo(x0, y0); rectHole.lineTo(x0, y1); rectHole.lineTo(x1, y1); rectHole.lineTo(x1, y0); rectHole.closePath();
  outer.holes.push(rectHole);
  const far = new THREE.Mesh(new THREE.ShapeGeometry(outer), new THREE.MeshLambertMaterial({ color: GROUND }));
  far.rotation.x = -Math.PI / 2; far.position.y = -0.05; far.receiveShadow = true; far.name = 'diorama-far';
  group.add(far);

  // земля вокруг карьера: отверстие — ровно по верхнему кольцу сетки карьера (те же точки, без щелей)
  const shape = new THREE.Shape();
  shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
  const hole = new THREE.Path();
  for (let i = PIT_SEG - 1; i >= 0; i--) { const [hx, hy] = dio.ringPoint(0, ts[i]); if (i === PIT_SEG - 1) hole.moveTo(hx, hy); else hole.lineTo(hx, hy); }
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

  // --- карьер: кольца по отступу от борта, высоты — dio.surfaceAt (уступы и врезанные съезды)
  group.add(buildPitMesh(THREE, dio, colors, u, ts));

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

  // --- сгустители у фабрик (круглые резервуары с мостом, ≈ 60 м) — окружение схемы, не двойники
  if (models && models.building) {
    const tk = (xs, ys, d) => { const g = models.building('thickener', { size: [d, d, 6] }); g.position.copy(S(xs, ys, 0)); group.add(g); };
    if (plant) { tk(plant[0] - 90, plant[1] - 150, 60); tk(plant[0] + 10, plant[1] - 150, 60); }
    const pc = D.objects['plant-clay'] && D.objects['plant-clay'].position;
    if (pc) tk(pc[0] + 125, pc[1] - 10, 50);
  }

  // --- мачты освещения по борту карьера (прожекторы — ореолы); мачта 30 м
  for (let i = 0; i < 14; i++) {
    const t = (i + 0.5) / 14 * Math.PI * 2;
    const [xs, ys] = dio.ringPoint(-u(60), t);
    let m;
    if (models && models.lightMast) m = models.lightMast(30);
    else { m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 30, 6), new THREE.MeshLambertMaterial({ color: 0xbfc4c8 })); m.position.y = 15; }
    const holder = new THREE.Group(); holder.add(m);
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
  }

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
  const litMats = new Map([[ground, ground.material], [far, far.material]]);
  const flatMats = new Map([[ground, new THREE.MeshBasicMaterial({ map: groundTex })], [far, new THREE.MeshBasicMaterial({ color: GROUND })]]);
  function setLook({ cheap = false, night = false } = {}) {
    for (const [mesh, lit] of litMats) {
      const flat = flatMats.get(mesh);
      flat.color.setHex(night ? 0x46506a : (mesh === far ? 0xf2e2ac : 0xffffff));
      mesh.material = cheap ? flat : lit;
    }
  }
  return {
    group, anchors, glowAt, setLook,
    setQuality(high) { for (const s of glows) s.visible = !!high; },
    update() {},
  };
}

// Углы точек на кольцах карьера: равный шаг по длине верхнего борта (у длинных боков эллипса точек больше)
function pitParams(dio) {
  const { a, b } = dio.pit, N = 8192, cum = [0];
  for (let i = 1; i <= N; i++) {
    const t0 = (i - 1) / N * Math.PI * 2, t1 = i / N * Math.PI * 2;
    cum.push(cum[i - 1] + Math.hypot(a * (Math.cos(t1) - Math.cos(t0)), b * (Math.sin(t1) - Math.sin(t0))));
  }
  const ts = [];
  let j = 0;
  for (let k = 0; k < PIT_SEG; k++) {
    const L = k / PIT_SEG * cum[N];
    while (cum[j + 1] < L) j++;
    ts.push((j + (L - cum[j]) / ((cum[j + 1] - cum[j]) || 1)) / N * Math.PI * 2);
  }
  return ts;
}

// Карьер: кольца точно по кромкам уступов (начало бермы, середина бермы, низ стенки), высоты — dio.surfaceAt.
// Берма — светлая, стенка — темнее (на теневой стороне ещё темнее), съезды и площадки забоев — светлые,
// дно с приглушёнными пятнами руды у забоев
function buildPitMesh(THREE, dio, colors, u, ts) {
  const { pit, D } = dio;
  const SEG = ts.length;
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
  const berm = new THREE.Color(0xe4d6b6), road = new THREE.Color(0xddd0b2), floor = new THREE.Color(0xb3a78f);
  const rust = new THREE.Color(0x9b6a47), grey = new THREE.Color(0x6f6862), tmp = new THREE.Color();
  const sun = [-0.85, -0.53];   // солнце с юго-запада (в плане)
  const ore = { sulphide: new THREE.Color(colors.sulphide), clay: new THREE.Color(colors.clay), waste: new THREE.Color(colors.waste) };
  const faces = Object.entries(D.objects).filter(([id, o]) => id.startsWith('face-') && o.position);
  const pos = [], col = [], idx = [];
  for (let r = 0; r < insets.length; r++) {
    const ins = insets[r];
    for (let i = 0; i < SEG; i++) {
      const t = ts[i];
      const [xs, ys] = ringPt(ins, t);
      const z = dio.surfaceAt(xs, ys);
      pos.push(xs, z, -ys);
      const prof = dio.benchProfile(Math.max(0, ins >= 0 ? ins : pit.Ds));
      const carved = Math.abs(z - prof) > 0.8;
      if (ins < 0 || ins >= pit.Ds) {
        tmp.copy(floor);
        for (const [id, o] of faces) {
          const d = Math.hypot(xs - o.position[0], ys - o.position[1]);
          const c = ore[(dio.faceOre && dio.faceOre[id]) || 'sulphide'];
          const R = u(160);   // зона руды ≈ 160 м вокруг забоя
          if (d < R && c) tmp.lerp(c, 0.32 * (1 - d / R));
        }
      } else if (carved) tmp.copy(road);
      else {
        const k = Math.floor(ins / pit.inset), uu = ins - k * pit.inset;
        if (uu < pit.berm - 0.01) tmp.copy(berm);
        else {
          const nx = -Math.cos(t) / pit.a, ny = -Math.sin(t) / pit.b, n = Math.hypot(nx, ny) || 1;
          const lit = Math.max(0, (nx / n) * sun[0] + (ny / n) * sun[1]);
          tmp.copy(rust).lerp(grey, k / Math.max(1, pit.benches - 1)).multiplyScalar(0.62 + 0.5 * lit);
        }
      }
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
  pos.push(pit.cx, dio.surfaceAt(pit.cx, pit.cy), -pit.cy); col.push(floor.r, floor.g, floor.b);
  const lastRing = (insets.length - 1) * SEG;
  for (let i = 0; i < SEG; i++) idx.push(lastRing + i, c0, lastRing + (i + 1) % SEG);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  m.name = 'diorama-pit';
  return m;
}

// Полотно дорог — лента по поверхности: точки через ≈ 4 единицы, высота каждой поперечины — dio.surfaceAt
// (максимум по оси и краям) + подъём; обочина — шире и чуть ниже. Ключ результата — 'дорога|материал'
export function roadRibbons(THREE, dio) {
  const W = dio.roadW, out = {};
  const parts = {};
  const add = (key, arr) => (parts[key] || (parts[key] = [])).push(...arr);
  for (const e of dio.edges) {
    const isRamp = /^road-ramp/.test(e.road);
    const [ax, ay] = e.sa, [bx, by] = e.sb;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.01) continue;
    const dx = (bx - ax) / L, dy = (by - ay) / L, nx = -dy, ny = dx;
    // концы продлены на полширины: на стыках рёбер нет щелей
    const ext = W / 2, n = Math.max(1, Math.ceil((L + 2 * ext) / 4));
    for (const [mat, half, lift] of [[isRamp ? 'ramp' : 'open', W / 2, 0.45], ['shoulder', W / 2 + 3, 0.2]]) {
      const tri = [];
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const s = -ext + (L + 2 * ext) * i / n;
        const cxp = ax + dx * s, cyp = ay + dy * s;
        const lx = cxp + nx * half, ly = cyp + ny * half, rx = cxp - nx * half, ry = cyp - ny * half;
        const h = Math.max(dio.surfaceAt(cxp, cyp), dio.surfaceAt(lx, ly), dio.surfaceAt(rx, ry)) + lift;
        const cur = [lx, h, -ly, rx, h, -ry];
        if (prev) tri.push(...prev.slice(0, 3), ...prev.slice(3), ...cur.slice(0, 3), ...cur.slice(0, 3), ...prev.slice(3), ...cur.slice(3));
        prev = cur;
      }
      add(e.road + '|' + mat, tri);
    }
  }
  for (const [key, arr] of Object.entries(parts)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    out[key] = g;
  }
  return out;
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
    for (const ed of dio.edges) if (segDist(x, y, ed.sa, ed.sb) < 30) return false;   // не на дорогах
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

// ограждение: тонкие светлые столбики и полупрозрачная сетка между ними (забор 2,2 м, столбы через 15 м)
function fence(THREE, S, corners) {
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
