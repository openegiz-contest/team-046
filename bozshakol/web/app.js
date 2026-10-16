// Общая 3D-сцена карьера Бозшаколь: степь, карьер, дороги, панель диспетчера,
// карточка двойника, связь с Ditto и загрузка слоёв модулей (layers/*.js).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';

// ---------------------------------------------------------------- палитра
const colors = {
  sulphide: 0x3d8f6e, clay: 0xc8722a, waste: 0x8a8a8a, empty: 0xffffff, down: 0xd32f2f,
  steppe: 0xe6d9a8, bench: [0xd9b784, 0xcfa86f, 0xc39a62], wall: [0xb88c55, 0xa97f4c, 0x9c7445],
  benchLine: 0x5a3e22, floor: 0xbf9d6c,
  road: 0xb9ad94, roadClosed: 0xd32f2f,
  building: 0xd8d8d8, roof: 0xa9b8cc, conveyor: 0x6f7f95, excavator: 0xf2a21b, drill: 0x4f6d8f,
  dump: 0x9a9a9a, stockpileOre: 0x6b7a5a, stockpileClay: 0xb86f3a, label: 0x2b2620,
};

const NS = 'kz.bozshakol';
const SCENARIO_NAMES = {
  blizzard: 'Метель', dispatch_off: 'Диспетчеризация выключена', road_closed: 'Дорога закрыта',
  excavator_down: 'Экскаватор сломан', clay_face: 'Глинистый забой', bad_blast: 'Неудачный взрыв',
  crusher_stop: 'Остановка дробилки', sag_maintenance: 'ТО мельницы',
};
const MINE_FIELDS = [
  ['sim_time', 'Модельное время'], ['shift', 'Смена'], ['shift_hour', 'Час смены'],
  ['temperature', 'Температура'], ['wind', 'Ветер'], ['visibility', 'Видимость'],
  ['speed_limit', 'Ограничение скорости'], ['ore_to_plants', 'Руда на фабрики'],
  ['plan_fulfilment', 'Выполнение плана'], ['feed_cu', 'Содержание Cu в питании'],
  ['feed_clay', 'Доля глины в питании'], ['cu_concentrate_shift', 'Концентрат Cu за смену'],
  ['trucks_hauling', 'Самосвалов в работе'],
];
const DISPATCH_FIELDS = [
  ['mode', 'Режим'], ['avg_wait_excavator', 'Среднее ожидание у экскаватора'],
  ['trucks_hauling', 'Самосвалов в работе'], ['delivered_crusher_t', 'Доставлено на дробилку'],
  ['delivered_clay_t', 'Доставлено на склад глины'], ['delivered_dump_t', 'Доставлено на отвал'],
  ['trips_total', 'Рейсов всего'],
];
const MODE_NAMES = { auto: 'автоматический', fixed: 'закреплённый', manual: 'ручной' };

// ---------------------------------------------------------------- состояние
const twins = {};            // thingId -> {attributes, features}
let geometry = null;
const layers = [];           // {name, mod, ctx, errors}
const clickable = [];        // объекты с userData.thingId
const labels = [];           // {obj, el, dy, last}
let openedThing = null;
let connState = 'нет';

const toScene = (x, y, z) => new THREE.Vector3(x, z, -y);
const val = (id, f, d) => {
  const t = twins[id]; const p = t && t.features && t.features[f] && t.features[f].properties;
  return p && p.value !== undefined ? p.value : d;
};

// ---------------------------------------------------------------- рендер
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdde8f0);
scene.fog = new THREE.Fog(0xdde8f0, 9000, 20000);

const perspCam = new THREE.PerspectiveCamera(50, 1, 2, 20000);
perspCam.position.set(0, 1800, 3200);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
orthoCam.position.set(0, 3000, -1200);
orthoCam.up.set(0, 0, -1);           // север — вверх экрана
orthoCam.lookAt(0, 0, -1200);
let camera = perspCam;

