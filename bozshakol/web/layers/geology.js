// Слой «геология»: забои face-* (развал взорванной горной массы рядом с экскаватором, цвет по типу руды), буровые станки drill-*
// (модель из общей библиотеки ctx.models) и переключатель «Содержание меди» — плитки блоков
// вокруг забоя с цветом по % Cu (данные — признак block_preview двойника забоя).
// Без теней, прозрачности и частиц: слой лёгкий и идёт без видеокарты.
const NS = 'kz.bozshakol';
const MAX_TILES = 200;          // всего плиток на всю сцену
const TILE_M = 25;              // сторона блока, м
// Постоянный множитель размера бурового станка поверх ctx.markerScale: на общем виде «Весь рудник» станок иначе слишком мелкий
// (координатор). Подобран по размерам моделей рядом с экскаваторами и самосвалами модуля №2 (у них множитель только markerScale): корпус станка
// 11 м против 12 м у экскаватора и 13 м у самосвала, поэтому при 1,6 корпус на ~35–45 % крупнее и заметен, а мачта (20 м) не превращает станок
// в великана; при начальных 2,5 станок вдвое крупнее самосвала.
const DRILL_SCALE = 1.6;
const CU_LOW = 0.1, CU_HIGH = 0.7;   // шкала плиток: серый → медный, % Cu
// Развал забоя: неровная насыпь кусков породы, размеры в единицах сцены (экскаватор в схеме — около 21 единицы). Длина — вдоль уступа,
// ширина — от экскаватора вглубь забоя; экскаватор стоит у ближнего края и работает забой сбоку.
const HEAP_L = 96, HEAP_W = 16, HEAP_H = 4.5;
const HEAP_GAP = 5;             // от центра экскаватора до ближнего края насыпи; насыпь узкая, чтобы буровые рядом с экскаватором не оказались на ней
const HEAP_LIFT = 0.2;          // основание над землёй схемы (ctx.groundAt): небольшой запас, чтобы основание не мерцало вровень с поверхностью
const HEAP_LEVELS = 3;          // ступеней крупности развала: 0 — обычный, 3 — крупные глыбы
const HEAP_COLORS = { sulphide: 0x4f8a6e, clay: 0xc9682a, waste: 0x77777a };   // приглушённые: медно-зелёный, рыжий, серый
const HEAP_DIM_TO = 0xc8c8c0;   // не взорван: тот же цвет, сильно разбавленный светло-серым
const OWN_ROCKS = 40;           // кусков собственной геометрии на забой (при отсутствии ctx.models.muckpile)
const BASE_P80 = { sulphide: 440, clay: 300, waste: 620 };   // обычная крупность по типу забоя, мм (см. blasting.py)
const COARSE_FROM = 1.25;       // во сколько раз крупнее обычного считаем «крупным куском» (подпись)
const COARSE_FULL = 0.8;        // при превышении обычной крупности на столько (то есть вдвое) развал самый крупный
const faces = {};    // thingId -> {patch, heap, variants, key, placeKey, seed, x, y, exc, top, baseY, tg, inst, perFace, previewRaw}
const drills = {};   // thingId -> {g, start, cur}
let mats = null;
let tilesGroup = null, tilesOn = false, tilesBtn = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}
function fmtNum(v, digits) {
  return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function nameOf(twin, id) {
  return (twin && twin.attributes && twin.attributes.name) || id.split(':')[1];
}

// Цвет плитки по содержанию меди: серый (0,1 %) → медный (0,7 %).
function cuColor(THREE, cu) {
  const t = Math.max(0, Math.min(1, (cu - CU_LOW) / (CU_HIGH - CU_LOW)));
  return new THREE.Color(0x8c8c8c).lerp(new THREE.Color(0xc4601f), t);
}

function parsePreview(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.length < 2) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function setTilesVisible(on) {
  tilesOn = on;
  if (tilesGroup) tilesGroup.visible = on;
  if (tilesBtn) tilesBtn.classList.toggle('active', on);
}

function makeToggle() {
  const bar = document.getElementById('topbar');
  if (!bar || document.getElementById('btn-geo-cu')) return;
  tilesBtn = document.createElement('button');
  tilesBtn.id = 'btn-geo-cu';
  tilesBtn.type = 'button';
  tilesBtn.textContent = 'Содержание меди';
  tilesBtn.title = 'Плитки блоков вокруг забоев: цвет по % Cu (серый 0,1 % → медный 0,7 %)';
  tilesBtn.addEventListener('click', () => setTilesVisible(!tilesOn));
  const status = document.getElementById('load-status');
  bar.insertBefore(tilesBtn, status || null);
}

// ---------------------------------------------------------------- развал взорванной горной массы
// Размер кусков по ступени крупности: 0 — обычный развал, HEAP_LEVELS — крупные глыбы (множитель к размерам кусков).
const rockScale = (level) => 1.6 + 1.0 * level;

// Собственная геометрия развала: бугристый купол и не больше OWN_ROCKS кусков (коробки и тетраэдры) в ОДНОЙ геометрии с цветом в вершинах.
// Размеры и повороты случайные, но воспроизводимые: зерно — от номера забоя.
function ownMuckpile(THREE, seed, L, W, H, K, hex) {
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const pos = [], col = [];
  const base = new THREE.Color(hex);
  const tones = [base.clone().multiplyScalar(0.7), base.clone().multiplyScalar(1.05), base.clone().lerp(new THREE.Color(0xffffff), 0.3)];   // купол темнее кусков, куски трёх тонов
  const v = new THREE.Vector3(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), tr = new THREE.Vector3();
  const addGeo = (geo, matrix, color) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      pos.push(v.x, v.y, v.z);
      col.push(color.r, color.g, color.b);
    }
  };
  // купол: верхняя половина сферы, растянутая по габаритам, с бугристостью
  const dome = new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const dp = dome.attributes.position;
  for (let i = 0; i < dp.count; i++) {
    const k = dp.getY(i) > 0.02 ? 1 + (rnd() - 0.5) * 0.3 : 1;
    dp.setXYZ(i, dp.getX(i) * k, dp.getY(i) * k, dp.getZ(i) * k);
  }
  addGeo(dome, m.makeScale(L / 2, H, W / 2), tones[0].clone().multiplyScalar(0.85));
  const box = new THREE.BoxGeometry(1, 1, 1), tet = new THREE.TetrahedronGeometry(0.75);
  const n = Math.max(12, Math.min(OWN_ROCKS, Math.round(L * W / 14 / (K * K))));
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.9;
    const size = (1.0 + rnd() * 1.6) * K;
    tr.set(Math.cos(a) * d * L / 2, H * Math.sqrt(Math.max(0, 1 - d * d)) + size * 0.2, Math.sin(a) * d * W / 2);
    q.setFromEuler(e.set(rnd() * 3, rnd() * 3, rnd() * 3));
    sc.set(size, size * (0.6 + rnd() * 0.4), size * (0.8 + rnd() * 0.4));
    addGeo(i % 2 ? box : tet, m.compose(tr, q, sc), tones[i % 3]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
  return g;
}

