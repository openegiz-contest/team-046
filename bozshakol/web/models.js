// Библиотека 3D-моделей техники и сооружений рудника Бозшаколь, версия 2 (three.js 0.160).
// Стиль — «игрушечно-премиальный»: низкополигональные формы с фасками, светлые чистые цвета,
// плоская заливка граней. Всё собирается из простых фигур в коде: без внешних файлов, текстур и картинок.
// Размеры — РЕАЛЬНЫЕ (метры), ось «вперёд» = +Z, низ модели на y = 0 (ставится на землю).
// Вертикальное преувеличение рельефа (VZ) к моделям не применяется — его учитывает только ctx.toScene.
//
// Подключение (один раз, например в app.js или в слое):
//   import { createModels, MODEL_SIZES } from './models.js';
//   const models = createModels(THREE, colors);   // colors — палитра сцены (ctx.colors)
//
// Использование в слое участника:
//   const g = ctx.models.truck({ cls: 135 }); ctx.group.add(g); ...
//   в update: g.position.copy(ctx.toScene(x, y, z)); g.rotation.y = Math.PI - heading*Math.PI/180;  (север сцены = −Z)
//             g.setLoad(cargo_type); g.setDumping(state === 'dumping' ? 1 : 0); g.setWheels(odometer_m);
//
// Каждая фабрика возвращает THREE.Group; методы висят и на самой группе, и в group.userData.api;
// group.userData.size — габариты (для самосвала и др. — запись из MODEL_SIZES), group.userData.parts — узлы.
// Общие методы всех моделей:
//   setDetail('full' | 'far') — в 'far' прячутся мелочи (перила, лестницы, фары, протектор, зубья ковша,
//                               решётка мачты, гидроцилиндры), силуэт остаётся;
//   setState(state)           — маленький маячок-индикатор: зелёный (работает), жёлтый (очередь, простой,
//                               заправка), красный (авария); 'down'/'failed' — ещё и корпус красный;
//                               'reserve' (самосвал в резерве) — корпус и кузов серо-белые, маячок погашен.
//
// Фабрики:
//   models.truck({ cls: 135 | 180 })      карьерный самосвал (Cat 793 / 795): setDumping(t 0..1),
//                                         setLoad('sulphide'|'clay'|'waste'|'none'), setState, setWheels(путь, м);
//                                         фары светятся, пока растёт пройденный путь (самосвал едет)
//   models.excavator()                    экскаватор — обратная лопата (класс Hitachi EX3600):
//                                         setSwing(рад, + против часовой), setBoom(t 0..1: копает → выгрузка), setState
//   models.drill()                        буровой станок: setMast(true — мачта вертикально / false — уложена), setState
//   models.crusher()                      гирационная дробилка: setState('running'|'idle'|'stopped' и др.)
//   models.conveyor(points, opts)         конвейер по ломаной (точки уже в сцене) на A-образных опорах, с роликоопорами:
//                                         setFlow(tph, dt) — при потоке виден слой руды и бегут кучки (шаг ~3 м при 2500 т/ч)
//                                         opts: { height: 3 (высота ленты над точками), step: 25 (шаг опор) }
//   models.building(type, opts)           'main'|'thickener'|'warehouse'|'substation'|'office'; opts.size = [д, ш, в]
//   models.stockpile(volume_m3, opts)     штабель (откос 37°) с глыбами: setVolume(v); opts.color
//   models.dump(radius, height, opts)     отвал — ступенчатые ярусы с плоскими площадками; opts.tiers (по умолчанию 3)
//   models.lightMast(h)                   решётчатая осветительная мачта: площадка с перилами и рама 2×4 прожектора (+Z)
//   models.powerLine(points, opts)        ЛЭП по точкам сцены: опоры + провода с провисом; opts.height (20)
//   models.fence(points, opts)            ограждение по точкам сцены: столбики + проволока; opts.step, opts.height
//   models.fuelStation()                  топливозаправочный пункт: резервуары, навес, колонки, будка
//
// Производительность: неподвижные детали модели склеиваются в общую геометрию (цвета — в вершинах),
// геометрия одной модели одна на все экземпляры, материалы общие. Вызовов отрисовки на модель:
// самосвал 10 (вдали 7), экскаватор 9 (вдали 7), буровой 6 (вдали 5); точные треугольники — в отчёте.

// Габариты моделей (метры) — для подписей, хитбоксов и расстановки
export const MODEL_SIZES = {
  truck135: { length: 13, width: 7.5, height: 6.5, wheel: 3.8 },
  truck180: { length: 15, width: 8, height: 7, wheel: 4.0 },
  excavator: { length: 12, width: 7, height: 7, boom: 10, stick: 5, reach: 16, bucket_m3: 22 },
  drill: { length: 11, width: 5, height: 4.5, mast: 20 },
  crusher: { length: 25, width: 25, height: 20, total_length: 42, total_height: 28 },
  building: {
    main: [120, 60, 24], thickener: [30, 30, 6], warehouse: [60, 30, 23], substation: [60, 40, 12], office: [20, 12, 8],
  },
  conveyor: { belt_width: 1.6, support_step: 25, speed_mps: 2.5 },
  lightMast: { height: 30 },
  powerLine: { height: 20 },
};

const DEG = Math.PI / 180;
const REPOSE = 37 * DEG;              // угол естественного откоса штабеля

