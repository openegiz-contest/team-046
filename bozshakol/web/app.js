// Общая 3D-сцена карьера Бозшаколь: степь, карьер, дороги, панель диспетчера, журнал событий,
// карточка двойника, связь с Ditto и загрузка слоёв модулей (layers/*.js).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { loadTerrain } from './terrain.js';
import { initKeyboard } from './controls.js';
import { buildPit as buildPitModel } from './pit.js';
import { buildEnvironment, glowTexture } from './environment.js';
import { createModels } from './models.js';
import { loadDiorama } from './diorama.js';
import { buildDiorama } from './diorama-scene.js';

// ---------------------------------------------------------------- палитра
const colors = {
  sulphide: 0x3d8f6e, clay: 0xc8722a, waste: 0x8a8a8a, empty: 0xffffff, down: 0xd32f2f,
  steppe: 0xe6d9a8,
  bench: [0xdcc08e, 0xcfae78],            // бермы (площадки) — два чередующихся светлых тона
  wall: [0x8f6a44, 0x7f5c3a],             // стенки уступов — заметно темнее берм
  benchLine: 0x4a3418, floor: 0xa8a27e,   // контуры кромок; дно карьера — серо-оливковое
  road: 0xcfc3a4, ramp: 0xe8dfc3, roadEdge: 0x4a3f2e, roadClosed: 0xd32f2f,
  building: 0xd8d8d8, roof: 0xa9b8cc, conveyor: 0x6f7f95, excavator: 0xf2a21b, drill: 0x4f6d8f,
  dump: 0x9a9a9a, stockpileOre: 0x6b7a5a, stockpileClay: 0xb86f3a, label: 0x2b2620,
};

const NS = 'kz.bozshakol';
const VZ = 1.5;   // вертикальное преувеличение рельефа (подпись в углу сцены); применяется через toScene ко всему
const SCENARIO_NAMES = {
  blizzard: 'Метель', dispatch_off: 'Диспетчеризация выключена', road_closed: 'Дорога закрыта',
  excavator_down: 'Экскаватор сломан', clay_face: 'Глинистый забой', bad_blast: 'Неудачный взрыв',
  crusher_stop: 'Остановка дробилки', sag_maintenance: 'ТО мельницы',
};
// «Что смотреть» у каждого сценария в панели
const SCENARIO_HINTS = {
  blizzard: 'дымка и плашка с видимостью, ограничение 20 км/ч, совет о падении привоза и запасе склада',
  dispatch_off: 'режим «ручной» в блоке «Транспорт», ожидание у экскаватора растёт',
  road_closed: 'съезд красный, самосвалы ищут объезд; после отмены — снова по съезду',
  excavator_down: 'экскаватор красный, его самосвалы уходят к другим; через модельный час — совет о привозе',
  clay_face: 'забой меняет тип и цвет, самосвалы везут его руду на склад глины, совет советника',
  bad_blast: 'крупность забоя 900 мм в карточке, погрузка медленнее, дробилка медленнее',
  crusher_stop: 'очередь у дробилки, запас склада и прогноз остановки фабрики, совет вверху панели',
  sag_maintenance: 'фабрика на ТО, склад растёт, при переполнении дробилка встаёт «склад полон»',
};
const MODE_NAMES = { auto: 'автоматический', fixed: 'закреплённый', manual: 'ручной' };
const STATE_NAMES = {
  running: 'работает', working: 'работает', idle: 'простой', stopped: 'остановлено', stop: 'остановлено',
  down: 'авария', maintenance: 'ТО', off: 'выключено', failed: 'авария',
};
const STOPPED = ['stopped', 'stop', 'down', 'maintenance', 'off', 'failed'];

// ---------------------------------------------------------------- состояние
const twins = {};            // thingId -> {attributes, features}
let geometry = null;
let terrainApi = null;       // результат loadTerrain
let modelsLib = null;        // библиотека моделей (models.js), отдаётся слоям как ctx.models
const layers = [];           // {name, mod, ctx, errors}
const clickable = [];        // объекты с userData.thingId
const labels = [];           // {obj, el, dy, importance, last, w, h}
let openedThing = null;      // выбранный двойник (карточка) = ctx.selected
let hoverThing = null;       // двойник под курсором = ctx.hover
let markerScale = 1;         // множитель размера значков техники = ctx.markerScale
let connState = 'нет';

// Режим сцены: 'schema' — схема-макет рудника (по умолчанию, diorama.js), 'map' — «Карта местности»:
// реальный масштаб, рельеф и снимок. Слои получают ctx.toScene / ctx.groundAt текущего режима;
// при переключении мир (земля, карьер, дороги, окружение и слои) собирается заново без перезагрузки страницы.
let mode = 'schema';
let dio = null;              // перенос координат в схему (diorama.js); null — схемы нет, только «Карта местности»
const realToScene = (x, y, z) => new THREE.Vector3(x, z * VZ, -y);
const toScene = (x, y, z) => (mode === 'schema' && dio ? dio.toScene(x, y, z) : realToScene(x, y, z));
const groundAt = (x, y) => (mode === 'schema' && dio ? dio.groundAt(x, y) : terrainApi.groundAt(x, y));
// Параметры, зависящие от режима. Схема — карта рудника 1 : 3 (единица = 3 м местности, core/diorama.json):
// расстояния и размеры объектов сжаты в 3 раза, подвижная техника крупнее зданий в 2,5 раза (MACHINE_SCALE).
const MODE_PARAMS = {
  map: {
    unit: 1, labelDist: { 2: 3500, 1: 700 }, hit: 1, follow: [-90, 45, 100], fly: [60, 3], markerFar: 1500,
    road: { w: 26, ramp: 50, lift: 1.5, h: 1.2 }, route: { r: 3.2, lift: 2.5 },
    cam: { near: 1, far: 30000, min: 12, max: 14000 }, orthoHalf: 3000, orthoAt: [-1100, 3000, 200],
    sun: { pos: [-4200, 3600, 2600], tgt: [-1100, 0, 200], box: [4600, 3600], near: 100, far: 14000 },
  },
  schema: {
    // схема: постоянно — только подписи крупных объектов (3); техника и забои — при наведении или выборе
    unit: 1 / 3, labelDist: { 2: 0, 1: 0 }, hit: 0.6, follow: [-16, 8, 18], fly: [25, 2.6], markerFar: 500,
    road: { w: 14, ramp: 18, lift: 0.3, h: 0.5 }, route: { r: 0.6, lift: 1.0 },
    cam: { near: 0.3, far: 40000, min: 4, max: 9000 }, orthoHalf: 1000, orthoAt: [-300, 3000, 100],
    sun: { pos: [-2600, 2700, 1900], tgt: [-300, 0, 0], box: [2300, 1500], near: 10, far: 9000 },
  },
};
const mp = () => MODE_PARAMS[mode];
// Масштаб подвижной техники (модели в метрах). Схема 1 : 3 → техника × 2,5 / 3: крупнее зданий и карьера в 2,5 раза,
// экскаватор крупнее самосвала (реальные пропорции между машинами). «Карта местности» — натуральная величина.
// Вдали (дальше markerFar) над машиной — цветной значок-стрелка, техника при этом не раздувается.
const MACHINE_SCALE = { schema: 2.5 / 3, map: 1 };
const val = (id, f, d) => {
  const t = twins[id]; const p = t && t.features && t.features[f] && t.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
};
const attr = (id, a, d) => { const t = twins[id]; return t && t.attributes && t.attributes[a] !== undefined ? t.attributes[a] : d; };
const nameOf = (id) => attr(id, 'name', id.split(':')[1] || id);

// ---------------------------------------------------------------- рендер
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // мягкая тональная кривая: светлые тона без пересвета
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = false;                   // тени — только в качестве «Высокое»
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const SKY = 0xdde8f0;
scene.background = new THREE.Color(SKY);   // до загрузки окружения (environment.js ставит небо и туман)
let environment = null;      // небо, туман, хвостохранилище, ЛЭП, ограждение, мачты (environment.js)
let terrainGround = null;    // группа земли (terrain.js), у неё setImagery(on)

const perspCam = new THREE.PerspectiveCamera(50, 1, 2, 30000);
perspCam.position.copy(toScene(-1500, -7900, 3600));
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
orthoCam.position.set(-1100, 3000, 200);
orthoCam.up.set(0, 0, -1);           // север — вверх экрана
orthoCam.lookAt(-1100, 0, 200);
let camera = perspCam;

const controls = new OrbitControls(perspCam, canvas);
controls.target.copy(toScene(-1100, -300, 0));
controls.maxPolarAngle = Math.PI * 0.49;
controls.enableDamping = true; controls.dampingFactor = 0.12;   // плавное вращение и колесо (без «упора»)
controls.zoomSpeed = 0.9;
controls.minDistance = 60;
controls.maxDistance = 14000;
controls.update();
const topControls = new OrbitControls(orthoCam, canvas);
topControls.target.set(-1100, 0, 200);
topControls.enableRotate = false;
// в виде сверху левая кнопка — панорамирование (вращение запрещено)
topControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
topControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
topControls.screenSpacePanning = true;
topControls.minZoom = 0.3; topControls.maxZoom = 12;
topControls.enabled = false;
topControls.update();

// Свет: небо-полусфера (голубое сверху, тёплый отражённый снизу) и тёплое низкое солнце с юго-запада
const hemi = new THREE.HemisphereLight(0xe3eef8, 0xb59c74, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe4bd, 3.1);
sun.position.set(-4200, 3600, 2600);   // низкое солнце: стенки уступов и грани рельефа дают разный тон
sun.target.position.set(-1100, 0, 200);
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4600, right: 4600, top: 3600, bottom: -3600, near: 100, far: 14000 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// Виды подобраны под окно 1920×1080 (холст ≈ 1,5 : 1); на более узком холсте камера отходит дальше,
// чтобы макет не обрезался по краям
let startFitted = false;
function fitToAspect(pos, target) {
  const k = Math.max(1, 1.5 / (perspCam.aspect || 1.5));
  return pos.sub(target).multiplyScalar(k).add(target);
}
function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h; perspCam.updateProjectionMatrix();
  if (!startFitted) { startFitted = true; fitToAspect(perspCam.position, controls.target); }
  const half = mp().orthoHalf, asp = w / h;
  orthoCam.left = -half * asp; orthoCam.right = half * asp; orthoCam.top = half; orthoCam.bottom = -half;
  orthoCam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- подписи (HTML-оверлей)