// Строит развал: ore — тип руды (цвет), dim — не взорван (приглушённый и низкий), level — ступень крупности кусков.
// Если в общей библиотеке есть ctx.models.muckpile() — берём её (форма и куски — её), иначе строим свою геометрию.
// Начало координат группы — центр насыпи на земле, локальная X — вдоль уступа, Z — вглубь забоя.
function buildMuckpile(ctx, ore, dim, level, seed) {
  const THREE = ctx.THREE;
  const color = new THREE.Color(HEAP_COLORS[ore] || HEAP_COLORS.waste);
  if (dim) color.lerp(new THREE.Color(HEAP_DIM_TO), 0.7);
  const K = rockScale(dim ? 0 : level);
  const H = HEAP_H * (dim ? 0.35 : 1 + 0.15 * level);
  let g;
  if (ctx.models && typeof ctx.models.muckpile === 'function') {
    // куски модели одного размера (0,6–2,4 м): для крупного развала строим насыпь тех же габаритов, уменьшенную в K раз, и увеличиваем группу в K раз
    g = ctx.models.muckpile({ length: HEAP_L / K, width: HEAP_W / K, height: H / K }, color.getHex());
    g.scale.setScalar(K);
  } else {
    g = ownMuckpile(THREE, seed, HEAP_L, HEAP_W, H, K, color.getHex());
  }
  g.userData.top = H + 2.4 * K;        // примерная высота гребня с кусками, ед. сцены
  return g;
}

