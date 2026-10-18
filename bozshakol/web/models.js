// Библиотека низкополигональных 3D-моделей техники и сооружений рудника Бозшаколь (three.js 0.160).
// Модели собираются из простых фигур, без внешних файлов, в РЕАЛЬНЫХ размерах (метры),
// ось «вперёд» = +Z, низ на y = 0 (ставится на землю). Вертикальное преувеличение рельефа (VZ)
// к моделям не применяется — его учитывает только ctx.toScene для положения.
//
// Подключение (один раз, например в app.js или в слое):
//   import { createModels, MODEL_SIZES } from './models.js';
//   const models = createModels(THREE, colors);   // colors — палитра сцены (ctx.colors)
//
// Использование в слое участника:
//   const g = ctx.models.truck({ cls: 135 }); ctx.group.add(g); ...
//   в update: g.position.copy(ctx.toScene(x, y, z)); g.rotation.y = -heading*Math.PI/180;
//             g.setLoad(cargo_type); g.setDumping(state === 'dumping' ? 1 : 0); g.setWheels(odometer_m);
//
// Каждая фабрика возвращает THREE.Group; методы висят и на самой группе, и в group.userData.api.
// Общие методы всех моделей:
//   setDetail('full' | 'far') — в 'far' прячутся мелкие детали (перила, фары, гидроцилиндры, диски);
//   setState(state)           — 'down' (или 'stopped' для дробилки) красит корпус в красный, иначе обычный цвет.
//
// Фабрики:
//   models.truck({ cls: 135 | 180 })      самосвал: setDumping(t 0..1), setLoad('sulphide'|'clay'|'waste'|'none'),
//                                         setState('down'|…), setWheels(пройденный путь, м)
//   models.excavator()                    экскаватор: setSwing(рад, + против часовой), setBoom(t 0..1: копает → выгрузка), setState
//   models.drill()                        буровой станок: setMast(true — мачта вертикально / false — уложена), setState
//   models.crusher()                      дробилка: setState('running'|'idle'|'stopped')
//   models.conveyor(points, opts)         конвейер по ломаной (точки уже в сцене): setFlow(tph, dt)
//                                         opts: { height: 3 (высота ленты над точками), step: 25 (шаг опор) }
//   models.building(type, opts)           'main'|'thickener'|'warehouse'|'substation'|'office'; opts.size = [д, ш, в]
//   models.stockpile(volume_m3, opts)     штабель (откос 37°): setVolume(v); opts.color
//   models.dump(radius, height, opts)     отвал — ступенчатые террасы; opts.tiers (по умолчанию 3)
//   models.lightMast(h)                   осветительная мачта
//   models.powerLine(points, opts)        ЛЭП по точкам сцены: опоры + провода; opts.height (20)
//   models.fence(points, opts)            ограждение по точкам сцены: столбики + проволока
//
// Треугольников (full): самосвал ≈ 500, экскаватор ≈ 420, буровой ≈ 230, дробилка ≈ 300,
// здания 50–200, опора конвейера 24. Точные числа — в отчёте/демо (renderer.info.render.triangles).

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
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();

  // ---------------------------------------------------------------- палитра моделей
  const C = {
    sulphide: colors.sulphide ?? 0x3d8f6e, clay: colors.clay ?? 0xc8722a, waste: colors.waste ?? 0x8a8a8a,
    down: colors.down ?? 0xd32f2f,
    frame: 0xf2b322, frameDark: 0xc98d0f,          // жёлтая рама и тёмно-жёлтые узлы
    bed: 0xb9bcc0, bedDown: 0xc9524a,             // кузов — светло-серый металл
    cab: 0xf6f3ea, cabDown: 0xe07a70,             // белая кабина
    tyre: 0x2a2a2a, rim: 0xd9d9d9, glass: 0x4f6f8a, lamp: 0xfff2b0,
    exc: colors.excavator ?? 0xf2a21b, excDark: 0xb97a12, excDown: 0xd84a3d, track: 0x3a3a3a, steel: 0x5b6168,
    drill: colors.drill ?? 0x4f6d8f, drillDark: 0x3a5068, mast: 0x9aa6b4,
    concrete: 0xb9b5aa, concreteDark: 0x8d8a82, crusher: 0x7d8692, crusherDown: 0xc5473e,
    wall: colors.building ?? 0xd8d8d8, roof: colors.roof ?? 0xa9b8cc, conveyor: colors.conveyor ?? 0x6f7f95,
    belt: 0x2f3338, ore: 0x6b7a5a, water: 0x6f8fa8, trafo: 0x7a8794, copper: 0xa36a3c,
    dump: colors.dump ?? 0x9a9a9a, dumpDark: 0x868686, pile: 0x7d6f5c, pole: 0x6d6d6d, wire: 0x3a3a3a,
    green: 0x43b36a, amber: 0xf2c94c, red: 0xd32f2f,
  };

  // ---------------------------------------------------------------- кэш материалов (общие для всех экземпляров)
  const matCache = new Map();
  function mat(key, color, opts) {
    const k = key + '|' + color + '|' + JSON.stringify(opts || {});
    let m = matCache.get(k);
    if (!m) {
      m = new THREE.MeshLambertMaterial(Object.assign({ color }, opts || {}));
      matCache.set(k, m);
    }
    return m;
  }
  const flat = (color, opts) => mat('f', color, Object.assign({ flatShading: true }, opts || {}));
  const smooth = (color, opts) => mat('s', color, opts);
  const lineMat = (() => { const c = {}; return (color) => c[color] || (c[color] = new THREE.LineBasicMaterial({ color })); })();

  // ---------------------------------------------------------------- геометрические помощники
  const boxGeoCache = new Map();
  function boxGeo(w, h, d) {
    const k = w + 'x' + h + 'x' + d;
    let g = boxGeoCache.get(k);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); boxGeoCache.set(k, g); }
    return g;
  }
  // коробка: mat, размеры, положение центра; detail = true — мелкая деталь (прячется в 'far')
  function box(parent, m, w, h, d, x, y, z, detail) {
    const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
    mesh.position.set(x, y, z);
    if (detail) mesh.userData.detail = true;
    parent.add(mesh);
    return mesh;
  }
  // цилиндр по оси Y
  function cyl(parent, m, rTop, rBot, h, seg, x, y, z, detail, open) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!open), m);
    mesh.position.set(x, y, z);
    if (detail) mesh.userData.detail = true;
    parent.add(mesh);
    return mesh;
  }
  // профиль (точки [z, y]) вытянутый по X на ширину w, центр по X
  function profile(parent, m, pts, w, detail) {
    const shape = new THREE.Shape();
    pts.forEach(([z, y], i) => (i ? shape.lineTo(z, y) : shape.moveTo(z, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, m);
    mesh.rotation.y = -Math.PI / 2;      // ось профиля → +Z, глубина вытяжки → −X
    mesh.position.x = w / 2;
    if (detail) mesh.userData.detail = true;
    parent.add(mesh);
    return mesh;
  }
  const unitCyl6 = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);   // для гидроцилиндров
  // поставить цилиндр единичной высоты между точками a и b (в системе родителя)
  function alignCyl(mesh, a, b, r) {
    tmpV.subVectors(b, a);
    const len = tmpV.length() || 0.001;
    mesh.position.copy(a).addScaledVector(tmpV, 0.5);
    mesh.scale.set(r, len, r);
    mesh.quaternion.setFromUnitVectors(UP, tmpV.normalize());
  }
  function hydraulic(parent, r) {
    const m = new THREE.Mesh(unitCyl6, smooth(C.steel));
    m.userData.detail = true; m.userData.r = r || 0.22;
    parent.add(m);
    return m;
  }
  // гусеничная тележка: профиль со скошенными концами, ширина w, длина l, высота h
  function track(parent, l, h, w, x) {
    const t = profile(parent, flat(C.track), [
      [-l / 2 + 0.6, 0], [l / 2 - 0.6, 0], [l / 2, h * 0.35], [l / 2 - 0.5, h], [-l / 2 + 0.5, h], [-l / 2, h * 0.35],
    ], w);
    t.position.x = x + w / 2;
    // светлая полоса катков
    box(parent, flat(C.steel), w + 0.1, h * 0.25, l * 0.75, x, h * 0.45, 0, true);
    return t;
  }

  // ---------------------------------------------------------------- общие методы
  function finish(group, api, size) {
    api.setDetail = api.setDetail || function (level) {
      const show = level !== 'far';
      group.traverse((o) => { if (o.userData.detail) o.visible = show; });
    };
    api.setState = api.setState || function (state) {
      const down = state === 'down' || state === 'failed';
      for (const s of group.userData.swaps || []) s.mesh.material = down ? s.down : s.normal;
    };
    group.userData.api = api;
    group.userData.size = size;
    Object.assign(group, api);
    return group;
  }
  // запомнить меш для перекраски в «аварию»
  function swap(group, mesh, normal, down) {
    (group.userData.swaps = group.userData.swaps || []).push({ mesh, normal, down });
    return mesh;
  }

  // ================================================================ САМОСВАЛ (Cat 793 / 795)
  function truck(opts) {
    const cls = (opts && opts.cls) === 180 ? 180 : 135;
    const S = cls === 180 ? MODEL_SIZES.truck180 : MODEL_SIZES.truck135;
    const L = S.length, W = S.width, H = S.height, R = S.wheel / 2, TW = R * 0.6;   // радиус и ширина шины
    const g = new THREE.Group();
    const mFrame = flat(C.frame), mFrameD = flat(C.frameDark), mBed = flat(C.bed), mCab = flat(C.cab);
    const mTyre = smooth(C.tyre), mRim = flat(C.rim);

    // рама и мосты
    box(g, mFrame, W * 0.55, 1.1, L * 0.86, 0, R + 0.25, 0.2);
    box(g, mFrameD, W * 0.8, 0.6, 1.0, 0, R, L * 0.3);          // передний мост
    box(g, mFrameD, W * 0.85, 0.9, 1.4, 0, R, -L * 0.27);       // задний мост
    box(g, mFrameD, W * 0.5, 1.6, 2.2, 0, R + 0.4, -L * 0.42);  // задняя балка/сцепка

    // колёса: 2 спереди, 4 сзади (сдвоенные). Ось шины — X
    const wheels = [];
    const tyreGeo = new THREE.CylinderGeometry(R, R, TW, 10);
    const rimGeo = new THREE.CircleGeometry(R * 0.55, 10);
    const addWheel = (x, z, outer) => {
      const w = new THREE.Mesh(tyreGeo, mTyre);
      w.position.set(x, R, z); w.rotation.set(0, 0, Math.PI / 2);
      g.add(w); wheels.push(w);
      if (outer) {   // диск только на внешней стороне
        const rim = new THREE.Mesh(rimGeo, mRim);
        rim.position.set(x + Math.sign(x) * (TW / 2 + 0.02), R, z);
        rim.rotation.y = Math.sign(x) * Math.PI / 2;
        rim.userData.detail = true; g.add(rim);
      }
    };
    const xo = W / 2 - TW / 2;
    addWheel(xo, L * 0.3, true); addWheel(-xo, L * 0.3, true);
    addWheel(xo, -L * 0.27, true); addWheel(-xo, -L * 0.27, true);
    addWheel(xo - TW - 0.15, -L * 0.27, false); addWheel(-(xo - TW - 0.15), -L * 0.27, false);

    // передок: капот/радиатор, площадка, кабина слева (+X), перила, лестница, фары
    const deckY = R * 2 + 0.3;                                     // площадка над передними колёсами
    box(g, mFrame, W * 0.6, deckY - 1.6, 2.4, 0, (deckY + 1.6) / 2 - 0.5, L * 0.44);     // радиатор
    box(g, flat(C.steel), W * 0.5, 0.5, 0.3, 0, deckY - 1.0, L * 0.5 + 0.1, true);       // решётка
    box(g, mFrame, W, 0.3, 3.4, 0, deckY, L * 0.36);               // палуба
    const cabW = W * 0.34, cabH = H - deckY - 0.15;
    const cab = swap(g, box(g, mCab, cabW, cabH, 2.6, W / 2 - cabW / 2 - 0.2, deckY + cabH / 2 + 0.15, L * 0.33), mCab, flat(C.cabDown));
    box(g, smooth(C.glass), cabW - 0.4, cabH * 0.45, 0.15, cab.position.x, cab.position.y + cabH * 0.1, L * 0.33 + 1.33, true); // лобовое стекло
    box(g, mFrame, W * 0.3, 1.2, 2.2, -W * 0.25, deckY + 0.75, L * 0.3);                 // воздушные фильтры справа
    // перила площадки (мелкие детали)
    const mRail = smooth(C.rim);
    box(g, mRail, W - 0.2, 0.08, 0.08, 0, deckY + 1.1, L * 0.5, true);
    box(g, mRail, 0.08, 1.0, 0.08, W / 2 - 0.1, deckY + 0.6, L * 0.5, true);
    box(g, mRail, 0.08, 1.0, 0.08, -W / 2 + 0.1, deckY + 0.6, L * 0.5, true);
    box(g, mRail, 0.08, 1.0, 0.08, 0, deckY + 0.6, L * 0.5, true);
    const ladder = box(g, mRail, 0.6, 0.1, 2.4, -W / 2 - 0.1, deckY - 1.1, L * 0.3, true);  // трап справа (под наклоном)
    ladder.rotation.x = -1.1;
    // фары
    const mLamp = smooth(C.lamp, { emissive: C.lamp, emissiveIntensity: 0.6 });
    box(g, mLamp, 0.5, 0.3, 0.2, W * 0.22, deckY - 0.6, L * 0.5 + 0.12, true);
    box(g, mLamp, 0.5, 0.3, 0.2, -W * 0.22, deckY - 0.6, L * 0.5 + 0.12, true);

    // кузов: поворачивается вокруг задней оси
    const bedPivot = new THREE.Group();
    const pivotY = R + 1.2, pivotZ = -L * 0.44;
    bedPivot.position.set(0, pivotY, pivotZ);
    g.add(bedPivot);
    const bedFloor = R * 2 + 0.6 - pivotY;                         // пол кузова чуть выше колёс
    const bedTop = H - 0.5 - pivotY;
    const zb = -L * 0.5 - pivotZ, zf = L * 0.12 - pivotZ;           // задний и передний край
    const bed = swap(g, profile(bedPivot, mBed, [
      [zb + 0.3, bedFloor - 0.4], [zf, bedFloor - 0.4], [zf, bedTop], [zf + 0.4, bedTop + 0.1],
      [zf + 0.4, bedTop + 0.5], [zb - 0.4, bedTop + 0.5], [zb - 0.1, bedFloor + 0.6],
    ], W), mBed, flat(C.bedDown));
    // козырёк над кабиной
    const canopy = box(bedPivot, mBed, W, 0.4, L * 0.32, 0, bedTop + 0.3, zf + 0.4 + L * 0.16);
    box(bedPivot, mBed, W * 0.9, 0.5, 0.6, 0, bedTop - 0.0, zf + 0.6, true);     // ребро козырька
    // рёбра жёсткости днища (деталь)
    box(bedPivot, mBed, W + 0.2, 0.3, 0.3, 0, bedFloor - 0.5, (zb + zf) / 2, true);
    box(bedPivot, mBed, W + 0.2, 0.3, 0.3, 0, bedFloor - 0.5, (zb + zf) / 2 + 3, true);
    // груз: «горка» — коробка, повёрнутая на 45° (гребень вдоль кузова)
    const loadSide = W * 0.46;
    const load = new THREE.Mesh(boxGeo(loadSide, loadSide, (zf - zb) * 0.8), flat(C.waste));
    load.rotation.z = Math.PI / 4;
    load.position.set(0, bedTop - loadSide * 0.3, (zb + zf) / 2);
    load.visible = false;
    bedPivot.add(load);
    const loadMats = { sulphide: flat(C.sulphide), clay: flat(C.clay), waste: flat(C.waste) };

    const api = {
      setDumping(t) { bedPivot.rotation.x = -Math.max(0, Math.min(1, t || 0)) * 45 * DEG; },
      setLoad(type) {
        const m = loadMats[type];
        load.visible = !!m;
        if (m) load.material = m;
      },
      setWheels(dist) { const a = (dist || 0) / R; for (const w of wheels) w.rotation.x = a; },
    };
    g.userData.parts = { bedPivot, bed, cab, canopy, load, wheels };
    return finish(g, api, S);
  }

  // ================================================================ ЭКСКАВАТОР (Hitachi EX3600, обратная лопата)
  function excavator() {
    const S = MODEL_SIZES.excavator;
    const g = new THREE.Group();
    const mExc = flat(C.exc), mExcD = flat(C.excDark), mSteel = flat(C.steel);
    // ходовая: две гусеницы и рама между ними
    track(g, 9.6, 2.4, 1.5, 2.75); track(g, 9.6, 2.4, 1.5, -4.25);
    box(g, mExcD, 4.2, 1.6, 5.5, 0, 1.6, 0);
    cyl(g, mExcD, 1.6, 1.6, 0.8, 12, 0, 2.7, 0);                 // опорно-поворотный круг
    // поворотная платформа
    const swing = new THREE.Group(); swing.position.y = 3.1; g.add(swing);
    const house = swap(g, box(swing, mExc, 6.6, 3.0, 8.6, 0, 1.5, -1.2), mExc, flat(C.excDown));
    box(swing, mExcD, 7.0, 2.6, 2.4, 0, 1.6, -6.6);              // противовес
    box(swing, mExc, 4.2, 1.0, 5.0, -0.9, 3.5, -2.2);            // капот двигателя
    cyl(swing, mSteel, 0.25, 0.25, 1.6, 6, -2.2, 4.6, -3.5, true);   // выхлопная труба
    box(swing, mSteel, 1.2, 0.6, 1.2, 1.6, 3.3, -3.5, true);     // воздухозаборник
    // кабина слева спереди (+X), приподнята
    const cab = swap(g, box(swing, flat(C.cab), 2.2, 2.4, 3.0, 2.3, 4.2, 2.6), flat(C.cab), flat(C.cabDown));
    box(swing, smooth(C.glass), 1.9, 1.5, 0.15, 2.3, 4.5, 4.15, true);          // стекло
    box(swing, mExc, 2.4, 1.2, 3.2, 2.3, 2.4, 2.6);              // подкабинная тумба
    // перила на платформе (деталь)
    const mRail = smooth(C.rim);
    box(swing, mRail, 0.06, 0.9, 8.4, -3.3, 3.5, -1.2, true);
    box(swing, mRail, 6.6, 0.06, 0.06, 0, 3.9, -7.7, true);
    box(swing, mRail, 0.06, 0.9, 2.4, 3.3, 3.5, -6.6, true);
    // стрела (профиль «банан» 10 м), рукоять 5 м, ковш
    const boomPivot = new THREE.Group(); boomPivot.position.set(0, 2.2, 2.4); swing.add(boomPivot);
    profile(boomPivot, mExc, [[-0.4, -0.9], [0, 0.9], [4.5, 1.9], [9.6, 0.9], [10.2, 0], [9.6, -0.7], [4.5, -0.3]], 1.8);
    box(boomPivot, mExcD, 2.6, 1.2, 1.6, 0, 0, 0.2);             // пята стрелы
    const stickPivot = new THREE.Group(); stickPivot.position.set(0, 0.1, 10); boomPivot.add(stickPivot);
    profile(stickPivot, mExc, [[-1.0, -0.5], [-0.6, 0.9], [1.5, 1.2], [5.2, 0.4], [5.2, -0.5], [0, -0.9]], 1.4);
    const bucketPivot = new THREE.Group(); bucketPivot.position.set(0, 0, 5.1); stickPivot.add(bucketPivot);
    // ковш 22 м³ (≈ 3,8 × 2,6 × 2,6 м): корпус + боковины + зубья
    const mBucket = flat(C.steel);
    box(bucketPivot, mBucket, 3.4, 2.6, 2.2, 0, -1.2, 0.6);
    box(bucketPivot, mBucket, 0.2, 2.8, 2.8, 1.9, -1.2, 0.4);
    box(bucketPivot, mBucket, 0.2, 2.8, 2.8, -1.9, -1.2, 0.4);
    for (let i = 0; i < 4; i++) box(bucketPivot, mExcD, 0.3, 0.3, 0.9, -1.35 + i * 0.9, -2.5, 1.9, true);
    // гидроцилиндры (детали, выравниваются в setBoom)
    const cylBoomL = hydraulic(swing, 0.28), cylBoomR = hydraulic(swing, 0.28);
    const cylStick = hydraulic(boomPivot, 0.26), cylBucket = hydraulic(stickPivot, 0.22);
    const pA = new THREE.Vector3(), pB = new THREE.Vector3();
    let boomT = 0;

    function setBoom(t) {
      boomT = Math.max(0, Math.min(1, t || 0));
      const a = (22 + 30 * boomT) * DEG;             // стрела: 22° (копает) → 52° (выгрузка)
      const s = (-100 + 25 * boomT) * DEG;           // рукоять относительно стрелы
      const b = (-70 + 95 * boomT) * DEG;            // ковш относительно рукояти: подогнут → раскрыт
      boomPivot.rotation.x = -a;
      stickPivot.rotation.x = -s;
      bucketPivot.rotation.x = -b;
      swing.updateMatrixWorld(true);
      // цилиндры стрелы: от платформы к середине стрелы
      pB.set(1.4, -0.5, 4.6); boomPivot.localToWorld(pB); swing.worldToLocal(pB);
      alignCyl(cylBoomL, pA.set(1.4, 0.8, 3.4), pB, cylBoomL.userData.r);
      pB.set(-1.4, -0.5, 4.6); boomPivot.localToWorld(pB); swing.worldToLocal(pB);
      alignCyl(cylBoomR, pA.set(-1.4, 0.8, 3.4), pB, cylBoomR.userData.r);
      // цилиндр рукояти: от верха стрелы к пятке рукояти
      pB.set(0, 1.0, -0.9); stickPivot.localToWorld(pB); boomPivot.worldToLocal(pB);
      alignCyl(cylStick, pA.set(0, 1.9, 3.6), pB, cylStick.userData.r);
      // цилиндр ковша: вдоль рукояти к тяге ковша
      pB.set(0, 0.6, -0.4); bucketPivot.localToWorld(pB); stickPivot.worldToLocal(pB);
      alignCyl(cylBucket, pA.set(0, 1.1, 0.8), pB, cylBucket.userData.r);
    }
    setBoom(0);
    const api = {
      setSwing(rad) { swing.rotation.y = rad || 0; },
      setBoom,
      get boomT() { return boomT; },
    };
    g.userData.parts = { swing, boomPivot, stickPivot, bucketPivot, house, cab };
    return finish(g, api, S);
  }

  // ================================================================ БУРОВОЙ СТАНОК
  function drill() {
    const S = MODEL_SIZES.drill;
    const g = new THREE.Group();
    const mBody = flat(C.drill), mDark = flat(C.drillDark), mMast = flat(C.mast);
    track(g, 8.0, 1.8, 1.1, 1.9); track(g, 8.0, 1.8, 1.1, -3.0);
    box(g, mDark, 3.4, 1.0, 6.0, 0, 1.4, 0);
    const deck = swap(g, box(g, mBody, 5.0, 1.0, 11.0, 0, 2.4, 0), mBody, flat(C.cabDown));          // палуба
    swap(g, box(g, mBody, 3.6, 2.6, 5.0, -0.4, 4.2, -0.5), mBody, flat(C.cabDown));                 // машинное отделение
    box(g, flat(C.cab), 2.2, 2.4, 2.4, 1.3, 4.1, 3.8);                                              // кабина слева спереди
    box(g, smooth(C.glass), 1.9, 1.3, 0.12, 1.3, 4.4, 5.05, true);
    box(g, mDark, 1.6, 0.9, 2.0, 1.4, 3.4, 1.4, true);                                              // компрессор
    // домкраты (детали)
    for (const [x, z] of [[2.2, 4.6], [-2.2, 4.6], [2.2, -4.6], [-2.2, -4.6]]) cyl(g, mDark, 0.22, 0.3, 2.6, 6, x, 1.3, z, true);
    // мачта 20 м: поворачивается у основания (вертикально ↔ уложена вперёд вдоль палубы)
    const mastPivot = new THREE.Group(); mastPivot.position.set(0, 2.9, -3.6); g.add(mastPivot);
    const MH = S.mast;
    box(mastPivot, mMast, 0.5, MH, 0.5, 0.7, MH / 2, 0.7);
    box(mastPivot, mMast, 0.5, MH, 0.5, -0.7, MH / 2, 0.7);
    box(mastPivot, mMast, 0.5, MH, 0.5, 0.7, MH / 2, -0.7);
    box(mastPivot, mMast, 0.5, MH, 0.5, -0.7, MH / 2, -0.7);
    for (let i = 1; i <= 5; i++) {                                    // раскосы-перемычки
      box(mastPivot, mMast, 1.9, 0.25, 0.25, 0, i * MH / 5 - 0.2, 0.7, true);
      box(mastPivot, mMast, 0.25, 0.25, 1.9, 0.7, i * MH / 5 - 0.2, 0, true);
    }
    box(mastPivot, mDark, 2.0, 1.6, 2.0, 0, MH - 0.8, 0);            // оголовок с лебёдкой
    cyl(mastPivot, smooth(C.steel), 0.16, 0.16, MH * 0.9, 6, 0, MH * 0.45, 0, true);   // буровая штанга
    box(mastPivot, mDark, 1.6, 0.8, 1.6, 0, 1.2, 0);                  // вращатель
    const api = {
      setMast(up) { mastPivot.rotation.x = up === false ? -82 * DEG : 0; },   // уложена — вперёд, вдоль палубы
    };
    g.userData.parts = { mastPivot, deck };
    return finish(g, api, S);
  }

  // ================================================================ ГИРАЦИОННАЯ ДРОБИЛКА
  function crusher() {
    const S = MODEL_SIZES.crusher;
    const g = new THREE.Group();
    const mConc = flat(C.concrete), mConcD = flat(C.concreteDark), mBody = flat(C.crusher), mSteel = flat(C.steel);
    const B = 25, HB = 20;
    // бетонное основание с площадкой разгрузки сверху
    box(g, mConc, B, HB, B, 0, HB / 2, 0);
    // пандус-въезд с тыла (−Z)
    const ramp = profile(g, mConcD, [[-B / 2 - 34, 0], [-B / 2, 0], [-B / 2, HB]], B * 0.8);
    ramp.position.z = 0;
    // парапеты (отбойные брусья) по краям площадки
    box(g, mConcD, B, 1.2, 1.0, 0, HB + 0.6, B / 2 - 0.5);
    box(g, mConcD, 1.0, 1.2, B, B / 2 - 0.5, HB + 0.6, 0);
    box(g, mConcD, 1.0, 1.2, B, -B / 2 + 0.5, HB + 0.6, 0);
    // приёмный бункер-воронка (открытый конус, видимый изнутри)
    cyl(g, flat(C.steel, { side: THREE.DoubleSide }), 8.5, 2.6, 6.0, 12, 0, HB + 0.2, 0, false, true);
    cyl(g, flat(C.concreteDark), 2.6, 2.6, 0.6, 12, 0, HB - 2.9, 0);  // горловина
    // корпус дробилки (пристройка сбоку, +X) и навес над воронкой
    const body = swap(g, box(g, mBody, 12, 16, 16, B / 2 + 6, 8, 0), mBody, flat(C.crusherDown));
    box(g, flat(C.roof), 13, 1.0, 17, B / 2 + 6, 16.5, 0);
    box(g, mBody, 6, 10, 6, B / 2 + 6, 22, 0);                        // привод / станина над корпусом
    // навес (козырёк на четырёх стойках) над площадкой
    for (const [x, z] of [[-B / 2 + 1.5, -B / 2 + 1.5], [B / 2 - 1.5, -B / 2 + 1.5], [-B / 2 + 1.5, B / 2 - 1.5], [B / 2 - 1.5, B / 2 - 1.5]])
      box(g, mSteel, 0.6, 9, 0.6, x, HB + 4.5, z, true);
    box(g, flat(C.roof), B + 2, 0.6, B / 2 + 2, 0, HB + 9.3, B / 4 - 1);
    // рукав пылеподавления и лестница (детали)
    cyl(g, mSteel, 0.5, 0.5, 14, 6, B / 2 + 11, 24, -6, true);
    box(g, mSteel, 0.8, HB, 0.3, B / 2 + 0.3, HB / 2, B / 2 + 0.2, true);
    // выход на конвейер: наклонная галерея из-под основания вперёд (+Z)
    const out = box(g, flat(C.conveyor), 3.2, 2.0, 24, 0, 5, B / 2 + 10);
    out.rotation.x = -14 * DEG;
    box(g, mSteel, 0.5, 6, 0.5, 1.2, 3, B / 2 + 16, true);
    box(g, mSteel, 0.5, 6, 0.5, -1.2, 3, B / 2 + 16, true);
    // индикатор состояния — фонарь на корпусе
    const lampMats = {
      running: smooth(C.green, { emissive: C.green, emissiveIntensity: 0.8 }),
      idle: smooth(C.amber, { emissive: C.amber, emissiveIntensity: 0.8 }),
      stopped: smooth(C.red, { emissive: C.red, emissiveIntensity: 0.9 }),
    };
    const lamp = cyl(g, lampMats.running, 0.8, 0.8, 1.6, 8, B / 2 + 6, 27.8, 0);
    const api = {
      setState(state) {
        const stopped = ['stopped', 'stop', 'down', 'failed', 'off', 'maintenance'].includes(state);
        lamp.material = stopped ? lampMats.stopped : (state === 'idle' ? lampMats.idle : lampMats.running);
        body.material = stopped ? flat(C.crusherDown) : mBody;
      },
    };
    g.userData.parts = { body, lamp };
    return finish(g, api, S);
  }

  // ================================================================ ЛЕНТОЧНЫЙ КОНВЕЙЕР
  // points — массив THREE.Vector3 в сцене (уже через toScene); лента на opts.height (3 м) над точками
  function conveyor(points, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const S = MODEL_SIZES.conveyor;
    const lift = opts.height ?? 3, step = opts.step ?? S.support_step, BW = S.belt_width;
    const pts = points.map((p) => new THREE.Vector3(p.x, p.y + lift, p.z));
    const mBelt = smooth(C.belt), mFrame = flat(C.conveyor);
    // сегменты: лента + рама
    const segs = []; let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], len = a.distanceTo(b);
      if (len < 0.01) continue;
      const seg = new THREE.Group();
      seg.position.copy(a).lerp(b, 0.5); seg.lookAt(b);
      box(seg, mFrame, BW + 0.8, 0.5, len, 0, -0.35, 0);
      box(seg, mBelt, BW, 0.18, len + 0.1, 0, 0, 0);
      box(seg, mFrame, 0.12, 0.9, len, BW / 2 + 0.3, 0.1, 0, true);    // бортики-перила
      box(seg, mFrame, 0.12, 0.9, len, -BW / 2 - 0.3, 0.1, 0, true);
      g.add(seg);
      segs.push({ a, b, len, start: total, dir: b.clone().sub(a).normalize() });
      total += len;
    }
    // опоры каждые step м: две стойки (InstancedMesh, 12 треугольников каждая → опора = 24)
    const legPos = [];
    for (const s of segs) {
      for (let d = step / 2; d < s.len; d += step) {
        const p = s.a.clone().addScaledVector(s.dir, d);
        const side = new THREE.Vector3(-s.dir.z, 0, s.dir.x).normalize().multiplyScalar(BW / 2 + 0.3);
        legPos.push(p.clone().add(side), p.clone().sub(side));
      }
    }
    if (legPos.length) {
      const legs = new THREE.InstancedMesh(boxGeo(0.3, 1, 0.3), mFrame, legPos.length);
      legPos.forEach((p, i) => {
        tmpM.compose(tmpV.set(p.x, p.y - 0.6 - lift / 2, p.z), tmpQ.identity(), tmpS.set(1, lift, 1));
        legs.setMatrixAt(i, tmpM);
      });
      legs.instanceMatrix.needsUpdate = true;
      g.add(legs);
    }
    // груз: «кучки» руды скользят по ленте
    const maxN = Math.max(1, Math.min(60, Math.floor(total / 10)));
    const lumps = new THREE.InstancedMesh(boxGeo(BW * 0.7, 0.45, 1.4), flat(C.ore), maxN);
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
    const api = {
      length: total,
      setFlow(tph, dt) {
        const n = tph > 0 && total > 0 ? Math.max(1, Math.min(maxN, Math.round(tph / 300))) : 0;
        lumps.count = n;
        if (!n) return;
        offset = (offset + S.speed_mps * (dt || 0)) % total;
        const spacing = total / n;
        for (let i = 0; i < n; i++) {
          placeAt(offset + i * spacing, slot);
          tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), slot.dir);
          tmpM.compose(tmpV.set(slot.pos.x, slot.pos.y + 0.3, slot.pos.z), tmpQ, tmpS.set(1, 1, 1));
          lumps.setMatrixAt(i, tmpM);
        }
        lumps.instanceMatrix.needsUpdate = true;
      },
    };
    g.userData.parts = { lumps, segs };
    return finish(g, api, { length: total, width: BW });
  }

  // ================================================================ ЗДАНИЯ
  function building(type, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const size = (opts.size || MODEL_SIZES.building[type] || [20, 12, 8]).slice();
    const [l, w, h] = size;
    const mWall = flat(C.wall), mRoof = flat(C.roof), mSteel = flat(C.steel);
    if (type === 'main') {
      // главный корпус: основной объём, фонари на крыше, пристройки, труба
      box(g, mWall, l, h, w, 0, h / 2, 0);
      box(g, mRoof, l + 1, 0.8, w + 1, 0, h + 0.4, 0);
      for (let i = -1; i <= 1; i++) {
        box(g, mWall, l * 0.26, 2.6, w * 0.35, i * l * 0.3, h + 1.9, 0);           // световые фонари
        box(g, mRoof, l * 0.26 + 0.6, 0.5, w * 0.35 + 0.6, i * l * 0.3, h + 3.4, 0);
      }
      box(g, mWall, l * 0.45, h * 0.55, w * 0.4, -l * 0.2, h * 0.275, w / 2 + w * 0.2);       // пристройка спереди
      box(g, mRoof, l * 0.45 + 0.8, 0.6, w * 0.4 + 0.8, -l * 0.2, h * 0.55 + 0.3, w / 2 + w * 0.2);
      box(g, mWall, l * 0.25, h * 1.3, w * 0.3, l * 0.3, h * 0.65, -w / 2 - w * 0.15);       // высокая часть (мельничный пролёт)
      box(g, mRoof, l * 0.25 + 0.8, 0.6, w * 0.3 + 0.8, l * 0.3, h * 1.3 + 0.3, -w / 2 - w * 0.15);
      cyl(g, flat(C.concreteDark), 1.2, 1.8, h * 1.9, 8, -l / 2 + 4, h * 0.95, -w / 2 + 4);  // труба
      box(g, smooth(C.glass), l * 0.8, 1.6, 0.1, 0, h * 0.6, w / 2 + 0.05, true);             // ленточное остекление
      box(g, smooth(C.glass), l * 0.8, 1.6, 0.1, 0, h * 0.6, -w / 2 - 0.05, true);
      box(g, mSteel, 6, 5, 0.3, l * 0.3, 2.5, w / 2 + 0.15, true);                              // ворота
    } else if (type === 'thickener') {
      const r = l / 2, hw = h || 6;
      cyl(g, flat(C.concrete), r, r, hw, 24, 0, hw / 2, 0);
      cyl(g, smooth(C.water), r - 0.8, r - 0.8, 0.3, 24, 0, hw + 0.1, 0);        // зеркало пульпы
      cyl(g, mSteel, 1.0, 1.0, 3.5, 8, 0, hw + 1.6, 0);                            // центральная колонна
      box(g, mSteel, r + 1.5, 0.5, 2.0, r / 2, hw + 1.6, 0);                       // мост
      box(g, smooth(C.rim), r + 1.5, 0.06, 0.06, r / 2, hw + 2.6, 0.9, true);
      box(g, smooth(C.rim), r + 1.5, 0.06, 0.06, r / 2, hw + 2.6, -0.9, true);
      box(g, mSteel, 2.5, 2.0, 2.5, 0, hw + 3.2, 0);                               // привод
    } else if (type === 'warehouse') {
      // ангар: прямоугольник + полукруглая крыша, вытянутый вдоль Z на длину l
      const wallH = Math.max(1, h - w / 2);
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(w / 2, wallH);
      shape.absarc(0, wallH, w / 2, 0, Math.PI, false); shape.lineTo(-w / 2, 0);
      const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false, curveSegments: 8 }), mRoof);
      body.position.z = -l / 2; g.add(body);
      box(g, mWall, w * 0.98, wallH * 0.98, 0.2, 0, wallH / 2, l / 2 + 0.05);     // торцы светлые
      box(g, mWall, w * 0.98, wallH * 0.98, 0.2, 0, wallH / 2, -l / 2 - 0.05);
      box(g, mSteel, w * 0.3, wallH * 0.8, 0.2, 0, wallH * 0.4, l / 2 + 0.2, true);   // ворота
    } else if (type === 'substation') {
      box(g, flat(C.concreteDark), l, 0.5, w, 0, 0.25, 0);                        // гравийная площадка
      const mTr = flat(C.trafo), mIns = smooth(C.copper);
      for (const x of [-l * 0.2, l * 0.2]) {
        box(g, mTr, 6, 5, 4.5, x, 3, -w * 0.15);                                  // бак трансформатора
        box(g, mTr, 7.2, 3.6, 0.8, x, 2.6, -w * 0.15 - 2.6);                       // радиаторы
        box(g, mTr, 7.2, 3.6, 0.8, x, 2.6, -w * 0.15 + 2.6);
        for (let k = -1; k <= 1; k++) cyl(g, mIns, 0.25, 0.4, 2.4, 4, x + k * 1.8, 6.6, -w * 0.15, true, true);   // вводы
      }
      // порталы ОРУ
      const PH = h || 12;
      for (const z of [w * 0.25, w * 0.42]) {
        box(g, mSteel, 0.6, PH, 0.6, -l * 0.4, PH / 2, z);
        box(g, mSteel, 0.6, PH, 0.6, l * 0.4, PH / 2, z);
        box(g, mSteel, l * 0.8 + 0.6, 0.6, 0.6, 0, PH - 0.3, z);
        for (let k = -1; k <= 1; k++) box(g, mIns, 0.25, 2.2, 0.25, k * l * 0.25, PH - 1.7, z, true);   // гирлянды
      }
      box(g, mWall, 10, 4, 6, l * 0.35, 2.25, -w * 0.35);                           // здание РУ
      box(g, mRoof, 10.6, 0.4, 6.6, l * 0.35, 4.4, -w * 0.35);
    } else {
      // office — небольшое здание (АБК)
      box(g, mWall, l, h, w, 0, h / 2, 0);
      box(g, mRoof, l + 0.8, 0.5, w + 0.8, 0, h + 0.25, 0);
      const floors = Math.max(1, Math.round(h / 3.5));
      for (let f = 0; f < floors; f++) box(g, smooth(C.glass), l * 0.85, 1.4, 0.1, 0, 2.0 + f * (h / floors), w / 2 + 0.05, true);
      box(g, mRoof, 5, 0.3, 3, 0, 3.2, w / 2 + 1.5, true);                           // козырёк входа
      box(g, mSteel, 0.2, 3.0, 0.2, 2.2, 1.5, w / 2 + 2.8, true);
      box(g, mSteel, 0.2, 3.0, 0.2, -2.2, 1.5, w / 2 + 2.8, true);
    }
    return finish(g, {}, { length: l, width: w, height: h });
  }

  // ================================================================ ШТАБЕЛЬ РУДЫ (откос 37°)
  const pileGeo = new THREE.CylinderGeometry(0.12, 1, 0.88 * Math.tan(REPOSE), 28);   // единичный усечённый конус
  function stockpile(volume, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const m = flat(opts.color ?? C.pile);
    const mesh = new THREE.Mesh(pileGeo, m);
    g.add(mesh);
    const api = {
      setVolume(v) {
        const r = v > 0 ? Math.cbrt(3 * v / (Math.PI * Math.tan(REPOSE))) : 0;   // V = π r² h / 3, h = r·tg 37°
        const s = Math.max(r, 0.01);
        mesh.scale.setScalar(s);
        mesh.position.y = s * 0.44 * Math.tan(REPOSE);
        mesh.visible = r > 0;
        g.userData.radius = r; g.userData.height = r * Math.tan(REPOSE) * 0.88;
      },
    };
    api.setVolume(volume || 0);
    return finish(g, api, { radius: g.userData.radius, height: g.userData.height });
  }

  // ================================================================ ОТВАЛ — ступенчатые террасы
  function dump(radius, height, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const n = Math.max(1, Math.min(4, opts.tiers ?? 3));
    const R = radius || 200, H = height || 30, th = H / n, slope = Math.tan(35 * DEG);
    let rBot = R, y = 0;
    for (let i = 0; i < n; i++) {
      const rTop = Math.max(rBot * 0.3, rBot - th / slope);
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, th, 32), flat(i % 2 ? C.dumpDark : C.dump));
      tier.position.y = y + th / 2;
      g.add(tier);
      y += th;
      rBot = rTop - R * 0.1;      // ширина бермы между ярусами
    }
    return finish(g, {}, { radius: R, height: H });
  }

  // ================================================================ ОСВЕТИТЕЛЬНАЯ МАЧТА
  function lightMast(h) {
    h = h || MODEL_SIZES.lightMast.height;
    const g = new THREE.Group();
    cyl(g, flat(C.pole), 0.25, 0.45, h, 6, 0, h / 2, 0);
    box(g, flat(C.steel), 2.6, 0.3, 2.6, 0, h, 0);
    const mLamp = smooth(C.lamp, { emissive: C.lamp, emissiveIntensity: 0.9 });
    for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) box(g, mLamp, 0.7, 0.5, 0.7, x, h + 0.5, z, true);
    box(g, smooth(C.rim), 2.6, 0.06, 0.06, 0, h + 1.1, 1.3, true);
    box(g, smooth(C.rim), 2.6, 0.06, 0.06, 0, h + 1.1, -1.3, true);
    return finish(g, {}, { height: h });
  }

  // ================================================================ ЛЭП: опоры по точкам сцены + провода
  function powerLine(points, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const H = opts.height || MODEL_SIZES.powerLine.height;
    const mPole = flat(C.pole);
    const wirePts = [];
    const tops = [];
    points.forEach((p, i) => {
      const next = points[i + 1] || p, prev = points[i - 1] || p;
      const dir = tmpV.subVectors(next, prev); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); dir.normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const tower = new THREE.Group(); tower.position.copy(p); tower.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone()); g.add(tower);
      box(tower, mPole, 0.5, H, 0.5, 2.2, H / 2, 0);
      box(tower, mPole, 0.5, H, 0.5, -2.2, H / 2, 0);
      box(tower, mPole, 9, 0.5, 0.5, 0, H - 1.5, 0);                         // траверса
      box(tower, mPole, 5.4, 0.3, 0.3, 0, H / 2, 0, true);                   // ригель
      for (const x of [-4, 0, 4]) box(tower, smooth(C.rim), 0.2, 1.2, 0.2, x, H - 2.3, 0, true);   // изоляторы
      tops.push([-4, 0, 4].map((x) => p.clone().add(side.clone().multiplyScalar(x)).add(new THREE.Vector3(0, H - 2.9, 0))));
    });
    for (let i = 0; i + 1 < tops.length; i++) {
      for (let k = 0; k < 3; k++) {
        const a = tops[i][k], b = tops[i + 1][k];
        const mid = a.clone().lerp(b, 0.5); mid.y -= Math.min(2.5, a.distanceTo(b) * 0.03);   // провис
        wirePts.push(a, mid, mid, b);
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
    const inst = new THREE.InstancedMesh(boxGeo(0.12, FH, 0.12), flat(C.pole), posts.length);
    posts.forEach((p, i) => { tmpM.makeTranslation(p.x, p.y + FH / 2, p.z); inst.setMatrixAt(i, tmpM); });
    inst.instanceMatrix.needsUpdate = true;
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

  // топливозаправочный пункт: два горизонтальных резервуара на опорах, навес на стойках, колонка, будка
  function fuelStation() {
    const g = new THREE.Group();
    const steel = mat('fuel-steel', 0xd9dcd8), dark = mat('fuel-dark', 0x4a4a48), roof = mat('fuel-roof', 0xb9c4cf), post = mat('fuel-post', 0x8a8f94), wall = mat('fuel-wall', 0xe6e2d8);
    for (const dz of [-6, 6]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 14, 12), steel);
      tank.rotation.z = Math.PI / 2; tank.position.set(-12, 3.2, dz); g.add(tank);
      for (const dx of [-5, 5]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 4.6), dark); leg.position.set(-12 + dx, 1, dz); g.add(leg); }
    }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, 14), roof); canopy.position.set(6, 7, 0); g.add(canopy);
    for (const [dx, dz] of [[-8, -6], [-8, 6], [8, -6], [8, 6]]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), post); p.position.set(6 + dx, 3.5, dz); p.userData.detail = true; g.add(p); }
    const pump = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.8), dark); pump.position.set(6, 1.1, 0); g.add(pump);
    const hut = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 5), wall); hut.position.set(18, 1.6, -5); g.add(hut);
    const hutRoof = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.4, 5.6), roof); hutRoof.position.set(18, 3.4, -5); g.add(hutRoof);
    return finish(g, {}, { length: 36, width: 20, height: 7.3 });
  }

  return {
    truck, excavator, drill, crusher, conveyor, building, stockpile, dump, lightMast, powerLine, fence, fuelStation,
    colors: C, sizes: MODEL_SIZES, materials: matCache,
  };
}