// ctx.label(obj, text, importance | {dy, small, importance, cls})
//   importance 3 — крупные объекты, видны всегда; 2 — забои, экскаваторы, буровые: при приближении или выборе;
//   1 — самосвалы: при наведении, выборе или сильном приближении. Третий аргумент-объект — старое поведение (importance 2).
// Текст меняется через obj.userData.label. Подписи, перекрывающие более важную, скрываются; лимит ~30.
const labelRoot = document.getElementById('labels');
const panelEl = document.getElementById('panel'), topbarEl = document.getElementById('topbar'), bannerEl = document.getElementById('scenario-banner');
// Важность по умолчанию (если слой её не передал) — по виду двойника: крупные объекты 3, самосвалы 1, остальное 2
function defaultImportance(obj) {
  const id = thingOf(obj) || '';
  if (/:(crusher|conveyor|plant|stockpile|dump|sag-mill|flotation|power)/.test(id)) return 3;
  if (id.includes(':truck-')) return 1;
  return 2;
}
const MAX_LABELS = 30;
// подписи важности 2 и 1 показываются ближе mp().labelDist (м в «Карте местности», единицы в схеме)
function addLabel(obj, text, arg) {
  let opts = {}, importance = defaultImportance(obj);
  if (typeof arg === 'number') importance = arg;
  else if (arg && typeof arg === 'object') { opts = arg; if (typeof opts.importance === 'number') importance = opts.importance; }
  const el = document.createElement('div');
  el.className = 'label' + (opts.small ? ' small' : '') + (opts.cls ? ' ' + opts.cls : '');
  el.textContent = text;
  el.style.display = 'none';
  labelRoot.appendChild(el);
  if (!opts.cls) obj.userData.label = text;            // служебные плашки (cls) текст объекта не трогают
  const rec = { obj, el, dy: opts.dy || 0, small: !!opts.small, importance, last: text, text, enabled: true, warn: !!opts.cls };
  labels.push(rec);
  return rec;
}
const _v = new THREE.Vector3(), _c = new THREE.Vector3();
const placed = [];
function overlaps(r) {
  for (const p of placed) if (r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y) return true;
  return false;
}
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const ortho = camera === orthoCam;
  const orthoDist = mp().orthoHalf / orthoCam.zoom;
  const LABEL_DIST = mp().labelDist;
  camera.getWorldPosition(_c);
  const cand = [];
  for (const L of labels) {
    L.show = false;
    if (!L.enabled || !(L.obj.visible || L.obj.userData.farHidden) || !L.obj.parent) continue;
    L.obj.getWorldPosition(_v);
    // у уменьшенных в схеме зданий и складов отступ подписи (в метрах) уменьшается так же
    const so = L.obj.userData.schemaScaled ? L.obj : (L.obj.parent && L.obj.parent.userData.schemaScaled ? L.obj.parent : null);
    _v.y += L.dy * (so ? so.scale.y : 1);
    const dist = ortho ? orthoDist : _c.distanceTo(_v);
    const id = thingOf(L.obj);
    const focused = id && (id === openedThing || id === hoverThing);
    let imp = L.importance;
    if (focused) imp = 4;
    if (imp < 3 && dist > (LABEL_DIST[Math.max(1, Math.min(2, Math.round(imp)))] ?? 2600)) continue;
    _v.project(camera);
    if (_v.z > 1 || _v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.05) continue;
    L.sx = (_v.x + 1) / 2 * w; L.sy = (1 - _v.y) / 2 * h; L.imp = imp; L.dist = dist;
    cand.push(L);
  }
  cand.sort((a, b) => (b.imp - a.imp) || (a.dist - b.dist));
  placed.length = 0;
  // панель слева и кнопки сверху — занятые области: подписи под ними прячем
  const cr = canvas.getBoundingClientRect();   // координаты подписей — относительно холста
  for (const el of [panelEl, topbarEl, bannerEl]) {
    const r = el.getBoundingClientRect();
    if (r.width) placed.push({ x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
  }
  let shown = 0;
  for (const L of cand) {
    const t = L.warn || L.obj.userData.label === undefined ? L.text : L.obj.userData.label;
    const txt = String(t);
    const cw = L.small ? 5.6 : 6.3, ch = L.small ? 15 : 18;
    const bw = txt.length * cw + 14;
    const r = { x: L.sx - bw / 2, y: L.sy - ch, w: bw, h: ch };
    if (shown >= MAX_LABELS || (L.imp < 4 && overlaps(r))) continue;
    placed.push(r); shown++;
    L.show = true;
    L.el.style.left = L.sx.toFixed(0) + 'px';
    L.el.style.top = L.sy.toFixed(0) + 'px';
    if (txt !== L.last) { L.el.textContent = txt; L.last = txt; }
  }
  for (const L of labels) {
    const d = L.show ? '' : 'none';
    if (L.el.style.display !== d) L.el.style.display = d;
  }
}

// ---------------------------------------------------------------- клики и наведение
// register(obj, thingId, {hitRadius}) — объект кликабелен; попадание засчитывается и в невидимую сферу
// радиусом hitRadius (по умолчанию 25 м) × markerScale вокруг объекта, чтобы в технику можно было попасть издалека.
function register(obj, thingId, opts = {}) {
  obj.userData.thingId = thingId;
  obj.userData.hitRadius = typeof opts.hitRadius === 'number' ? opts.hitRadius : 25;
  clickable.push(obj);
}
const byThing = (thingId) => clickable.find((o) => o.userData.thingId === thingId) || null;
function thingOf(obj) { let o = obj; while (o && !o.userData.thingId) o = o.parent; return o ? o.userData.thingId : null; }
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  let best = null, bestD = Infinity;
  for (const hit of raycaster.intersectObjects(clickable, true)) {
    let o = hit.object;
    while (o && !o.userData.thingId) o = o.parent;
    if (o && hit.distance < bestD) { best = o.userData.thingId; bestD = hit.distance; }
  }
  if (best && MACHINE_RE.test(best)) return best;   // прямое попадание в технику главнее «хитбоксов» соседних зон
  for (const o of clickable) {
    if ((!o.visible && !o.userData.farHidden) || !o.parent || !o.userData.hitRadius) continue;
    o.getWorldPosition(_v);
    // вдали в технику попасть трудно — радиус «хитбокса» растёт с расстоянием (как значок)
    const rad = Math.max(o.userData.hitRadius * markerScale * mp().hit,
      o.userData.farHidden ? raycaster.ray.origin.distanceTo(_v) * 0.012 : 0);
    if (raycaster.ray.distanceToPoint(_v) > rad) continue;
    const along = raycaster.ray.origin.distanceTo(_v);
    if (along < bestD + rad) { best = o.userData.thingId; bestD = along; }   // «хитбокс» важнее поверхности за ним
  }
  return best;
}
let downPos = null, movePos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointermove', (e) => { movePos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerleave', () => { movePos = null; hoverThing = null; canvas.style.cursor = ''; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5) return;
  const id = pick(e.clientX, e.clientY);
  if (id) openCard(id);
});
function updateHover() {
  if (!movePos || downPos) return;
  hoverThing = pick(movePos[0], movePos[1]);
  canvas.style.cursor = hoverThing ? 'pointer' : '';
}

// ---------------------------------------------------------------- карточка двойника
const card = document.getElementById('card');
const cardBody = document.querySelector('#card-table tbody');
function clearSelection() { openedThing = null; card.hidden = true; updateFollowButton(); }   // снять выбор (и слежение)
document.getElementById('card-close').addEventListener('click', clearSelection);
function openCard(thingId) { openedThing = thingId; card.hidden = false; renderCard(); updateFollowButton(); }
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
function fmt(v, digits) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return v.toLocaleString('ru-RU', { maximumFractionDigits: digits === undefined ? 2 : digits });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10).split('-').reverse().join('.') + ' ' + v.slice(11, 16);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const simClock = () => { const s = val(NS + ':mine', 'sim_time', ''); return typeof s === 'string' && s.length >= 16 ? s.slice(11, 16) : '—:—'; };

// ---------------------------------------------------------------- панель диспетчера
function plantCard(id, label) {
  const plan = Number(attr(id, 'design_tph', 0)) || 0;
  const feed = Number(val(id, 'feed_rate', 0)) || 0;
  let pct = Number(val(id, 'plan_fulfilment', NaN));
  if (!isFinite(pct)) pct = plan ? feed / plan * 100 : 0;
  const state = val(id, 'state', '');
  const stopped = STOPPED.includes(state);
  const cu = val(id, 'feed_cu', null), clay = val(id, 'feed_clay', null);
  const extra = [];
  if (cu !== null) extra.push('Cu в питании ' + fmt(cu, 2) + ' %');
  if (clay !== null) extra.push('глина ' + fmt(clay, 0) + ' %');
  const stateCls = stopped ? 'bad' : (state === 'idle' ? 'warn' : 'ok');
  return '<div class="plant-card' + (stopped ? ' stopped' : '') + '">' +
    '<div class="row"><b>' + esc(label) + '</b><span class="state ' + stateCls + '">' + esc(STATE_NAMES[state] || state || '—') + '</span></div>' +
    '<div class="row muted">план ' + fmt(plan, 0) + ' т/ч · факт <b>' + fmt(feed, 0) + ' т/ч</b></div>' +
    '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, pct)).toFixed(0) + '%" class="' + (pct < 70 ? 'bad' : pct < 90 ? 'warn' : 'ok') + '"></i><span>' + fmt(pct, 0) + ' %</span></div>' +
    (extra.length ? '<div class="muted">' + esc(extra.join(' · ')) + '</div>' : '') + '</div>';
}
function renderDispatcher() {
  const mine = NS + ':mine', disp = NS + ':dispatch';
  document.getElementById('shift-line').textContent =
    'Смена ' + fmt(val(mine, 'shift', '—'), 0) + ' · ' + simClock() + ' модельного времени' +
    (val(mine, 'shift_hour', null) !== null ? ' · ' + fmt(val(mine, 'shift_hour'), 1) + '-й час' : '');
  document.getElementById('plants').innerHTML =
    plantCard(NS + ':plant-sulphide', 'Сульфидная фабрика') + plantCard(NS + ':plant-clay', 'Глинистая фабрика');
  // транспорт: сводка по самосвалам
  let hauling = 0, queued = 0, down = 0, total = 0;
  for (const [id, t] of Object.entries(twins)) {
    if (!id.startsWith(NS + ':truck-')) continue;
    total++;
    const s = val(id, 'state', '');
    if (s === 'down') down++;
    else if (s === 'queued_load' || s === 'queued_dump') queued++;
    if (s && s !== 'down') hauling++;
  }
  const th = val(disp, 'trucks_hauling', null);
  const wait = val(disp, 'avg_wait_excavator', null);
  const wUnit = (twins[disp] && twins[disp].features.avg_wait_excavator && twins[disp].features.avg_wait_excavator.properties.unit) || 'мин';
  const rows = [
    ['Режим', MODE_NAMES[val(disp, 'mode', '')] || val(disp, 'mode', '—')],
    ['Ожидание у экскаватора', wait === null ? '—' : fmt(wait, 1) + ' ' + wUnit],
    ['Самосвалы в работе / в очереди / авария', (th !== null ? fmt(th, 0) : hauling) + ' / ' + queued + ' / ' + down + (total ? ' из ' + total : '')],
    ['Очередь у дробилки', fmt(val(disp, 'queue_crusher', val(NS + ':crusher-01', 'trucks_queued', 0)), 0)],
    ['Очередь у склада глины', fmt(val(disp, 'queue_clay', val(NS + ':stockpile-clay', 'trucks_queued', 0)), 0)],
  ];
  document.getElementById('transport-table').innerHTML = rows.map(([k, v]) =>
    '<tr><td>' + esc(k) + '</td><td class="val">' + esc(v) + '</td></tr>').join('');
  const vis = val(mine, 'visibility', null);
  document.getElementById('weather').textContent = 'Погода: ' + fmt(val(mine, 'temperature', null), 0) + ' °C · ветер ' +
    fmt(val(mine, 'wind', null), 0) + ' м/с · видимость ' + (vis === null ? '—' : fmt(vis, 0) + ' м') +
    ' · ограничение ' + fmt(val(mine, 'speed_limit', null), 0) + ' км/ч';
  const off = !!val(NS + ':scenarios', 'dispatch_off', false);
  document.getElementById('transport-block').classList.toggle('alert', off);
  document.getElementById('dispatch-off-note').hidden = !off;
}