const controls = new OrbitControls(perspCam, canvas);
controls.target.set(0, -50, -600);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 100;
controls.maxDistance = 12000;
controls.update();
const topControls = new OrbitControls(orthoCam, canvas);
topControls.target.set(0, 0, -1200);
topControls.enableRotate = false;
// в виде сверху левая кнопка — панорамирование (вращение запрещено)
topControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
topControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
topControls.screenSpacePanning = true;
topControls.minZoom = 0.3; topControls.maxZoom = 12;
topControls.enabled = false;
topControls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8c9a0, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2000, 4000, 1500);
scene.add(sun);

function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h; perspCam.updateProjectionMatrix();
  const half = 3200, asp = w / h;
  orthoCam.left = -half * asp; orthoCam.right = half * asp; orthoCam.top = half; orthoCam.bottom = -half;
  orthoCam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- подписи (HTML-оверлей)
const labelRoot = document.getElementById('labels');
const MAX_LABELS = 28;
// addLabel(obj, text, {small, dy}) — подпись над объектом; текст потом меняют через obj.userData.label
function addLabel(obj, text, opts = {}) {
  if (labels.length >= MAX_LABELS) return null;
  const el = document.createElement('div');
  el.className = 'label' + (opts.small ? ' small' : '');
  el.textContent = text;
  labelRoot.appendChild(el);
  obj.userData.label = text;
  const rec = { obj, el, dy: opts.dy || 0, last: text };
  labels.push(rec);
  return rec;
}
const _v = new THREE.Vector3();
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const L of labels) {
    if (!L.obj.visible || !L.obj.parent) { L.el.style.display = 'none'; continue; }
    L.obj.getWorldPosition(_v); _v.y += L.dy;
    _v.project(camera);
    if (_v.z > 1 || _v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.05) { L.el.style.display = 'none'; continue; }
    L.el.style.display = '';
    L.el.style.left = ((_v.x + 1) / 2 * w).toFixed(0) + 'px';
    L.el.style.top = ((1 - _v.y) / 2 * h).toFixed(0) + 'px';
    const t = L.obj.userData.label;
    if (t !== L.last) { L.el.textContent = t; L.last = t; }
  }
}

// ---------------------------------------------------------------- клики
function register(obj, thingId) { obj.userData.thingId = thingId; clickable.push(obj); }
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5) return;
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(clickable, true);
  for (const hit of hits) {
    let o = hit.object;
    while (o && !o.userData.thingId) o = o.parent;
    if (o) { openCard(o.userData.thingId); return; }
  }
});

