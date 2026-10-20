// Слой «геология»: забои face-* (пятно на уступе, цвет по типу руды), буровые станки drill-*
// (модель из общей библиотеки ctx.models) и переключатель «Содержание меди» — плитки блоков
// вокруг забоя с цветом по % Cu (данные — признак block_preview двойника забоя).
// Без теней, прозрачности и частиц: слой лёгкий и идёт без видеокарты.
const NS = 'kz.bozshakol';
const MAX_TILES = 200;          // всего плиток на всю сцену
const TILE_M = 25;              // сторона блока, м
const CU_LOW = 0.1, CU_HIGH = 0.7;   // шкала плиток: серый → медный, % Cu
const faces = {};    // thingId -> {mesh, x, y, gz, tg, inst, perFace, previewRaw}
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
  const mute = (col) => new THREE.Color(col).lerp(new THREE.Color(0x9a9a9a), 0.3);   // приглушённые цвета
  const lam = (col) => new THREE.MeshLambertMaterial({ color: mute(col), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mats = {
    face: { sulphide: lam(c.sulphide), clay: lam(c.clay), waste: lam(c.waste) },
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
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), mats.face[o.ore_type] || mats.face.waste);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(ctx.toScene(x, y, gz + 0.6));
      ctx.group.add(mesh);
      ctx.register(mesh, id, { hitRadius: 60 });
      ctx.label(mesh, 'Забой ' + o.id.slice(-2), 2);
      // плитки блоков: один InstancedMesh на забой, всё в группе с центром в забое
      const tg = new THREE.Group();
      tg.position.copy(ctx.toScene(x, y, gz + 1.2));
      const inst = new THREE.InstancedMesh(tileGeo, mats.tile, perFace);
      inst.count = 0;
      inst.frustumCulled = false;
      tg.add(inst);
      tilesGroup.add(tg);
      faces[id] = { mesh, x, y, gz, tg, inst, perFace, previewRaw: null };
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
  const origin = ctx.toScene(rec.x, rec.y, rec.gz + 1.2);
  let n = 0;
  for (const t of list) {
    if (!Array.isArray(t) || t.length < 3) continue;
    const p = ctx.toScene(rec.x + t[0], rec.y + t[1], rec.gz + 1.2);
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
    const m = mats.face[ore] || mats.face.waste;
    if (rec.mesh.material !== m) rec.mesh.material = m;
    rec.mesh.scale.setScalar(S);              // заметность пятна на общем плане
    rec.tg.scale.setScalar(S);
    const name = nameOf(twin, id);
    let text = name;
    if (ore === 'waste') text += ' · вскрыша';
    else text += ' · ' + fmtNum(fv(twin, 'cu_grade', 0), 2) + ' % Cu · глина ' + fmtNum(fv(twin, 'clay_pct', 0), 0) + ' %';
    if (fv(twin, 'blasted', true) !== true) text += ' · не взорван';
    // предупреждение о нехватке бурения: только текст подписи
    const status = fv(twin, 'drilling_ahead_status', 'ok');
    if (status === 'critical') text += ' · нет взорванного запаса';
    else if (status === 'low') text += ' · запас ' + fmtNum(fv(twin, 'blasted_ahead_h', 0), 0) + ' ч';
    rec.mesh.userData.label = text;
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
    g.scale.setScalar(S);
    const state = fv(twin, 'state', '');
    g.setMast(state === 'drilling');
    g.setState(state);
    g.setDetail(g.position.distanceTo(ctx.camera.position) > 2500 ? 'far' : 'full');
    const stateRu = { drilling: 'бурение', moving: 'переезд', idle: 'простой', down: 'авария' }[state] || state;
    g.userData.label = nameOf(twin, id) + (stateRu ? ' · ' + stateRu : '');
  }
}
