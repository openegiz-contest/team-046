// Макет рудника для режима «Схема»: подставка со срезом слоёв грунта, светлый фон с тонкой сеткой,
// степь мягкими пятнами и утрамбованные площадки (текстура рисуется кодом), карьер — 7 чётких уступов
// с врезанными съездами, хвостохранилище, ограждение, мачты освещения, ЛЭП. Дороги строит app.js.
//
//   buildDiorama(THREE, dio, models, colors, glowTexture) ->
//     { group, anchors: {pitName, pitFloor, tailings}, setWeather({blizzard}), setQuality(high), glowAt, update(dt) }

const STRATA = [            // срез подставки сверху вниз: [до глубины, цвет]
  [-2.5, 0x7a5c3c],          // почвенный слой
  [-14, 0xd2b07a],           // лёсс и суглинки
  [-30, 0xb8693e],           // глины коры выветривания
  [-48, 0x9b8a74],           // выветрелые породы
  [-60, 0x6b625b],           // коренные породы
];
const BASE_Z = -60, PLINTH_PAD = 0;

export function buildDiorama(THREE, dio, models, colors, glowTexture) {
  const group = new THREE.Group();
  group.name = 'diorama';
  const { D, pit } = dio;
  const B = dio.bounds;
  const S = dio.s;
  const glows = [];

  // --- подставка: срез слоями по четырём сторонам, тёмное основание, мягкая тень, сетка фона
  const x0 = B.minX - PLINTH_PAD, x1 = B.maxX + PLINTH_PAD, y0 = B.minY - PLINTH_PAD, y1 = B.maxY + PLINTH_PAD;
  let top = 0;
  for (const [bottom, color] of STRATA) {
    group.add(sideWalls(THREE, x0, y0, x1, y1, top - 0.02, bottom, color));
    top = bottom;
  }
  const baseSlab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 6, 3, y1 - y0 + 6), new THREE.MeshLambertMaterial({ color: 0x3e4650 }));
  baseSlab.position.set((x0 + x1) / 2, BASE_Z - 1.5, -(y0 + y1) / 2);
  group.add(baseSlab);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softShadowTexture(THREE), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set((x1 - x0) * 1.35, (y1 - y0) * 1.5, 1);
  shadow.position.set((x0 + x1) / 2 + 30, BASE_Z - 3.2, -(y0 + y1) / 2 + 26);
  shadow.renderOrder = -2;
  group.add(shadow);
  const grid = new THREE.GridHelper(4000, 100, 0xc3ccd4, 0xd9dfe4);
  grid.position.y = BASE_Z - 3.4;
  grid.name = 'diorama-grid';
  grid.material.depthWrite = false;   // непрозрачные светлые линии: без смешивания — дешевле без видеокарты
  group.add(grid);

  // --- поверхность: ровная степь с вырезом под карьер; пятна и площадки — в текстуре
  const shape = new THREE.Shape();
  shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
  const hole = new THREE.Path(); hole.absellipse(pit.cx, pit.cy, pit.a, pit.b, 0, Math.PI * 2, true, 0);
  shape.holes.push(hole);
  const groundGeo = new THREE.ShapeGeometry(shape, 160);
  const uv = groundGeo.attributes.uv, gp = groundGeo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (gp.getX(i) - x0) / (x1 - x0), (gp.getY(i) - y0) / (y1 - y0));
  const groundTex = steppeTexture(THREE, dio, colors, [x0, y0, x1, y1]);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }));
  ground.rotation.x = -Math.PI / 2;      // ShapeGeometry в плоскости XY: y → −z сцены (север)
  ground.receiveShadow = true;
  ground.name = 'diorama-ground';
  group.add(ground);

  // --- россыпь камней по степи и у борта карьера (один InstancedMesh): не на дорогах и не на площадках
  group.add(rocks(THREE, dio, [x0, y0, x1, y1]));

  // --- карьер: кольца по отступу от борта, высоты — dio.surfaceAt (уступы и врезанные съезды)
  group.add(buildPitMesh(THREE, dio, colors));

  // --- хвостохранилище: светлый пляж, гладкая вода с бликом, насыпная дамба
  const tl = D.extra && D.extra.tailings;
  const anchors = {};
  if (tl) {
    const [tx, ty] = tl.center, [rx, ry] = tl.radii;
    const beach = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshLambertMaterial({ color: 0xdcd2b2 }));
    beach.scale.set(rx + 7, ry + 7, 1); beach.rotation.x = -Math.PI / 2; beach.position.copy(S(tx, ty, 0.12));
    const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshStandardMaterial({ color: 0x7fa3b4, roughness: 0.12, metalness: 0 }));
    pond.scale.set(rx - 2, ry - 2, 1); pond.rotation.x = -Math.PI / 2; pond.position.copy(S(tx, ty, 0.9));
    pond.name = 'tailings-pond';
    const damShape = new THREE.Shape();
    damShape.moveTo(-2.6, 0); damShape.lineTo(2.6, 0); damShape.lineTo(1.2, 2.2); damShape.lineTo(-1.2, 2.2); damShape.closePath();
    const pts = [];
    for (let i = 0; i <= 96; i++) { const t = i / 96 * Math.PI * 2; pts.push(new THREE.Vector3((rx + 1) * Math.cos(t), 0, (ry + 1) * Math.sin(t))); }
    const dam = new THREE.Mesh(new THREE.ExtrudeGeometry(damShape, { steps: 96, bevelEnabled: false, extrudePath: new THREE.CatmullRomCurve3(pts, true) }),
      new THREE.MeshLambertMaterial({ color: 0xa48f6e, flatShading: true }));
    dam.position.copy(S(tx, ty, 0)); dam.name = 'tailings-dam';
    group.add(beach, pond, dam);
    anchors.tailings = new THREE.Object3D(); anchors.tailings.position.copy(S(tx, ty, 3)); group.add(anchors.tailings);
  }

  // --- ограждение промплощадки сульфидной фабрики: светлые столбики и сетка
  const plant = D.objects['plant-sulphide'] && D.objects['plant-sulphide'].position;
  if (plant) group.add(fence(THREE, S, [[plant[0] - 54, plant[1] - 32], [plant[0] + 50, plant[1] - 32], [plant[0] + 50, plant[1] + 36], [plant[0] - 54, plant[1] + 36]]));

  // --- сгустители у фабрик (круглые резервуары с мостом) — окружение схемы, не двойники
  if (models && models.building) {
    const tk = (xs, ys, d) => { const g = models.building('thickener', { size: [d, d, 6] }); g.scale.setScalar(0.55); g.position.copy(S(xs, ys, 0)); group.add(g); };
    if (plant) { tk(plant[0] - 30, plant[1] - 46, 34); tk(plant[0] + 4, plant[1] - 46, 34); }
    const pc = D.objects['plant-clay'] && D.objects['plant-clay'].position;
    if (pc) tk(pc[0] + 36, pc[1] - 4, 30);
  }

  // --- мачты освещения по борту карьера (прожекторы — ореолы)
  for (let i = 0; i < 8; i++) {
    const t = (i + 0.5) / 8 * Math.PI * 2;
    const xs = pit.cx + (pit.a + 9) * Math.cos(t), ys = pit.cy + (pit.b + 8) * Math.sin(t);
    let m;
    if (models && models.lightMast) m = models.lightMast(30);
    else { m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 30, 6), new THREE.MeshLambertMaterial({ color: 0xbfc4c8 })); m.position.y = 15; }
    const holder = new THREE.Group(); holder.add(m); holder.scale.setScalar(0.55);
    holder.position.copy(S(xs, ys, 0));
    holder.rotation.y = Math.atan2(pit.cx - xs, -(pit.cy - ys)) + Math.PI;   // прожекторы — к карьеру
    group.add(holder);
    glowAt(S(xs, ys, 30 * 0.55 + 1), 0xfff1c4, 11);
  }

  // --- ЛЭП: с края макета к подстанции и от подстанции к фабрике
  const sub = D.objects['power-grid'] && D.objects['power-grid'].position;
  if (sub && models && models.powerLine) {
    const line = (from, to, step) => {
      const n = Math.max(2, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / step)), pts = [];
      for (let i = 0; i <= n; i++) pts.push(S(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n, 0));
      const g = models.powerLine(pts, { height: 20 }); g.scale.y = 0.6; group.add(g);
    };
    line([B.minX + 4, B.minY + 30], sub, 26);
    if (plant) line(sub, [plant[0] + 40, plant[1] - 24], 20);
  }

  // --- подписи карьера
  anchors.pitName = new THREE.Object3D(); anchors.pitName.position.copy(S(pit.cx, pit.cy + pit.b, 2)); group.add(anchors.pitName);
  anchors.pitFloor = new THREE.Object3D(); anchors.pitFloor.position.copy(S(pit.cx, pit.cy, -pit.depth + 1)); group.add(anchors.pitFloor);

  function glowAt(position, color, size) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    sp.position.copy(position); sp.scale.set(size, size, 1); sp.userData.glow = true;
    group.add(sp); glows.push(sp);
    return sp;
  }
  return {
    group, anchors, glowAt,
    setQuality(high) { for (const s of glows) s.visible = !!high; },
    update() {},
  };
}