// ---------------------------------------------------------------- сценарии: кнопки, плашка, значки
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
      const title = document.createElement('span'); title.className = 'title'; title.textContent = SCENARIO_NAMES[name] || name;
      const show = document.createElement('button'); show.type = 'button'; show.className = 'show'; show.textContent = 'показать';
      show.title = 'Камера к главному объекту сценария';
      const btn = document.createElement('button'); btn.type = 'button';
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = SCENARIO_HINTS[name] ? 'Что смотреть: ' + SCENARIO_HINTS[name] : '';
      const params = document.createElement('div'); params.className = 'params';
      row.append(title, show, btn); div.append(row, hint, params); root.appendChild(div);
      rec = scenarioButtons[name] = { btn, params, value: null };
      btn.addEventListener('click', () => setScenario(name, !rec.value, btn));
      show.addEventListener('click', () => {
        const f = twins[NS + ':scenarios'] && twins[NS + ':scenarios'].features[name];
        flyToThing(scenarioTarget(name, (f && f.properties) || {}));
      });
    }
    rec.value = !!p.value;
    rec.btn.textContent = rec.value ? 'Выключить' : 'Включить';
    rec.btn.className = rec.value ? 'on' : 'off';
    rec.params.textContent = Object.entries(p)
      .filter(([k]) => !['value', 'unit', 'owner'].includes(k))
      .map(([k, v]) => k + ': ' + fmt(v)).join(' · ');
  }
  renderScenarioBanner(t);
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
// Объект, которого касается сценарий (thingId), по параметрам признака
function scenarioTarget(name, p) {
  switch (name) {
    case 'crusher_stop': return NS + ':crusher-01';
    case 'blizzard': return NS + ':stockpile-coarse';
    case 'dispatch_off': return NS + ':excavator-01';
    case 'sag_maintenance': return NS + ':sag-mill-01';
    case 'road_closed': return p.road ? NS + ':' + p.road : null;
    case 'excavator_down': return p.excavator ? NS + ':' + p.excavator : null;
    case 'clay_face': case 'bad_blast': return p.face ? NS + ':' + p.face : null;
    default: return null;
  }
}
const badges = {};   // имя сценария -> подпись-значок
function renderScenarioBanner(t) {
  const active = [];
  for (const [name, feat] of Object.entries(t.features)) {
    const p = feat.properties || {};
    const on = !!p.value;
    if (on) active.push(SCENARIO_NAMES[name] || name);
    // значок над объектом
    let b = badges[name];
    if (on && !b) {
      const target = scenarioTarget(name, p);
      const obj = target && byThing(target);
      if (obj) {
        const base = labels.find((L) => L.obj === obj || (L.obj.parent === obj && !L.el.classList.contains('warn')));
        b = badges[name] = addLabel(obj, '⚠ ' + (SCENARIO_NAMES[name] || name), { importance: 3.5, cls: 'warn', dy: (base ? base.dy : 20) + 14 * markerScale });
      }
    }
    if (b) b.enabled = on;
  }
  const banner = document.getElementById('scenario-banner');
  banner.hidden = active.length === 0;
  banner.textContent = active.length ? 'Активные сценарии: ' + active.join(' · ') : '';
  // метель — дымка на всей сцене
  const blizzard = !!val(NS + ':scenarios', 'blizzard', false);
  const visibility = val(NS + ':mine', 'visibility', blizzard ? 300 : 5000);
  if (environment) environment.setWeather({ blizzard, visibility });   // туман по дальности видимости
  if (lighting === 'night') nightSky();                                  // ночью небо остаётся тёмным
  const wb = document.getElementById('weather-banner');
  if (wb) {
    wb.hidden = !blizzard;
    if (blizzard) wb.textContent = 'Метель · видимость ' + fmt(visibility, 0) + ' м · ограничение скорости ' + fmt(val(NS + ':mine', 'speed_limit', 20), 0) + ' км/ч';
  }
}