// ---------------------------------------------------------------- карточка двойника
const card = document.getElementById('card');
const cardBody = document.querySelector('#card-table tbody');
document.getElementById('card-close').addEventListener('click', () => { openedThing = null; card.hidden = true; });
function openCard(thingId) { openedThing = thingId; card.hidden = false; renderCard(); }
function renderCard() {
  if (!openedThing) return;
  const t = twins[openedThing];
  document.getElementById('card-name').textContent = (t && t.attributes && t.attributes.name) || openedThing;
  document.getElementById('card-id').textContent = openedThing;
  const rows = [];
  if (t && t.features) {
    for (const [f, feat] of Object.entries(t.features)) {
      const p = feat.properties || {};
      rows.push('<tr><td>' + esc(f) + '</td><td class="val">' + esc(fmt(p.value)) + '</td><td>' + esc(p.unit || '') + '</td></tr>');
    }
  }
  cardBody.innerHTML = rows.join('') || '<tr><td colspan="3">нет данных</td></tr>';
}
setInterval(() => { if (openedThing && !card.hidden) renderCard(); }, 1000);

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(v) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10).split('-').reverse().join('.') + ' ' + v.slice(11, 16);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------- панель
function kvTable(tableId, thingId, fields) {
  const t = twins[thingId];
  const el = document.getElementById(tableId);
  if (!t) { el.innerHTML = '<tr><td colspan="2">нет данных</td></tr>'; return; }
  el.innerHTML = fields.map(([f, name]) => {
    const p = (t.features[f] || {}).properties || {};
    let v = fmt(p.value);
    if (f === 'mode') v = MODE_NAMES[p.value] || v;
    const unit = p.unit && p.unit !== 'ISO' && p.unit !== '№' ? ' ' + p.unit : '';
    return '<tr><td>' + name + '</td><td class="val">' + esc(v) + esc(unit) + '</td></tr>';
  }).join('');
}
const scenarioButtons = {};
function renderScenarios() {
  const t = twins[NS + ':scenarios'];
  const root = document.getElementById('scenarios');
  if (!t) { root.textContent = 'нет данных'; return; }
  for (const [name, feat] of Object.entries(t.features)) {
    const p = feat.properties || {};
    let rec = scenarioButtons[name];
    if (!rec) {
      if (root.firstChild && root.firstChild.nodeType === 3) root.textContent = '';
      const div = document.createElement('div'); div.className = 'scenario';
      const row = document.createElement('div'); row.className = 'row';
      const title = document.createElement('span'); title.textContent = SCENARIO_NAMES[name] || name;
      const btn = document.createElement('button'); btn.type = 'button';
      const params = document.createElement('div'); params.className = 'params';
      row.append(title, btn); div.append(row, params); root.appendChild(div);
      rec = scenarioButtons[name] = { btn, params, value: null };
      btn.addEventListener('click', () => setScenario(name, !rec.value, btn));
    }
    rec.value = !!p.value;
    rec.btn.textContent = rec.value ? 'Выключить' : 'Включить';
    rec.btn.className = rec.value ? 'on' : 'off';
    rec.params.textContent = Object.entries(p)
      .filter(([k]) => !['value', 'unit', 'owner'].includes(k))
      .map(([k, v]) => k + ': ' + fmt(v)).join(' · ');
  }
}
async function setScenario(name, on, btn) {
  btn.disabled = true;
  try {
    const url = '/ditto/api/2/things/' + NS + ':scenarios/features/' + encodeURIComponent(name) + '/properties/value';
    const r = await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(!!on),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // локально обновим сразу, событие Ditto подтвердит
    const f = twins[NS + ':scenarios'].features[name];
    f.properties = Object.assign({}, f.properties, { value: !!on });
  } catch (e) {
    console.error('Сценарий ' + name + ': ошибка записи', e);
    alert('Не удалось переключить сценарий: ' + e.message);
  }
  btn.disabled = false;
  renderPanel();
}
function renderPanel() {
  kvTable('mine-table', NS + ':mine', MINE_FIELDS);
  kvTable('dispatch-table', NS + ':dispatch', DISPATCH_FIELDS);
  renderScenarios();
  document.getElementById('conn').textContent = connState;
  updateRoads();
}