// Положение развала: от экскаватора вглубь забоя, длинной стороной вдоль уступа. Позиция экскаватора — из его двойника (x, y).
// Направление «от экскаватора к забою» считается в плоскости сцены; если экскаватор в самом забое — от центра карьера наружу.
function placeHeap(ctx, rec, ex) {
  const key = ex[0] + ',' + ex[1];
  if (rec.placeKey === key) return;
  rec.placeKey = key;
  const pe = ctx.toScene(ex[0], ex[1], ctx.groundAt(ex[0], ex[1]));
  const pf = ctx.toScene(rec.x, rec.y, ctx.groundAt(rec.x, rec.y));
  let dx = pf.x - pe.x, dz = pf.z - pe.z;
  if (Math.hypot(dx, dz) < 3) {
    const c0 = (ctx.geometry.pit && ctx.geometry.pit.center) || [0, 0];     // центр карьера — из geometry.json
    const pc = ctx.toScene(c0[0], c0[1], ctx.groundAt(c0[0], c0[1]));
    dx = pf.x - pc.x; dz = pf.z - pc.z;
  }
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const off = HEAP_GAP + HEAP_W / 2;
  rec.heap.position.set(pe.x + dx * off, pe.y + HEAP_LIFT, pe.z + dz * off);
  rec.heap.rotation.y = Math.atan2(dx, dz);     // локальная Z — вглубь забоя, локальная X — вдоль уступа
  rec.patch.position.copy(rec.heap.position);
  rec.baseY = rec.heap.position.y;
}