// ---------------------------------------------------------------- советы диспетчеру (двойник advisor)
const ADVICE_CLS = { critical: 'crit', important: 'imp', info: 'info' };
const ADVICE_PRI = { critical: 'критично', important: 'важно', info: 'к сведению' };
const adviceBadges = {};   // id совета -> значок над объектом
let adviceShown = [];      // последний список советов (для кликов)
let prevAdvicePri = null;  // id совета -> приоритет (для журнала событий)
let lastAdviceRaw = null;  // последняя отрисованная строка advice (перерисовка только при изменении)
function adviceList() {
  const raw = val(NS + ':advisor', 'advice', null);
  if (raw === null) return null;
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
// Камера летит к объекту совета, карточка открывается
function flyToThing(thingId) {
  const obj = thingId && byThing(thingId);
  if (!obj) { if (thingId && twins[thingId]) openCard(thingId); return; }   // объекта в сцене нет — хотя бы карточка
  followId = null; updateFollowButton();
  obj.getWorldPosition(_v);
  const size = ((obj.userData.size && obj.userData.size.length) || 60) * (obj.scale.x || 1);
  const [dMin, k] = mp().fly;
  const d = Math.max(dMin, size * k);
  flyTo(_v.clone().add(new THREE.Vector3(-d * 0.7, d * 0.7, d * 0.9)), _v.clone());
  markViewButton('');
  openCard(thingId);
}
function adviceHtml(a, i, top) {
  const cls = ADVICE_CLS[a.priority] || 'info';
  return '<div class="advice ' + cls + (top ? ' top' : '') + '" data-i="' + i + '" title="Показать объект в сцене">' +
    '<div class="pri">' + esc(ADVICE_PRI[a.priority] || a.priority) + (a.title ? ' · ' + esc(a.title) : '') + '</div>' +
    '<div class="text">' + esc(a.text || '') + '</div>' +
    (top ? '<div class="why">' + esc(a.reason || '') + (a.effect ? ' · Ожидаемый эффект: ' + esc(a.effect) : '') + '</div>' : '') + '</div>';
}
function renderAdvice() {
  const root = document.getElementById('advice');
  const raw = val(NS + ':advisor', 'advice', null);
  if (raw === lastAdviceRaw) return;                 // ничего не изменилось — не трогаем DOM (иначе теряются клики)
  lastAdviceRaw = raw;
  const list = adviceList();
  if (list === null) { root.innerHTML = '<div class="advice none">нет данных</div>'; return; }
  adviceShown = list;
  root.innerHTML = list.length
    ? list.map((a, i) => adviceHtml(a, i, i === 0)).join('')
    : '<div class="advice none">Отклонений нет — советов пока нет</div>';
  for (const el of root.querySelectorAll('[data-i]')) el.addEventListener('click', () => flyToThing(adviceShown[+el.dataset.i].target));
  // значок над объектом совета
  const ids = new Set(list.map((a) => a.id));
  for (const a of list) {
    let b = adviceBadges[a.id];
    if (!b) {
      const obj = a.target && byThing(a.target);
      if (obj) {
        const base = labels.find((L) => L.obj === obj || (L.obj.parent === obj && !L.el.classList.contains('warn')));
        b = adviceBadges[a.id] = addLabel(obj, '💡 совет', { importance: 3.5, cls: 'advice', dy: (base ? base.dy : 20) + 30 * markerScale });
      }
    }
    if (b) { b.enabled = true; b.el.classList.toggle('crit', a.priority === 'critical'); b.el.textContent = '💡 ' + (a.title || 'совет'); }
  }
  for (const [id, b] of Object.entries(adviceBadges)) if (!ids.has(id)) b.enabled = false;
  // журнал: новые, снятые советы и смена приоритета
  const pri = {};
  for (const a of list) pri[a.id] = a.priority;
  if (prevAdvicePri !== null) {
    for (const a of list) {
      if (!(a.id in prevAdvicePri)) logEvent('Совет (' + (ADVICE_PRI[a.priority] || a.priority) + '): ' + a.text);
      else if (prevAdvicePri[a.id] !== a.priority) logEvent('Совет теперь «' + (ADVICE_PRI[a.priority] || a.priority) + '»: ' + (a.title || a.id));
    }
    for (const id of Object.keys(prevAdvicePri)) if (!ids.has(id)) logEvent('Совет снят: ' + id);
  }
  prevAdvicePri = pri;
}

// ---------------------------------------------------------------- журнал событий
const LOG_MAX = 50;
const logEntries = [];
let prevWatch = null;
function logEvent(text) {
  logEntries.unshift({ time: simClock(), text });
  if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
  document.getElementById('log').innerHTML = logEntries.map((e) =>
    '<div class="log-row"><span class="t">' + esc(e.time) + '</span> ' + esc(e.text) + '</div>').join('');
}
function watchState() {
  const w = {};
  const sc = twins[NS + ':scenarios'];
  if (sc) for (const [n, f] of Object.entries(sc.features)) w['scen:' + n] = !!(f.properties && f.properties.value);
  w['crusher.state'] = val(NS + ':crusher-01', 'state', undefined);
  w['crusher.accepting'] = val(NS + ':crusher-01', 'accepting', undefined);
  w['clay.accepting'] = val(NS + ':stockpile-clay', 'accepting', undefined);
  for (const id of Object.keys(twins)) {
    if (id.startsWith(NS + ':excavator-') || id.startsWith(NS + ':truck-')) w['down:' + id] = val(id, 'state', '') === 'down';
    else if (id.startsWith(NS + ':road-')) w['open:' + id] = val(id, 'open', undefined);
  }
  return w;
}
function diffEvents() {
  const cur = watchState();
  if (prevWatch) {
    for (const [k, v] of Object.entries(cur)) {
      const was = prevWatch[k];
      if (was === v || was === undefined) continue;
      if (k.startsWith('scen:')) logEvent((v ? 'Включён' : 'Выключен') + ' сценарий «' + (SCENARIO_NAMES[k.slice(5)] || k.slice(5)) + '»');
      else if (k === 'crusher.state') {
        const n = nameOf(NS + ':crusher-01');
        if (STOPPED.includes(v)) logEvent(n + ' остановилась (' + (STATE_NAMES[v] || v) + ')');
        else if (STOPPED.includes(was)) logEvent(n + ' запустилась');
        else logEvent(n + ': ' + (STATE_NAMES[v] || v));
      } else if (k === 'crusher.accepting') logEvent(nameOf(NS + ':crusher-01') + (v === false ? ' не принимает самосвалы' : ' снова принимает самосвалы'));
      else if (k === 'clay.accepting') logEvent(nameOf(NS + ':stockpile-clay') + (v === false ? ' не принимает самосвалы' : ' снова принимает самосвалы'));
      else if (k.startsWith('down:')) logEvent(nameOf(k.slice(5)) + (v ? ' — авария' : ' снова в работе'));
      else if (k.startsWith('open:')) logEvent('Дорога «' + nameOf(k.slice(5)) + '» ' + (v === false ? 'закрыта' : 'открыта'));
    }
  }
  prevWatch = cur;
}

// ---------------------------------------------------------------- сверка с реальностью (advisor.reality, core/reality.py)
const REALITY_STATUS = { ok: 'в пределах ±10 %', off: 'вне ±10 %', warmup: 'модель разгоняется', no_data: 'нет данных' };
let lastRealityRaw = null;
function fmtNum(v, unit) {
  const d = unit === '% Cu' ? 3 : (unit === 'мин' || unit === 'кВт·ч/т' || unit === '%') ? 1 : 0;
  return fmt(v, d);
}
function renderReality() {
  const box = document.getElementById('reality');
  if (!box || box.hidden) return;
  const raw = val(NS + ':advisor', 'reality', null);
  if (raw === lastRealityRaw) return;
  lastRealityRaw = raw;
  const tbody = document.querySelector('#reality-table tbody');
  let data = null;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { data = null; }
  if (!data || !Array.isArray(data.rows)) { tbody.innerHTML = '<tr><td colspan="4" class="muted">нет данных — советник ещё не опубликовал сверку</td></tr>'; return; }
  const note = document.getElementById('reality-note');
  note.textContent = (data.warmup ? 'Модель разгоняется: данных ' + fmt(data.window_min, 0) + ' модельных минут из 60 — сравнение предварительное. ' : '') +
    'Модель — среднее по двойникам за последний модельный час; реальность — факты Бозшаколя (data/SOURCES.md). ' +
    'Зелёный — отклонение в пределах ±10 %, жёлтый — больше.';
  tbody.innerHTML = data.rows.map((r) => {
    const real = r.real_range ? fmtNum(r.real_range[0], r.unit) + '–' + fmtNum(r.real_range[1], r.unit) : fmtNum(r.real, r.unit);
    const model = r.model === null || r.model === undefined ? null : fmtNum(r.model, r.unit);
    const dev = r.dev_pct === null || r.dev_pct === undefined ? REALITY_STATUS[r.status] || '—'
      : (r.dev_pct > 0 ? '+' : '') + fmt(r.dev_pct, 1) + ' %' + (r.status === 'warmup' ? ' · разгон' : '');
    return '<tr title="' + esc('Реальность: ' + r.source + '\nМодель: ' + r.model_from) + '">' +
      '<td>' + esc(r.name) + '<div class="src">' + esc(r.source.split(' — ')[0]) +
      (r.calibrated ? ' · калибровка: план модели взят из этого же отчёта' : '') + '</div></td>' +
      '<td class="num">' + (model === null ? '—' : esc(model) + ' ' + esc(r.unit)) + '</td>' +
      '<td class="num">' + esc(real) + ' ' + esc(r.unit) + '</td>' +
      '<td class="num"><span class="dev ' + esc(r.status) + '">' + esc(dev) + '</span></td></tr>';
  }).join('');
}
function initReality() {
  const box = document.getElementById('reality'), btn = document.getElementById('btn-reality');
  if (!box || !btn) return;
  const show = (on) => { box.hidden = !on; btn.classList.toggle('active', on); lastRealityRaw = null; renderReality(); };
  btn.addEventListener('click', () => { show(box.hidden); btn.blur(); });
  document.getElementById('reality-close').addEventListener('click', () => show(false));
}

function renderPanel() {
  renderDispatcher();
  renderReality();
  renderScenarios();
  renderAdvice();
  diffEvents();
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
// Карьер рисует pit.js (уступы, бермы, оттенки руды, отбойные валы); здесь — клик и подписи
function buildPit() {
  const faces = (geometry.objects || []).filter((o) => o.kind === 'face')
    .map((o) => ({ x: o.position[0], y: o.position[1], ore: o.ore_type }));
  terrain.add(buildPitModel(THREE, geometry, terrainApi, toScene, colors, faces));
  const pit = geometry.pit, A = pit.semi_axes_top[0], B = pit.semi_axes_top[1], inset = pit.inset_per_bench, count = pit.bench_count;
  // невидимое дно — цель клика и подписи карьера
  const fShape = new THREE.Shape(); fShape.absellipse(0, 0, A - count * inset, B - count * inset, 0, Math.PI * 2, false, 0);
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(fShape, 32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -pit.depth * VZ + 1;
  terrain.add(floor);
  register(floor, NS + ':pit-central', { hitRadius: 0 });
  addLabel(floor, 'Карьер · дно −' + pit.depth + ' м', { importance: 3, dy: 4 });
  const rimAnchor = new THREE.Object3D(); rimAnchor.position.copy(toScene(0, B, terrainApi.demAt(0, B))); terrain.add(rimAnchor);
  addLabel(rimAnchor, 'Карьер Бозшаколь · ' + fmt(2 * A / 1000, 1) + ' × ' + fmt(2 * B / 1000, 1) + ' км', { importance: 3, dy: 6 });
}

// ---------------------------------------------------------------- дороги
const roadMeshes = {};   // roadId -> [mesh]
const roadMats = {
  open: new THREE.MeshLambertMaterial({ color: colors.road }),
  ramp: new THREE.MeshLambertMaterial({ color: colors.ramp }),
  edge: new THREE.MeshLambertMaterial({ color: colors.roadEdge }),
  shoulder: new THREE.MeshLambertMaterial({ color: 0xbfae86 }),   // обочина в схеме
  berm: new THREE.MeshLambertMaterial({ color: 0xa8916c }),       // отбойный вал съездов в схеме
  closed: new THREE.MeshLambertMaterial({ color: colors.roadClosed }),
};
// Высота узла дороги в сцене: Z узлов geometry.json уже абсолютные — наземные узлы получают
// высоту рельефа в core/tools/make_geometry.py (их читает и модуль транспорта), ничего не добавляем
function nodePos(n) {
  return toScene(n[0], n[1], n[2] + mp().road.lift);
}
// Коробки дорог сливаются в одну геометрию на (дорогу, материал): вызовов отрисовки в разы меньше
function mergeBoxes(list) {
  const pos = [], nor = [];
  for (const { geo, matrix } of list) {
    const g = geo.toNonIndexed(); g.applyMatrix4(matrix);
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    geo.dispose(); g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
function buildRoads() {
  const ramps = {};   // road -> [точки] для подписи (середина съезда)
  const parts = {};   // 'дорога|материал' -> [{geo, matrix}]
  const add = (road, mat, geo, matrix) => (parts[road + '|' + mat] || (parts[road + '|' + mat] = [])).push({ geo, matrix });
  const R = mp().road, schema = mode === 'schema';
  // в схеме ребро режется на куски ≈ 80 единиц: дорога идёт по поверхности (съезд выходит на борт, а не под землю)
  const pieces = [];
  for (const e of geometry.edges) {
    const a = geometry.nodes[e.from], b = geometry.nodes[e.to];
    if (!a || !b) continue;
    const n = schema ? Math.max(1, Math.ceil(nodePos(a).distanceTo(nodePos(b)) / 80)) : 1;
    for (let i = 0; i < n; i++) {
      const p = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      pieces.push({ e, a: p(i / n), b: p((i + 1) / n), first: i === 0 });
    }
  }
  for (const { e, a, b } of pieces) {
    const isRamp = /^road-ramp/.test(e.road);
    const pa = nodePos(a), pb = nodePos(b);
    const len = pa.distanceTo(pb);
    const width = isRamp ? R.ramp : R.w;
    const o = new THREE.Object3D();
    o.position.copy(pa).add(pb).multiplyScalar(0.5);
    o.lookAt(pb);                       // ось Z коробки — вдоль ребра
    o.updateMatrix();
    add(e.road, isRamp ? 'ramp' : 'open', new THREE.BoxGeometry(width, R.h, len + width), o.matrix.clone());
    const below = (dy) => new THREE.Matrix4().makeTranslation(0, -dy, 0).multiply(o.matrix);
    if (schema) {
      // схема: светлая обочина чуть ниже полотна; у съездов — отбойный вал по обеим сторонам
      add(e.road, 'shoulder', new THREE.BoxGeometry(width + 2.4, R.h, len + width + 1.2), below(0.2));
      if (isRamp) for (const side of [-1, 1]) {
        add(e.road, 'berm', new THREE.BoxGeometry(1.1, 1.3, len), o.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(side * (width / 2 + 0.9), 0.5, 0)));
      }
    } else {
      // бровка: чуть шире и чуть ниже полотна — у всех дорог (на съездах шире — отбойный вал); верх бровки ниже полотна
      add(e.road, 'edge', new THREE.BoxGeometry(width + (isRamp ? 10 : 7), isRamp ? 2.6 : 1.4, len + width + 6), below(isRamp ? 1.2 : 0.4));
    }
    if (isRamp) (ramps[e.road] || (ramps[e.road] = [])).push(pa, pb);
  }
  for (const [key, list] of Object.entries(parts)) {
    const [road, mat] = key.split('|');
    const m = new THREE.Mesh(mergeBoxes(list), roadMats[mat]);
    terrain.add(m);
    if (mat === 'open' || mat === 'ramp') { m.userData.road = road; (roadMeshes[road] || (roadMeshes[road] = [])).push(m); }
  }
  for (const [rid, pts] of Object.entries(ramps)) {
    const mid = pts[Math.floor(pts.length / 2)].clone(); mid.y += 2 * mp().unit;
    const anchor = new THREE.Object3D(); anchor.position.copy(mid); terrain.add(anchor);
    for (const m of roadMeshes[rid]) m.userData.thingId = NS + ':' + rid;   // клик по полотну — карточка дороги
    register(anchor, NS + ':' + rid, { hitRadius: 0 });
    clickable.push(...roadMeshes[rid]);
    const info = (geometry.roads && geometry.roads[rid]) || {};
    addLabel(anchor, info.name || rid, { importance: 3, dy: mode === 'schema' ? 2 : 10 });
  }
}
// Дороги road-* при open=false — красные
function updateRoads() {
  for (const [rid, meshes] of Object.entries(roadMeshes)) {
    const open = val(NS + ':' + rid, 'open', true);
    const mat = open === false ? roadMats.closed : (/^road-ramp/.test(rid) ? roadMats.ramp : roadMats.open);
    for (const m of meshes) m.material = mat;
  }
}

// ---------------------------------------------------------------- камера: виды, плавные переходы, слежение
// Координаты — рудника (м), по geometry.json: карьер в центре, дробилка на южном борту,
// конвейер и фабрика к западу-юго-западу, отвалы к юго-востоку
const VIEWS = {
  all: { target: [-1100, -300, 0], pos: [-1500, -7900, 3600] },      // косой вид ≈ 35° на весь макет
  pit: { target: [150, -50, -110], pos: [-300, -2500, 1250] },       // карьер: техника на уступах и дне
  crusher: { target: [-420, -640, 0], pos: [-760, -1650, 430] },     // дробилка, заправка, начало конвейера
  plants: { target: [-2600, -800, 15], pos: [-2950, -1850, 520] },   // фабрика, склад, подстанция
};
let tween = null;         // {fromPos, toPos, fromTgt, toTgt, t}
let followId = null;      // thingId самосвала, за которым идёт камера
const btnFollow = document.getElementById('btn-follow');
function setPerspective() {
  if (camera === perspCam) return;
  camera = perspCam; controls.enabled = true; topControls.enabled = false;
  markViewButton('');
}
function flyTo(pos, target) {
  setPerspective();
  tween = { fromPos: perspCam.position.clone(), toPos: pos.clone(), fromTgt: controls.target.clone(), toTgt: target.clone(), t: 0 };
}
function markViewButton(name) {
  for (const b of document.querySelectorAll('#topbar button[data-view]')) b.classList.toggle('active', b.dataset.view === name);
}
// Виды схемы — в координатах схемы [x — восток, y — север, z — высота], единицы
const VIEWS_SCHEMA = {
  all: { target: [-400, -130, 0], pos: [-480, -1500, 1000] },    // косой вид ≈ 35° на весь рудник
  pit: { target: [-60, -20, -40], pos: [-140, -560, 330] },      // карьер: 13 уступов, съезды, техника на дне
  crusher: { target: [-100, -200, 0], pos: [-150, -330, 90] },   // дробилка, заправка, начало конвейера
  plants: { target: [-860, -270, 5], pos: [-920, -480, 150] },   // фабрика, склад, подстанция
};
// Переход к виду по имени (кнопки сверху и клавиши 1–5)
function setView(name) {
  const views = mode === 'schema' ? VIEWS_SCHEMA : VIEWS;
  const conv = (p) => (mode === 'schema' ? dio.s(...p) : realToScene(...p));
  if (name !== 'top' && !views[name]) return;
  followId = null; updateFollowButton(); stopOrbit();
  if (name === 'top') {
    camera = orthoCam; controls.enabled = false; topControls.enabled = true; tween = null;
  } else {
    const v = views[name];
    const target = conv(v.target);
    flyTo(fitToAspect(conv(v.pos), target), target);
  }
  markViewButton(name);
}
for (const b of document.querySelectorAll('#topbar button[data-view]')) {
  b.addEventListener('click', () => setView(b.dataset.view));
}
function updateFollowButton() {
  const canFollow = !!(openedThing && openedThing.startsWith(NS + ':truck-'));
  btnFollow.disabled = !canFollow;
  if (followId && openedThing && openedThing !== followId && canFollow) followId = openedThing;   // выбрали другой самосвал
  if (!canFollow) followId = null;
  btnFollow.classList.toggle('active', !!followId);
  btnFollow.textContent = followId ? 'Следую: ' + nameOf(followId) : 'Следовать за самосвалом';
}
// Следовать за выбранным самосвалом / отпустить (кнопка и Пробел)
function toggleFollow() {
  if (followId) { followId = null; updateFollowButton(); return; }
  const obj = openedThing && byThing(openedThing);
  if (!obj) return;
  followId = openedThing;
  obj.getWorldPosition(_v);
  stopOrbit();
  flyTo(_v.clone().add(new THREE.Vector3(...mp().follow)), _v.clone());
  markViewButton('');
  updateFollowButton();
}
btnFollow.addEventListener('click', toggleFollow);
const _d = new THREE.Vector3();
function updateCamera(dt) {
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.0);
    const s = tween.t * tween.t * (3 - 2 * tween.t);   // плавный разгон и торможение
    perspCam.position.lerpVectors(tween.fromPos, tween.toPos, s);
    controls.target.lerpVectors(tween.fromTgt, tween.toTgt, s);
    if (tween.t >= 1) tween = null;
  } else if (followId && camera === perspCam) {
    const obj = byThing(followId);
    if (obj && (obj.visible || obj.userData.farHidden)) {
      obj.getWorldPosition(_v);
      _d.subVectors(_v, controls.target).multiplyScalar(Math.min(1, dt * 4));   // камера догоняет плавно
      controls.target.add(_d); perspCam.position.add(_d);
    }
  }
  (camera === perspCam ? controls : topControls).update();
  // масштаб техники — постоянный (MACHINE_SCALE); на дальнем плане её видно по значкам-стрелкам (updateMarkers)
  markerScale = MACHINE_SCALE[mode];
  if (orbitId && !tween && camera === perspCam) {   // облёт: цель — на объекте, камера вращается вокруг
    const obj = byThing(orbitId);
    if (obj) { obj.getWorldPosition(_v); _d.subVectors(_v, controls.target).multiplyScalar(Math.min(1, dt * 4)); controls.target.add(_d); perspCam.position.add(_d); }
  }
}

// ---------------------------------------------------------------- слои
// ctx.place(obj, x, y, z, heading) — рекомендуемая постановка объекта в обоих режимах: место по toScene,
// курс (градусы, 0 — север, по часовой) — по направлению в сцене (в схеме дороги повёрнуты не как в жизни)
function place(obj, x, y, z, heading) {
  const p = toScene(x, y, z);
  obj.position.copy(p);
  const h = Number(heading);
  if (heading !== undefined && heading !== null && isFinite(h)) {
    const r = h * Math.PI / 180, q = toScene(x + Math.sin(r) * 5, y + Math.cos(r) * 5, z);
    if (Math.hypot(q.x - p.x, q.z - p.z) > 1e-6) obj.rotation.y = Math.atan2(q.x - p.x, q.z - p.z);
  }
  return obj;
}
// suffix — новая копия модулей слоёв (?w=N) при пересборке мира: их внутреннее состояние начинается заново
async function loadLayers(suffix = '') {
  for (const name of ['haulage', 'geology', 'processing']) {
    const group = new THREE.Group(); group.name = 'layer-' + name; scene.add(group);
    const ctx = {
      THREE, scene, group, geometry, toScene, register, colors, dt: 0, camera, label: addLabel,
      markerScale, hover: null, selected: null, heightAt: groundAt, groundAt, place, mode,
      models: modelsLib, verticalScale: mode === 'schema' ? 1 : VZ,
    };
    try {
      const mod = await import('./layers/' + name + '.js' + suffix);
      if (typeof mod.init === 'function') await mod.init(ctx);
      layers.push({ name, mod, ctx, errors: 0 });
    } catch (e) {
      console.error('Слой ' + name + ': ошибка загрузки', e);
    }
  }
}

// ---------------------------------------------------------------- клавиатура (controls.js)
let keyboard = null;
function initKeys() {
  const half = (terrainApi && terrainApi.meta && terrainApi.meta.half_m) || 3000;   // квадрат рельефа, м
  const area = (terrainApi && terrainApi.areaHalf) || 3000;   // земля 10 × 10 км
  keyboard = initKeyboard({
    camera: () => camera,
    controls: () => (camera === perspCam ? controls : topControls),
    isTop: () => camera === orthoCam,
    setView, goHome: () => setView('all'), toggleFollow, clearSelection,
    stopFly: () => { tween = null; },
    unit: () => mp().unit,
    // высота земли под точкой сцены (sx, sz) — в единицах сцены
    groundY: (sx, sz) => (mode === 'schema' && dio ? dio.surfaceAt(sx, -sz) : terrainApi.heightAt(sx, -sz) * VZ),
    // границы движения камеры (координаты рудника или схемы): макет и поле вокруг; камера общего вида южнее макета
    bounds: () => {
      if (mode === 'schema' && dio) { const b = dio.bounds; return { minX: b.minX - 100, maxX: b.maxX + 100, minY: b.minY - 420, maxY: b.maxY + 100 }; }
      return terrainApi && terrainApi.bounds
        ? { minX: terrainApi.bounds.minX - 2500, maxX: terrainApi.bounds.maxX + 2500, minY: terrainApi.bounds.minY - 6000, maxY: terrainApi.bounds.maxY + 2500 }
        : { minX: -area, maxX: area, minY: -area, maxY: area };
    },
  });
}

// ---------------------------------------------------------------- качество, контактные тени, маршрут
// «Высокое» — тени от солнца и ореолы огней; «Обычное» — без них (контактные тени-круги остаются всегда).
// При старте 3 с замер кадров: меньше 25 к/с — автоматически «Обычное». Выбор пользователя запоминается.
let quality = 'high', qualityAuto = true, qualityProbe = null;
const shadowCasters = new WeakSet();
function applyQuality(q) {
  quality = q === 'normal' ? 'normal' : 'high';
  const high = quality === 'high';
  // «Обычное»: кадр в разрешении 0,65 от экрана — без видеокарты отрисовка пикселей самая дорогая часть кадра
  renderer.setPixelRatio(high ? 1 : 0.65);
  resize();
  renderer.shadowMap.enabled = high;
  sun.castShadow = high;
  if (environment && environment.setQuality) environment.setQuality(high || lighting === 'night');   // ночью огни горят всегда
  if (environment && environment.setLook) environment.setLook({ cheap: !high, night: lighting === 'night' });
  for (const s of glowSprites) s.visible = high;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  const sel = document.getElementById('quality');
  if (sel) sel.value = quality;
}
// ---------------------------------------------------------------- освещение: «День» / «Ночная смена»
// Ночью: тёмное небо, приглушённые небо и луна, ореолы прожекторов мачт (при любом качестве), фары самосвалов
// с ореолами, подсвеченные окна корпусов (models.setNight). Без постобработки — только спрайты и материалы.
let lighting = 'day';
const NIGHT_BG = 0x0f1a2c;
function nightSky() {
  if (!scene.background || !scene.background.isColor) scene.background = new THREE.Color(NIGHT_BG);
  else scene.background.setHex(NIGHT_BG);
  if (scene.fog) scene.fog.color.setHex(NIGHT_BG);
}
function applyLighting(l) {
  lighting = l === 'night' ? 'night' : 'day';
  const night = lighting === 'night';
  hemi.color.setHex(night ? 0x5d7096 : 0xe3eef8); hemi.groundColor.setHex(night ? 0x2b2620 : 0xb59c74);
  hemi.intensity = night ? 0.8 : 1.35;
  sun.color.setHex(night ? 0x9fb6ff : 0xffe4bd); sun.intensity = night ? 0.6 : 3.1;   // ночью — луна
  for (const name of ['diorama-grid', 'grid']) {   // сетка фона (схема и «Карта местности») ночью — тёмно-синяя
    const grid = scene.getObjectByName(name);
    if (grid && grid.material) grid.material.color.setHex(night ? 0x34476b : 0xffffff);
  }
  scene.traverse((o) => {   // ореолы прожекторов ночью крупнее
    if (!o.isSprite || !o.userData.glow) return;
    if (!o.userData.baseScale) o.userData.baseScale = o.scale.x;
    o.scale.setScalar(o.userData.baseScale * (night ? 1.7 : 1));
  });
  renderer.toneMappingExposure = night ? 1.15 : 1.05;
  if (modelsLib && modelsLib.setNight) modelsLib.setNight(night);
  if (environment && environment.setQuality) environment.setQuality(quality === 'high' || night);
  if (environment && environment.setLook) environment.setLook({ cheap: quality !== 'high', night });
  if (night) nightSky();
  else renderScenarioBannerSafe();   // днём фон и туман — по погоде (метель)
  updateHeadlights();
  const sel = document.getElementById('lighting');
  if (sel) sel.value = lighting;
  window.__lighting = lighting;
}
function renderScenarioBannerSafe() {
  const t = twins[NS + ':scenarios'];
  if (t) renderScenarioBanner(t);
  else if (environment && environment.setWeather) environment.setWeather({ blizzard: false, visibility: 5000 });
}
// фары: ореол спереди каждого самосвала (дочерний спрайт — масштабируется вместе с моделью), видны ночью
let headTex = null;
function updateHeadlights() {
  const night = lighting === 'night';
  for (const o of clickable) {
    if ((o.userData.thingId || '').indexOf(':truck-') < 0 || o.isMesh) continue;
    let hl = o.userData.headlight;
    if (!hl && night) {
      headTex = headTex || glowTexture(THREE);
      hl = new THREE.Group();
      const L = ((o.userData.size && o.userData.size.length) || 13) / 2 + 0.6;
      for (const x of [-2.4, 2.4]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: headTex, color: 0xfff1c8, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
        sp.position.set(x, 2.6, L); sp.scale.set(5, 5, 1); sp.raycast = () => {};
        hl.add(sp);
      }
      const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: headTex, color: 0xffe2a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.55 }));
      beam.position.set(0, 0.6, L + 7); beam.scale.set(14, 8, 1); beam.raycast = () => {};   // пятно света на дороге
      hl.add(beam);
      o.add(hl); o.userData.headlight = hl;
    }
    if (hl) hl.visible = night;
  }
}
function initLighting() {
  const sel = document.getElementById('lighting');
  let saved = null;
  try { saved = localStorage.getItem('bz-lighting'); } catch (e) { /* хранилище недоступно */ }
  applyLighting(saved === 'night' ? 'night' : 'day');
  if (sel) sel.addEventListener('change', () => {
    applyLighting(sel.value);
    try { localStorage.setItem('bz-lighting', sel.value); } catch (e) { /* хранилище недоступно */ }
  });
}
function initQuality() {
  const sel = document.getElementById('quality');
  let saved = null;
  try { saved = localStorage.getItem('bz-quality'); } catch (e) { /* хранилище недоступно */ }
  if (saved === 'high' || saved === 'normal') { qualityAuto = false; applyQuality(saved); }
  else { applyQuality('high'); qualityProbe = { start: performance.now(), frames: 0 }; }
  if (sel) sel.addEventListener('change', () => {
    qualityAuto = false; qualityProbe = null; applyQuality(sel.value);
    try { localStorage.setItem('bz-quality', sel.value); } catch (e) { /* хранилище недоступно */ }
  });
}
// контактная тень — тёмный мягкий круг под техникой (дёшево, без карты теней)
let blobTex = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}
const blobGeo = new THREE.PlaneGeometry(1, 1);
let blobMat = null;
const glowSprites = [];
function decorateModels() {
  for (const o of clickable) {
    const id = o.userData.thingId || '';
    if (o.userData.blob || !/:(truck|excavator|drill)-/.test(id)) continue;
    const size = o.userData.size || {};
    const L = (size.length || size.l || 14), W = (size.width || size.w || 8);
    blobMat = blobMat || new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.85 });
    const b = new THREE.Mesh(blobGeo, blobMat);
    b.rotation.x = -Math.PI / 2; b.position.y = 0.25; b.scale.set(W * 1.7, L * 1.45, 1); b.renderOrder = -1;
    b.userData.blob = true; b.raycast = () => {};
    o.add(b); o.userData.blob = b;
  }
  // тени от солнца — у моделей техники и зданий (в «Высоком»)
  if (quality === 'high') scene.traverse((m) => {
    if (m.isMesh && !shadowCasters.has(m) && !m.userData.blob && m.parent && m.parent.name !== 'terrain') {
      shadowCasters.add(m);
      m.castShadow = !(m.material && m.material.transparent);
      m.receiveShadow = true;
    }
  });
}
// маршрут выбранного самосвала: кратчайший путь по графу дорог до пункта назначения — светящаяся линия
let routeMesh = null, routeKey = '';
const routeMat = new THREE.MeshBasicMaterial({ color: 0x12c8e8, transparent: true, opacity: 0.9, depthWrite: false });   // тонкая яркая линия; обычное смешение: на светлой степи сложение цветов выгорает в белое
function nearestNode(x, y) {
  let best = null, bd = Infinity;
  for (const [n, p] of Object.entries(geometry.nodes)) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = n; } }
  return best;
}
function destNode(dest) {
  if (!dest) return null;
  const nodes = geometry.nodes;
  if (nodes[dest]) return dest;
  const m = /^excavator-(\d+)$/.exec(dest);
  if (m && nodes['face-' + m[1]]) return 'face-' + m[1];
  if (/^crusher/.test(dest) && nodes.crusher) return 'crusher';
  return null;
}
function shortestPath(a, b) {
  const adj = {};
  for (const e of geometry.edges) {
    const w = e.length_m || 1;
    (adj[e.from] || (adj[e.from] = [])).push([e.to, w]);
    (adj[e.to] || (adj[e.to] = [])).push([e.from, w]);
  }
  const dist = { [a]: 0 }, prev = {}, todo = new Set(Object.keys(geometry.nodes));
  while (todo.size) {
    let u = null, du = Infinity;
    for (const n of todo) if ((dist[n] ?? Infinity) < du) { du = dist[n]; u = n; }
    if (u === null || u === b) break;
    todo.delete(u);
    for (const [v, w] of adj[u] || []) if (du + w < (dist[v] ?? Infinity)) { dist[v] = du + w; prev[v] = u; }
  }
  if (dist[b] === undefined) return null;
  const path = [b];
  while (path[0] !== a) path.unshift(prev[path[0]]);
  return path;
}
function updateRoute() {
  const id = openedThing && openedThing.startsWith(NS + ':truck-') ? openedThing : null;
  const dest = id ? destNode(val(id, 'destination', '')) : null;
  const x = id ? Number(val(id, 'x', NaN)) : NaN, y = id ? Number(val(id, 'y', NaN)) : NaN;
  const from = id && isFinite(x) && isFinite(y) ? nearestNode(x, y) : null;
  const key = id && dest && from ? id + from + dest : '';
  if (key === routeKey) return;
  routeKey = key;
  if (routeMesh) { terrain.remove(routeMesh); routeMesh.geometry.dispose(); routeMesh = null; }
  if (!key || from === dest) return;
  const path = shortestPath(from, dest);
  if (!path || path.length < 2) return;
  // ближайший узел может остаться позади самосвала — тогда линия начинается со следующего
  const n0 = geometry.nodes[path[0]], n1 = geometry.nodes[path[1]];
  if (Math.hypot(n1[0] - x, n1[1] - y) < Math.hypot(n1[0] - n0[0], n1[1] - n0[1])) path.shift();
  const z = Number(val(id, 'z', NaN));   // в карьере поверхность рельефа выше самосвала — берём его высоту из двойника
  const RT = mp().route;
  const pts = [toScene(x, y, (isFinite(z) ? z : groundAt(x, y)) + RT.lift)];
  for (const n of path) { const p = geometry.nodes[n]; pts.push(toScene(p[0], p[1], p[2] + RT.lift)); }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
  routeMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(400, pts.length * 12), RT.r, 6, false), routeMat);
  routeMesh.raycast = () => {};
  terrain.add(routeMesh);
}