// ---------------------------------------------------------------- данные из Ditto
const SEARCH_URL = '/ditto/api/2/search/things?namespaces=' + NS + '&option=size(200)&fields=thingId,attributes,features';
async function loadSnapshot() {
  const r = await fetch(SEARCH_URL, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('поиск двойников: HTTP ' + r.status);
  const data = await r.json();
  for (const item of data.items || []) {
    twins[item.thingId] = { attributes: item.attributes || {}, features: item.features || {} };
  }
  renderPanel();
}
// Событие SSE: {thingId, features: {f: {properties: {...}}}} — сливаем поверх имеющихся
function mergeEvent(ev) {
  if (!ev || !ev.thingId) return;
  const t = twins[ev.thingId] || (twins[ev.thingId] = { attributes: {}, features: {} });
  if (ev.attributes) Object.assign(t.attributes, ev.attributes);
  for (const [f, feat] of Object.entries(ev.features || {})) {
    if (!feat) { delete t.features[f]; continue; }
    const cur = t.features[f] || (t.features[f] = { properties: {} });
    cur.properties = Object.assign({}, cur.properties, feat.properties || {});
  }
}
let es = null, pollTimer = null, panelDirty = false;
function setConn(s) { connState = s; document.getElementById('conn').textContent = s; }
function startPolling() {
  if (pollTimer) return;
  setConn('опрос');
  pollTimer = setInterval(async () => {
    try { await loadSnapshot(); setConn('опрос'); } catch (e) { setConn('нет'); }
  }, 1000);
}
function startSSE() {
  let opened = false;
  try {
    es = new EventSource('/ditto/api/2/things?namespaces=' + NS + '&fields=thingId,features');
  } catch (e) { console.warn('SSE недоступен', e); startPolling(); return; }
  const giveUp = () => { if (es) { es.close(); es = null; } startPolling(); };
  const timer = setTimeout(() => { if (!opened) { console.warn('SSE не открылся за 5 с — переходим на опрос'); giveUp(); } }, 5000);
  es.onopen = () => { opened = true; clearTimeout(timer); setConn('SSE'); };
  es.onmessage = (m) => {
    if (!m.data) return;
    try { mergeEvent(JSON.parse(m.data)); panelDirty = true; } catch (e) { /* служебные строки */ }
  };
  es.onerror = () => { console.warn('SSE оборвался — переходим на опрос'); clearTimeout(timer); giveUp(); };
}
setInterval(() => { if (panelDirty) { panelDirty = false; renderPanel(); } }, 1000);

// ---------------------------------------------------------------- степь и карьер
const terrain = new THREE.Group();
scene.add(terrain);
function ellipsePts(a, b, n) {
  const pts = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([a * Math.cos(t), b * Math.sin(t)]); }
  return pts;
}
// Кольцо (площадка) или стенка между двумя эллипсами; outer/inner — массивы [x, y] рудника
function ringMesh(outer, inner, yOut, yIn, color) {
  const n = outer.length, pos = [], idx = [];
  for (let i = 0; i < n; i++) {
    pos.push(outer[i][0], yOut, -outer[i][1]);
    pos.push(inner[i][0], yIn, -inner[i][1]);
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i, b = 2 * i + 1, c = (2 * (i + 1)) % (2 * n), d = (2 * (i + 1) + 1) % (2 * n);
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
}
function buildTerrain() {
  const pit = geometry.pit, A = pit.semi_axes_top[0], B = pit.semi_axes_top[1], N = 56;
  const h = pit.bench_height, inset = pit.inset_per_bench, count = pit.bench_count;
  // степь — плоскость с отверстием под карьер, ~8 × 9 км со сдвигом к северу
  const shape = new THREE.Shape();
  shape.moveTo(-4000, -3200); shape.lineTo(4000, -3200); shape.lineTo(4000, 5800); shape.lineTo(-4000, 5800); shape.closePath();
  const hole = new THREE.Path(); hole.absellipse(0, 0, A, B, 0, Math.PI * 2, false, 0);
  shape.holes.push(hole);
  const steppe = new THREE.Mesh(new THREE.ShapeGeometry(shape, 28), new THREE.MeshLambertMaterial({ color: colors.steppe }));
  steppe.rotation.x = -Math.PI / 2;
  terrain.add(steppe);
  // уступы карьера
  let prev = ellipsePts(A, B, N);
  for (let k = 0; k < count; k++) {
    const next = ellipsePts(A - (k + 1) * inset, B - (k + 1) * inset, N);
    const yTop = -k * h, yBot = (k === count - 1) ? -pit.depth : -(k + 1) * h;
    terrain.add(ringMesh(prev, next, yTop, yTop, colors.bench[k % 3]));   // площадка
    terrain.add(ringMesh(next, next, yTop, yBot, colors.wall[k % 3]));    // стенка
    const linePts = prev.map(([x, y]) => new THREE.Vector3(x, yTop + 0.5, -y));
    terrain.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(linePts), new THREE.LineBasicMaterial({ color: colors.benchLine })));
    prev = next;
  }
  // дно
  const fShape = new THREE.Shape(); fShape.absellipse(0, 0, A - count * inset, B - count * inset, 0, Math.PI * 2, false, 0);
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(fShape, 28), new THREE.MeshLambertMaterial({ color: colors.floor }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -pit.depth;
  terrain.add(floor);
  const fl = prev.map(([x, y]) => new THREE.Vector3(x, -pit.depth + 0.5, -y));
  terrain.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(fl), new THREE.LineBasicMaterial({ color: colors.benchLine })));
}