export function init(ctx) {
  const THREE = ctx.THREE;
  mats = {
    tile: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  };
  tilesGroup = new THREE.Group();
  tilesGroup.name = 'geology-cu-tiles';
  ctx.group.add(tilesGroup);
  const objs = ctx.geometry.objects || [];
  const nFaces = objs.filter((o) => o.kind === 'face').length || 1;
  const perFace = Math.max(1, Math.min(33, Math.floor(MAX_TILES / nFaces)));
  const tileGeo = new THREE.PlaneGeometry(TILE_M, TILE_M);
  tileGeo.rotateX(-Math.PI / 2);
  const excOf = {};     // запасное место экскаватора забоя: geometry.json (основное — двойник экскаватора)
  for (const o of objs) if (o.kind === 'excavator' && o.face) excOf[o.face] = o.position;

  for (const o of objs) {
    const id = NS + ':' + o.id;
    if (o.kind === 'face') {
      const [x, y] = o.position;
      const gz = ctx.groundAt(x, y);
      let seed = 0;
      for (const ch of o.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      // patch — пустая группа: цель для наведения и подпись (масштаб ей сцена меняет сама); насыпь лежит отдельно в heap
      const patch = new THREE.Group();
      patch.position.copy(ctx.toScene(x, y, gz + HEAP_LIFT));
      const heap = new THREE.Group();
      heap.position.copy(patch.position);
      ctx.group.add(heap);
      ctx.group.add(patch);
      ctx.register(patch, id, { hitRadius: 60 });
      ctx.label(patch, 'Забой ' + o.id.slice(-2), 2);
      // плитки блоков: один InstancedMesh на забой, всё в группе с центром в забое
      const tg = new THREE.Group();
      tg.position.copy(ctx.toScene(x, y, gz + HEAP_LIFT + 0.6));
      const inst = new THREE.InstancedMesh(tileGeo, mats.tile, perFace);
      inst.count = 0;
      inst.frustumCulled = false;
      tg.add(inst);
      tilesGroup.add(tg);
      faces[id] = { patch, heap, variants: {}, key: '', placeKey: '', seed, x, y, exc: excOf[o.id] || null, top: HEAP_H, baseY: patch.position.y, tg, inst, perFace, previewRaw: null };
    } else if (o.kind === 'drill') {
      const g = ctx.models.drill();
      g.position.copy(ctx.toScene(o.position[0], o.position[1], ctx.groundAt(o.position[0], o.position[1])));
      ctx.group.add(g);
      ctx.register(g, id);
      ctx.label(g, 'Буровой станок ' + o.id.slice(-2), 2);
      drills[id] = { g, start: [o.position[0], o.position[1]], cur: null };
    }
  }
  setTilesVisible(false);
  makeToggle();
}

function applyPreview(ctx, rec, raw) {
  const THREE = ctx.THREE;
  const list = parsePreview(raw).slice(0, rec.perFace);
  const m = new THREE.Matrix4();
  const origin = ctx.toScene(rec.x, rec.y, 0);
  let n = 0;
  for (const t of list) {
    if (!Array.isArray(t) || t.length < 3) continue;
    const p = ctx.toScene(rec.x + t[0], rec.y + t[1], 0);
    m.makeTranslation(p.x - origin.x, 0, p.z - origin.z);
    rec.inst.setMatrixAt(n, m);
    rec.inst.setColorAt(n, cuColor(THREE, Number(t[2])));
    n++;
  }
  rec.inst.count = n;
  rec.inst.instanceMatrix.needsUpdate = true;
  if (rec.inst.instanceColor) rec.inst.instanceColor.needsUpdate = true;
}

export function update(ctx, twins) {
  const S = ctx.markerScale || 1;
  for (const [id, rec] of Object.entries(faces)) {
    const twin = twins[id];
    if (!twin) continue;
    const ore = fv(twin, 'ore_type', 'waste');
    const blasted = fv(twin, 'blasted', true) === true;
    const p80 = Number(fv(twin, 'p80', 0));
    const role = fv(twin, 'face_role', ore);      // обычная крупность — по роли забоя: p80 даёт блок его панели, а при clay_face тип руды меняется принудительно
    const ratio = p80 / (BASE_P80[role] || BASE_P80[ore] || 440);
    const coarse = Math.max(0, Math.min(1, (ratio - 1) / COARSE_FULL));
    const level = blasted ? Math.round(coarse * HEAP_LEVELS) : 0;
    // экскаватор забоя — по его двойнику (x, y); пока там нули, берём место из geometry.json
    const et = twins[twin.attributes && twin.attributes.downstream];
    let ex = [Number(fv(et, 'x', 0)), Number(fv(et, 'y', 0))];
    if (!ex[0] && !ex[1]) ex = rec.exc || [rec.x, rec.y];
    placeHeap(ctx, rec, ex);
    // вариант развала: тип руды, взорван ли блок, ступень крупности; каждый строится один раз и дальше только показывается
    const key = ore + '|' + (blasted ? 1 : 0) + '|' + level;
    if (key !== rec.key) {
      if (rec.variants[rec.key]) rec.variants[rec.key].visible = false;
      let v = rec.variants[key];
      if (!v) {
        v = rec.variants[key] = buildMuckpile(ctx, ore, !blasted, level, rec.seed);
        rec.heap.add(v);
      }
      v.visible = true;
      rec.key = key;
      rec.top = v.userData.top;
    }
    // плитки карты меди — над гребнем насыпи, чтобы не тонули в ней
    rec.tg.position.y = rec.baseY + rec.top + 1;
    rec.tg.scale.setScalar(S);
    const name = nameOf(twin, id);
    let text = name;
    if (ore === 'waste') text += ' · вскрыша';
    else text += ' · ' + fmtNum(fv(twin, 'cu_grade', 0), 2) + ' % Cu · глина ' + fmtNum(fv(twin, 'clay_pct', 0), 0) + ' %';
    if (!blasted) text += ' · не взорван';
    // крупный кусок после взрыва (например, сценарий bad_blast): строка только когда крупность заметно выше обычной
    if (ratio > COARSE_FROM) text += ' · крупный кусок ' + fmtNum(p80, 0) + ' мм · погрузка ×' + fmtNum(fv(twin, 'loading_factor', 1), 2);
    // предупреждение о нехватке бурения: только текст подписи
    const status = fv(twin, 'drilling_ahead_status', 'ok');
    if (status === 'critical') text += ' · нет взорванного запаса';
    else if (status === 'low') text += ' · запас ' + fmtNum(fv(twin, 'blasted_ahead_h', 0), 0) + ' ч';
    rec.patch.userData.label = text;
    const raw = fv(twin, 'block_preview', null);
    if (raw !== rec.previewRaw) { rec.previewRaw = raw; applyPreview(ctx, rec, raw); }
  }
  for (const [id, d] of Object.entries(drills)) {
    const twin = twins[id];
    if (!twin) continue;
    const g = d.g;
    let x = fv(twin, 'x', 0), y = fv(twin, 'y', 0);
    if (x === 0 && y === 0) { x = d.start[0]; y = d.start[1]; }   // x/y/z двойника ещё нулевые — стартовая позиция из геометрии
    if (!d.cur) d.cur = [x, y];
    const k = 1 - Math.exp(-3 * (ctx.dt || 0.033));            // плавный переезд между обновлениями
    d.cur[0] += (x - d.cur[0]) * k; d.cur[1] += (y - d.cur[1]) * k;
    g.position.copy(ctx.toScene(d.cur[0], d.cur[1], ctx.groundAt(d.cur[0], d.cur[1])));
    g.scale.setScalar(S * DRILL_SCALE);
    const state = fv(twin, 'state', '');
    g.setMast(state === 'drilling');
    g.setState(state);
    g.setDetail(g.position.distanceTo(ctx.camera.position) > 2500 ? 'far' : 'full');
    const stateRu = { drilling: 'бурение', moving: 'переезд', idle: 'простой', down: 'авария' }[state] || state;
    g.userData.label = nameOf(twin, id) + (stateRu ? ' · ' + stateRu : '');
  }
}