// ---------------------------------------------------------------- цикл
let last = performance.now(), lastFrame = 0, frameNo = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 33) return;          // не чаще 30 кадров/с
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now; lastFrame = now; frameNo++;
  if (keyboard) keyboard.update(dt);      // клавиатура: движение камеры до перелётов и рендера
  updateCamera(dt);
  if (frameNo % 4 === 0) updateHover();      // наведение — ~8 раз в секунду
  restoreRaw();                               // поправки прошлого кадра снимаются — слой видит свои места
  for (const L of layers) {
    L.ctx.dt = dt; L.ctx.camera = camera; L.ctx.markerScale = markerScale;
    L.ctx.hover = hoverThing; L.ctx.selected = openedThing;
    try { if (typeof L.mod.update === 'function') L.mod.update(L.ctx, twins); }
    catch (e) { if (L.errors++ % 300 === 0) console.error('Слой ' + L.name + ': ошибка в update', e); }
  }
  adjustMachines(dt);
  updateDust(dt);
  if (frameNo % 15 === 0) updateDownBadges();
  if (frameNo % 30 === 1) { decorateModels(); if (lighting === 'night') updateHeadlights(); }   // тени новым моделям; фары новым самосвалам
  if (frameNo % 15 === 0) updateRoute();
  if (routeMesh) routeMat.opacity = 0.75 + 0.2 * Math.sin(now / 300);
  renderer.render(scene, camera);
  if (qualityProbe) {                       // первые 3 с — замер кадров для выбора качества
    qualityProbe.frames++;
    const el = now - qualityProbe.start;
    if (el > 3000) {
      const fps = qualityProbe.frames * 1000 / el;
      qualityProbe = null;
      if (qualityAuto && fps < 25) applyQuality('normal');
      window.__qualityProbeFps = fps;
    }
  }
  window.__quality = quality;
  window.__sceneFrames = (window.__sceneFrames || 0) + 1;   // счётчик кадров для замера производительности
  window.__renderInfo = renderer.info.render;
  window.__mode = mode;
  if (quality === 'high' || frameNo % 2 === 0 || tween) updateLabels();   // в «Обычном» подписи — через кадр
}