// четыре стенки слоя подставки (наружу), без верха и низа — в карьер подставка не заходит
function sideWalls(THREE, x0, y0, x1, y1, zt, zb, color) {
  const pos = [];
  const quad = (ax, ay, bx, by) => {   // наружная грань от (ax, ay) к (bx, by), обход — против часовой снаружи
    const A = [ax, zt, -ay], Bp = [bx, zt, -by], C = [bx, zb, -by], Dp = [ax, zb, -ay];
    pos.push(...A, ...Dp, ...C, ...A, ...C, ...Bp);
  };
  quad(x0, y0, x1, y0); quad(x1, y0, x1, y1); quad(x1, y1, x0, y1); quad(x0, y1, x0, y0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
}

// Карьер: кольца по отступу от борта (берма — светлая, стенка — темнее, на теневой стороне ещё темнее),
// дно с приглушёнными пятнами руды у забоев, съезды и площадки забоев — светлые
function buildPitMesh(THREE, dio, colors) {
  const { pit, D } = dio;
  const SEG = 320;
  const insets = [];
  for (let k = 0; k < pit.benches; k++) {
    const o = k * pit.inset;
    insets.push(o, o + pit.berm * 0.5, o + pit.berm, o + pit.berm + (pit.inset - pit.berm) * 0.5);
  }
  insets.push(pit.Ds);
  for (const f of [0.8, 0.6, 0.4, 0.22, 0.08]) insets.push(-f);   // дно: доли полуосей эллипса дна
  const ringPt = (ins, t) => {
    if (ins >= 0) return [pit.cx + (pit.a - ins) * Math.cos(t), pit.cy + (pit.b - ins) * Math.sin(t)];
    const f = -ins; return [pit.cx + (pit.a - pit.Ds) * f * Math.cos(t), pit.cy + (pit.b - pit.Ds) * f * Math.sin(t)];
  };
  const berm = new THREE.Color(0xe4d6b6), road = new THREE.Color(0xddd0b2), floor = new THREE.Color(0xb3a78f);
  const rust = new THREE.Color(0x9b6a47), grey = new THREE.Color(0x6f6862), tmp = new THREE.Color();
  const sun = [-0.85, -0.53];   // солнце с юго-запада (в плане)
  const ore = { sulphide: new THREE.Color(colors.sulphide), clay: new THREE.Color(colors.clay), waste: new THREE.Color(colors.waste) };
  const pos = [], col = [], idx = [];
  for (let r = 0; r < insets.length; r++) {
    const ins = insets[r];
    for (let i = 0; i < SEG; i++) {
      const t = i / SEG * Math.PI * 2;
      const [xs, ys] = ringPt(ins, t);
      const z = dio.surfaceAt(xs, ys);
      pos.push(xs, z, -ys);
      const prof = dio.benchProfile(Math.max(0, ins >= 0 ? ins : pit.Ds));
      const carved = Math.abs(z - prof) > 0.6;
      if (ins < 0 || ins >= pit.Ds) {
        tmp.copy(floor);
        for (const [id, o] of Object.entries(D.objects)) {
          if (!id.startsWith('face-') || !o.position) continue;
          const d = Math.hypot(xs - o.position[0], ys - o.position[1]);
          const c = ore[(dio.faceOre && dio.faceOre[id]) || 'sulphide'];
          if (d < 20 && c) tmp.lerp(c, 0.32 * (1 - d / 20));
        }
      } else if (carved) tmp.copy(road);
      else {
        const k = Math.floor(ins / pit.inset), u = ins - k * pit.inset;
        if (u < pit.berm - 0.01) tmp.copy(berm);
        else {
          const nx = -Math.cos(t) / pit.a, ny = -Math.sin(t) / pit.b, n = Math.hypot(nx, ny) || 1;
          const lit = Math.max(0, (nx / n) * sun[0] + (ny / n) * sun[1]);
          tmp.copy(rust).lerp(grey, k / Math.max(1, pit.benches - 1)).multiplyScalar(0.62 + 0.5 * lit);
        }
      }
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let r = 0; r < insets.length - 1; r++) {
    for (let i = 0; i < SEG; i++) {
      const a0 = r * SEG + i, a1 = r * SEG + (i + 1) % SEG, b0 = a0 + SEG, b1 = a1 + SEG;
      idx.push(a0, b0, a1, a1, b0, b1);
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

// Текстура степи: мягкие пятна трёх-четырёх тонов с гладкими краями и утрамбованные площадки у объектов
function steppeTexture(THREE, dio, colors, [x0, y0, x1, y1]) {
  const W = 1536, H = Math.round(W * (y1 - y0) / (x1 - x0));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const px = (x) => (x - x0) / (x1 - x0) * W, py = (y) => (1 - (y - y0) / (y1 - y0)) * H, pr = (r) => r / (x1 - x0) * W;
  g.fillStyle = '#d6c896'; g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const tones = ['rgba(201,184,128,', 'rgba(224,212,166,', 'rgba(190,176,122,', 'rgba(214,196,140,'];
  for (let i = 0; i < 70; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0), r = 25 + rnd() * 70;
    const gr = g.createRadialGradient(px(x), py(y), 0, px(x), py(y), pr(r));
    const t = tones[i % tones.length];
    gr.addColorStop(0, t + '0.55)'); gr.addColorStop(0.6, t + '0.35)'); gr.addColorStop(1, t + '0)');
    g.fillStyle = gr;
    g.save(); g.translate(px(x), py(y)); g.scale(1, 0.65 + rnd() * 0.5); g.translate(-px(x), -py(y));
    g.beginPath(); g.arc(px(x), py(y), pr(r), 0, Math.PI * 2); g.fill(); g.restore();
  }
  // утрамбованные площадки: светлый грунт с мягким краем
  const pad = (x, y, w, h, r) => {
    g.save(); g.shadowColor = 'rgba(200,186,150,0.9)'; g.shadowBlur = pr(5);
    g.fillStyle = '#ddd0b0';
    roundRect(g, px(x - w / 2), py(y + h / 2), pr(w), pr(h), pr(r)); g.fill(); g.restore();
  };
  const O = dio.D.objects;
  const at = (id) => O[id] && O[id].position;
  const plant = at('plant-sulphide');
  if (plant) pad(plant[0] - 2, plant[1] + 2, 104, 68, 6);
  const sp = at('stockpile-coarse'); if (sp) pad(sp[0], sp[1], 46, 42, 14);
  const cr = at('crusher-01'); if (cr) pad(cr[0], cr[1] - 6, 46, 34, 6);
  const fs = at('fuel-station'); if (fs) pad(fs[0], fs[1], 26, 20, 5);
  const pc = at('plant-clay'); if (pc) pad(pc[0], pc[1], 64, 44, 6);
  const sc = at('stockpile-clay'); if (sc) pad(sc[0], sc[1], 40, 36, 12);
  const sub = at('power-grid'); if (sub) pad(sub[0], sub[1], 34, 26, 4);
  const dump = at('dump-waste-1');
  if (dump) {   // подошва отвала — серый грунт с мягким краем
    const gr = g.createRadialGradient(px(dump[0]), py(dump[1]), pr(30), px(dump[0]), py(dump[1]), pr(62));
    gr.addColorStop(0, 'rgba(176,170,160,0.9)'); gr.addColorStop(1, 'rgba(176,170,160,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(px(dump[0]), py(dump[1]), pr(62), 0, Math.PI * 2); g.fill();
  }
  // светлый пояс вокруг борта карьера
  const p = dio.pit;
  g.save(); g.strokeStyle = 'rgba(228,214,178,0.9)'; g.lineWidth = pr(9); g.shadowColor = 'rgba(228,214,178,0.8)'; g.shadowBlur = pr(4);
  g.beginPath(); g.ellipse(px(p.cx), py(p.cy), pr(p.a + 3), pr(p.b + 3), 0, 0, Math.PI * 2); g.stroke(); g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

function rocks(THREE, dio, [x0, y0, x1, y1]) {
  const { pit, D } = dio;
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const segDist = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
  };
  const busy = Object.values(D.objects).filter((o) => o.position && (o.scale || 1) < 1 || false).map((o) => o.position);
  const keep = (x, y) => {
    const e = ((x - pit.cx) / (pit.a + 4)) ** 2 + ((y - pit.cy) / (pit.b + 4)) ** 2;
    if (e < 1) return false;                                                   // не в карьере
    for (const ed of dio.edges) if (segDist(x, y, ed.sa, ed.sb) < 10) return false;   // не на дорогах
    for (const p of busy) if (Math.hypot(x - p[0], y - p[1]) < 40) return false;      // не на площадках
    const tl = D.extra && D.extra.tailings;
    if (tl && ((x - tl.center[0]) / (tl.radii[0] + 12)) ** 2 + ((y - tl.center[1]) / (tl.radii[1] + 12)) ** 2 < 1) return false;
    return true;
  };
  const pts = [];
  for (let i = 0; i < 4000 && pts.length < 320; i++) {
    let x, y;
    if (i % 3 === 0) {   // треть — у борта карьера
      const t = rnd() * Math.PI * 2, r = 1.06 + rnd() * 0.18;
      x = pit.cx + pit.a * r * Math.cos(t); y = pit.cy + pit.b * r * Math.sin(t);
    } else { x = x0 + 6 + rnd() * (x1 - x0 - 12); y = y0 + 6 + rnd() * (y1 - y0 - 12); }
    if (keep(x, y)) pts.push([x, y, 0.5 + rnd() * rnd() * 2.6, rnd() * Math.PI]);
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

// мягкая тень под макетом (радиальный градиент)
function softShadowTexture(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 20, 64, 64, 64);
  gr.addColorStop(0, 'rgba(40,46,54,0.42)'); gr.addColorStop(0.7, 'rgba(40,46,54,0.18)'); gr.addColorStop(1, 'rgba(40,46,54,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ограждение: тонкие светлые столбики и полупрозрачная сетка между ними
function fence(THREE, S, corners) {
  const grp = new THREE.Group(); grp.name = 'fence';
  const postMat = new THREE.MeshLambertMaterial({ color: 0xd9dde0 });
  const netMat = new THREE.MeshBasicMaterial({ color: 0xc9ced2, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const H = 2.2, STEP = 6;
  const posts = [], net = [];
  for (let s = 0; s < corners.length; s++) {
    const [ax, ay] = corners[s], [bx, by] = corners[(s + 1) % corners.length];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
    for (let i = 0; i < n; i++) {
      const x = ax + (bx - ax) * i / n, y = ay + (by - ay) * i / n;
      posts.push([x, y]);
    }
    const A = S(ax, ay, 0), Bv = S(bx, by, 0);
    net.push(A.x, 0.15, A.z, Bv.x, 0.15, Bv.z, Bv.x, H, Bv.z, A.x, 0.15, A.z, Bv.x, H, Bv.z, A.x, H, A.z);
  }
  const pg = new THREE.CylinderGeometry(0.12, 0.12, H, 5); pg.translate(0, H / 2, 0);
  const inst = new THREE.InstancedMesh(pg, postMat, posts.length);
  const m = new THREE.Matrix4();
  posts.forEach(([x, y], i) => { const p = S(x, y, 0); m.makeTranslation(p.x, p.y, p.z); inst.setMatrixAt(i, m); });
  const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(net, 3));
  grp.add(inst, new THREE.Mesh(ng, netMat));
  return grp;
}