export function createModels(THREE, colors) {
  colors = colors || {};
  const UP = new THREE.Vector3(0, 1, 0);
  const IDENT = new THREE.Matrix4();
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _n = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _nm = new THREE.Matrix3();
  const _m = new THREE.Matrix4();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ---------------------------------------------------------------- палитра моделей
  const C = {
    sulphide: colors.sulphide ?? 0x3d8f6e, clay: colors.clay ?? 0xc8722a, waste: colors.waste ?? 0x8a8a8a,
    down: colors.down ?? 0xd32f2f,
    truck: 0xf5bd26, reserve: 0xdde0e3, paintDown: 0xd8463a,        // жёлтый корпус Cat; резерв; авария
    cab: 0xf8f7f2, glass: 0x2d4a66, tyre: 0x2a2b2e, rim: 0xe4e5e2, hub: 0x9ca1a7,
    dark: 0x3b3f45, black: 0x24262a, rail: 0xf0f0ec, steel: 0x6c737b, chrome: 0xdde2e6,
    lamp: 0xfff2bd, lampOff: 0xd8d2bb, tail: 0xc8352b,
    exc: 0xef7d1e, excDark: 0xb95c16, track: 0x3a3c41, grouser: 0x28292c, roller: 0x8d9298,
    bucket: 0x50555b, bucketSide: 0x666b72, teeth: 0x34373b,
    drill: colors.drill ?? 0x4f6d8f, mast: 0xc4ccd5, mastDark: 0x56606b,
    concrete: 0xc6c1b5, concreteDark: 0x9a958b, crusher: 0x7d8692, hopper: 0x737a83, gravel: 0xaea795,
    wall: colors.building ?? 0xd8d8d8, roof: colors.roof ?? 0xa9b8cc, conveyor: colors.conveyor ?? 0x6f7f95,
    belt: 0x2c2f33, ore: 0x6b7a5a, water: 0x6f97b3, waterLight: 0x8fb2c8, trafo: 0x7d8a97, porcelain: 0x8e5b3a,
    accent: 0x2f7fc1, safety: 0xf2c230, grating: 0x8a9097,
    dump: colors.dump ?? 0x9a9a9a, dumpDark: 0x868686, pile: 0x7d6f5c, pole: 0x8d949b, wire: 0x3a3a3a,
    green: 0x36d06e, amber: 0xffb526, red: 0xff3b30, beaconOff: 0x9aa0a6,
  };

  // ---------------------------------------------------------------- материалы (общие на все экземпляры)
  // Все меши — Lambert с плоской заливкой и цветом в вершинах; цвет материала умножается на цвет вершин,
  // поэтому «окрашенные» узлы (корпус, кузов) хранят в вершинах только оттенок, а цвет даёт материал.
  const matCache = new Map();
  function mat(color, opts) {
    const k = color + '|' + (opts ? JSON.stringify(opts) : '');
    let m = matCache.get(k);
    if (!m) {
      m = new THREE.MeshLambertMaterial(Object.assign({ color, vertexColors: true, flatShading: true }, opts || {}));
      matCache.set(k, m);
    }
    return m;
  }
  const glow = (color, k) => mat(color, { emissive: color, emissiveIntensity: k ?? 1 });
  const VC = () => mat(0xffffff);
  const lineMats = {};
  const lineMat = (c) => lineMats[c] || (lineMats[c] = new THREE.LineBasicMaterial({ color: c }));
  const BEACON = {
    green: glow(C.green, 1.0), amber: glow(C.amber, 1.0), red: glow(C.red, 1.1), off: mat(C.beaconOff),
  };

  // ---------------------------------------------------------------- цвета вершин
  const colCache = new Map();
  function col(hex) {
    let c = colCache.get(hex);
    if (!c) { const t = new THREE.Color(hex); c = [t.r, t.g, t.b]; colCache.set(hex, c); }
    return c;
  }
  const sh = (k) => [k, k, k];                                     // оттенок для окрашиваемых узлов
  const mix = (hex, k) => { const c = col(hex); return [c[0] * k, c[1] * k, c[2] * k]; };
  function rng(seed) {                                             // детерминированный генератор (одинаково у всех)
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0; let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- склейка деталей в одну геометрию
  // Parts.add(геометрия, цвет, матрица[, разброс оттенка, генератор]) → build() — одна BufferGeometry
  class Parts {
    constructor() { this.p = []; this.n = []; this.c = []; }
    add(geo, color, m, jitter, rnd) {
      const c = typeof color === 'number' ? col(color) : color;
      const P = geo.attributes.position.array, N = geo.attributes.normal ? geo.attributes.normal.array : null;
      const M = m || IDENT;
      _nm.getNormalMatrix(M);
      const flip = M.determinant() < 0;
      const cnt = P.length / 3;
      for (let t = 0; t + 2 < cnt; t += 3) {
        const k = jitter ? 1 + (rnd() - 0.5) * jitter : 1;
        for (let j = 0; j < 3; j++) {
          const i = t + (flip ? (j === 0 ? 0 : 3 - j) : j);
          _v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(M);
          this.p.push(_v.x, _v.y, _v.z);
          if (N) _n.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]).applyMatrix3(_nm).normalize(); else _n.set(0, 1, 0);
          this.n.push(_n.x, _n.y, _n.z);
          this.c.push(c[0] * k, c[1] * k, c[2] * k);
        }
      }
      return this;
    }
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
  }

  // матрица: сдвиг, поворот (Эйлер XYZ, радианы), масштаб
  function T(x, y, z, rx, ry, rz, sx, sy, sz) {
    return new THREE.Matrix4().compose(_v2.set(x || 0, y || 0, z || 0),
      _q.setFromEuler(_e.set(rx || 0, ry || 0, rz || 0)), _s.set(sx ?? 1, sy ?? 1, sz ?? 1));
  }
  // матрица: наклон tilt вокруг X, затем курс yaw вокруг Y (для прожекторов и т.п.)
  function TY(x, y, z, yaw, tilt) {
    return new THREE.Matrix4().compose(_v2.set(x, y, z), _q.setFromEuler(_e.set(tilt || 0, yaw || 0, 0, 'YXZ')), _s.set(1, 1, 1));
  }
  // матрица «балки»: геометрия единичной высоты по Y (центр в 0) ставится между точками a и b
  function BM(a, b, sx, sz) {
    const d = _v3.subVectors(b, a); const len = d.length() || 1e-3;
    return new THREE.Matrix4().compose(_v2.addVectors(a, b).multiplyScalar(0.5),
      _q.setFromUnitVectors(UP, d.multiplyScalar(1 / len)), _s.set(sx ?? 1, len, sz ?? 1));
  }
  const mul = (A, Bm) => new THREE.Matrix4().multiplyMatrices(A, Bm);

  // ---------------------------------------------------------------- примитивы (кэшируются по параметрам)
  const geoCache = new Map();
  function cached(key, fn) { let g = geoCache.get(key); if (g === undefined) { g = fn(); geoCache.set(key, g); } return g; }
  const ni = (g) => { const r = g.index ? g.toNonIndexed() : g; r.deleteAttribute('uv'); return r; };

  // выпуклое тело из многоугольников (порядок обхода выправляется наружу от центра)
  function convex(polys, center) {
    const c0 = center || [0, 0, 0]; const pos = [], nor = [];
    for (const poly of polys) {
      let cx = 0, cy = 0, cz = 0;
      for (const p of poly) { cx += p[0]; cy += p[1]; cz += p[2]; }
      cx = cx / poly.length - c0[0]; cy = cy / poly.length - c0[1]; cz = cz / poly.length - c0[2];
      for (let i = 1; i + 1 < poly.length; i++) {
        const a = poly[0]; let b = poly[i], c = poly[i + 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz); if (l < 1e-9) continue;
        if (nx * cx + ny * cy + nz * cz < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        for (let k = 0; k < 3; k++) nor.push(nx / l, ny / l, nz / l);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  }
  // простая коробка (центр в 0)
  const box = (w, h, d) => cached(`b${w}|${h}|${d}`, () => ni(new THREE.BoxGeometry(w, h, d)));
  // коробка с фасками по всем рёбрам: 44 треугольника; b — ширина фаски
  function rbox(w, h, d, b) {
    b = Math.min(b ?? 0.1, w * 0.45, h * 0.45, d * 0.45);
    if (!(b > 0.004)) return box(w, h, d);
    return cached(`r${w}|${h}|${d}|${b}`, () => {
      const hx = w / 2, hy = h / 2, hz = d / 2;
      const P = (sx, sy, sz, ax) => (ax === 0 ? [sx * hx, sy * (hy - b), sz * (hz - b)]
        : ax === 1 ? [sx * (hx - b), sy * hy, sz * (hz - b)] : [sx * (hx - b), sy * (hy - b), sz * hz]);
      const S = [-1, 1], polys = [];
      for (const s of S) {
        polys.push([P(s, -1, -1, 0), P(s, 1, -1, 0), P(s, 1, 1, 0), P(s, -1, 1, 0)]);
        polys.push([P(-1, s, -1, 1), P(1, s, -1, 1), P(1, s, 1, 1), P(-1, s, 1, 1)]);
        polys.push([P(-1, -1, s, 2), P(1, -1, s, 2), P(1, 1, s, 2), P(-1, 1, s, 2)]);
      }
      for (const a of S) for (const c of S) {
        polys.push([P(a, c, -1, 0), P(a, c, 1, 0), P(a, c, 1, 1), P(a, c, -1, 1)]);
        polys.push([P(-1, a, c, 1), P(1, a, c, 1), P(1, a, c, 2), P(-1, a, c, 2)]);
        polys.push([P(a, -1, c, 0), P(a, 1, c, 0), P(a, 1, c, 2), P(a, -1, c, 2)]);
      }
      for (const sx of S) for (const sy of S) for (const sz of S) polys.push([P(sx, sy, sz, 0), P(sx, sy, sz, 1), P(sx, sy, sz, 2)]);
      return convex(polys);
    });
  }
  // усечённая «пирамида»: низ w0×d0, верх w1×d1 (смещён на dx, dz), высота h, центр по высоте в 0
  function taper(w0, d0, w1, d1, h, dx, dz) {
    dx = dx || 0; dz = dz || 0;
    return cached(`t${w0}|${d0}|${w1}|${d1}|${h}|${dx}|${dz}`, () => {
      const y0 = -h / 2, y1 = h / 2;
      const bo = [[-w0 / 2, y0, -d0 / 2], [w0 / 2, y0, -d0 / 2], [w0 / 2, y0, d0 / 2], [-w0 / 2, y0, d0 / 2]];
      const to = [[dx - w1 / 2, y1, dz - d1 / 2], [dx + w1 / 2, y1, dz - d1 / 2], [dx + w1 / 2, y1, dz + d1 / 2], [dx - w1 / 2, y1, dz + d1 / 2]];
      const polys = [bo, to];
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; polys.push([bo[i], bo[j], to[j], to[i]]); }
      return convex(polys, [dx / 2, 0, dz / 2]);
    });
  }
  const cyl = (rt, rb, h, seg, open) => cached(`c${rt}|${rb}|${h}|${seg}|${open ? 1 : 0}`,
    () => ni(new THREE.CylinderGeometry(rt, rb, h, seg || 8, 1, !!open)));
  // тело вращения вокруг Y; профиль [[r, y], ...] против часовой стрелки (r — вправо, y — вверх) → грани наружу
  const lathe = (pts, seg) => cached('l' + JSON.stringify(pts) + '|' + seg,
    () => ni(new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg)));
  const ico = (r) => cached('i' + r, () => ni(new THREE.IcosahedronGeometry(r, 0)));
  const dod = (r) => cached('d' + r, () => ni(new THREE.DodecahedronGeometry(r, 0)));
  // профиль [[z, y], ...], вытянутый по X на ширину w (центр по X), фаска b по контуру
  function prism(pts, w, b) {
    b = b || 0;
    return cached('p' + JSON.stringify(pts) + '|' + w + '|' + b, () => {
      const shape = new THREE.Shape();
      pts.forEach(([z, y], i) => (i ? shape.lineTo(z, y) : shape.moveTo(z, y)));
      const depth = Math.max(0.01, w - 2 * b);
      const g = new THREE.ExtrudeGeometry(shape, b > 0
        ? { depth, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments: 4 }
        : { depth, bevelEnabled: false, curveSegments: 4 });
      g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, depth / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
      return ni(g);
    });
  }
  // кабина со стёклами: низ белый, стеклянный пояс, крыша с козырьком, стойки по углам
  function cabin(P, cx, y0, cz, w, h, d) {
    const h1 = h * 0.4, h2 = h * 0.46, h3 = h * 0.14;
    P.add(rbox(w, h1, d, 0.08), C.cab, T(cx, y0 + h1 / 2, cz));
    P.add(rbox(w - 0.1, h2, d - 0.1, 0.04), C.glass, T(cx, y0 + h1 + h2 / 2, cz));
    P.add(rbox(w + 0.12, h3, d + 0.18, 0.06), C.cab, T(cx, y0 + h1 + h2 + h3 / 2, cz));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.add(box(0.14, h2, 0.14), C.cab, T(cx + sx * (w / 2 - 0.05), y0 + h1 + h2 / 2, cz + sz * (d / 2 - 0.05)));
    for (const sx of [-1, 1]) P.add(box(0.12, h2, 0.12), C.cab, T(cx + sx * (w / 2 - 0.03), y0 + h1 + h2 / 2, cz - d * 0.1));
  }
  const beaconGeo = (s) => lathe([[0, 0], [0.26 * s, 0], [0.26 * s, 0.13 * s], [0.19 * s, 0.28 * s], [0, 0.33 * s]], 8);
  // гусеница: «стадион» сбоку (длина l, высота h, ширина w)
  function trackProfile(l, h) {
    const rr = h / 2, zc = l / 2 - rr, pr = [];
    for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + i * Math.PI / 4; pr.push([+(zc + rr * Math.cos(a)).toFixed(3), +(rr + rr * Math.sin(a)).toFixed(3)]); }
    for (let i = 0; i <= 4; i++) { const a = Math.PI / 2 + i * Math.PI / 4; pr.push([+(-zc + rr * Math.cos(a)).toFixed(3), +(rr + rr * Math.sin(a)).toFixed(3)]); }
    return pr;
  }
  // гусеничная тележка в P (вблизи — с катками и грунтозацепами, если ribs)
  function crawler(P, x, l, h, w, ribs) {
    const rr = h / 2, zc = l / 2 - rr, s = Math.sign(x) || 1;
    P.add(prism(trackProfile(l, h), w, 0.07), C.track, T(x, 0, 0));
    P.add(rbox(0.14, h * 0.42, l - h - 0.3, 0.04), 0x575b61, T(x + s * (w / 2 + 0.02), rr + 0.05, 0));       // рама гусеницы
    for (const z of [zc, -zc]) P.add(cyl(rr * 0.72, rr * 0.72, 0.2, 12), 0x6c7177, T(x + s * (w / 2 + 0.05), rr, z, 0, 0, Math.PI / 2));
    if (!ribs) return;
    const nr = Math.max(3, Math.round(l / 1.7));
    for (let k = 0; k < nr; k++) P.add(cyl(rr * 0.27, rr * 0.27, 0.16, 8), C.roller, T(x + s * (w / 2 + 0.1), rr * 0.48, -zc + 0.8 + k * (2 * zc - 1.6) / (nr - 1), 0, 0, Math.PI / 2));
    for (let z = -zc; z <= zc + 1e-6; z += 0.5) P.add(box(w + 0.04, 0.11, 0.2), C.grouser, T(x, h + 0.03, z));
    for (const e of [-1, 1]) for (const a of [25, 55]) {
      const th = a * DEG;
      P.add(box(w + 0.04, 0.11, 0.2), C.grouser, T(x, rr + (rr + 0.03) * Math.sin(th), e * (zc + (rr + 0.03) * Math.cos(th)), Math.atan2(e * Math.cos(th), Math.sin(th)), 0, 0));
    }
  }

  // ---------------------------------------------------------------- меши, детализация, состояние
  function mk(parent, geo, material, opt) {
    const m = new THREE.Mesh(geo, material);
    if (opt) {
      if (opt.detail) m.userData.detail = true;
      if (opt.far) { m.userData.nearGeo = geo; m.userData.farGeo = opt.far; }
    }
    parent.add(m);
    return m;
  }
  function applyDetail(group, level) {
    const far = level === 'far';
    group.userData.far = far;
    group.traverse((o) => {
      if (o.userData.detail) o.visible = !far && !o.userData.hiddenByState;
      if (o.userData.farGeo) o.geometry = far ? o.userData.farGeo : o.userData.nearGeo;
    });
  }
  function stateKind(s) {
    if (/^(down|failed|stopped|stop|off|fault|broken|alarm)/.test(s)) return 'red';
    if (s === 'reserve' || s === '') return 'off';
    if (/^(queued|queue|idle|wait|refuel|maint|spot|standby|park|blocked)/.test(s)) return 'amber';
    return 'green';
  }
  function applyState(group, state) {
    const s = String(state ?? '');
    if (group.userData.stateNow === s) return;
    group.userData.stateNow = s;
    const down = s === 'down' || s === 'failed';
    const reserve = s === 'reserve';
    for (const sw of group.userData.swaps || []) sw.mesh.material = down ? sw.down : (reserve && sw.reserve ? sw.reserve : sw.normal);
    const b = group.userData.beacon;
    if (b) b.material = BEACON[stateKind(s)];
  }
  function finish(group, api, size) {
    if (!api.setDetail) {
      api.setDetail = function (level) {
        level = level === 'far' ? 'far' : 'full';
        if (group.userData.detailLevel === level) return;
        group.userData.detailLevel = level;
        applyDetail(group, level);
      };
    }
    if (!api.setState) api.setState = function (state) { applyState(group, state); };
    group.userData.api = api;
    group.userData.size = size;
    Object.assign(group, api);
    return group;
  }
  // запомнить меш для перекраски корпуса (авария — красный, резерв — серо-белый)
  function swap(group, mesh, normal, down, reserve) {
    (group.userData.swaps = group.userData.swaps || []).push({ mesh, normal, down, reserve });
    return mesh;
  }

  // ================================================================ САМОСВАЛ (Cat 793 / 795)
  // колесо: шина с шахматным протектором и грунтозацепами «ёлочкой», диск с гайками, ступица (вдали — только шина и диск)
  function tyreGeo(R, TW, seg, tread) {
    return cached(`tyre${R}|${TW}|${seg}|${tread ? 1 : 0}`, () => {
      const ri = R * 0.58, rs = R * 0.92, ch = TW * 0.16;
      const pts = tread
        ? [[ri, -TW / 2], [rs, -TW / 2], [R, -TW / 2 + ch], [R, 0], [R, TW / 2 - ch], [rs, TW / 2], [ri, TW / 2]]
        : [[ri, -TW / 2], [R * 0.96, -TW / 2], [R, -TW / 2 + ch], [R, TW / 2 - ch], [R * 0.96, TW / 2], [ri, TW / 2]];
      const g = ni(new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg));
      if (tread) {
        const p = g.attributes.position, k = (R - 0.1) / R, step = 2 * Math.PI / seg;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          if (Math.hypot(x, z) < R * 0.99 || Math.abs(y) < ch) continue;
          const idx = ((Math.round(Math.atan2(x, z) / step) % seg) + seg) % seg;
          if ((y < 0) === (idx % 2 === 0)) p.setXYZ(i, x * k, y, z * k);
        }
        g.computeVertexNormals();
      }
      return g;
    });
  }
  function wheelSet(R, TW, list, far) {
    const P = new Parts();
    const ri = R * 0.58;
    const tyre = tyreGeo(R, TW, far ? 8 : 18, !far);
    // диск: кольцо (середина закрыта ступицей), без вырожденных треугольников у оси
    const rim = far
      ? lathe([[ri, TW / 2 - 0.2], [ri, TW / 2 - 0.04], [0.01, TW / 2 + 0.02]], 8)
      : lathe([[ri + 0.02, TW / 2 - 0.25], [ri + 0.02, TW / 2 - 0.08], [ri * 0.74, TW / 2 - 0.02], [ri * 0.3, TW / 2 + 0.05]], 12);
    const hub = lathe([[ri * 0.32, TW / 2], [ri * 0.32, TW / 2 + 0.15], [0.01, TW / 2 + 0.18]], 8);
    // гайки ступицы и грунтозацепы протектора «ёлочкой» (рёбра на беговой дорожке, через одно — к разным бортам)
    const nut = box(0.14, 0.14, 0.1), lug = taper(TW * 0.42, 0.34, TW * 0.36, 0.22, 0.14);
    const NL = 16;
    for (const [x, s, withRim] of list) {
      const m = T(x, 0, 0, 0, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2);    // ось колеса — X, диск наружу
      P.add(tyre, C.tyre, m);
      if (withRim) { P.add(rim, C.rim, m); if (!far) P.add(hub, C.hub, m); }
      if (far) continue;
      if (withRim) for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3, r = ri * 0.46;
        P.add(nut, C.dark, T(x + s * (TW / 2 + 0.03), Math.sin(a) * r, Math.cos(a) * r));
      }
      for (let k = 0; k < NL; k++) {
        const a = (k + 0.5) / NL * Math.PI * 2, side = k % 2 ? 1 : -1;
        // грунтозацеп: касательно к шине, сдвинут к одному борту и чуть повёрнут (ёлочка)
        const lm = new THREE.Matrix4().makeRotationX(-a);
        lm.multiply(T(x + side * TW * 0.15, R - 0.035, 0, 0, side * 0.35, 0));
        P.add(lug, 0x1f2023, lm);
      }
    }
    return P.build();
  }
  // «шапка» груза: неровный холм из граней + несколько глыб
  function moundGeo(x0, x1, z0, z1, yb, yp, seed) {
    const rnd = rng(seed), nx = 6, nz = 7, grid = [];
    for (let i = 0; i < nx; i++) {
      grid.push([]);
      for (let j = 0; j < nz; j++) {
        const u = i / (nx - 1) * 2 - 1, v = j / (nz - 1) * 2 - 1;
        const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
        const f = Math.max(0, 1 - u * u) * Math.pow(Math.max(0, 1 - v * v), 0.7);
        const y = edge ? yb - 0.15 : yb + (yp - yb) * (0.2 + 0.8 * Math.pow(f, 0.8)) + (rnd() - 0.5) * 0.35;
        grid[i].push([x0 + (x1 - x0) * (i / (nx - 1)), y, z0 + (z1 - z0) * (j / (nz - 1))]);
      }
    }
    const pos = [];
    for (let i = 0; i + 1 < nx; i++) for (let j = 0; j + 1 < nz; j++) {
      const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
      if ((i + j) % 2) pos.push(...a, ...d, ...b, ...b, ...d, ...c); else pos.push(...a, ...d, ...c, ...a, ...c, ...b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const P = new Parts();
    P.add(g, sh(1), IDENT, 0.22, rnd);
    const zc = (z0 + z1) / 2, xc = (x0 + x1) / 2;
    for (const [dx, dz, r] of [[-0.9, -1.2, 0.45], [0.8, 0.6, 0.4], [-0.2, 1.6, 0.35], [0.3, -0.3, 0.5]]) {
      P.add(ico(r), sh(0.9), T(xc + dx, yp - 0.15 - Math.abs(dz) * 0.12, zc + dz, rnd() * 3, rnd() * 3, 0), 0.3, rnd);
    }
    return P.build();
  }
  function truckGeos(cls) {
    return cached('truck' + cls, () => {
      const S = cls === 180 ? MODEL_SIZES.truck180 : MODEL_SIZES.truck135;
      const L = S.length, W = S.width, H = S.height, R = S.wheel / 2, TW = R * 0.6;
      const zF = L * 0.3, zR = -L * 0.27, xo = W / 2 - TW / 2, xi = xo - TW - 0.12;
      const deckY = 2 * R + 0.12, deckTop = deckY + 0.15, radH = deckY - 1.0;
      const body = new Parts(), neu = new Parts(), det = new Parts(), lit = new Parts(), bed = new Parts();
      const s1 = sh(1), s2 = sh(0.84), s3 = sh(0.7);
      // --- корпус (жёлтый): рама, передок, палуба, капот, баки
      for (const x of [-0.95, 0.95]) body.add(rbox(0.7, 1.0, L * 0.8, 0.12), s3, T(x, R + 0.2, -0.3));
      body.add(rbox(W * 0.42, 1.2, 1.6, 0.15), s3, T(0, R + 0.5, -L / 2 + 0.9));            // задняя поперечина
      body.add(rbox(W * 0.44, radH, 1.8, 0.15), s1, T(0, 1.0 + radH / 2, L / 2 - 1.1));      // кожух радиатора
      body.add(rbox(W * 0.64, 0.8, 0.8, 0.15), s2, T(0, 1.2, L / 2 - 0.35));                // бампер
      body.add(rbox(W, 0.3, L * 0.36, 0.08), s1, T(0, deckY, L * 0.32));                    // верхняя площадка
      body.add(rbox(W * 0.96, 0.9, 0.22, 0.06), s2, T(0, deckY - 0.55, L / 2 - 0.12));      // фартук площадки (фары)
      body.add(rbox(W * 0.3, 1.2, L * 0.22, 0.2), s1, T(-0.15, deckTop + 0.6, L * 0.3));    // капот двигателя
      body.add(rbox(W * 0.24, 1.5, 1.9, 0.15), s2, T(-W * 0.36, deckTop + 0.75, L * 0.37)); // воздушные фильтры справа
      body.add(rbox(1.0, 1.4, 2.8, 0.3), s1, T(W / 2 - 0.8, R + 0.5, 0.1));                 // топливный бак (слева)
      body.add(rbox(1.0, 1.6, 2.6, 0.3), s2, T(-(W / 2 - 0.8), R + 0.6, 0.1));              // гидробак (справа)
      // --- неокрашиваемое: мосты, кабина (белая, слева = +X), решётка радиатора
      neu.add(rbox(W - 2 * TW - 0.3, 0.6, 0.8, 0.1), C.dark, T(0, R, zF));                  // передний мост
      neu.add(rbox(2.6, 1.1, 1.3, 0.15), C.dark, T(0, R, zR));                              // картер заднего моста
      neu.add(cyl(0.45, 0.45, 2 * xi - TW, 8), C.dark, T(0, R, zR, 0, 0, Math.PI / 2));    // рукава полуосей
      const cabW = W * 0.32, cabL = 2.3, cabH = H - 0.55 - deckTop, cx = W / 2 - cabW / 2 - 0.12, cz = L * 0.36;
      cabin(neu, cx, deckTop, cz, cabW, cabH, cabL);
      neu.add(box(W * 0.36, radH * 0.6, 0.08), C.black, T(0, 1.0 + radH * 0.45, L / 2 - 0.17));
      // --- мелочи (прячутся вдали): жалюзи, диагональная лестница, перила, зеркала, фильтры, задние фонари
      for (let i = 0; i < 5; i++) det.add(box(W * 0.34, 0.07, 0.06), C.steel, T(0, 1.0 + radH * (0.22 + i * 0.12), L / 2 - 0.12));
      const zs = L / 2 + 0.45, sa = V(-W * 0.36, 0.8, zs), sb = V(W * 0.06, deckY - 0.05, zs);
      det.add(box(0.12, 1, 0.75), C.dark, BM(sa, sb));                                      // марш лестницы
      for (let i = 1; i <= 5; i++) { const p = sa.clone().lerp(sb, i / 6); det.add(box(0.42, 0.06, 0.75), C.rail, T(p.x, p.y + 0.07, zs)); }
      det.add(box(0.07, 1, 0.07), C.rail, BM(V(sa.x, sa.y + 1.0, zs + 0.36), V(sb.x, sb.y + 1.0, zs + 0.36)));
      for (const f of [0, 0.5, 1]) { const p = sa.clone().lerp(sb, f); det.add(box(0.07, 1.0, 0.07), C.rail, T(p.x, p.y + 0.5, zs + 0.36)); }
      const rt = deckTop + 1.0, rz = L / 2 - 0.06;
      det.add(box(W - 0.2, 0.07, 0.07), C.rail, T(0, rt, rz));
      det.add(box(W - 0.2, 0.06, 0.06), C.rail, T(0, rt - 0.5, rz));
      for (const x of [-W / 2 + 0.1, -W * 0.2, W * 0.2, W / 2 - 0.1]) det.add(box(0.07, 1.0, 0.07), C.rail, T(x, deckTop + 0.5, rz));
      const rl = L * 0.35 - 0.06, rzc = L * 0.15 + rl / 2;
      for (const sx of [-1, 1]) {
        det.add(box(0.07, 0.07, rl), C.rail, T(sx * (W / 2 - 0.05), rt, rzc));
        det.add(box(0.06, 0.06, rl), C.rail, T(sx * (W / 2 - 0.05), rt - 0.5, rzc));
        for (const z of [L * 0.15, rzc]) det.add(box(0.07, 1.0, 0.07), C.rail, T(sx * (W / 2 - 0.05), deckTop + 0.5, z));
        det.add(box(0.08, 0.55, 0.35), C.dark, T(sx * (W / 2 + 0.35), deckTop + 1.45, L / 2 - 0.4));   // зеркала
        det.add(box(0.5, 0.06, 0.06), C.dark, T(sx * (W / 2 + 0.1), deckTop + 1.2, L / 2 - 0.4));
        det.add(box(0.32, 0.26, 0.1), C.tail, T(sx * W * 0.16, R + 0.8, -L / 2 + 0.06));          // задние фонари
      }
      for (const dx of [-0.42, 0.42]) det.add(cyl(0.22, 0.22, 0.5, 8), C.dark, T(-W * 0.36 + dx, deckTop + 1.75, L * 0.37));
      // --- фары (отдельный меш: горят, когда самосвал едет)
      for (const x of [-W * 0.4, -W * 0.3, W * 0.3, W * 0.4]) lit.add(box(0.42, 0.3, 0.12), s1,T(x, deckY - 0.55, L / 2 + 0.02));
      // --- кузов (в системе оси подъёма): пол с подъёмом к хвосту, борта с рёбрами, передняя стенка, козырёк
      const pivotY = R + 0.95, pivotZ = -L * 0.4;
      const yF = 2 * R + 0.35, yT = H - 1.05, zb = -L / 2 - 0.15, zf = L * 0.12, zc = L / 2 - 0.25;
      const PP = (z, y) => [+(z - pivotZ).toFixed(3), +(y - pivotY).toFixed(3)];
      const TP = (x, y, z, rx) => T(x, y - pivotY, z - pivotZ, rx);
      bed.add(prism([PP(zf, yF - 0.35), PP(zf, yF), PP(zb + 1.6, yF), PP(zb, yF + 0.9), PP(zb, yF + 0.55), PP(zb + 1.6, yF - 0.35)], W - 0.5, 0.06), sh(0.78));
      const side = prism([PP(zb + 1.6, yF - 0.35), PP(zf, yF - 0.35), PP(zf, yT), PP(zb, yT), PP(zb, yF + 0.55)], 0.26, 0.05);
      for (const sx of [-1, 1]) {
        bed.add(side, s1, T(sx * (W / 2 - 0.13), 0, 0));
        bed.add(rbox(0.42, 0.42, zf - zb, 0.1), s2, TP(sx * (W / 2 - 0.2), yT + 0.1, (zb + zf) / 2));             // верхний пояс борта
        for (let k = 1; k <= 4; k++) bed.add(rbox(0.24, yT - yF + 0.25, 0.34, 0.06), s2, TP(sx * (W / 2 + 0.05), (yT + yF - 0.35) / 2, zb + 1.6 + k * (zf - zb - 1.6) / 5));
        bed.add(rbox(0.3, 1.1, 0.4, 0.08), s2, TP(sx * (W / 2 + 0.06), yF + 0.8, zb + 0.6));                  // кормовое ребро
        bed.add(box(0.16, 0.24, zf - zb - 1.8), s2, TP(sx * (W / 2 + 0.02), yF + 0.3, (zf + zb + 1.6) / 2));     // горизонтальное ребро
        bed.add(box(0.5, 0.45, zf - zb - 1.8), s3, TP(sx * 1.0, yF - 0.55, (zf + zb + 1.6) / 2));                // продольные балки днища
        bed.add(box(0.6, 1.0, 1.0), s3, TP(sx * 1.0, pivotY + 0.35, pivotZ));                                   // проушины оси
        bed.add(prism([PP(zf, H - 0.44), PP(zf + 2.0, H - 0.44), PP(zf, H - 1.9)], 0.22, 0.03), s2, T(sx * (W / 2 - 0.11), 0, 0)); // косынки козырька
      }
      bed.add(rbox(W, H - 0.44 - (yF - 0.35), 0.4, 0.08), s2, TP(0, (yF - 0.35 + H - 0.44) / 2, zf));             // передняя стенка
      bed.add(rbox(W + 0.1, 0.44, zc - zf, 0.1), s1, TP(0, H - 0.22, (zf + zc) / 2));                             // козырёк над кабиной
      bed.add(rbox(W + 0.1, 0.55, 0.2, 0.05), s2, TP(0, H - 0.5, zc));
      const bc = new Parts().add(beaconGeo(1), sh(1), TP(W / 2 - 0.55, H - 0.02, zc - 0.55));
      // --- груз и гидроцилиндры подъёма
      const load = moundGeo(-(W / 2 - 0.45), W / 2 - 0.45, zb + 0.9 - pivotZ, zf - 0.35 - pivotZ, yT - 0.55 - pivotY, yT + 1.25 - pivotY, 135 + cls);
      const hoist = new Parts();
      for (const sx of [-1.25, 1.25]) {
        hoist.add(cyl(0.26, 0.26, 0.65, 8), C.dark, T(sx, -0.175, 0));
        hoist.add(cyl(0.15, 0.15, 0.36, 8), C.chrome, T(sx, 0.32, 0));
      }
      return {
        R, zF, zR, pivotY, pivotZ,
        body: body.build(), neutral: neu.build(), detail: det.build(), lights: lit.build(), bed: bed.build(), beacon: bc.build(),
        load, hoist: hoist.build(),
        hoistA: V(0, R + 0.35, zR + R + 0.5), hoistB: V(0, yF - 0.6 - pivotY, -0.3 - pivotZ),
        wheelF: wheelSet(R, TW, [[xo, 1, true], [-xo, -1, true]], false),
        wheelFfar: wheelSet(R, TW, [[xo, 1, true], [-xo, -1, true]], true),
        wheelR: wheelSet(R, TW, [[xo, 1, true], [-xo, -1, true], [xi, 1, false], [-xi, -1, false]], false),
        wheelRfar: wheelSet(R, TW, [[xo, 1, true], [-xo, -1, true], [xi, 1, false], [-xi, -1, false]], true),
      };
    });
  }

  function truck(opts) {
    const cls = (opts && opts.cls) === 180 ? 180 : 135;
    const S = cls === 180 ? MODEL_SIZES.truck180 : MODEL_SIZES.truck135;
    const G = truckGeos(cls);
    const g = new THREE.Group();
    const paint = mat(C.truck), paintDown = mat(C.paintDown), paintRes = mat(C.reserve);
    const body = swap(g, mk(g, G.body, paint), paint, paintDown, paintRes);
    const cab = mk(g, G.neutral, VC());
    mk(g, G.detail, VC(), { detail: true });
    const lampOff = mat(C.lampOff), lampOn = glow(C.lamp, 1.3);
    const lights = mk(g, G.lights, lampOff, { detail: true });
    const wF = mk(g, G.wheelF, VC(), { far: G.wheelFfar }); wF.position.set(0, G.R, G.zF);
    const wR = mk(g, G.wheelR, VC(), { far: G.wheelRfar }); wR.position.set(0, G.R, G.zR);
    const bedPivot = new THREE.Group(); bedPivot.position.set(0, G.pivotY, G.pivotZ); g.add(bedPivot);
    const bed = swap(g, mk(bedPivot, G.bed, paint), paint, paintDown, paintRes);
    const beacon = mk(bedPivot, G.beacon, BEACON.off); g.userData.beacon = beacon;   // маячок на козырьке
    const loadMats = { sulphide: mat(C.sulphide), clay: mat(C.clay), waste: mat(C.waste) };
    const load = mk(bedPivot, G.load, loadMats.waste); load.visible = false;
    const hoist = mk(g, G.hoist, VC(), { detail: true });
    hoist.userData.hiddenByState = true; hoist.visible = false;

    let dumpT = -1, lastDist = null, lastMove = -1e9, lastT = now(), wheelA = 0, lightsOn = false;
    const api = {
      setDumping(t) {
        t = Math.max(0, Math.min(1, +t || 0));
        if (t === dumpT) return;
        dumpT = t;
        bedPivot.rotation.x = -t * 45 * DEG;
        const hidden = t < 0.01;
        hoist.userData.hiddenByState = hidden;
        hoist.visible = !hidden && !g.userData.far;
        if (hidden) return;
        bedPivot.updateMatrix();
        _v.copy(G.hoistB).applyMatrix4(bedPivot.matrix);
        const d = _v3.subVectors(_v, G.hoistA); const len = d.length() || 0.01;
        hoist.position.addVectors(G.hoistA, _v).multiplyScalar(0.5);
        hoist.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / len));
        hoist.scale.set(1, len, 1);
      },
      setLoad(type) {
        const m = loadMats[type];
        load.visible = !!m;
        if (m) load.material = m;
      },
      // колёса поворачиваются на путь/радиус (плавно догоняют новое значение); фары горят, пока путь растёт
      setWheels(dist) {
        dist = +dist || 0;
        const t = now();
        if (lastDist === null) lastDist = dist;
        if (Math.abs(dist - lastDist) > 0.05) { lastMove = t; lastDist = dist; }
        const moving = t - lastMove < 2500;
        if (moving !== lightsOn) { lightsOn = moving; lights.material = moving ? lampOn : lampOff; }
        const target = dist / G.R, dt = Math.min(0.25, Math.max(0, (t - lastT) / 1000)); lastT = t;
        if (Math.abs(target - wheelA) > 60) wheelA = target; else wheelA += (target - wheelA) * (1 - Math.exp(-dt * 3));
        wF.rotation.x = wheelA; wR.rotation.x = wheelA;
      },
      get moving() { return lightsOn; },
    };
    g.userData.parts = { bedPivot, bed, body, cab, canopy: bed, load, wheels: [wF, wR], lights, beacon, hoist };
    return finish(g, api, S);
  }

  // ================================================================ ЭКСКАВАТОР (класс Hitachi EX3600, обратная лопата)
  function excavatorGeos() {
    return cached('excavator', () => {
      const under = new Parts(), underFar = new Parts();
      for (const x of [-2.85, 2.85]) { crawler(under, x, 9.6, 2.3, 1.4, true); crawler(underFar, x, 9.6, 2.3, 1.4, false); }
      for (const P of [under, underFar]) {
        P.add(rbox(3.4, 1.3, 4.6, 0.2), C.excDark, T(0, 1.45, 0));                          // центральная рама
        P.add(cyl(1.8, 1.8, 0.5, 14), C.dark, T(0, 2.75, 0));                               // опорно-поворотный круг
      }
      // поворотная платформа (оранжевая, перекрашивается при аварии)
      const house = new Parts(), hn = new Parts(), hd = new Parts();
      house.add(rbox(6.2, 2.7, 7.6, 0.25), sh(1), T(0, 1.35, -1.4));
      house.add(rbox(6.6, 2.3, 2.0, 0.6), sh(0.8), T(0, 1.2, -6.1));                        // противовес
      house.add(rbox(4.0, 0.7, 4.2, 0.2), sh(0.93), T(-0.9, 3.05, -2.6));                   // капот двигателя
      house.add(rbox(2.6, 1.8, 1.4, 0.2), sh(0.8), T(0, 1.5, 2.1));                         // пята стрелы
      house.add(rbox(2.4, 2.0, 1.6, 0.15), sh(0.86), T(2.2, 1.9, 3.2));                     // опора кабины
      house.add(rbox(2.5, 0.4, 2.9, 0.1), sh(0.9), T(2.2, 2.9, 2.6));                       // подиум кабины
      cabin(hn, 2.2, 3.1, 2.6, 2.3, 2.4, 2.8);
      for (const sx of [-1, 1]) hn.add(box(0.06, 1.0, 2.6), C.black, T(sx * 3.12, 1.5, -3.0));   // решётки радиаторов
      for (const z of [-3.4, -2.6]) hn.add(cyl(0.2, 0.2, 1.1, 8), C.dark, T(-2.0, 3.85, z));     // выхлопные трубы
      hn.add(box(6.62, 0.3, 0.2), C.black, T(0, 0.55, -7.1));
      hn.add(box(6.62, 0.3, 0.2), C.safety, T(0, 0.9, -7.1));                                   // полоса на противовесе
      // перила по краям платформы и зеркало (мелочи)
      const ry = 2.7 + 1.0;
      hd.add(box(0.06, 0.06, 6.0), C.rail, T(3.08, ry, -2.0)); hd.add(box(0.06, 0.06, 7.2), C.rail, T(-3.08, ry, -1.6));
      hd.add(box(6.2, 0.06, 0.06), C.rail, T(0, ry, -5.15));
      for (const z of [-5.0, -3.0, -1.0, 1.0]) hd.add(box(0.06, 1.0, 0.06), C.rail, T(3.08, ry - 0.5, z));
      for (const z of [-5.0, -3.0, -1.0, 1.0, 2.0]) hd.add(box(0.06, 1.0, 0.06), C.rail, T(-3.08, ry - 0.5, z));
      hd.add(box(0.06, 0.55, 0.4), C.dark, T(3.55, 4.7, 3.7)); hd.add(box(0.4, 0.05, 0.05), C.dark, T(3.35, 4.5, 3.7));
      const bc = new Parts().add(beaconGeo(1.1), sh(1), T(2.95, 5.5, 1.6));
      // стрела, рукоять (оранжевые), ковш с зубьями
      const boom = new Parts(), stick = new Parts();
      boom.add(prism([[-0.4, -0.9], [0, 0.9], [4.5, 1.9], [9.6, 0.9], [10.2, 0], [9.6, -0.7], [4.5, -0.3]], 1.8, 0.12), sh(1));
      boom.add(cyl(0.62, 0.62, 2.3, 10), sh(0.78), T(0, 0, 0, 0, 0, Math.PI / 2));
      boom.add(cyl(0.5, 0.5, 1.9, 10), sh(0.78), T(0, 0.1, 10.0, 0, 0, Math.PI / 2));
      for (const sx of [-1, 1]) boom.add(rbox(0.5, 0.7, 0.9, 0.08), sh(0.8), T(sx * 1.15, -0.45, 4.6));
      boom.add(rbox(0.7, 0.5, 0.9, 0.08), sh(0.8), T(0, 1.95, 3.6));
      stick.add(prism([[-1.0, -0.5], [-0.6, 0.9], [1.5, 1.2], [5.2, 0.4], [5.2, -0.5], [0, -0.9]], 1.4, 0.1), sh(1));
      stick.add(cyl(0.45, 0.45, 1.6, 10), sh(0.78), T(0, 0, 5.1, 0, 0, Math.PI / 2));
      stick.add(rbox(0.6, 0.5, 0.8, 0.08), sh(0.8), T(0, 1.15, 0.8));
      const bpts = [[-0.5, 0.2], [0.8, 0.35], [2.0, -2.4], [1.2, -2.75], [-0.3, -2.35], [-0.7, -1.0]];
      const bucket = new Parts(), bucketFar = new Parts();
      for (const P of [bucket, bucketFar]) {
        P.add(prism(bpts, 3.3, 0.1), C.bucket);
        P.add(box(3.1, 1, 0.06), C.black, BM(V(0, 0.35 + 0.4 * 0.04, 0.8 + 0.917 * 0.04), V(0, -2.4 + 0.4 * 0.04, 2.0 + 0.917 * 0.04)));   // «зев»
        P.add(rbox(0.6, 0.5, 1.0, 0.08), C.dark, T(0, 0.45, -0.25));                       // серьга
      }
      for (const sx of [-1, 1]) bucket.add(prism(bpts, 0.12, 0.02), C.bucketSide, T(sx * 1.71, 0, 0));
      const lip = V(0, -2.4, 2.0), tdir = V(0, -0.917, 0.4);
      for (let i = 0; i < 5; i++) {
        const a = lip.clone().setX(-1.3 + i * 0.65).addScaledVector(tdir, -0.1);
        bucket.add(taper(0.32, 0.3, 0.12, 0.1, 1), C.teeth, BM(a, a.clone().addScaledVector(tdir, 0.75)));
      }
      // гидроцилиндр единичной длины: корпус + шток (масштаб экземпляра — радиус и длина)
      const hyd = new Parts();
      hyd.add(cyl(1, 1, 0.62, 8), 0x3f4349, T(0, -0.19, 0));
      hyd.add(cyl(0.5, 0.5, 0.4, 8), C.chrome, T(0, 0.3, 0));
      return {
        under: under.build(), underFar: underFar.build(), house: house.build(), houseN: hn.build(), houseD: hd.build(), beacon: bc.build(),
        boom: boom.build(), stick: stick.build(), bucket: bucket.build(), bucketFar: bucketFar.build(), hyd: hyd.build(),
      };
    });
  }
  function excavator() {
    const S = MODEL_SIZES.excavator;
    const G = excavatorGeos();
    const g = new THREE.Group();
    const paint = mat(C.exc), paintDown = mat(C.paintDown);
    mk(g, G.under, VC(), { far: G.underFar });
    const swing = new THREE.Group(); swing.position.y = 3.1; g.add(swing);
    const house = swap(g, mk(swing, G.house, paint), paint, paintDown);
    const cab = mk(swing, G.houseN, VC());
    mk(swing, G.houseD, VC(), { detail: true });
    g.userData.beacon = mk(swing, G.beacon, BEACON.off);
    const boomPivot = new THREE.Group(); boomPivot.position.set(0, 2.2, 2.4); swing.add(boomPivot);
    swap(g, mk(boomPivot, G.boom, paint), paint, paintDown);
    const stickPivot = new THREE.Group(); stickPivot.position.set(0, 0.1, 10); boomPivot.add(stickPivot);
    swap(g, mk(stickPivot, G.stick, paint), paint, paintDown);
    const bucketPivot = new THREE.Group(); bucketPivot.position.set(0, 0, 5.1); stickPivot.add(bucketPivot);
    mk(bucketPivot, G.bucket, VC(), { far: G.bucketFar });
    // 4 гидроцилиндра одним вызовом отрисовки (экземпляры в системе платформы)
    const cyls = new THREE.InstancedMesh(G.hyd, VC(), 4);
    cyls.userData.detail = true; cyls.frustumCulled = false;
    cyls.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 6), 14);
    swing.add(cyls);
    const pA = new THREE.Vector3(), pB = new THREE.Vector3();
    const Ms = new THREE.Matrix4(), Mk = new THREE.Matrix4();
    function setCyl(i, a, b, r) {
      const d = _v3.subVectors(b, a); const len = d.length() || 0.01;
      _m.compose(_v2.addVectors(a, b).multiplyScalar(0.5), _q.setFromUnitVectors(UP, d.multiplyScalar(1 / len)), _s.set(r, len, r));
      cyls.setMatrixAt(i, _m);
    }
    let boomT = 0;
    function setBoom(t) {
      boomT = Math.max(0, Math.min(1, t || 0));
      const a = (22 + 30 * boomT) * DEG;             // стрела: 22° (копает) → 52° (выгрузка)
      const s = (-100 + 25 * boomT) * DEG;           // рукоять относительно стрелы
      const b = (-70 + 95 * boomT) * DEG;            // ковш относительно рукояти: подогнут → раскрыт
      boomPivot.rotation.x = -a;
      stickPivot.rotation.x = -s;
      bucketPivot.rotation.x = -b;
      boomPivot.updateMatrix(); stickPivot.updateMatrix(); bucketPivot.updateMatrix();
      const Mb = boomPivot.matrix;
      Ms.multiplyMatrices(Mb, stickPivot.matrix);
      Mk.multiplyMatrices(Ms, bucketPivot.matrix);
      // цилиндры стрелы: от платформы к середине стрелы
      setCyl(0, pA.set(1.4, 0.8, 3.4), pB.set(1.4, -0.5, 4.6).applyMatrix4(Mb), 0.28);
      setCyl(1, pA.set(-1.4, 0.8, 3.4), pB.set(-1.4, -0.5, 4.6).applyMatrix4(Mb), 0.28);
      // цилиндр рукояти: от верха стрелы к пятке рукояти
      setCyl(2, pA.set(0, 1.9, 3.6).applyMatrix4(Mb), pB.set(0, 1.0, -0.9).applyMatrix4(Ms), 0.26);
      // цилиндр ковша: вдоль рукояти к тяге ковша
      setCyl(3, pA.set(0, 1.1, 0.8).applyMatrix4(Ms), pB.set(0, 0.6, -0.4).applyMatrix4(Mk), 0.22);
      cyls.instanceMatrix.needsUpdate = true;
    }
    setBoom(0);
    const api = {
      setSwing(rad) { swing.rotation.y = rad || 0; },
      setBoom,
      get boomT() { return boomT; },
    };
    g.userData.parts = { swing, boomPivot, stickPivot, bucketPivot, house, cab, cylinders: cyls };
    return finish(g, api, S);
  }

  // ================================================================ БУРОВОЙ СТАНОК
  function drillGeos() {
    return cached('drill', () => {
      const MH = MODEL_SIZES.drill.mast, y0 = -2.6;
      const under = new Parts(), underFar = new Parts();
      for (const x of [-1.9, 1.9]) { crawler(under, x, 8.0, 1.5, 1.0, true); crawler(underFar, x, 8.0, 1.5, 1.0, false); }
      for (const P of [under, underFar]) P.add(rbox(2.8, 0.9, 6.0, 0.12), C.dark, T(0, 1.1, 0));
      const body = new Parts(), n = new Parts(), d = new Parts();
      body.add(rbox(4.8, 0.7, 10.8, 0.15), sh(0.85), T(0, 1.95, 0));                       // палуба
      body.add(rbox(3.4, 2.0, 5.2, 0.3), sh(1), T(-0.6, 3.3, -2.4));                       // машинное отделение
      body.add(rbox(4.2, 2.4, 1.1, 0.2), sh(0.85), T(0, 3.5, -4.85));                      // радиаторный блок
      body.add(rbox(1.7, 2.1, 0.9, 0.12), sh(0.8), T(-1.0, 3.35, 3.8));                    // опора мачты
      body.add(rbox(1.6, 1.4, 2.4, 0.2), sh(0.92), T(1.4, 3.0, 0.4));                      // компрессор
      cabin(n, 1.35, 2.3, 4.0, 2.0, 2.3, 2.2);
      n.add(box(3.6, 1.8, 0.06), C.black, T(0, 3.5, -5.42));
      n.add(cyl(0.55, 0.55, 1.6, 10), C.steel, T(1.6, 3.1, -2.6));                         // пылеуловитель
      n.add(cyl(0.16, 0.16, 1.2, 8), C.dark, T(-1.6, 4.8, -3.6));                          // выхлоп
      for (const [x, z] of [[2.15, 4.7], [-2.15, 4.7], [2.15, -4.7], [-2.15, -4.7]]) {
        d.add(cyl(0.2, 0.26, 2.2, 6), C.dark, T(x, 1.3, z));                               // домкраты
        d.add(box(0.7, 0.15, 0.7), C.dark, T(x, 0.1, z));
      }
      for (const sx of [-1, 1]) {
        d.add(box(0.06, 0.06, 7.0), C.rail, T(sx * 2.35, 3.3, -1.6));
        for (const z of [-5.0, -2.7, -0.4, 1.8]) d.add(box(0.06, 1.0, 0.06), C.rail, T(sx * 2.35, 2.8, z));
      }
      const bc = new Parts().add(beaconGeo(1), sh(1), T(1.85, 4.6, 3.4));
      // мачта (в системе оси мачты): 4 пояса, решётка из распорок и раскосов, оголовок, штанга, вращатель
      const mast = new Parts(), mastFar = new Parts(), hw = 0.55;
      for (const P of [mast, mastFar]) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.add(box(0.2, MH, 0.2), C.mast, T(sx * hw, y0 + MH / 2, sz * hw));
        P.add(rbox(1.6, 1.3, 1.6, 0.12), C.mastDark, T(0, y0 + MH - 0.2, 0));
        P.add(rbox(1.0, 1.1, 1.0, 0.1), C.drill, T(0, y0 + MH * 0.45, 0));
        P.add(cyl(0.12, 0.12, MH - 1.5, 6), C.chrome, T(0, y0 + (MH - 1.5) / 2, 0));
      }
      for (const yy of [y0 + MH * 0.3, y0 + MH * 0.6]) for (const sz of [-1, 1]) mastFar.add(box(1.1, 0.12, 0.12), C.mast, T(0, yy, sz * hw));
      const lv = Math.round(MH / 2.2), dy = MH / lv;
      for (let i = 0; i <= lv; i++) {
        const yy = y0 + i * dy;
        for (const s of [-1, 1]) { mast.add(box(1.1, 0.09, 0.09), C.mast, T(0, yy, s * hw)); mast.add(box(0.09, 0.09, 1.1), C.mast, T(s * hw, yy, 0)); }
        if (i === lv) break;
        const f = i % 2 ? 1 : -1;
        for (const s of [-1, 1]) {
          mast.add(box(0.07, 1, 0.07), C.mast, BM(V(-hw * f, yy, s * hw), V(hw * f, yy + dy, s * hw)));
          mast.add(box(0.07, 1, 0.07), C.mast, BM(V(s * hw, yy, -hw * f), V(s * hw, yy + dy, hw * f)));
        }
      }
      return {
        under: under.build(), underFar: underFar.build(), body: body.build(), neutral: n.build(), detail: d.build(),
        beacon: bc.build(), mast: mast.build(), mastFar: mastFar.build(),
      };
    });
  }
  function drill() {
    const S = MODEL_SIZES.drill;
    const G = drillGeos();
    const g = new THREE.Group();
    const paint = mat(C.drill), paintDown = mat(C.paintDown);
    mk(g, G.under, VC(), { far: G.underFar });
    const deck = swap(g, mk(g, G.body, paint), paint, paintDown);
    mk(g, G.neutral, VC());
    mk(g, G.detail, VC(), { detail: true });
    g.userData.beacon = mk(g, G.beacon, BEACON.off);
    // мачта 20 м: ось у передней опоры; уложена — назад, над палубой
    const mastPivot = new THREE.Group(); mastPivot.position.set(-1.0, 4.4, 3.8); g.add(mastPivot);
    const mast = mk(mastPivot, G.mast, VC(), { far: G.mastFar });
    const api = {
      setMast(up) { mastPivot.rotation.x = up === false ? -83 * DEG : 0; },
    };
    g.userData.parts = { mastPivot, deck, mast };
    return finish(g, api, S);
  }

  // ================================================================ ГИРАЦИОННАЯ ДРОБИЛКА
  function crusherGeos() {
    return cached('crusher', () => {
      const B = 25, HB = 20, X = B / 2 + 6;
      const P = new Parts(), body = new Parts(), D = new Parts(), L = new Parts();
      // бетонное основание: сплошной низ + стенки вокруг приёмной воронки
      P.add(rbox(B, HB - 5, B, 0.3), C.concrete, T(0, (HB - 5) / 2, 0));
      for (const s of [-1, 1]) {
        P.add(rbox(3.7, 5, B, 0.15), C.concrete, T(s * (B / 2 - 1.85), HB - 2.5, 0));
        P.add(rbox(B - 7.4, 5, 3.7, 0.15), C.concrete, T(0, HB - 2.5, s * (B / 2 - 1.85)));
      }
      for (const u of [-9.4, -3.1, 3.1, 9.4]) {
        P.add(box(1.0, HB - 0.4, 0.4), C.concreteDark, T(u, (HB - 0.4) / 2, B / 2 + 0.15));   // пилястры
        P.add(box(0.4, HB - 0.4, 1.0), C.concreteDark, T(-B / 2 - 0.15, (HB - 0.4) / 2, u));
      }
      P.add(box(B + 0.3, 0.5, 0.3), C.concreteDark, T(0, HB - 0.25, B / 2 + 0.1));
      P.add(box(0.3, 0.5, B + 0.3), C.concreteDark, T(-B / 2 - 0.1, HB - 0.25, 0));
      // отбойные брусья (жёлтые) по трём сторонам площадки разгрузки; въезд с тыла (−Z)
      P.add(rbox(B, 1.0, 0.9, 0.1), C.safety, T(0, HB + 0.5, B / 2 - 0.45));
      for (const s of [-1, 1]) P.add(rbox(0.9, 1.0, B, 0.1), C.safety, T(s * (B / 2 - 0.45), HB + 0.5, 0));
      // приёмная воронка (стенка с толщиной) и руда на дне
      P.add(lathe([[2.4, HB - 5.2], [8.6, HB + 0.5], [8.15, HB + 0.5], [2.0, HB - 5.2]], 16), C.hopper);
      P.add(cyl(2.3, 2.3, 0.2, 12), 0x4d4339, T(0, HB - 5.1, 0));
      // пандус-въезд и валы безопасности
      P.add(prism([[-B / 2 - 34, 0], [-B / 2, 0], [-B / 2, HB]], B * 0.8), C.gravel);
      for (const s of [-1, 1]) P.add(prism([[-B / 2 - 34, 0], [-B / 2, HB], [-B / 2, HB + 1.2], [-B / 2 - 34, 1.2]], 1.2), C.concreteDark, T(s * (B * 0.4 - 0.6), 0, 0));
      // корпус дробилки (+X): стены перекрашиваются при остановке
      body.add(rbox(12, 16, 16, 0.3), sh(1), T(X, 8, 0));
      body.add(rbox(6, 9, 6, 0.25), sh(0.92), T(X, 21.5, 0));                                // привод
      for (const u of [-4, -1.3, 1.3, 4]) body.add(box(0.35, 15, 0.3), sh(0.85), T(X + u, 8, 8.1));
      for (const u of [-5.3, -1.8, 1.8, 5.3]) body.add(box(0.3, 15, 0.35), sh(0.85), T(X + 6.1, 8, u));
      P.add(box(12.3, 0.9, 16.3), C.accent, T(X, 14.6, 0));                                  // фирменный пояс
      P.add(rbox(13, 0.8, 17, 0.2), C.roof, T(X, 16.4, 0));
      P.add(rbox(6.6, 0.5, 6.6, 0.1), C.roof, T(X, 26.25, 0));
      P.add(box(10, 1.2, 0.1), C.glass, T(X, 11.5, 8.06)); P.add(box(0.1, 1.2, 13), C.glass, T(X + 6.06, 11.5, 0));
      P.add(box(3, 4, 0.1), C.dark, T(X - 3, 2, 8.06));
      // разгрузочная галерея под конвейер (+Z)
      P.add(rbox(3.4, 2.4, 24, 0.15), C.conveyor, T(0, 5, B / 2 + 10, -14 * DEG));
      for (const sx of [-1.2, 1.2]) P.add(box(0.5, 6, 0.5), C.steel, T(sx, 3, B / 2 + 16));
      // лестничная башня на западной стене и гидромолот на площадке (мелочи)
      for (let i = 0; i < 5; i++) {
        const y = i * 4, f = i % 2 ? 1 : -1;
        D.add(box(1.0, 1, 0.12), C.steel, BM(V(-B / 2 - 0.9, y, -7 * f), V(-B / 2 - 0.9, y + 4, 7 * f)));
        D.add(box(1.2, 0.15, 1.6), C.steel, T(-B / 2 - 0.9, y + 4, 7.8 * f));
        D.add(box(0.06, 1, 0.06), C.safety, BM(V(-B / 2 - 1.4, y + 1.0, -7 * f), V(-B / 2 - 1.4, y + 5.0, 7 * f)));
      }
      D.add(cyl(0.8, 1.0, 2.0, 8), C.dark, T(B / 2 - 3, HB + 1, B / 2 - 3));
      D.add(box(0.5, 1, 0.6), C.safety, BM(V(B / 2 - 3, HB + 2, B / 2 - 3), V(B / 2 - 6.5, HB + 5.5, B / 2 - 7)));
      D.add(box(0.4, 1, 0.5), C.safety, BM(V(B / 2 - 6.5, HB + 5.5, B / 2 - 7), V(B / 2 - 8, HB + 2.6, B / 2 - 9.5)));
      D.add(rbox(0.6, 1.2, 0.6, 0.08), C.dark, T(B / 2 - 8.2, HB + 2.0, B / 2 - 9.8));
      for (const s of [-1, 1]) D.add(box(0.06, 0.06, 6.6), C.rail, T(X + s * 3.25, 27.4, 0));
      L.add(beaconGeo(3.2), sh(1), T(X, 26.5, 0));
      return { stat: P.build(), body: body.build(), detail: D.build(), lamp: L.build() };
    });
  }
  function crusher() {
    const S = MODEL_SIZES.crusher;
    const G = crusherGeos();
    const g = new THREE.Group();
    const mBody = mat(C.crusher), mDown = mat(C.paintDown);
    mk(g, G.stat, VC());
    const body = mk(g, G.body, mBody);
    mk(g, G.detail, VC(), { detail: true });
    const lampMats = { running: BEACON.green, idle: BEACON.amber, stopped: BEACON.red };
    const lamp = mk(g, G.lamp, lampMats.running);
    const api = {
      setState(state) {
        const stopped = ['stopped', 'stop', 'down', 'failed', 'off', 'maintenance'].includes(state);
        lamp.material = stopped ? lampMats.stopped : (state === 'idle' ? lampMats.idle : lampMats.running);
        body.material = stopped ? mDown : mBody;
      },
    };
    g.userData.parts = { body, lamp };
    return finish(g, api, S);
  }

  // ================================================================ ЛЕНТОЧНЫЙ КОНВЕЙЕР
  // points — массив THREE.Vector3 в сцене (уже через toScene); лента на opts.height (3 м) над точками.
  // Вся трасса — 6 вызовов отрисовки независимо от длины: став, мостки, слой руды, опоры, роликоопоры, куски руды.
  function conveyor(points, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const S = MODEL_SIZES.conveyor;
    const lift = opts.height ?? 3, step = opts.step ?? S.support_step, BW = S.belt_width;
    const pts = points.map((p) => new THREE.Vector3(p.x, p.y + lift, p.z));
    const main = new Parts(), walk = new Parts(), oreBed = new Parts(), oreRnd = rng(5);
    const segs = []; let total = 0;
    const c30 = Math.cos(30 * DEG), s30 = Math.sin(30 * DEG), sw = BW * 0.32;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], len = a.distanceTo(b);
      if (len < 0.01) continue;
      const dir = b.clone().sub(a).normalize();
      const xA = new THREE.Vector3().crossVectors(UP, dir); if (xA.lengthSq() < 1e-6) xA.set(1, 0, 0); xA.normalize();
      const yA = new THREE.Vector3().crossVectors(dir, xA);
      const M = new THREE.Matrix4().makeBasis(xA, yA, dir).setPosition(a.clone().lerp(b, 0.5));
      const q = new THREE.Quaternion().setFromRotationMatrix(M);
      const L2 = len + 0.05;
      // лента-желоб (3 полосы), обратная ветвь, продольные балки става
      main.add(box(BW * 0.45, 0.06, L2), C.belt, mul(M, T(0, 0, 0)));
      for (const s of [-1, 1]) main.add(box(sw, 0.06, L2), C.belt, mul(M, T(s * (BW * 0.225 + sw / 2 * c30), sw / 2 * s30, 0, 0, 0, s * 30 * DEG)));
      main.add(box(BW * 0.85, 0.04, L2), C.belt, mul(M, T(0, -0.55, 0)));
      oreBed.add(taper(BW * 0.62, 1, BW * 0.2, 1, 0.2), sh(1), mul(M, T(0, 0.12, 0, 0, 0, 0, 1, 1, L2)), 0.12, oreRnd);   // слой руды на ленте
      for (const s of [-1, 1]) main.add(box(0.16, 0.5, L2), C.conveyor, mul(M, T(s * (BW / 2 + 0.3), -0.2, 0)));
      // мостик обслуживания и перила (мелочи)
      walk.add(box(0.8, 0.06, L2), C.grating, mul(M, T(BW / 2 + 0.85, -0.45, 0)));
      walk.add(box(0.05, 0.05, L2), C.safety, mul(M, T(BW / 2 + 1.22, 0.6, 0)));
      walk.add(box(0.04, 0.04, L2), C.safety, mul(M, T(BW / 2 + 1.22, 0.1, 0)));
      segs.push({ a, b, len, start: total, dir, q });
      total += len;
    }
    // приводной и натяжной барабаны на концах
    if (segs.length) {
      for (const [s, p] of [[segs[0], segs[0].a], [segs[segs.length - 1], segs[segs.length - 1].b]]) {
        const M = new THREE.Matrix4().compose(p, s.q, _s.set(1, 1, 1));
        main.add(cyl(0.45, 0.45, BW + 0.2, 10), C.steel, mul(M, T(0, -0.25, 0, 0, 0, Math.PI / 2)));
        main.add(rbox(BW + 1.0, 1.2, 1.4, 0.1), C.conveyor, mul(M, T(0, -0.6, 0)));
      }
    }
    if (main.p.length) mk(g, main.build(), VC());
    if (walk.p.length) mk(g, walk.build(), VC(), { detail: true });
    // опоры-рамы каждые step м (экземпляры): две стойки, ригель, раскос, башмаки
    const legPos = [];
    for (const s of segs) for (let d = step / 2; d < s.len; d += step) legPos.push([s.a.clone().addScaledVector(s.dir, d), Math.atan2(s.dir.x, s.dir.z)]);
    if (legPos.length) {
      // A-образная рама: стойки расходятся к низу, распорка на трети высоты, ригель под ставом
      const fr = new Parts(), lx = BW / 2 + 0.3, hLeg = Math.max(0.5, lift - 0.15), lb = lx + Math.min(1.4, hLeg * 0.22);
      for (const s of [-1, 1]) {
        fr.add(box(0.24, 1, 0.24), C.conveyor, BM(V(s * lb, 0.1, 0), V(s * lx, hLeg, 0)));
        fr.add(rbox(0.8, 0.3, 0.8, 0.05), C.concreteDark, T(s * lb, 0.15, 0));
      }
      fr.add(rbox(BW + 1.1, 0.28, 0.3, 0.05), C.conveyor, T(0, hLeg - 0.1, 0));
      if (hLeg > 1.2) {
        const yb = hLeg * 0.35, xb = lb + (lx - lb) * 0.35;
        fr.add(box(2 * xb, 0.14, 0.14), C.conveyor, T(0, yb, 0));
        fr.add(box(0.1, 1, 0.1), C.conveyor, BM(V(-xb, yb, 0), V(0, hLeg - 0.2, 0)));
        fr.add(box(0.1, 1, 0.1), C.conveyor, BM(V(xb, yb, 0), V(0, hLeg - 0.2, 0)));
      }
      const legs = new THREE.InstancedMesh(fr.build(), VC(), legPos.length);
      legPos.forEach(([p, yaw], i) => {
        _m.compose(_v.set(p.x, p.y - lift - 0.3, p.z), _q.setFromAxisAngle(UP, yaw), _s.set(1, 1, 1));
        legs.setMatrixAt(i, _m);
      });
      legs.instanceMatrix.needsUpdate = true;
      legs.computeBoundingSphere();
      g.add(legs);
    }
    // роликоопоры каждые 4 м (экземпляры, только вблизи)
    const idl = [];
    for (const s of segs) for (let d = 2; d < s.len && idl.length < 5000; d += 4) idl.push([s.a.clone().addScaledVector(s.dir, d), s.q]);
    if (idl.length) {
      const ip = new Parts();
      ip.add(box(BW + 0.5, 0.08, 0.1), C.steel, T(0, -0.26, 0));
      for (const s of [-1, 1]) ip.add(box(0.08, 0.5, 0.1), C.steel, T(s * (BW / 2 + 0.2), -0.02, 0));
      // три ролика желоба (средний и два наклонных) и нижний ролик обратной ветви
      const rol = cyl(0.09, 0.09, 1, 8);
      ip.add(rol, C.roller, T(0, -0.12, 0, 0, 0, Math.PI / 2, 1, BW * 0.42, 1));
      for (const s of [-1, 1]) ip.add(rol, C.roller, T(s * (BW * 0.225 + sw / 2 * c30), sw / 2 * s30 - 0.12, 0, 0, 0, Math.PI / 2 + s * 30 * DEG, 1, sw * 0.95, 1));
      ip.add(rol, C.roller, T(0, -0.66, 0, 0, 0, Math.PI / 2, 1, BW * 0.8, 1));
      ip.add(box(0.05, 1.05, 0.05), C.safety, T(BW / 2 + 1.22, 0.08, 0));                      // стойка перил мостика
      ip.add(box(0.9, 0.06, 0.06), C.steel, T(BW / 2 + 0.85, -0.5, 0));                         // кронштейн мостика
      const idlers = new THREE.InstancedMesh(ip.build(), VC(), idl.length);
      idl.forEach(([p, q], i) => { _m.compose(p, q, _s.set(1, 1, 1)); idlers.setMatrixAt(i, _m); });
      idlers.instanceMatrix.needsUpdate = true;
      idlers.computeBoundingSphere();
      idlers.userData.detail = true;
      g.add(idlers);
    }
    // груз: сплошной слой руды на ленте (виден, пока есть поток) + «кучки» руды, которые скользят по ленте
    const oreMat = mat(C.ore);
    const bedMesh = oreBed.p.length ? mk(g, oreBed.build(), oreMat) : null;
    if (bedMesh) bedMesh.visible = false;
    const maxN = Math.max(1, Math.min(300, Math.floor(total / 3)));
    const lumpGeo = cached('lump' + BW, () => {
      const P = new Parts(), rnd = rng(7);
      P.add(dod(1), sh(1), T(0, 0, 0, 0.3, 0.5, 0, BW * 0.3, 0.24, 0.62), 0.25, rnd);
      P.add(dod(1), sh(0.9), T(BW * 0.12, 0.12, 0.35, 0.8, 0.2, 0.4, 0.22, 0.17, 0.3), 0.25, rnd);
      P.add(dod(1), sh(1.05), T(-BW * 0.1, 0.1, -0.3, 0.2, 1.1, 0.7, 0.2, 0.15, 0.28), 0.25, rnd);
      return P.build();
    });
    const lumps = new THREE.InstancedMesh(lumpGeo, oreMat, maxN);
    lumps.count = 0; lumps.frustumCulled = false;
    g.add(lumps);
    let offset = 0;
    function placeAt(dist, out) {
      let d = ((dist % total) + total) % total;
      for (const s of segs) {
        if (d <= s.len || s === segs[segs.length - 1]) {
          out.pos.copy(s.a).addScaledVector(s.dir, Math.min(d, s.len));
          out.dir = s.dir; return;
        }
        d -= s.len;
      }
    }
    const slot = { pos: new THREE.Vector3(), dir: null };
    const ZF = new THREE.Vector3(0, 0, 1);
    const api = {
      length: total,
      setFlow(tph, dt) {
        // число кучек растёт с производительностью: при ~2500 т/ч — кучка каждые 3 м
        const n = tph > 0 && total > 0 ? Math.max(1, Math.min(maxN, Math.round(maxN * Math.min(1, tph / 2500)))) : 0;
        lumps.count = n;
        if (bedMesh) bedMesh.visible = n > 0;
        if (!n) return;
        offset = (offset + S.speed_mps * (dt || 0)) % total;
        const spacing = total / n;
        for (let i = 0; i < n; i++) {
          placeAt(offset + i * spacing, slot);
          _q.setFromUnitVectors(ZF, slot.dir);
          _m.compose(_v.set(slot.pos.x, slot.pos.y + 0.22, slot.pos.z), _q, _s.set(1, 1, 1));
          lumps.setMatrixAt(i, _m);
        }
        lumps.instanceMatrix.needsUpdate = true;
      },
    };
    g.userData.parts = { lumps, segs, oreBed: bedMesh };
    return finish(g, api, { length: total, width: BW });
  }

  // ================================================================ ЗДАНИЯ
  function buildingGeos(type, l, w, h) {
    return cached(`bld|${type}|${l}|${w}|${h}`, () => {
      const P = new Parts(), D = new Parts();
      const wallD = mix(C.wall, 0.86), roofD = mix(C.roof, 0.8);
      if (type === 'main') {
        // главный корпус: зал с пилястрами, ленточные окна, фирменный пояс, двускатная кровля с фонарями,
        // пристройка спереди, высокий мельничный пролёт сзади, дымовая труба, ворота
        P.add(rbox(l + 0.6, 1.2, w + 0.6, 0.1), C.concreteDark, T(0, 0.6, 0));
        P.add(rbox(l, h, w, 0.25), C.wall, T(0, h / 2, 0));
        const n = Math.max(2, Math.round(l / 7)), m = Math.max(2, Math.round(w / 7));
        for (let i = 0; i <= n; i++) for (const s of [-1, 1]) P.add(box(0.6, h - 1.2, 0.35), wallD, T(-l / 2 + i * l / n, 0.6 + h / 2, s * (w / 2 + 0.12)));
        for (let j = 0; j <= m; j++) for (const s of [-1, 1]) P.add(box(0.35, h - 1.2, 0.6), wallD, T(s * (l / 2 + 0.12), 0.6 + h / 2, -w / 2 + j * w / m));
        const rows = h > 14 ? [0.36, 0.66] : [0.5];
        for (const f of rows) for (const s of [-1, 1]) {
          P.add(box(l - 3, 1.5, 0.12), C.glass, T(0, h * f, s * (w / 2 + 0.04)));
          P.add(box(0.12, 1.5, w - 3), C.glass, T(s * (l / 2 + 0.04), h * f, 0));
        }
        for (const s of [-1, 1]) {
          P.add(box(l + 0.4, 1.0, 0.2), C.accent, T(0, h - 1.3, s * (w / 2 + 0.2)));
          P.add(box(0.2, 1.0, w + 0.4), C.accent, T(s * (l / 2 + 0.2), h - 1.3, 0));
          P.add(box(l + 1.4, 0.4, 0.3), roofD, T(0, h + 0.1, s * (w / 2 + 0.6)));
        }
        P.add(taper(l + 1.2, w + 1.2, l + 1.2, 1.0, 2.2), C.roof, T(0, h + 1.1, 0));
        for (let i = -1; i <= 1; i++) {
          P.add(box(l * 0.24, 2.0, w * 0.2), C.wall, T(i * l * 0.3, h + 2.6, 0));
          for (const s of [-1, 1]) P.add(box(l * 0.22, 0.8, 0.1), C.glass, T(i * l * 0.3, h + 2.7, s * (w * 0.1 + 0.03)));
          P.add(taper(l * 0.24 + 0.8, w * 0.2 + 0.8, l * 0.24 + 0.8, 0.6, 0.9), C.roof, T(i * l * 0.3, h + 4.05, 0));
        }
        const aw = l * 0.45, ah = h * 0.55, ad = w * 0.4, ax = -l * 0.2, az = w / 2 + ad / 2;
        P.add(rbox(aw, ah, ad, 0.2), C.wall, T(ax, ah / 2, az));
        P.add(box(aw - 2, 1.4, 0.1), C.glass, T(ax, ah * 0.55, az + ad / 2 + 0.03));
        P.add(box(0.1, 1.4, ad - 2), C.glass, T(ax - aw / 2 - 0.03, ah * 0.55, az));
        P.add(box(aw + 0.2, 0.7, 0.15), C.accent, T(ax, ah - 0.6, az + ad / 2 + 0.08));
        P.add(rbox(aw + 0.8, 0.5, ad + 0.8, 0.1), C.roof, T(ax, ah + 0.25, az));
        const bw = l * 0.25, bh = h * 1.3, bd = w * 0.3, bx = l * 0.3, bz = -w / 2 - bd / 2;
        P.add(rbox(bw, bh, bd, 0.2), C.wall, T(bx, bh / 2, bz));
        for (let i = 0; i <= 4; i++) P.add(box(0.5, bh - 1.0, 0.3), wallD, T(bx - bw / 2 + i * bw / 4, bh / 2, bz - bd / 2 - 0.1));
        P.add(box(bw - 2, 1.5, 0.1), C.glass, T(bx, bh * 0.7, bz - bd / 2 - 0.04));
        P.add(box(bw + 0.3, 1.0, 0.2), C.accent, T(bx, bh - 1.3, bz - bd / 2 - 0.15));
        P.add(taper(bw + 1, bd + 1, bw + 1, 0.8, 1.6), C.roof, T(bx, bh + 0.8, bz));
        for (const gx of [l * 0.12, l * 0.27, l * 0.42]) {
          P.add(box(6, 7, 0.15), 0x5a6068, T(gx, 3.5, w / 2 + 0.1));
          P.add(box(6.8, 0.5, 0.3), C.accent, T(gx, 7.3, w / 2 + 0.15));
        }
        // трубопроводы вдоль длинной стены (−Z): пульпа (серый), вода (синий), воздух (жёлтый) — на кронштейнах
        const pz = -w / 2 - 0.9, px0 = -l / 2 + 2, px1 = l * 0.15, plen = px1 - px0;
        const pipes = [[4.2, 0.45, C.steel], [5.3, 0.32, C.accent], [6.2, 0.22, C.safety]];
        for (const [py, pr, pc] of pipes) {
          P.add(cyl(pr, pr, plen, 10), pc, T((px0 + px1) / 2, py, pz - (0.55 - pr), 0, 0, Math.PI / 2));
          P.add(cyl(pr * 1.25, pr * 1.25, 0.3, 10), pc, T(px0 + 0.15, py, pz - (0.55 - pr), 0, 0, Math.PI / 2));   // фланцы
        }
        P.add(cyl(0.45, 0.45, 4.2, 10), C.steel, T(px1 + 0.2, 2.1, pz - 0.1));                   // опуск в землю
        for (let x = px0 + 2; x < px1; x += 6) D.add(box(0.15, 3.0, 1.2), C.dark, T(x, 5.0, pz + 0.05));   // кронштейны
        const cxh = -l / 2 + 4, czh = -w / 2 + 4;
        P.add(cyl(1.2, 1.8, h * 1.9, 10), C.concrete, T(cxh, h * 0.95, czh));
        for (const dy of [1.2, 4.6]) P.add(cyl(1.22, 1.26, 1.4, 10), C.paintDown, T(cxh, h * 1.9 - dy, czh));
        for (let i = 0; i < 4; i++) D.add(rbox(3, 1.4, 2.2, 0.1), C.steel, T(-l * 0.4 + i * 6, h + 1.6, w * 0.3));   // вентиляция на кровле
        for (let i = 0; i < 4; i++) D.add(box(1.2, 0.12, 3.2), C.steel, BM(V(l / 2 + 1.0, i * h / 4, -w * 0.2), V(l / 2 + 1.0, (i + 1) * h / 4, w * 0.2)));
      } else if (type === 'thickener') {
        // сгуститель: кольцевая стенка, зеркало пульпы, центральная колонна, мост-ферма с приводом
        const r = l / 2, hw = h || 6;
        P.add(lathe([[r - 0.6, 0], [r, 0], [r, hw + 0.3], [r - 0.6, hw + 0.3]], 32), C.concrete);
        P.add(lathe([[r - 1.6, hw - 0.18], [r - 0.6, hw - 0.18], [r - 0.6, hw + 0.02], [r - 1.6, hw + 0.02]], 32), C.concreteDark);
        P.add(cyl(r - 0.6, r - 0.6, 0.3, 32), C.water, T(0, hw - 0.3, 0));
        P.add(cyl(r * 0.45, r * 0.45, 0.02, 24), C.waterLight, T(0, hw - 0.14, 0));
        P.add(cyl(1.1, 1.1, hw + 2.5, 10), C.steel, T(0, (hw + 2.5) / 2, 0));
        P.add(box(r + 0.5, 0.15, 1.6), C.grating, T(r / 2, hw + 1.6, 0));
        for (const s of [-1, 1]) P.add(box(r + 0.5, 0.3, 0.25), C.steel, T(r / 2, hw + 1.4, s * 0.8));
        P.add(rbox(2.8, 1.6, 2.8, 0.15), C.trafo, T(0, hw + 3.3, 0));
        P.add(rbox(1.2, 0.9, 1.6, 0.1), C.accent, T(0, hw + 4.5, 0));
        const nb = Math.max(3, Math.round(r / 2.5));
        for (let i = 0; i < nb; i++) for (const s of [-1, 1]) {
          const x0 = 1.0 + i * (r - 0.5) / nb, x1 = 1.0 + (i + 1) * (r - 0.5) / nb;
          D.add(box(0.08, 1, 0.08), C.steel, BM(V(x0, hw + 1.5, s * 0.8), V(x1, hw + 2.6, s * 0.8)));
          D.add(box(0.06, 1.1, 0.06), C.rail, T(x1, hw + 2.15, s * 0.8));
        }
        for (const s of [-1, 1]) D.add(box(r + 0.5, 0.06, 0.06), C.rail, T(r / 2, hw + 2.6, s * 0.8));
        D.add(cyl(0.3, 0.3, r, 8), C.steel, T(-r / 2, hw + 1.0, 0, 0, 0, Math.PI / 2));
      } else if (type === 'warehouse') {
        // ангар: стены + полукруглая крыша вдоль Z на длину l, рёбра-арки, светлые торцы с воротами
        const wallH = Math.max(1, h - w / 2);
        const shape = new THREE.Shape();
        shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(w / 2, wallH);
        shape.absarc(0, wallH, w / 2, 0, Math.PI, false); shape.lineTo(-w / 2, 0);
        P.add(ni(new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false, curveSegments: 10 })), C.roof, T(0, 0, -l / 2));
        const rib = ni(new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false, curveSegments: 10 }));
        const nr = Math.max(2, Math.round(l / 6));
        for (let i = 0; i <= nr; i++) {
          const z = i === 0 ? -l / 2 : i === nr ? l / 2 - 0.5 : -l / 2 - 0.25 + i * l / nr;
          P.add(rib, roofD, T(0, 0, z, 0, 0, 0, 1.015, 1.012, 1));
        }
        const face = ni(new THREE.ShapeGeometry(shape, 10));
        P.add(face, C.wall, T(0, 0, l / 2 + 0.03)); P.add(face, C.wall, T(0, 0, -l / 2 - 0.03, 0, Math.PI, 0));
        P.add(box(w + 0.4, 0.6, l + 0.4), C.concreteDark, T(0, 0.3, 0));
        P.add(box(w * 0.32, wallH * 0.85, 0.2), 0x5a6068, T(0, wallH * 0.425, l / 2 + 0.14));
        P.add(box(w * 0.36, 0.6, 0.3), C.accent, T(0, wallH * 0.85 + 0.3, l / 2 + 0.18));
        P.add(box(w * 0.5, 0.9, 0.1), C.glass, T(0, wallH * 0.85 + 1.6, l / 2 + 0.08));             // световая полоса над воротами
        P.add(box(2.2, 2.6, 0.2), 0x5a6068, T(w * 0.3, 1.3, -l / 2 - 0.14));
        D.add(rbox(4, 0.3, 2.4, 0.05), C.accent, T(w * 0.3, 3.0, -l / 2 - 1.2));
      } else if (type === 'substation') {
        // подстанция: гравийная площадка, трансформаторы с радиаторами и вводами, порталы ОРУ, здание РУ
        P.add(rbox(l, 0.4, w, 0.1), C.gravel, T(0, 0.2, 0));
        const trD = mix(C.trafo, 0.82);
        for (const x of [-l * 0.2, l * 0.2]) {
          const z = -w * 0.15;
          P.add(box(6.5, 0.5, 5), C.concrete, T(x, 0.65, z));
          P.add(rbox(5.5, 4.2, 4.0, 0.2), C.trafo, T(x, 3.0, z));
          for (let k = 0; k < 6; k++) for (const s of [-1, 1]) P.add(box(0.12, 3.2, 1.1), trD, T(x - 2.2 + k * 0.88, 2.9, z + s * 2.55));
          P.add(cyl(0.55, 0.55, 4.0, 10), C.trafo, T(x, 6.1, z - 1.3, 0, 0, Math.PI / 2));
          for (let k = -1; k <= 1; k++) P.add(cyl(0.18, 0.34, 1.8, 6), C.porcelain, T(x + k * 1.4, 6.0, z + 0.8));
        }
        const PH = h || 12;
        for (const z of [w * 0.25, w * 0.42]) {
          for (const s of [-1, 1]) P.add(taper(0.9, 0.9, 0.45, 0.45, PH), C.steel, T(s * l * 0.4, PH / 2, z));
          P.add(rbox(l * 0.8 + 0.6, 0.7, 0.7, 0.08), C.steel, T(0, PH - 0.35, z));
          for (let k = -1; k <= 1; k++) D.add(cyl(0.16, 0.16, 2.2, 6), C.porcelain, T(k * l * 0.25, PH - 1.8, z));
        }
        for (let k = -1; k <= 1; k++) D.add(box(0.1, 0.1, w * 0.17), C.steel, T(k * l * 0.25, PH - 2.9, w * 0.335));
        const bx = l * 0.35, bz = -w * 0.35;
        P.add(rbox(10, 4, 6, 0.15), C.wall, T(bx, 2.4, bz));
        P.add(rbox(10.6, 0.4, 6.6, 0.08), C.roof, T(bx, 4.6, bz));
        P.add(box(10.1, 0.6, 6.1), C.accent, T(bx, 3.8, bz));
        P.add(box(1.4, 2.4, 0.1), 0x5a6068, T(bx - 2.5, 1.6, bz + 3.03));
        for (const s of [-1, 1]) {
          D.add(box(l - 1, 2.0, 0.05), 0xb9bec3, T(0, 1.4, s * (w / 2 - 0.5)));
          D.add(box(0.05, 2.0, w - 1), 0xb9bec3, T(s * (l / 2 - 0.5), 1.4, 0));
        }
      } else {
        // office — небольшое здание (АБК): окна по этажам, плоская кровля, синий козырёк входа
        P.add(rbox(l + 0.4, 0.6, w + 0.4, 0.08), C.concreteDark, T(0, 0.3, 0));
        P.add(rbox(l, h, w, 0.2), C.wall, T(0, h / 2, 0));
        const floors = Math.max(1, Math.round(h / 3.5));
        for (let f = 0; f < floors; f++) {
          const y = 1.0 + f * (h / floors) + 0.9;
          for (const s of [-1, 1]) {
            P.add(box(l * 0.86, 1.3, 0.1), C.glass, T(0, y, s * (w / 2 + 0.03)));
            P.add(box(0.1, 1.3, w * 0.8), C.glass, T(s * (l / 2 + 0.03), y, 0));
          }
        }
        P.add(rbox(l + 0.3, 0.5, w + 0.3, 0.06), C.roof, T(0, h + 0.25, 0));
        P.add(box(2.6, h, 0.25), C.accent, T(l * 0.3, h / 2, w / 2 + 0.1));
        P.add(rbox(5, 0.35, 3, 0.06), C.accent, T(0, 3.2, w / 2 + 1.5));
        P.add(box(2.2, 2.6, 0.1), C.glass, T(0, 1.3, w / 2 + 0.05));
        for (const s of [-1, 1]) D.add(box(0.2, 3.0, 0.2), C.steel, T(s * 2.2, 1.5, w / 2 + 2.8));
        D.add(rbox(2.4, 1.2, 1.6, 0.1), C.steel, T(-l * 0.25, h + 1.1, 0));
      }
      return { main: P.build(), detail: D.p.length ? D.build() : null };
    });
  }
  function building(type, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const size = (opts.size || MODEL_SIZES.building[type] || [20, 12, 8]).slice();
    const [l, w, h] = size;
    const G = buildingGeos(['main', 'thickener', 'warehouse', 'substation'].includes(type) ? type : 'office', l, w, h);
    mk(g, G.main, VC());
    if (G.detail) mk(g, G.detail, VC(), { detail: true });
    return finish(g, {}, { length: l, width: w, height: h });
  }

  // ================================================================ ШТАБЕЛЬ РУДЫ (откос 37°)
  // единичный конус (радиус основания 1) с неровной поверхностью и глыбами; масштаб = радиус
  const HU = 0.88 * Math.tan(REPOSE);
  function pileGeo() {
    return cached('pile', () => {
      const rnd = rng(37), seg = 18, rings = [0, 0.3, 0.6, 1];
      const grid = rings.map((f, ri) => {
        const row = [];
        for (let k = 0; k < seg; k++) {
          const a = k / seg * Math.PI * 2;
          const inner = ri > 0 && ri < rings.length - 1;
          const r = (1 - 0.88 * f) * (inner ? 1 + (rnd() - 0.5) * 0.08 : 1);
          row.push([Math.sin(a) * r, HU * f + (inner ? (rnd() - 0.5) * 0.03 : 0), Math.cos(a) * r]);
        }
        return row;
      });
      const pos = [];
      for (let ri = 0; ri + 1 < grid.length; ri++) for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg, a = grid[ri][k], b = grid[ri][k1], c = grid[ri + 1][k1], d = grid[ri + 1][k];
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
      const top = [0, HU + 0.02, 0], tr = grid[grid.length - 1];
      for (let k = 0; k < seg; k++) pos.push(...tr[k], ...tr[(k + 1) % seg], ...top);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const P = new Parts();
      P.add(g, sh(1), IDENT, 0.16, rnd);
      for (let i = 0; i < 28; i++) {
        const f = 0.08 + rnd() * 0.8, a = rnd() * Math.PI * 2, r = 1 - 0.88 * f;
        const s = 0.022 + rnd() * 0.025;
        P.add(ico(1), sh(0.82 + rnd() * 0.25), T(Math.sin(a) * r, HU * f + s * 0.3, Math.cos(a) * r, rnd() * 3, rnd() * 3, rnd() * 3, s, s * 0.8, s), 0.2, rnd);
      }
      return P.build();
    });
  }
  function stockpile(volume, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const mesh = mk(g, pileGeo(), mat(opts.color ?? C.pile));
    const api = {
      setVolume(v) {
        const r = v > 0 ? Math.cbrt(3 * v / (Math.PI * Math.tan(REPOSE))) : 0;   // V = π r² h / 3, h = r·tg 37°
        const s = Math.max(r, 0.01);
        mesh.scale.setScalar(s);
        mesh.position.y = 0;
        mesh.visible = r > 0;
        g.userData.radius = r; g.userData.height = r * Math.tan(REPOSE) * 0.88;
      },
    };
    api.setVolume(volume || 0);
    g.userData.parts = { mesh };
    return finish(g, api, { radius: g.userData.radius, height: g.userData.height });
  }

  // ================================================================ ОТВАЛ — ступенчатые ярусы с плоскими площадками
  function dump(radius, height, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const n = Math.max(1, Math.min(4, opts.tiers ?? 3));
    const R = radius || 200, H = height || 30, th = H / n, slope = Math.tan(35 * DEG);
    const geo = cached(`dump|${R}|${H}|${n}`, () => {
      const seg = 40, rnd = rng(11), ph1 = rnd() * 6, ph2 = rnd() * 6;
      const wob = (a) => 1 + 0.03 * Math.sin(3 * a + ph1) + 0.02 * Math.sin(7 * a + ph2);
      const pos = [], colr = [];
      const push = (p, c) => { pos.push(p[0], p[1], p[2]); colr.push(c[0], c[1], c[2]); };
      let rBot = R, y = 0;
      for (let i = 0; i < n; i++) {
        const rTop = Math.max(rBot * 0.3, rBot - th / slope);
        const base = i % 2 ? C.dumpDark : C.dump;
        const cs = mix(base, 0.9), ct = mix(base, 1.08);
        for (let k = 0; k < seg; k++) {
          const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2, w0 = wob(a0), w1 = wob(a1);
          const b0 = [Math.sin(a0) * rBot * w0, y, Math.cos(a0) * rBot * w0], b1 = [Math.sin(a1) * rBot * w1, y, Math.cos(a1) * rBot * w1];
          const t0 = [Math.sin(a0) * rTop * w0, y + th, Math.cos(a0) * rTop * w0], t1 = [Math.sin(a1) * rTop * w1, y + th, Math.cos(a1) * rTop * w1];
          const k1 = 1 + (rnd() - 0.5) * 0.06, csj = [cs[0] * k1, cs[1] * k1, cs[2] * k1];
          push(b0, csj); push(b1, csj); push(t1, csj); push(b0, csj); push(t1, csj); push(t0, csj);   // откос
          push(t0, ct); push(t1, ct); push([0, y + th, 0], ct);                                      // площадка
        }
        y += th;
        rBot = rTop - R * 0.1;      // ширина бермы между ярусами
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      gg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      gg.computeVertexNormals(); gg.computeBoundingSphere();
      return gg;
    });
    mk(g, geo, VC());
    return finish(g, {}, { radius: R, height: H });
  }

  // ================================================================ ОСВЕТИТЕЛЬНАЯ МАЧТА
  function lightMast(h) {
    h = h || MODEL_SIZES.lightMast.height;
    const G = cached('mast' + h, () => {
      // решётчатая четырёхгранная мачта (сужается кверху), площадка обслуживания, рама с прожекторами
      const P = new Parts(), D = new Parts(), L = new Parts();
      const hb = 1.1, ht = 0.45, hw = (y) => hb + (ht - hb) * (y / h);
      P.add(rbox(3.0, 0.8, 3.0, 0.12), C.concrete, T(0, 0.4, 0));
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [sx, sz] of corners) P.add(box(0.2, 1, 0.2), C.pole, BM(V(sx * hb, 0.6, sz * hb), V(sx * ht, h, sz * ht)));
      const lv = Math.max(4, Math.round(h / 2.5)), dy = (h - 0.6) / lv;
      for (let i = 0; i <= lv; i++) {
        const y = 0.6 + i * dy, a = hw(y);
        for (let e = 0; e < 4; e++) {
          const [x0, z0] = corners[e], [x1, z1] = corners[(e + 1) % 4];
          const pa = V(x0 * a, y, z0 * a), pb = V(x1 * a, y, z1 * a);
          D.add(box(0.07, 1, 0.07), C.pole, BM(pa, pb));                                      // пояс
          if (i < lv) {                                                                       // раскос
            const y2 = y + dy, a2 = hw(y2), f = i % 2;
            D.add(box(0.06, 1, 0.06), C.pole, BM(f ? pa : pb, f ? V(x1 * a2, y2, z1 * a2) : V(x0 * a2, y2, z0 * a2)));
          }
        }
      }
      // лестница с кольцами вдоль одной грани
      D.add(box(0.05, h - 1.2, 0.05), C.steel, T(-0.18, h / 2 + 0.3, hb * 0.7 + 0.3));
      D.add(box(0.05, h - 1.2, 0.05), C.steel, T(0.18, h / 2 + 0.3, hb * 0.7 + 0.3));
      // площадка и рама прожекторов: прямоугольная решётка 2 ряда × 4 прожектора, смотрит в одну сторону (+Z)
      P.add(rbox(3.2, 0.2, 3.2, 0.05), C.grating, T(0, h, 0));
      for (const s of [-1, 1]) {
        D.add(box(3.2, 0.05, 0.05), C.rail, T(0, h + 1.05, s * 1.58));
        D.add(box(0.05, 0.05, 3.2), C.rail, T(s * 1.58, h + 1.05, 0));
        for (const t of [-1, 1]) D.add(box(0.05, 1.05, 0.05), C.rail, T(s * 1.58, h + 0.55, t * 1.58));
      }
      const fy = h + 2.6, fz = 0.9;
      P.add(box(4.6, 0.16, 0.16), C.steel, T(0, fy - 1.25, fz));
      P.add(box(4.6, 0.16, 0.16), C.steel, T(0, fy + 1.25, fz));
      for (const s of [-1, 1]) P.add(box(0.16, 2.66, 0.16), C.steel, T(s * 2.3, fy, fz));
      for (const s of [-1, 1]) P.add(box(0.14, 1, 0.14), C.steel, BM(V(s * 1.2, h + 0.1, 0.2), V(s * 1.2, fy - 1.25, fz)));
      for (const row of [-0.62, 0.62]) for (let k = 0; k < 4; k++) {
        const x = -1.65 + k * 1.1, M = TY(x, fy + row, fz + 0.2, 0, 18 * DEG);
        P.add(rbox(0.95, 0.95, 0.32, 0.06), C.dark, M);
        L.add(box(0.78, 0.78, 0.05), sh(1), mul(M, T(0, 0, 0.17)));
      }
      return { main: P.build(), detail: D.build(), lamps: L.build() };
    });
    const g = new THREE.Group();
    mk(g, G.main, VC());
    mk(g, G.detail, VC(), { detail: true });
    mk(g, G.lamps, glow(C.lamp, 1.1));
    return finish(g, {}, { height: h });
  }

  // ================================================================ ЛЭП: опоры по точкам сцены + провода
  function powerLine(points, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const H = opts.height || MODEL_SIZES.powerLine.height;
    const P = new Parts(), D = new Parts();
    const tops = [];
    points.forEach((p, i) => {
      const next = points[i + 1] || p, prev = points[i - 1] || p;
      const dir = _v.subVectors(next, prev); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const M = new THREE.Matrix4().compose(p, _q.setFromAxisAngle(UP, Math.atan2(dir.x, dir.z)), _s.set(1, 1, 1));
      for (const s of [-1, 1]) {
        P.add(taper(0.7, 0.7, 0.4, 0.4, H), C.pole, mul(M, T(s * 2.2, H / 2, 0)));
        P.add(box(1.2, 0.5, 1.2), C.concreteDark, mul(M, T(s * 2.2, 0.25, 0)));
        P.add(taper(0.4, 0.4, 0.12, 0.12, 2.2), C.pole, mul(M, T(s * 2.2, H + 1.1, 0)));
      }
      P.add(rbox(9.4, 0.5, 0.5, 0.05), C.pole, mul(M, T(0, H - 1.5, 0)));
      for (const [ya, yb] of [[0.8, H * 0.45], [H * 0.45, H - 2.0]]) {
        P.add(box(0.15, 1, 0.15), C.pole, mul(M, BM(V(-2.2, ya, 0), V(2.2, yb, 0))));
        P.add(box(0.15, 1, 0.15), C.pole, mul(M, BM(V(2.2, ya, 0), V(-2.2, yb, 0))));
      }
      for (const x of [-4, 0, 4]) D.add(cyl(0.18, 0.18, 1.2, 6), 0x7fa3ba, mul(M, T(x, H - 2.35, 0)));   // изоляторы
      tops.push([-4, 0, 4].map((x) => p.clone().addScaledVector(side, x).add(new THREE.Vector3(0, H - 2.9, 0))));
    });
    if (P.p.length) mk(g, P.build(), VC());
    if (D.p.length) mk(g, D.build(), VC(), { detail: true });
    const wirePts = [];
    for (let i = 0; i + 1 < tops.length; i++) {
      for (let k = 0; k < 3; k++) {
        const a = tops[i][k], b = tops[i + 1][k];
        const sag = Math.min(2.5, a.distanceTo(b) * 0.03);
        let prev = a;
        for (let j = 1; j <= 6; j++) {
          const t = j / 6, q = a.clone().lerp(b, t); q.y -= 4 * sag * t * (1 - t);   // провис
          wirePts.push(prev, q); prev = q;
        }
      }
    }
    if (wirePts.length) {
      const wires = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wirePts), lineMat(C.wire));
      wires.userData.detail = true;
      g.add(wires);
    }
    return finish(g, {}, { height: H });
  }

  // ================================================================ ОГРАЖДЕНИЕ: столбики каждые ~4 м + проволока
  function fence(points, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const step = opts.step || 4, FH = opts.height || 2;
    const posts = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1], len = a.distanceTo(b);
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) posts.push(a.clone().lerp(b, k / n));
    }
    posts.push(points[points.length - 1].clone());
    const postGeo = cached('post' + FH, () => {
      const P = new Parts();
      P.add(box(0.12, FH, 0.12), C.pole, T(0, 0, 0));
      P.add(box(0.06, 0.4, 0.06), C.pole, T(0, FH / 2 + 0.15, 0.1, 0.5, 0, 0));
      return P.build();
    });
    const inst = new THREE.InstancedMesh(postGeo, VC(), posts.length);
    posts.forEach((p, i) => { _m.makeTranslation(p.x, p.y + FH / 2, p.z); inst.setMatrixAt(i, _m); });
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    g.add(inst);
    const wirePts = [];
    for (let i = 0; i + 1 < posts.length; i++) {
      for (const hh of [FH * 0.35, FH * 0.7, FH]) {
        wirePts.push(posts[i].clone().add(new THREE.Vector3(0, hh, 0)), posts[i + 1].clone().add(new THREE.Vector3(0, hh, 0)));
      }
    }
    const wires = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wirePts), lineMat(C.wire));
    wires.userData.detail = true;
    g.add(wires);
    return finish(g, {}, { height: FH });
  }

  // ================================================================ ТОПЛИВОЗАПРАВОЧНЫЙ ПУНКТ
  // два горизонтальных резервуара в обваловании, навес на стойках с синим фризом, островок с колонками, будка
  function fuelStation() {
    const G = cached('fuel', () => {
      const P = new Parts(), D = new Parts();
      const tank = lathe([[0, -7.6], [1.4, -7.35], [2.1, -6.8], [2.2, -6.2], [2.2, 6.2], [2.1, 6.8], [1.4, 7.35], [0, 7.6]], 14);
      for (const dz of [-6, 6]) {
        P.add(tank, 0xeef0ee, T(-12, 3.2, dz, 0, 0, -Math.PI / 2));
        P.add(cyl(2.24, 2.24, 1.2, 14), C.accent, T(-12, 3.2, dz, 0, 0, Math.PI / 2));
        for (const dx of [-4.5, 4.5]) P.add(rbox(1, 2, 4.0, 0.1), C.dark, T(-12 + dx, 1, dz));
        D.add(box(10, 0.1, 0.8), C.grating, T(-12, 5.45, dz));
        for (const s of [-1, 1]) {
          D.add(box(10, 0.05, 0.05), C.safety, T(-12, 6.4, dz + s * 0.4));
          for (const dx of [-4.8, 0, 4.8]) D.add(box(0.05, 0.95, 0.05), C.safety, T(-12 + dx, 5.95, dz + s * 0.4));
        }
      }
      for (const s of [-1, 1]) {
        P.add(box(17, 0.8, 0.3), C.concrete, T(-12, 0.4, s * 10));
        P.add(box(0.3, 0.8, 20), C.concrete, T(-12 + s * 8.5, 0.4, 0));
      }
      P.add(box(22, 0.1, 16), C.concrete, T(6, 0.05, 0));
      P.add(rbox(20, 0.6, 14, 0.12), C.wall, T(6, 7.0, 0));
      for (const s of [-1, 1]) {
        P.add(box(20.3, 0.9, 0.2), C.accent, T(6, 6.9, s * 7.05));
        P.add(box(0.2, 0.9, 14.3), C.accent, T(6 + s * 10.05, 6.9, 0));
      }
      for (const [dx, dz] of [[-8, -6], [-8, 6], [8, -6], [8, 6]]) P.add(box(0.5, 6.7, 0.5), C.steel, T(6 + dx, 3.35, dz));
      P.add(rbox(8, 0.3, 2.2, 0.06), C.concrete, T(6, 0.25, 0));
      for (const s of [-1, 1]) {
        P.add(rbox(1.0, 2.2, 0.7, 0.08), 0xf4f4f0, T(6 + s * 2, 1.5, 0));
        P.add(rbox(1.1, 0.4, 0.8, 0.06), C.accent, T(6 + s * 2, 2.8, 0));
        P.add(box(0.6, 0.4, 0.05), C.glass, T(6 + s * 2, 2.0, 0.37));
        D.add(box(0.06, 1, 0.06), C.black, BM(V(6 + s * 2 + 0.4, 1.8, 0.3), V(6 + s * 2 + 0.9, 0.6, 1.2)));
      }
      P.add(rbox(6, 3.2, 5, 0.1), C.wall, T(18, 1.6, -5));
      P.add(rbox(6.6, 0.4, 5.6, 0.06), C.roof, T(18, 3.4, -5));
      P.add(box(2.5, 1.0, 0.1), C.glass, T(17, 2.0, -2.45));
      P.add(box(1.0, 2.2, 0.1), 0x5a6068, T(19.6, 1.1, -2.45));
      return { main: P.build(), detail: D.build() };
    });
    const g = new THREE.Group();
    mk(g, G.main, VC());
    mk(g, G.detail, VC(), { detail: true });
    return finish(g, {}, { length: 36, width: 20, height: 7.3 });
  }

  return {
    truck, excavator, drill, crusher, conveyor, building, stockpile, dump, lightMast, powerLine, fence, fuelStation,
    colors: C, sizes: MODEL_SIZES, materials: matCache,
  };
}
