// Слой «геология»: забои face-* (пятно на уступе, цвет по типу руды), буровые станки drill-*
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
// Пятно забоя — 12 плиток (4 × 3, всего 120 × 60 м). При обычной крупности плитки лежат ровно; при крупном куске (после взрыва) их
// разворачивает на небольшие случайные углы, чуть приподнимает и раздвигает — читается как развал крупных глыб. Без новых эффектов.
const TILE_COLS = 4, TILE_ROWS = 3;
const PATCH_W = 120, PATCH_H = 60;
const PATCH_LIFT = 2.0;         // м над землёй: площадка под забоем в сцене чуть выше рельефа, ровное пятно иначе тонет в ней
const BASE_P80 = { sulphide: 440, clay: 300, waste: 740 };   // обычная крупность по типу забоя, мм (см. blasting.py)
const COARSE_FROM = 1.25;       // во сколько раз крупнее обычного считаем «крупным куском» (подпись и грубое пятно)
const COARSE_FULL = 0.8;        // при превышении обычной крупности на столько (то есть вдвое) пятно «грубое» полностью
const faces = {};    // thingId -> {patch, tiles, coarse, mat, x, y, gz, tg, inst, perFace, previewRaw}
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

export function init(ctx) {
  const THREE = ctx.THREE, c = ctx.colors;
  // Цвета пятен забоев — насыщенные и тёмные, чтобы читались на светлой площадке под забоем и друг на друге: сульфидная руда — тёмно-зелёная,
  // глинистая — оранжево-рыжая, вскрыша — тёмно-серая (палитра сцены c.* для этого слишком бледная).
  const FACE_COLORS = { sulphide: 0x11704c, clay: 0xe0661a, waste: 0x474747 };
  const lam = (col) => new THREE.MeshLambertMaterial({ color: col, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // забой не взорван — пятно блёклое: тот же цвет, сильно разбавленный светло-серым
  const dimmed = (col) => new THREE.MeshLambertMaterial({ color: new THREE.Color(col).lerp(new THREE.Color(0xc8c8c0), 0.72), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mats = {
    face: { sulphide: lam(FACE_COLORS.sulphide), clay: lam(FACE_COLORS.clay), waste: lam(FACE_COLORS.waste) },
    dim: { sulphide: dimmed(FACE_COLORS.sulphide), clay: dimmed(FACE_COLORS.clay), waste: dimmed(FACE_COLORS.waste) },
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

  for (const o of objs) {
    const id = NS + ':' + o.id;
    if (o.kind === 'face') {
      const [x, y] = o.position;
      const gz = ctx.groundAt(x, y);
      const patch = new THREE.Group();
      patch.position.copy(ctx.toScene(x, y, gz + PATCH_LIFT));
      const tw = PATCH_W / TILE_COLS, th = PATCH_H / TILE_ROWS;
      const tileGeoFace = new THREE.PlaneGeometry(tw, th);
      let seed = 0;
      for (const ch of o.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };   // детерминированный −1…1
      const tiles = [];
      for (let r = 0; r < TILE_ROWS; r++) {
        for (let cI = 0; cI < TILE_COLS; cI++) {
          const t = new THREE.Mesh(tileGeoFace, mats.face[o.ore_type] || mats.face.waste);
          t.rotation.order = 'YXZ';
          t.rotation.x = -Math.PI / 2;
          t.position.set(-PATCH_W / 2 + tw * (cI + 0.5), 0, -PATCH_H / 2 + th * (r + 0.5));
          patch.add(t);
          tiles.push({ t, yaw: rnd(), tilt: rnd(), roll: rnd(), lift: rnd() });
        }
      }
      ctx.group.add(patch);
      ctx.register(patch, id, { hitRadius: 60 });
      ctx.label(patch, 'Забой ' + o.id.slice(-2), 2);
      // плитки блоков: один InstancedMesh на забой, всё в группе с центром в забое
      const tg = new THREE.Group();
      tg.position.copy(ctx.toScene(x, y, gz + PATCH_LIFT + 0.6));
      const inst = new THREE.InstancedMesh(tileGeo, mats.tile, perFace);
      inst.count = 0;
      inst.frustumCulled = false;
      tg.add(inst);
      tilesGroup.add(tg);
      faces[id] = { patch, tiles, coarse: -1, mat: null, x, y, gz, tg, inst, perFace, previewRaw: null };
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
  const origin = ctx.toScene(rec.x, rec.y, rec.gz + PATCH_LIFT + 0.6);
  let n = 0;
  for (const t of list) {
    if (!Array.isArray(t) || t.length < 3) continue;
    const p = ctx.toScene(rec.x + t[0], rec.y + t[1], rec.gz + PATCH_LIFT + 0.6);
    m.makeTranslation(p.x - origin.x, 0, p.z - origin.z);
    rec.inst.setMatrixAt(n, m);
    rec.inst.setColorAt(n, cuColor(THREE, Number(t[2])));
    n++;
  }
  rec.inst.count = n;
  rec.inst.instanceMatrix.needsUpdate = true;
  if (rec.inst.instanceColor) rec.inst.instanceColor.needsUpdate = true;
}

// Грубость пятна: 0 — плитки лежат ровно, 1 — развал крупных глыб (плитки развёрнуты, наклонены, приподняты и раздвинуты).
function applyCoarse(rec, coarse) {
  rec.coarse = coarse;
  for (const tl of rec.tiles) {
    const t = tl.t;
    t.rotation.y = tl.yaw * 0.8 * coarse;                          // до ±46°
    t.rotation.x = -Math.PI / 2 + tl.tilt * 0.4 * coarse;          // наклон до ±23°
    t.rotation.z = tl.roll * 0.4 * coarse;
    t.position.y = (0.5 + 3.5 * Math.abs(tl.lift)) * coarse;       // приподняты до ~4 м
    const sc = 1 - 0.3 * coarse;                                    // между плитками появляются щели
    t.scale.set(sc, sc, 1);
  }
}

export function update(ctx, twins) {
  const S = ctx.markerScale || 1;
  for (const [id, rec] of Object.entries(faces)) {
    const twin = twins[id];
    if (!twin) continue;
    const ore = fv(twin, 'ore_type', 'waste');
    const blasted = fv(twin, 'blasted', true) === true;
    const m = (blasted ? mats.face : mats.dim)[ore] || mats.face.waste;     // не взорван — приглушённое пятно
    if (rec.mat !== m) { rec.mat = m; for (const tl of rec.tiles) tl.t.material = m; }
    const p80 = Number(fv(twin, 'p80', 0));
    const ratio = p80 / (BASE_P80[ore] || 440);
    const coarse = Math.max(0, Math.min(1, (ratio - 1) / COARSE_FULL));
    if (Math.abs(coarse - rec.coarse) > 0.01) applyCoarse(rec, coarse);
    rec.patch.scale.setScalar(S);             // заметность пятна на общем плане
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