// ---------------------------------------------------------------- заправка (общая сцена)
function buildFuelStation() {
  const o = (geometry.objects || []).find((x) => x.kind === 'fuel');
  if (!o || !modelsLib || !modelsLib.fuelStation) return;
  const g = modelsLib.fuelStation();
  g.position.copy(toScene(o.position[0], o.position[1], groundAt(o.position[0], o.position[1])));
  const s = mode === 'schema' && dio && dio.D.objects['fuel-station'] ? dio.D.objects['fuel-station'].scale || 1 : 1;
  g.scale.setScalar(s);
  terrain.add(g);
  addLabel(g, 'Заправка (ГСМ)', { importance: 3, dy: 12 * s });
}


// ---------------------------------------------------------------- мир: сборка по режиму, пересборка при переключении
// Камера, солнце и вид сверху — под масштаб режима
function applyModeCamera() {
  const p = mp();
  perspCam.near = p.cam.near; perspCam.far = p.cam.far; perspCam.updateProjectionMatrix();
  controls.minDistance = p.cam.min; controls.maxDistance = p.cam.max;
  sun.position.set(...p.sun.pos); sun.target.position.set(...p.sun.tgt);
  Object.assign(sun.shadow.camera, { left: -p.sun.box[0], right: p.sun.box[0], top: p.sun.box[1], bottom: -p.sun.box[1], near: p.sun.near, far: p.sun.far });
  sun.shadow.camera.updateProjectionMatrix();
  const [ox, oy, oz] = p.orthoAt;
  orthoCam.position.set(ox, oy, oz); orthoCam.lookAt(ox, 0, oz); orthoCam.zoom = 1;
  topControls.target.set(ox, 0, oz); topControls.update();
  resize();
}
// Сразу (без перелёта) поставить камеру в вид
function jumpToView(name) {
  const views = mode === 'schema' ? VIEWS_SCHEMA : VIEWS, v = views[name];
  const conv = (p) => (mode === 'schema' ? dio.s(...p) : realToScene(...p));
  setPerspective(); tween = null;
  const target = conv(v.target);
  perspCam.position.copy(fitToAspect(conv(v.pos), target)); controls.target.copy(target); controls.update();
  markViewButton(name);
}
// Схема: макет (diorama-scene.js), подписи карьера, светлый фон; туман — только в метель
function buildSchemaEnvironment() {
  const d = buildDiorama(THREE, dio, modelsLib, colors, glowTexture);
  terrain.add(d.group);
  register(d.anchors.pitFloor, NS + ':pit-central', { hitRadius: 0 });
  addLabel(d.anchors.pitFloor, 'Карьер · дно −' + geometry.pit.depth + ' м', { importance: 3, dy: 2 });
  const A = geometry.pit.semi_axes_top;
  addLabel(d.anchors.pitName, 'Карьер Бозшаколь · ' + fmt(2 * A[0] / 1000, 1) + ' × ' + fmt(2 * A[1] / 1000, 1) + ' км', { importance: 3, dy: 3 });
  if (d.anchors.tailings) addLabel(d.anchors.tailings, 'Хвостохранилище', { importance: 2, dy: 2 });
  // степь уходит в дымку у горизонта: небо и туман одного светлого тона, краёв карты не видно
  scene.background = new THREE.Color(0xdde5ea);
  scene.fog = new THREE.Fog(0xdde5ea, 2600, 15000);
  return {
    group: null,
    setQuality: d.setQuality,
    setLook: d.setLook,
    setWeather({ blizzard = false } = {}) {
      scene.background.setHex(blizzard ? 0xdfe3e7 : 0xdde5ea);
      scene.fog.color.setHex(blizzard ? 0xdfe2e5 : 0xdde5ea);
      scene.fog.near = blizzard ? 120 : 2600; scene.fog.far = blizzard ? 700 : 15000;
    },
    update() {},
  };
}
function buildWorld() {
  applyModeCamera();
  if (mode === 'schema') environment = buildSchemaEnvironment();
  else {
    terrainGround = terrainApi.buildGround(terrain, { toScene });
    buildPit();
    environment = buildEnvironment(THREE, geometry, terrainApi, toScene, scene, modelsLib);
    if (terrainGround && terrainGround.setImagery) terrainGround.setImagery(true);   // «Карта местности» — со снимком
  }
  buildRoads(); updateRoads();
  buildFuelStation();
  jumpToView('all');
  updateModeUi();
}
// В схеме здания, склады и отвал меньше натуральной величины (множитель — core/diorama.json)
function applySchemaScales() {
  if (mode !== 'schema' || !dio) return;
  for (const o of clickable) {
    const id = (o.userData.thingId || '').slice(NS.length + 1);
    const s = dio.D.objects[id] && dio.D.objects[id].scale;
    if (s && s !== 1 && !o.userData.schemaScaled) { o.scale.set(s, s * 1.5, s); o.userData.schemaScaled = true; }   // высота — с вертикальным масштабом ×1,5
  }
  // маячки состояния слоя переработки (шар радиусом 3 м) — в схеме рядом с уменьшенными зданиями слишком крупные
  const proc = scene.getObjectByName('layer-processing');
  if (proc) proc.traverse((m) => {
    const g = m.isMesh && m.geometry;
    if (g && g.type === 'SphereGeometry' && g.parameters.radius === 3 && !g.userData.schemaScaled) { g.scale(0.4, 0.4, 0.4); g.userData.schemaScaled = true; }
  });
  // плитки блоков («Содержание меди») — общая геометрия плитки в метрах: уменьшаем один раз
  const tiles = scene.getObjectByName('geology-cu-tiles');
  if (tiles) tiles.traverse((m) => {
    if (m.isInstancedMesh && !m.geometry.userData.schemaScaled) { m.geometry.scale(1 / 3, 1, 1 / 3); m.geometry.userData.schemaScaled = true; }
  });
}
const isAttached = (o) => { while (o.parent) o = o.parent; return o === scene; };
function teardownWorld() {
  for (const L of layers) scene.remove(L.ctx.group);
  layers.length = 0;
  if (environment && environment.group) scene.remove(environment.group);
  environment = null; terrainGround = null;
  terrain.clear();
  for (const k of Object.keys(roadMeshes)) delete roadMeshes[k];
  if (routeMesh) { routeMesh.geometry.dispose(); routeMesh = null; }
  routeKey = '';
  glowSprites.length = 0;
  for (let i = clickable.length - 1; i >= 0; i--) if (!isAttached(clickable[i])) clickable.splice(i, 1);
  for (let i = labels.length - 1; i >= 0; i--) if (!isAttached(labels[i].obj)) { labels[i].el.remove(); labels.splice(i, 1); }
  for (const k of Object.keys(badges)) delete badges[k];
  for (const k of Object.keys(adviceBadges)) delete adviceBadges[k];
  for (const k of Object.keys(downBadges)) delete downBadges[k];
  // кнопки, которые слои добавили в верхнюю панель (их обработчики — у старой копии модуля): слой создаст заново
  for (const id of ['btn-geo-cu']) { const el = document.getElementById(id); if (el) el.remove(); }
  for (const d of dust) d.sp.visible = false;
  machineList = []; if (markerMesh) markerMesh.count = 0; stopOrbit();
  lastAdviceRaw = null;
  followId = null; tween = null;
}
let worldGen = 0, switching = false;
async function switchMode(next) {
  if (switching || next === mode || (next === 'schema' && !dio)) return;
  switching = true;
  try {
    teardownWorld();
    mode = next;
    buildWorld();
    await loadLayers('?w=' + (++worldGen));   // свежие копии модулей слоёв: их состояние — заново, в новом режиме
    applySchemaScales();
    applyQuality(quality);
    applyLighting(lighting);
    renderPanel();
    updateFollowButton();
  } finally { switching = false; }
}
// В схеме вся техника ближе 2,5 км «по метрам» слоёв — дальнюю (дальше 150 единиц от камеры) переводим
// в упрощённую детализацию после update слоёв: силуэт тот же, кадров больше
function schemaDetail() {
  if (mode !== 'schema') return;
  camera.getWorldPosition(_c);
  for (const o of clickable) {
    if (typeof o.setDetail !== 'function' || !/:(truck|excavator|drill)-/.test(o.userData.thingId || '')) continue;
    // слой ставит детализацию по своему порогу (2,5 км) каждый кадр — в схеме решает сцена: перехватываем setDetail,
    // иначе модель переключалась бы туда-обратно каждый кадр
    if (!o.userData.schemaDetailOrig) {
      const orig = o.setDetail;
      o.userData.schemaDetailOrig = orig;
      o.setDetail = (level) => orig.call(o, o.userData.schemaDetail || level);
    }
    o.getWorldPosition(_v);
    o.userData.schemaDetail = camera === orthoCam || _v.distanceTo(_c) > 250 ? 'far' : 'full';
    o.setDetail(o.userData.schemaDetail);
  }
}
// Авария (state = down) у самосвала или экскаватора — значок над техникой (маячок модели — красный, корпус — красный)
const downBadges = {};
function updateDownBadges() {
  for (const o of clickable) {
    const id = o.userData.thingId || '';
    if (!/:(truck|excavator)-/.test(id) || !o.isObject3D || o.isMesh) continue;
    const down = val(id, 'state', '') === 'down';
    let b = downBadges[id];
    if (b && b.obj !== o) { b.el.remove(); const i = labels.indexOf(b); if (i >= 0) labels.splice(i, 1); b = downBadges[id] = null; }
    if (down && !b) b = downBadges[id] = addLabel(o, '⛔ авария', { importance: 3.5, cls: 'warn', dy: 9 });
    if (b) b.enabled = down;
  }
}
// Пыль за едущими самосвалами (только «Высокое»): пул мягких спрайтов, гаснут за ~1,5 с
const dust = [];
let dustMat = null, dustT = 0;
const dustPrev = new WeakMap();
function updateDust(dt) {
  const on = quality === 'high';
  for (const d of dust) {
    if (!d.sp.visible) continue;
    d.age += dt;
    const k = d.age / 1.6;
    if (k >= 1 || !on) { d.sp.visible = false; continue; }
    d.sp.material.opacity = 0.32 * (1 - k);
    d.sp.scale.setScalar(d.size * (1 + 1.8 * k));
    d.sp.position.y += dt * 1.2 * mp().unit * 10;
  }
  if (!on) return;
  dustT += dt;
  if (dustT < 0.2) return;
  dustT = 0;
  for (const o of clickable) {
    if ((o.userData.thingId || '').indexOf(':truck-') < 0 || !o.parent || o.isMesh) continue;
    const prev = dustPrev.get(o), p = o.position;
    dustPrev.set(o, p.clone());
    if (!prev || prev.distanceTo(p) < 0.6 * mp().unit * 10) continue;   // стоит или ползёт — пыли нет
    let d = dust.find((x) => !x.sp.visible);
    if (!d) {
      if (dust.length >= 140) continue;
      dustMat = dustMat || new THREE.SpriteMaterial({ map: glowTexture(THREE), color: 0xd8c9a4, transparent: true, depthWrite: false });
      d = { sp: new THREE.Sprite(dustMat.clone()), age: 0, size: 1 };
      d.sp.raycast = () => {};
      dust.push(d);
    }
    if (d.sp.parent !== scene) scene.add(d.sp);
    const back = new THREE.Vector3(-Math.sin(o.rotation.y), 0, -Math.cos(o.rotation.y)).multiplyScalar(7 * o.scale.x);
    d.sp.position.copy(p).add(back); d.sp.position.y += 1.5 * o.scale.x;
    d.size = 6 * o.scale.x; d.age = 0; d.sp.visible = true;
  }
}
// Очереди: в схеме подъезды сжаты, а самосвалы — в натуральную величину, поэтому стоящие в очереди к одному
// пункту (queued_load / queued_dump) слились бы в кучу. Выстраиваем их вдоль дороги, по которой к пункту
// приезжают (к забою — путь от дробилки, к дробилке — путь из карьера), с шагом в длину самосвала
// (только в схеме, только картинка)
const QUEUE_STEP = 17;   // единиц: самосвал 180 т (15 м × 2,5 / 3 ≈ 12,5) + зазор (с запасом на повороты подъезда)
const queueLanes = {};
function queueLane(node) {
  if (queueLanes[node] !== undefined) return queueLanes[node];
  const from = node === 'crusher' ? 'floor-c' : 'crusher';
  const path = geometry.nodes[from] ? shortestPath(node, from) : null;
  return (queueLanes[node] = path && path.length > 1 ? path.map((n) => dio.D.nodes[n]) : null);
}
function lanePoint(lane, dist) {   // точка на ломаной на расстоянии dist от начала + направление к началу
  for (let i = 0; i < lane.length - 1; i++) {
    const a = lane[i], b = lane[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (dist <= L || i === lane.length - 2) {
      const t = L > 0 ? Math.min(1, dist / L) : 0;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, dx: a[0] - b[0], dy: a[1] - b[1] };
    }
    dist -= L;
  }
  return null;
}
function lineUpQueues() {
  if (mode !== 'schema' || !dio) return;
  const groups = {};
  for (const o of clickable) {
    const id = o.userData.thingId || '';
    if (id.indexOf(':truck-') < 0 || o.isMesh || !o.parent) continue;
    const st = val(id, 'state', '');
    // очереди к экскаватору, дробилке, складу глины; на заправке и в резерве — стоянка вдоль подъезда к заправке
    const parked = st === 'reserve' || st === 'refueling';
    if (st !== 'queued_load' && st !== 'queued_dump' && !parked) continue;
    const node = parked && dio.D.nodes['fuel-station'] ? 'fuel-station'
      : destNode(val(id, 'destination', '')) || nearestNode(Number(val(id, 'x', 0)), Number(val(id, 'y', 0)));
    if (!node || !dio.D.nodes[node]) continue;
    (groups[node] || (groups[node] = [])).push(o);
  }
  for (const [node, list] of Object.entries(groups)) {
    const lane = queueLane(node);
    if (!lane) continue;
    list.sort((a, b) => (a.userData.thingId < b.userData.thingId ? -1 : 1));
    list.forEach((o, k) => {
      const q = lanePoint(lane, (node === 'fuel-station' ? k + 0.5 : k + 1) * QUEUE_STEP);
      if (!q) return;
      const p = dio.s(q.x, q.y, q.z + mp().road.lift);
      const yaw = Math.atan2(q.dx, -q.dy);      // носом к пункту (в сцене z = −север)
      p.x += -Math.cos(yaw) * LANE; p.z += Math.sin(yaw) * LANE;   // очередь — на своей (правой) полосе, встречные проходят
      o.position.copy(p);
      o.rotation.y = yaw;
    });
  }
}
// Дно карьера в схеме сжато сильнее всего: буровой в 20–30 м от экскаватора оказался бы внутри него —
// после update слоёв отводим буровые не ближе 24 единиц от экскаваторов (только в схеме, только картинка)
function separateDrills() {
  if (mode !== 'schema') return;
  const ex = clickable.filter((o) => /:excavator-/.test(o.userData.thingId || '') && !o.isMesh);
  for (const o of clickable) {
    if (!/:drill-/.test(o.userData.thingId || '') || o.isMesh) continue;
    for (const e of ex) {
      const dx = o.position.x - e.position.x, dz = o.position.z - e.position.z, d = Math.hypot(dx, dz);
      const R = 16;   // единиц: полкорпуса экскаватора (≈ 7) + полкорпуса бурового (≈ 5) + зазор
      if (d >= R) continue;
      const k = d > 0.01 ? R / d : 1;
      o.position.x = e.position.x + (d > 0.01 ? dx * k : R); o.position.z = e.position.z + (d > 0.01 ? dz * k : 0);
      if (dio) o.position.y = dio.surfaceAt(o.position.x, -o.position.z);   // на поверхность схемы в новом месте
    }
  }
  // самосвал под погрузкой у увеличенного экскаватора (×1,4) — не ближе 15 единиц от его центра (без наложения на гусеницы)
  for (const o of clickable) {
    if (!/:truck-/.test(o.userData.thingId || '') || o.isMesh) continue;
    for (const e of ex) {
      const dx = o.position.x - e.position.x, dz = o.position.z - e.position.z, d = Math.hypot(dx, dz);
      const R = 15;   // единиц: полкорпуса экскаватора + полкорпуса самосвала + зазор
      if (d >= R) continue;
      // самосвал в самой точке экскаватора (забой на заезде): отводим назад по его ходу — он стоит носом к экскаватору
      const ux = d > 0.01 ? dx / d : -Math.sin(o.rotation.y), uz = d > 0.01 ? dz / d : -Math.cos(o.rotation.y);
      o.position.x = e.position.x + ux * R; o.position.z = e.position.z + uz * R;
      if (dio) o.position.y = Math.max(o.position.y, dio.surfaceAt(o.position.x, -o.position.z));
    }
  }
}
// Зоны забоев слоя геологии нарисованы в метрах (плоскость или группа плиток ≈ 120 × 60 м), слой каждый кадр ставит им
// масштаб ctx.markerScale — в схеме после обновления слоя ставим 1 : 3, как у карьера
function shrinkFaceZones() {
  if (mode !== 'schema') return;
  for (const o of clickable) {
    if (!/:face-/.test(o.userData.thingId || '')) continue;
    // плоскость (повёрнута в горизонталь: локальные x, y) или группа плиток (x, z сцены): в схеме — 1 : 3
    if (o.isMesh) o.scale.set(1 / 3, 1 / 3, 1);
    else o.scale.set(1 / 3, 1, 1 / 3);
  }
}
// ---------------------------------------------------------------- техника: исходные места слоёв и поправки сцены
// Слои ставят технику по двойникам. Сцена в схеме поверх этого (только картинка, данные двойников не меняются):
// разворачивает самосвалы по ходу, разводит встречные по полосам, выстраивает очереди вдоль подъездов, отводит
// машины друг от друга. Перед update слоёв поправки снимаются (restoreRaw), чтобы слой не принял их за свои места.
let machineList = [];
const MACHINE_RE = /:(truck|excavator|drill)-/;
function restoreRaw() {
  for (const o of machineList) if (o.userData.rawPos && o.parent) o.position.copy(o.userData.rawPos);
}
function adjustMachines(dt) {
  machineList = clickable.filter((o) => !o.isMesh && o.parent && MACHINE_RE.test(o.userData.thingId || ''));
  for (const o of machineList) (o.userData.rawPos || (o.userData.rawPos = new THREE.Vector3())).copy(o.position);
  if (mode === 'schema' && dio) {
    orientTrucks(dt);
    shrinkFaceZones();
    for (const o of machineList) if (/:drill-/.test(o.userData.thingId)) o.scale.setScalar(markerScale);   // как остальная техника
    schemaDetail();
    laneOffsets();
    lineUpQueues();
    separateDrills();
    separateTrucks();
    separateDrills();   // ещё раз: отведённый назад самосвал не должен въехать в экскаватор
  }
  updateMarkers();
}
// Две полосы: едущий самосвал смещается вправо по ходу (гружёные и порожние идут навстречу — по разным сторонам)
const LANE = 3.5;   // единиц: четверть ширины дороги 14
const MOVING = new Set(['hauling', 'returning', 'to_fuel', 'refueling_trip', 'traveling']);
function laneOffsets() {
  for (const o of machineList) {
    const id = o.userData.thingId;
    if (id.indexOf(':truck-') < 0) continue;
    const st = val(id, 'state', ''), m = truckMotion.get(o);
    if (!m || m.cur === null || !(MOVING.has(st) || Number(val(id, 'speed', 0)) > 1)) continue;
    o.position.x += -Math.cos(m.cur) * LANE; o.position.z += Math.sin(m.cur) * LANE;   // вправо от направления движения
  }
}
// Если два самосвала всё равно налезают (по габаритам с учётом курса) — задний отходит назад вдоль своего хода;
// два стоящих на разгрузке в одной точке — второй сдвигается в сторону
const TRUCK_L = 15 * 2.5 / 3 + 1.5, TRUCK_W = 8 * 2.5 / 3 + 0.8;   // единиц: самосвал 180 т + зазор
function truckBox(o) { return { cx: o.position.x, cz: o.position.z, ux: Math.sin(o.rotation.y), uz: Math.cos(o.rotation.y) }; }
function boxesOverlap(A, B) {   // разделяющая ось для двух прямоугольников TRUCK_L × TRUCK_W
  const hl = TRUCK_L / 2, hw = TRUCK_W / 2, dx = B.cx - A.cx, dz = B.cz - A.cz;
  for (const [ax, az] of [[A.ux, A.uz], [-A.uz, A.ux], [B.ux, B.uz], [-B.uz, B.ux]]) {
    const ra = hl * Math.abs(A.ux * ax + A.uz * az) + hw * Math.abs(-A.uz * ax + A.ux * az);
    const rb = hl * Math.abs(B.ux * ax + B.uz * az) + hw * Math.abs(-B.uz * ax + B.ux * az);
    if (Math.abs(dx * ax + dz * az) >= ra + rb) return false;
  }
  return true;
}
function separateTrucks() {
  const trucks = machineList.filter((o) => o.userData.thingId.indexOf(':truck-') >= 0);
  // под погрузкой и разгрузкой самосвал стоит у экскаватора / пункта — его не двигаем, отходит другой
  const fixed = (o) => { const st = val(o.userData.thingId, 'state', ''); return st === 'loading' || st === 'dumping'; };
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < trucks.length; i++) for (let j = i + 1; j < trucks.length; j++) {
      const a = trucks[i], b = trucks[j];
      if (!boxesOverlap(truckBox(a), truckBox(b))) continue;
      let back, ux, uz;
      if (fixed(a) && fixed(b)) {          // оба стоят в одной точке разгрузки: второй — вбок на ширину машины
        back = b; ux = Math.cos(b.rotation.y); uz = -Math.sin(b.rotation.y);
      } else {
        const fx = Math.sin(a.rotation.y), fz = Math.cos(a.rotation.y);
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
        back = (dx * fx + dz * fz) >= 0 ? b : a;          // кто сзади по ходу a
        if (fixed(back)) back = back === a ? b : a;
        ux = Math.sin(back.rotation.y); uz = Math.cos(back.rotation.y);
      }
      const step = fixed(a) && fixed(b) ? TRUCK_W : TRUCK_L * 0.5;
      back.position.x -= ux * step; back.position.z -= uz * step;
      if (dio) back.position.y = Math.max(back.position.y, dio.surfaceAt(back.position.x, -back.position.z));
      moved = true;
    }
    if (!moved) break;
  }
}
// Значки-стрелки над техникой на дальнем плане (дальше markerFar от камеры) и в виде сверху: цвет — груз/состояние
let markerMesh = null;
const _mm = new THREE.Matrix4(), _mq = new THREE.Quaternion(), _ms = new THREE.Vector3(), _mc = new THREE.Color();
function markerColor(id) {
  const st = val(id, 'state', '');
  if (st === 'down' || st === 'failed') return 0xd32f2f;
  if (id.indexOf(':excavator-') >= 0) return 0xef7d1e;
  if (id.indexOf(':drill-') >= 0) return 0x4f8fd0;
  if (st === 'reserve') return 0xb8bec4;
  return Number(val(id, 'payload', 0)) > 0 ? (colors[val(id, 'cargo_type', '')] || 0x3d8f6e) : 0xffffff;
}
function updateMarkers() {
  if (!markerMesh) {
    const g = new THREE.ConeGeometry(1, 2.2, 4); g.rotateX(Math.PI); g.translate(0, 1.1, 0);   // остриём вниз
    markerMesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ fog: false }), 64);
    markerMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3);
    markerMesh.frustumCulled = false; markerMesh.raycast = () => {}; markerMesh.name = 'machine-markers';
    scene.add(markerMesh);
  }
  if (markerMesh.parent !== scene) scene.add(markerMesh);
  camera.getWorldPosition(_c);
  const far = mp().markerFar, ortho = camera === orthoCam;
  let n = 0;
  for (const o of machineList) {
    o.getWorldPosition(_v);
    const dist = ortho ? mp().orthoHalf / orthoCam.zoom * 2 : _v.distanceTo(_c);
    // совсем далеко (машина — пара пикселей) модель не рисуется, только значок; клик и подписи работают (farHidden)
    const hide = !ortho && dist > far * 1.6;
    o.userData.farHidden = hide; o.visible = !hide;   // каждый кадр: модели и слои сами включают видимость
    if (n >= 64) continue;
    if (!ortho && dist < far) continue;
    const size = dist * 0.0055;                                  // ≈ одинаковый размер на экране
    _ms.setScalar(size);
    _v.y += 12 * o.scale.y + size * 0.4;
    _mm.compose(_v, _mq, _ms);
    markerMesh.setMatrixAt(n, _mm);
    markerMesh.setColorAt(n, _mc.setHex(markerColor(o.userData.thingId)));
    n++;
  }
  markerMesh.count = n;
  markerMesh.instanceMatrix.needsUpdate = true;
  if (markerMesh.instanceColor) markerMesh.instanceColor.needsUpdate = true;
}
// для проверок: где объект на экране (пиксели холста) — скрипты наводят мышь без перебора точек
window.__screenOf = (thingId) => {
  const o = byThing(thingId); if (!o) return null;
  o.getWorldPosition(_v); _v.y += 3; _v.project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (_v.x + 1) / 2 * r.width, y: r.top + (1 - _v.y) / 2 * r.height, visible: _v.z < 1 };
};
// для проверок: места и курсы техники в сцене (после поправок)
window.__machineLayout = () => machineList.map((o) => ({ id: o.userData.thingId, x: o.position.x, z: o.position.z,
  yaw: o.rotation.y, s: o.scale.x, state: val(o.userData.thingId, 'state', '') }));