// ---------------------------------------------------------------- дороги
const roadMeshes = {};   // roadId -> [mesh]
const roadMats = {
  open: new THREE.MeshLambertMaterial({ color: colors.road }),
  closed: new THREE.MeshLambertMaterial({ color: colors.roadClosed }),
};
function buildRoads() {
  for (const e of geometry.edges) {
    const a = geometry.nodes[e.from], b = geometry.nodes[e.to];
    if (!a || !b) continue;
    const pa = toScene(a[0], a[1], a[2] + 1.5), pb = toScene(b[0], b[1], b[2] + 1.5);
    const len = pa.distanceTo(pb);
    const m = new THREE.Mesh(new THREE.BoxGeometry(24, 1, len + 24), roadMats.open);
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.lookAt(pb);                       // ось Z коробки — вдоль ребра
    m.userData.road = e.road;
    terrain.add(m);
    (roadMeshes[e.road] || (roadMeshes[e.road] = [])).push(m);
  }
}
// Дороги road-* при open=false — красные
function updateRoads() {
  for (const [rid, meshes] of Object.entries(roadMeshes)) {
    const open = val(NS + ':' + rid, 'open', true);
    const mat = open === false ? roadMats.closed : roadMats.open;
    for (const m of meshes) m.material = mat;
  }
}

// ---------------------------------------------------------------- переключатель вида
const btnView = document.getElementById('btn-view');
btnView.addEventListener('click', () => {
  const top = camera === perspCam;
  camera = top ? orthoCam : perspCam;
  controls.enabled = !top; topControls.enabled = top;
  btnView.textContent = top ? '3D' : 'Сверху';
});

// ---------------------------------------------------------------- слои
async function loadLayers() {
  for (const name of ['haulage', 'geology', 'processing']) {
    const group = new THREE.Group(); group.name = 'layer-' + name; scene.add(group);
    const ctx = { THREE, scene, group, geometry, toScene, register, colors, dt: 0, camera, label: addLabel };
    try {
      const mod = await import('./layers/' + name + '.js');
      if (typeof mod.init === 'function') await mod.init(ctx);
      layers.push({ name, mod, ctx, errors: 0 });
    } catch (e) {
      console.error('Слой ' + name + ': ошибка загрузки', e);
    }
  }
}

// ---------------------------------------------------------------- цикл
let last = performance.now(), lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 33) return;          // не чаще 30 кадров/с
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now; lastFrame = now;
  (camera === perspCam ? controls : topControls).update();
  for (const L of layers) {
    L.ctx.dt = dt; L.ctx.camera = camera;
    try { if (typeof L.mod.update === 'function') L.mod.update(L.ctx, twins); }
    catch (e) { if (L.errors++ % 300 === 0) console.error('Слой ' + L.name + ': ошибка в update', e); }
  }
  renderer.render(scene, camera);
  updateLabels();
}

// ---------------------------------------------------------------- запуск
(async function main() {
  const status = document.getElementById('load-status');
  try {
    const r = await fetch('/geometry.json'); if (!r.ok) throw new Error('HTTP ' + r.status);
    geometry = await r.json();
    buildTerrain(); buildRoads();
  } catch (e) { status.textContent = 'ошибка геометрии'; console.error('geometry.json', e); return; }
  fetch('/config.json').then((r) => r.json()).then((c) => {
    if (c && c.grafanaUrl) {
      const a = document.getElementById('grafana-link');
      a.href = c.grafanaUrl.replace(/\/$/, '') + '/dashboards?query=' + encodeURIComponent('Бозшаколь');
      a.hidden = false;
    }
  }).catch((e) => console.warn('config.json', e));
  try { await loadSnapshot(); } catch (e) { console.error(e); setConn('нет'); }
  startSSE();
  await loadLayers();
  status.textContent = '';
  requestAnimationFrame(frame);
})();