// Облёт: двойной клик по объекту — камера летит к нему и вращается вокруг; Esc, виды или перетаскивание — выход
let orbitId = null;
function stopOrbit() { orbitId = null; controls.autoRotate = false; }
canvas.addEventListener('dblclick', (e) => {
  const id = pick(e.clientX, e.clientY);
  const obj = id && byThing(id);
  if (!obj || camera !== perspCam) return;
  followId = null; updateFollowButton();
  obj.getWorldPosition(_v);
  let d;
  if (MACHINE_RE.test(id)) {   // техника — крупный план: 20–30 м местности
    const len = ((obj.userData.size && (obj.userData.size.length || obj.userData.size[0])) || 13) * (obj.scale.x || 1);
    d = Math.max(mp().cam.min * 2.5, len * 1.8);
  } else {                     // здания и площадки — по габаритам, снаружи (≈ 135 м и дальше)
    const box = new THREE.Box3().setFromObject(obj), sz = box.getSize(new THREE.Vector3());
    d = Math.max(45 * mp().unit * 3, Math.max(sz.x, sz.z) * 1.4);
    if (!box.isEmpty()) box.getCenter(_v);
  }
  flyTo(_v.clone().add(new THREE.Vector3(-d * 0.75, d * 0.45, d * 0.8)), _v.clone());
  orbitId = id; controls.autoRotate = true; controls.autoRotateSpeed = 1.2;
  markViewButton('');
  openCard(id);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopOrbit(); });
canvas.addEventListener('pointerdown', () => { if (orbitId) controls.autoRotate = false; });

// В схеме дороги повёрнуты не так, как в жизни: самосвал разворачивается носом по направлению своего движения в сцене
const truckMotion = new WeakMap();
function orientTrucks(dt) {
  if (mode !== 'schema') return;
  for (const o of clickable) {
    if ((o.userData.thingId || '').indexOf(':truck-') < 0 || !o.parent) continue;
    const p = o.position;
    let m = truckMotion.get(o);
    if (!m) { truckMotion.set(o, { x: p.x, z: p.z, yaw: null, cur: null }); continue; }
    const dx = p.x - m.x, dz = p.z - m.z;
    if (dx * dx + dz * dz > 0.0025) { m.yaw = Math.atan2(dx, dz); m.x = p.x; m.z = p.z; }
    if (m.yaw === null) continue;
    if (m.cur === null) m.cur = m.yaw;
    let d = m.yaw - m.cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    m.cur += d * Math.min(1, dt * 8);
    o.rotation.y = m.cur;
  }
}

// ---------------------------------------------------------------- кнопка «Карта местности» / «Схема» и подписи источников
function updateAttribution() {
  const a = document.getElementById('attribution');
  if (mode !== 'map' || !terrainApi || !terrainApi.attribution) { a.hidden = true; return; }
  const on = terrainGround && terrainGround.imageryEnabled && terrainGround.imageryEnabled();
  a.textContent = terrainApi.attribution.dem + (on ? ' ' + terrainApi.attribution.image : '');
  a.hidden = !a.textContent;
}
function updateModeUi() {
  const btn = document.getElementById('btn-map');
  if (btn) {
    btn.classList.toggle('active', mode === 'map');
    btn.textContent = mode === 'map' ? 'Схема' : 'Карта местности';
    btn.title = mode === 'map' ? 'Вернуться к схеме-макету рудника' : 'Реальный масштаб: рельеф Copernicus DEM и снимок Sentinel-2';
  }
  const note = document.getElementById('scale-note');
  if (note) note.textContent = mode === 'schema'
    ? 'Схема рудника 1 : 3 (техника крупнее в 2,5 раза). Реальное расположение — кнопка «Карта местности»'
    : 'вертикальный масштаб ×1,5';
  updateAttribution();
}
function initModeButton() {
  const btn = document.getElementById('btn-map');
  if (btn) btn.addEventListener('click', () => { switchMode(mode === 'schema' ? 'map' : 'schema'); btn.blur(); });
  updateModeUi();
}

// ---------------------------------------------------------------- путеводитель «Как посмотреть двойник»
// При первом открытии показывается окно; закрывается; кнопка «Как посмотреть» в углу открывает снова.
function initGuide() {
  const box = document.getElementById('guide'), open = document.getElementById('guide-open');
  if (!box) return;
  const show = (on) => { box.hidden = !on; };
  document.getElementById('guide-close').addEventListener('click', () => show(false));
  document.getElementById('guide-ok').addEventListener('click', () => show(false));
  if (open) open.addEventListener('click', () => show(box.hidden));
  for (const a of box.querySelectorAll('[data-view-go]')) a.addEventListener('click', () => { setView(a.dataset.viewGo); show(false); });
  let seen = false;
  try { seen = localStorage.getItem('bz-guide-seen') === '1'; localStorage.setItem('bz-guide-seen', '1'); } catch (e) { /* хранилище недоступно */ }
  if (!seen) show(true);
}

// ---------------------------------------------------------------- запуск
(async function main() {
  const status = document.getElementById('load-status');
  try {
    const r = await fetch('/geometry.json'); if (!r.ok) throw new Error('HTTP ' + r.status);
    geometry = await r.json();
    terrainApi = await loadTerrain(THREE, geometry);
    modelsLib = createModels(THREE, colors);   // библиотека моделей для слоёв (ctx.models) и окружения
    try { dio = await loadDiorama(THREE, geometry, terrainApi); }
    catch (e) { console.warn('схема рудника недоступна — показываем «Карту местности»', e); dio = null; mode = 'map'; }
    buildWorld();
    initModeButton();
    initKeys();
    initQuality();
    initLighting();
    initReality();
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
  applySchemaScales();
  renderPanel();          // значки сценариев — после регистрации объектов слоями
  updateFollowButton();
  markViewButton('all');
  status.textContent = '';
  initGuide();
  requestAnimationFrame(frame);
})();
