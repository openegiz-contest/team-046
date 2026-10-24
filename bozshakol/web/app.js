// Общая 3D-сцена карьера Бозшаколь: степь, карьер, дороги, панель диспетчера, журнал событий,
// карточка двойника, связь с Ditto и загрузка слоёв модулей (layers/*.js).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { loadTerrain } from './terrain.js';
import { initKeyboard } from './controls.js';
import { glowTexture } from './environment.js';
import { createModels } from './models.js';
import { loadDiorama } from './diorama.js';
import { buildDiorama, roadRibbons } from './diorama-scene.js';

// Отладочный доступ к объектам сцены (window.__*) — только с ?debug=1 в адресе (скрипты проверок)
const dbgWin = new URLSearchParams(location.search).has('debug') ? window : {};

// ---------------------------------------------------------------- палитра
const colors = {
  sulphide: 0x3d8f6e, clay: 0xc8722a, waste: 0x8a8a8a, empty: 0xffffff,
  down: 0xd1236a,                         // авария / остановка / закрыто — красно-пурпурный (виден и при дальтонизме)
  steppe: 0xe6d9a8,
  bench: [0xdcc08e, 0xcfae78],            // бермы (площадки) — два чередующихся светлых тона
  wall: [0x8f6a44, 0x7f5c3a],             // стенки уступов — заметно темнее берм
  benchLine: 0x4a3418, floor: 0xa8a27e,   // контуры кромок; дно карьера — серо-оливковое
  road: 0xcfc3a4, ramp: 0xe8dfc3, roadEdge: 0x4a3f2e, roadClosed: 0xd1236a,
  building: 0xd8d8d8, roof: 0xa9b8cc, conveyor: 0x6f7f95, excavator: 0xf2a21b, drill: 0x4f6d8f,
  dump: 0x9a9a9a, stockpileOre: 0x6b7a5a, stockpileClay: 0xb86f3a, label: 0x2b2620,
};

const NS = 'kz.bozshakol';
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

// Сцена одна — схема рудника (diorama.js): расстояния сжаты в 2 раза (единица карты = 2 м местности), здания
// и склады — крупнее для наглядности (enlargeBuildings, ×1,6–2). Реальная местность — фото по кнопке «Фото местности» (окно, сцена от него не зависит).
// terrainApi (рельеф Copernicus DEM) нужен только для «высоты над землёй» в переносе координат, в сцене его нет.
const mode = 'schema';
let dio = null;              // перенос координат в схему (diorama.js)
const toScene = (x, y, z) => dio.toScene(x, y, z);
const groundAt = (x, y) => dio.groundAt(x, y);
const PARAMS = {
  // постоянно — только подписи крупных объектов (3); техника и забои — при наведении или выборе
  unit: 1 / 2, labelDist: { 2: 0, 1: 0 }, hit: 0.6, follow: [-30, 15, 34], fly: [40, 2.6], markerFar: 800,
  route: { r: 0.6, lift: 0.8 },
  cam: { near: 0.5, far: 60000, min: 6, max: 13000 }, orthoHalf: 1500, orthoAt: [-900, 4000, 150],
  sun: { pos: [-3900, 4000, 2850], tgt: [-700, 0, 0], box: [3600, 2000], near: 10, far: 13000 },
};
const mp = () => PARAMS;
// Масштаб подвижной техники (модели в метрах): ×1,25 к реальному размеру — не больше чем в 2 раза; экскаватор
// крупнее самосвала (реальные пропорции между машинами). Вдали (дальше markerFar) над машиной — значок-стрелка.
const MACHINE_SCALE = 1.25;
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
// AgX: мягкий пересвет без сдвига оттенков (ACES уводил красный в оранжевый) — цвета состояний остаются узнаваемыми
renderer.toneMapping = THREE.AgXToneMapping;
const EXPOSURE = { day: 0.92, night: 1.2 };
renderer.toneMappingExposure = EXPOSURE.day;
renderer.shadowMap.enabled = false;                   // тени — только в качестве «Высокое»
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const SKY = 0xdde8f0;
scene.background = new THREE.Color(SKY);   // до загрузки окружения (environment.js ставит небо и туман)
let environment = null;
const ADVICE_AT = { plan: 'plant-sulphide' };   // совет → объект, у которого его подпись (иначе — его цель)
let weatherBlizzard = false;   // метель: туман пересчитывается по расстоянию камеры (updateCamera)      // небо, туман, качество и вид земли (buildSchemaEnvironment)

const perspCam = new THREE.PerspectiveCamera(50, 1, 2, 30000);
perspCam.position.set(-950, 1700, 2700);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
orthoCam.position.set(-1100, 3000, 200);
orthoCam.up.set(0, 0, -1);           // север — вверх экрана
orthoCam.lookAt(-1100, 0, 200);
let camera = perspCam;

const controls = new OrbitControls(perspCam, canvas);
controls.target.set(-800, 0, 150);
// наклон взгляда — от −85° (почти отвесно вниз) до +80° (в небо): камера может быть ниже точки, вокруг которой вращается
controls.minPolarAngle = Math.PI * 5 / 180; controls.maxPolarAngle = Math.PI * 170 / 180;
controls.enableDamping = true; controls.dampingFactor = 0.12;   // плавное вращение
controls.enableZoom = false;   // колесо и тачпад — свой плавный зум (wheelZoom): шаг ≈ 11 % расстояния, мягкое торможение
controls.minDistance = 60;
controls.maxDistance = 14000;
controls.update();
const topControls = new OrbitControls(orthoCam, canvas);
topControls.target.set(-1100, 0, 200);
topControls.enableRotate = false;
topControls.enableZoom = false;   // колесо — свой плавный зум (wheelZoom), как в перспективе
// в виде сверху левая кнопка — панорамирование (вращение запрещено)
topControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
topControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
topControls.screenSpacePanning = true;
topControls.minZoom = 0.3; topControls.maxZoom = 12;
topControls.enabled = false;
topControls.update();

// Свет: небо-полусфера (голубое сверху, тёплый отражённый снизу) и тёплое низкое солнце с юго-запада
const hemi = new THREE.HemisphereLight(0xe3eef8, 0x8f7a58, 1.05);   // снизу — темнее: у форм есть теневая сторона
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe4bd, 3.6);
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
// панель диспетчера свёрнута или развёрнута (запомнено в localStorage; без него — развёрнута) — до первого resize
try { document.body.classList.toggle('panel-collapsed', localStorage.getItem('bz-panel') === 'collapsed'); } catch (e) { /* хранилище недоступно */ }
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- подписи (HTML-оверлей)
// ctx.label(obj, text, importance | {dy, small, importance, cls})
//   importance 3 — крупные объекты, видны всегда; 2 — забои, экскаваторы, буровые: при приближении или выборе;
//   1 — самосвалы: при наведении, выборе или сильном приближении. Третий аргумент-объект — старое поведение (importance 2).
// Текст меняется через obj.userData.label. Подписи, перекрывающие более важную, скрываются; лимит ~30.
const labelRoot = document.getElementById('labels');
const panelEl = document.getElementById('panel'), topbarEl = document.getElementById('topbar'), bannerEl = document.getElementById('scenario-banner');
const notesEl = document.getElementById('scene-notes'), helpHintEl = document.getElementById('help-hint'), guideOpenEl = document.getElementById('guide-open');
// Важность по умолчанию (если слой её не передал) — по виду двойника: крупные объекты 3, самосвалы 1, остальное 2
function defaultImportance(obj) {
  const id = thingOf(obj) || '';
  if (/:(crusher|conveyor|plant|stockpile|dump|sag-mill|flotation|power)/.test(id)) return 3;
  if (id.includes(':truck-')) return 1;
  return 2;
}
const MAX_LABELS = 30;
const adviceTitles = {};   // id совета → его заголовок по-русски (для журнала «Совет снят»)
const IN_CYCLE = new Set(['queued_load', 'loading', 'hauling', 'queued_dump', 'dumping', 'returning']);   // самосвал в работе
// Окна поверх сцены (сверка, фото местности, путеводитель): Esc закрывает верхнее открытое, по одному за нажатие
const openWindows = [];
function windowShown(close, on) {
  const i = openWindows.indexOf(close); if (i >= 0) openWindows.splice(i, 1);
  if (on) openWindows.push(close);
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openWindows.length) return;
  openWindows[openWindows.length - 1]();
  e.stopImmediatePropagation(); e.preventDefault();
}, true);
// закрыта ли точка поверхностью (земля, карьер) или зданием (дробилка, корпуса) с места камеры: луч от камеры к точке
const _occRay = new THREE.Raycaster(), _occDir = new THREE.Vector3();
function occludedByGround(from, to) {
  const surf = [];
  terrain.traverse((m) => { if (m.isMesh && m.visible && /^diorama-(ground|pit|ramp)$/.test(m.name)) surf.push(m); });
  const proc = scene.getObjectByName('layer-processing');
  if (proc) proc.traverse((m) => { if (m.isMesh && m.visible && !(m.material && m.material.transparent)) surf.push(m); });
  _occDir.subVectors(to, from); const len = _occDir.length(); _occDir.normalize();
  _occRay.set(from, _occDir); _occRay.far = len - 3;
  return _occRay.intersectObjects(surf, false).length > 0;
}
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
  const rec = { obj, el, dy: opts.dy || 0, small: !!opts.small, importance, last: text, text, enabled: true, warn: !!opts.cls,
    occlude: !!opts.occlude, hidden: false };
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
    _v.y += L.dy;
    const dist = ortho ? orthoDist : _c.distanceTo(_v);
    const id = thingOf(L.obj);
    const focused = id && (id === openedThing || id === hoverThing);
    let imp = L.importance;
    if (focused) imp = 4;
    if (imp < 3 && dist > (LABEL_DIST[Math.max(1, Math.min(2, Math.round(imp)))] ?? 2600)) continue;
    if (L.occlude && !ortho) {   // подпись за бортом карьера (дно не видно из-за борта) — не показываем
      if (frameNo % 10 === 0 || L.hidden === undefined) L.hidden = occludedByGround(_c, _v);
      if (L.hidden) continue;
    }
    _v.project(camera);
    if (_v.z > 1 || _v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.05) continue;
    L.sx = (_v.x + 1) / 2 * w; L.sy = (1 - _v.y) / 2 * h; L.imp = imp; L.dist = dist;
    cand.push(L);
  }
  cand.sort((a, b) => (b.imp - a.imp) || (a.dist - b.dist));
  placed.length = 0;
  // панель слева, кнопки сверху, сноска и кнопки внизу — занятые области: подписи под ними прячем
  const cr = canvas.getBoundingClientRect();   // координаты подписей — относительно холста
  const ui = [];
  for (const el of [panelEl, topbarEl, bannerEl, notesEl, helpHintEl, guideOpenEl]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width) ui.push({ x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
  }
  const underUi = (r) => r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h ||
    ui.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  let shown = 0;
  for (const L of cand) {
    const t = L.warn || L.obj.userData.label === undefined ? L.text : L.obj.userData.label;
    const txt = String(t);
    const cw = L.small ? 5.6 : 6.3, ch = L.small ? 15 : 18;
    const bw = txt.length * cw + 14;
    const r = { x: L.sx - bw / 2, y: L.sy - ch, w: bw, h: ch };
    if (shown >= MAX_LABELS || underUi(r) || (L.imp < 4 && overlaps(r))) continue;
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
      const ru = FEATURE_RU[f];
      const name = ru ? esc(ru) + '<div class="tech">' + esc(f) + '</div>' : esc(f);
      rows.push('<tr><td>' + name + '</td><td class="val">' + esc(fmt(p.value)) + '</td><td>' + esc(p.unit || '') + '</td></tr>');
    }
  }
  cardBody.innerHTML = rows.join('') || '<tr><td colspan="3">нет данных</td></tr>';
}
setInterval(() => { if (openedThing && !card.hidden) renderCard(); }, 1000);

// Русские названия признаков двойников в карточке (техническое имя — рядом мелко)
const FEATURE_RU = {
  state: 'состояние', payload: 'груз', load: 'груз', load_type: 'тип груза', cargo: 'груз', speed: 'скорость',
  fuel: 'топливо', fuel_pct: 'топливо', fuel_l: 'топливо', x: 'место: x', y: 'место: y', z: 'высота', heading: 'курс',
  destination: 'куда едет', source: 'откуда', assigned_excavator: 'закреплён за экскаватором', trips: 'рейсы',
  trips_total: 'рейсы всего', odometer_km: 'пробег', engine_hours: 'моточасы', accepting: 'принимает руду',
  throughput: 'производительность', bunker_t: 'бункер', bunker: 'бункер', stop_reason: 'причина остановки',
  trucks_queued: 'самосвалов в очереди', trucks_on_road: 'самосвалов на дороге', queue_crusher: 'очередь у дробилки', queue_clay: 'очередь у склада глины',
  feed_rate: 'подача', plan_rate: 'план', plan_fulfilment: 'выполнение плана', feed_cu: 'медь в питании',
  feed_clay: 'глина в питании', feed_hardness: 'крепость питания', feed_p80: 'крупность питания P80', recovery: 'извлечение',
  cu_concentrate_shift: 'медь в концентрате за смену', ore_shift_t: 'руда за смену', cu_year_pace: 'медь, темп года',
  specific_energy: 'удельная электроэнергия', power: 'мощность', load_level: 'нагрузка сети', stock: 'запас', stock_t: 'запас',
  capacity_t: 'вместимость', hours_left: 'хватит на', inflow: 'поступление', outflow: 'отгрузка', stop_forecast: 'фабрика встанет в',
  ore_type: 'тип руды', clay_pct: 'доля глины', cu_grade: 'содержание меди', au_grade: 'содержание золота', p80: 'крупность P80', hardness: 'крепость',
  loading_factor: 'скорость погрузки', remaining: 'остаток', recommended_destination: 'куда везти', blasted: 'взорван',
  blasted_ahead_h: 'взорванный запас', bench: 'уступ', open: 'открыта', closed_reason: 'причина закрытия', length_m: 'длина',
  mode: 'режим', avg_wait_excavator: 'ожидание у экскаватора', avg_wait_dump: 'ожидание на разгрузке',
  trucks_hauling: 'самосвалов в рейсе', trucks_needed: 'нужно самосвалов', trucks_reserve: 'в резерве',
  delivered_crusher_t: 'привезено на дробилку', delivered_clay_t: 'привезено на склад глины', delivered_dump_t: 'вывезено в отвал',
  sim_time: 'модельное время', shift: 'смена', shift_hour: 'час смены', temperature: 'температура', wind: 'ветер',
  visibility: 'видимость', speed_limit: 'ограничение скорости', active_scenarios: 'включённые сценарии', advice: 'советы',
  drilled_m: 'пробурено', penetration_rate: 'скорость бурения', utilization: 'загрузка', value: 'значение',
};
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(v, digits) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return v.toLocaleString('ru-RU', { maximumFractionDigits: digits === undefined ? 2 : digits });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10).split('-').reverse().join('.') + ' ' + v.slice(11, 16);
  }
  if (Array.isArray(v)) return v.length > 6 ? 'список из ' + v.length + ' значений' : JSON.stringify(v);
  if (typeof v === 'object') { const j = JSON.stringify(v); return j.length > 80 ? j.slice(0, 77) + '…' : j; }
  const t = String(v);   // длинная строка (например, JSON-массив строкой) — коротко, карточка не длиннее экрана
  if (t.length > 120) return /^\s*[\[{]/.test(t) ? 'данные (' + t.length + ' знаков)' : t.slice(0, 117) + '…';
  return t;
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
    '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, pct)).toFixed(0) + '%" class="' + (pct < 70 ? 'bad' : pct < 90 ? 'warn' : 'ok') + '"></i><span>за смену ' + fmt(pct, 0) + ' %</span></div>' +
    (extra.length ? '<div class="muted">' + esc(extra.join(' · ')) + '</div>' : '') + '</div>';
}
function renderDispatcher() {
  const mine = NS + ':mine', disp = NS + ':dispatch';
  const shiftEl = document.getElementById('shift-line');   // коротко, в одну строку; время — модельное (в подсказке)
  shiftEl.textContent = 'Смена ' + fmt(val(mine, 'shift', '—'), 0) +
    (val(mine, 'shift_hour', null) !== null ? ' · ' + (Math.floor(Number(val(mine, 'shift_hour')) || 0) + 1) + '-й час' : '') + ' · ' + simClock();
  shiftEl.title = 'Время — по часам модели рудника';
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
    if (IN_CYCLE.has(s)) hauling++;   // «в работе» — в цикле (очередь, погрузка, рейс, разгрузка), как у советника
  }
  const wait = val(disp, 'avg_wait_excavator', null);
  const wUnit = (twins[disp] && twins[disp].features.avg_wait_excavator && twins[disp].features.avg_wait_excavator.properties.unit) || 'мин';
  const rows = [
    ['Режим', MODE_NAMES[val(disp, 'mode', '')] || val(disp, 'mode', '—')],
    ['Ожидание у экскаватора', wait === null ? '—' : fmt(wait, 1) + ' ' + wUnit],
    ['Самосвалы в работе (в цикле) / из них в очереди / авария', hauling + ' / ' + queued + ' / ' + down + (total ? ' из ' + total : '')],
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

// Главные цифры смены (крупно наверху панели): руда на фабрики, медь в питании, ожидание у экскаватора, режим диспетчера
function setKpi(id, value, sub, cls) {
  const el = document.getElementById(id);
  el.querySelector('.k-val').textContent = value;
  el.querySelector('.k-sub').textContent = sub || '';
  el.classList.remove('ok', 'warn', 'bad');
  if (cls) el.classList.add(cls);
}
function renderMain() {
  const ps = NS + ':plant-sulphide', pc = NS + ':plant-clay', disp = NS + ':dispatch';
  const feed = (Number(val(ps, 'feed_rate', 0)) || 0) + (Number(val(pc, 'feed_rate', 0)) || 0);
  const plan = (Number(attr(ps, 'design_tph', 0)) || 0) + (Number(attr(pc, 'design_tph', 0)) || 0);
  const pct = plan ? feed / plan * 100 : 0;
  setKpi('kpi-ore', twins[ps] || twins[pc] ? fmt(feed, 0) + ' т/ч' : '—',
    plan ? 'план ' + fmt(plan, 0) + ' т/ч · ' + fmt(pct, 0) + ' %' : '', plan ? (pct < 70 ? 'bad' : pct < 90 ? 'warn' : 'ok') : '');
  const cu = val(ps, 'feed_cu', null);
  setKpi('kpi-cu', cu === null ? '—' : fmt(cu, 2) + ' %', 'сульфидная фабрика');
  let queued = 0, inCycle = 0, total = 0;
  for (const id of Object.keys(twins)) {
    if (!id.startsWith(NS + ':truck-')) continue;
    total++;
    const s = val(id, 'state', '');
    if (s === 'queued_load') queued++;
    if (IN_CYCLE.has(s)) inCycle++;
  }
  const wait = val(disp, 'avg_wait_excavator', null);
  const wf = twins[disp] && twins[disp].features.avg_wait_excavator;
  setKpi('kpi-wait', wait === null ? '—' : fmt(wait, 1) + ' ' + ((wf && wf.properties.unit) || 'мин'), 'в очереди: ' + queued);
  const off = !!val(NS + ':scenarios', 'dispatch_off', false);
  const mode = val(disp, 'mode', '');
  setKpi('kpi-mode', off ? 'выключен' : MODE_NAMES[mode] || mode || '—',
    off ? 'диспетчеризация выключена' : total ? 'в работе ' + inCycle + ' из ' + total + ' самосвалов' : '', off ? 'bad' : '');
  if (qOpen) fillQ(qOpen.dataset.q);   // открытое пояснение — с живыми цифрами
}

// «?» у блоков панели: пояснение простыми словами (и живые цифры, где они есть)
const Q_TEXT = {
  ore: ['Руда на фабрики', 'Сколько руды за час сейчас поступает на обе фабрики — сульфидную и глинистую. «План» — сколько они могут ' +
    'принять за час. Факт заметно ниже плана — фабрикам не хватает руды: посмотрите на самосвалы, экскаваторы и дробилку.'],
  cu: ['Медь в питании', 'Сколько меди в руде, которая сейчас идёт на сульфидную фабрику, — в процентах от веса руды. Чем выше, ' +
    'тем больше меди получится из той же руды. Руду с разных забоев смешивают, чтобы это число держалось ровным.'],
  wait: ['Ожидание у экскаватора', 'Сколько минут в среднем самосвал стоит у экскаватора, пока подойдёт его очередь грузиться. ' +
    'Меньше — лучше: машины не простаивают. Растёт, если на один забой отправили слишком много самосвалов или экскаватор сломался.'],
  mode: ['Режим диспетчера', '«Автоматический» — система сама выбирает каждому самосвалу забой и место разгрузки, чтобы меньше ждать. ' +
    '«Закреплённый» — каждый самосвал ездит по одному и тому же маршруту. «Ручной» — рейсы назначает диспетчер. ' +
    '«Выключен» — включён сценарий «Диспетчеризация выключена».'],
  advice: ['Совет диспетчеру', 'Подсказка: что сейчас мешает руднику и что с этим сделать. Цвет — срочность: красный — критично, ' +
    'жёлтый — важно, зелёный — к сведению. Нажмите на совет — камера покажет место; над объектом в сцене тоже висит значок 💡.'],
  scenarios: ['Сценарии «что если»', 'Кнопки, которыми можно устроить руднику неприятность — например, остановить дробилку или ' +
    'закрыть съезд. Включите и посмотрите, как рудник справляется и что посоветует система. «Показать» — камера к месту события.'],
  plants: ['Фабрики', 'Две обогатительные фабрики: сульфидная перерабатывает основную руду, глинистая — руду с глиной. План — сколько ' +
    'фабрика может принять за час, факт — сколько получает сейчас. Полоска — сколько плана смены уже выполнено.'],
  transport: ['Транспорт', 'Самосвалы возят руду от экскаваторов на дробилку и склад глины, а пустую породу — в отвал. «В работе» — ' +
    'в рейсе, на погрузке или разгрузке; «в очереди» — ждут погрузки или разгрузки; «авария» — сломаны. Ниже — погода в карьере.'],
  log: ['Журнал событий', 'Что случилось за смену: аварии, закрытые дороги, включённые сценарии, новые и снятые советы. ' +
    'Время — по часам модели рудника.'],
  legend: ['Легенда', 'Что означают цвета в сцене: груз самосвала, состояние оборудования, дороги и уступы карьера.'],
  settings: ['Настройки', '«Качество»: «Обычное» — быстрее на слабом компьютере, «Высокое» — с тенями и огнями. ' +
    '«Освещение»: день или ночная смена с прожекторами и фарами.'],
};
const qPop = document.getElementById('q-pop');
let qOpen = null;   // кнопка «?», чьё пояснение открыто
function qLive(key) {
  const ps = NS + ':plant-sulphide', pc = NS + ':plant-clay';
  const plant = (id, name) => twins[id] ? name + ': ' + fmt(Number(val(id, 'feed_rate', 0)) || 0, 0) + ' из ' +
    fmt(Number(attr(id, 'design_tph', 0)) || 0, 0) + ' т/ч' : '';
  if (key === 'ore') return [plant(ps, 'Сульфидная'), plant(pc, 'Глинистая')].filter(Boolean).join(' · ');
  if (key === 'cu') {
    const c = val(pc, 'feed_cu', null);
    return c === null ? '' : 'На глинистой фабрике сейчас — ' + fmt(c, 2) + ' %';
  }
  if (key === 'advice') { const l = adviceList(); return l && l.length > 1 ? 'Сейчас советов: ' + l.length + ' (главный — первым)' : ''; }
  return '';
}
function fillQ(key) {
  const [title, text] = Q_TEXT[key] || ['', ''];
  document.getElementById('q-pop-title').textContent = title;
  document.getElementById('q-pop-text').textContent = text;
  document.getElementById('q-pop-live').textContent = qLive(key);
}
function closeQ() {
  if (!qOpen) return;
  qOpen.classList.remove('open'); qOpen = null;
  qPop.hidden = true; windowShown(closeQ, false);
}
function openQ(btn) {
  if (qOpen) qOpen.classList.remove('open');
  qOpen = btn; btn.classList.add('open');
  fillQ(btn.dataset.q);
  qPop.hidden = false;
  const r = btn.getBoundingClientRect(), w = qPop.offsetWidth, h = qPop.offsetHeight;   // справа от панели, рядом с «?»
  qPop.style.left = Math.max(8, Math.min(r.right + 12, window.innerWidth - w - 8)) + 'px';
  qPop.style.top = Math.max(8, Math.min(r.top - 10, window.innerHeight - h - 8)) + 'px';
  windowShown(closeQ, true);
}
for (const b of panelEl.querySelectorAll('.q')) {
  b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();   // «?» в заголовке раздела не открывает и не закрывает сам раздел
    if (qOpen === b) closeQ(); else openQ(b);
    b.blur();
  });
}
document.getElementById('q-pop-close').addEventListener('click', closeQ);
document.addEventListener('click', (e) => { if (qOpen && !qPop.contains(e.target)) closeQ(); });

// Свернуть / развернуть панель; положение — в localStorage (без хранилища не запоминается, при открытии панель развёрнута)
function setPanel(collapsed) {
  document.body.classList.toggle('panel-collapsed', collapsed);
  document.getElementById('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('bz-panel', collapsed ? 'collapsed' : 'expanded'); } catch (e) { /* хранилище недоступно */ }
  closeQ();
  resize();
}
document.getElementById('panel-toggle').setAttribute('aria-expanded', String(!document.body.classList.contains('panel-collapsed')));
document.getElementById('panel-toggle').addEventListener('click', (e) => { setPanel(true); e.currentTarget.blur(); });
document.getElementById('panel-strip').addEventListener('click', (e) => { setPanel(false); e.currentTarget.blur(); });
// заголовок раздела под фокусом не должен открываться-закрываться пробелом (пробел — полёт вверх)
panelEl.addEventListener('click', (e) => { const el = e.target.closest('summary'); if (el) el.blur(); });

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
    (top || !a.title ? '<div class="text">' + esc(a.text || '') + '</div>' : '') +   // остальные советы — одной строкой
    (top && (a.reason || a.effect) ? '<details class="why"><summary>Почему и что даст</summary>' + esc(a.reason || '') +
      (a.effect ? ' · Ожидаемый эффект: ' + esc(a.effect) : '') + '</details>' : '') + '</div>';
}
function renderAdvice() {
  const root = document.getElementById('advice');
  const raw = val(NS + ':advisor', 'advice', null);
  if (raw === lastAdviceRaw) return;                 // ничего не изменилось — не трогаем DOM (иначе теряются клики)
  lastAdviceRaw = raw;
  const list = adviceList();
  const alarm = document.getElementById('panel-alarm');   // свёрнутая панель: ⚠, если есть совет (красный — критичный)
  alarm.hidden = !(list && list.length);
  alarm.classList.toggle('crit', !!list && list.some((a) => a.priority === 'critical'));
  document.getElementById('panel-strip').title = 'Развернуть панель диспетчера' + (list && list.length ? ' · советов: ' + list.length : '');
  if (list === null) { root.innerHTML = '<div class="advice none">нет данных</div>'; return; }
  adviceShown = list;
  root.innerHTML = list.length
    ? list.map((a, i) => adviceHtml(a, i, i === 0)).join('')
    : '<div class="advice none">Отклонений нет — советов пока нет</div>';
  for (const el of root.querySelectorAll('[data-i]')) el.addEventListener('click', (e) => {
    if (e.target.closest('details.why')) return;   // «Почему и что даст» открывается, камера не летит
    flyToThing(adviceShown[+el.dataset.i].target);
  });
  // значок над объектом совета
  const ids = new Set(list.map((a) => a.id));
  for (const a of list) {
    let b = adviceBadges[a.id];
    if (!b) {
      // подпись совета — у объекта, к которому совет относится (план фабрики — у фабрики, а не у узкого места в карьере)
      const at = ADVICE_AT[a.id];
      const obj = (at && byThing(NS + ':' + at)) || (a.target && byThing(a.target));
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
  for (const a of list) { pri[a.id] = a.priority; adviceTitles[a.id] = a.title || adviceTitles[a.id]; }
  if (prevAdvicePri !== null) {
    for (const a of list) {
      if (!(a.id in prevAdvicePri)) logEvent('Совет (' + (ADVICE_PRI[a.priority] || a.priority) + '): ' + a.text);
      else if (prevAdvicePri[a.id] !== a.priority) logEvent('Совет теперь «' + (ADVICE_PRI[a.priority] || a.priority) + '»: ' + (a.title || a.id));
    }
    for (const id of Object.keys(prevAdvicePri)) if (!ids.has(id)) logEvent('Совет снят: ' + (adviceTitles[id] || 'совет'));
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
  if (!prevWatch && Object.keys(cur).length) {   // первое открытие: состояние на сейчас
    for (const [k, v] of Object.entries(cur)) {
      if (k.startsWith('scen:') && v) logEvent('Сценарий «' + (SCENARIO_NAMES[k.slice(5)] || k.slice(5)) + '» уже включён');
      else if (k === 'crusher.accepting' && v === false) logEvent(nameOf(NS + ':crusher-01') + ' не принимает самосвалы');
      else if (k.startsWith('down:') && v) logEvent(nameOf(k.slice(5)) + ' — авария');
      else if (k.startsWith('open:') && v === false) logEvent('Дорога «' + nameOf(k.slice(5)) + '» закрыта');
    }
  }
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
  const close = () => show(false);
  const show = (on) => { box.hidden = !on; btn.classList.toggle('active', on); lastRealityRaw = null; renderReality(); windowShown(close, on); };
  btn.addEventListener('click', () => { show(box.hidden); btn.blur(); });
  document.getElementById('reality-close').addEventListener('click', () => show(false));
}

function renderPanel() {
  renderDispatcher();
  renderReality();
  renderScenarios();
  renderAdvice();
  renderMain();
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

// ---------------------------------------------------------------- земля, карьер, дороги (группа terrain)
const terrain = new THREE.Group();
scene.add(terrain);

// ---------------------------------------------------------------- дороги
const roadMeshes = {};   // roadId -> [mesh]
const roadMatKind = {};  // материал -> 'lambert' | 'basic' (качество)
const roadMats = {
  open: new THREE.MeshLambertMaterial({ color: colors.road }),
  ramp: new THREE.MeshLambertMaterial({ color: colors.ramp }),
  edge: new THREE.MeshLambertMaterial({ color: colors.roadEdge }),
  shoulder: new THREE.MeshLambertMaterial({ color: 0xbfae86 }),   // обочина
  closed: new THREE.MeshLambertMaterial({ color: colors.roadClosed }),
};
// сдвиг к камере ступенями: лента съезда (diorama-scene.js: −1/−4) < обочина < полотно дорог < полотно съездов —
// издали и на откосах полотно всегда поверх обочины, обочина — поверх ленты; где полотно съезда ложится на дорогу дна
// или бровки, наверху — съезд (без «пилы» и белой штриховки)
const ROAD_OFFSET = { shoulder: [-1.5, -6], ramp: [-2.5, -10], closed: [-2.5, -10] };
const roadOffset = (k) => { const [f, u] = ROAD_OFFSET[k] || [-2, -8]; return { polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: u }; };
function buildRoads() {
  // полотно — лента по единой поверхности (diorama-scene.js roadRibbons): нигде не уходит под землю
  for (const [k, m] of Object.entries(roadMats)) Object.assign(m, roadOffset(k));
  for (const [key, geo] of Object.entries(roadRibbons(THREE, dio))) {
    const [road, mat] = key.split('|');
    const m = new THREE.Mesh(geo, roadMats[mat]);
    terrain.add(m);
    if (mat === 'open' || mat === 'ramp') { m.userData.road = road; (roadMeshes[road] || (roadMeshes[road] = [])).push(m); }
  }
  // подписи и клик по съездам: середина съезда (по рёбрам схемы)
  const ramps = {};
  for (const e of dio.edges) if (/^road-ramp/.test(e.road)) (ramps[e.road] || (ramps[e.road] = [])).push(e);
  for (const [rid, list] of Object.entries(ramps)) {
    const e = list[Math.floor(list.length / 2)];
    const [xs, ys, zs] = dio.edgeAt(e, 0.5);   // середина ребра по трассе съезда
    const anchor = new THREE.Object3D(); anchor.position.copy(dio.s(xs, ys, zs + 2)); terrain.add(anchor);
    for (const m of roadMeshes[rid] || []) m.userData.thingId = NS + ':' + rid;   // клик по полотну — карточка дороги
    register(anchor, NS + ':' + rid, { hitRadius: 0 });
    clickable.push(...(roadMeshes[rid] || []));
    const info = (geometry.roads && geometry.roads[rid]) || {};
    addLabel(anchor, info.name || rid, { importance: 3, dy: 3 });
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
let tween = null;         // {fromPos, toPos, fromTgt, toTgt, t}
let followId = null;      // thingId самосвала, за которым идёт камера
const btnFollow = document.getElementById('btn-follow');
function setPerspective() {
  if (camera === perspCam) return;
  camera = perspCam; controls.enabled = true; topControls.enabled = false; zoomGoal = null;
  markViewButton('');
}
function flyTo(pos, target) {
  setPerspective(); zoomGoal = null;
  tween = { fromPos: perspCam.position.clone(), toPos: pos.clone(), fromTgt: controls.target.clone(), toTgt: target.clone(), t: 0 };
}
function markViewButton(name) {
  for (const b of document.querySelectorAll('#topbar button[data-view]')) b.classList.toggle('active', b.dataset.view === name);
}
// Виды — в координатах схемы [x — восток, y — север, z — высота], единицы
const VIEWS_SCHEMA = {
  all: { target: [-650, -200, 0], pos: [-760, -2500, 1500] },    // косой вид ≈ 33° на весь рудник
  pit: { target: [-120, -20, -90], pos: [-200, -640, 420] },     // карьер: 13 уступов, съезды, техника на дне
  crusher: { target: [-160, -330, 0], pos: [-240, -560, 160] },  // дробилка, заправка, начало конвейера
  plants: { target: [-1480, -390, 10], pos: [-1560, -1080, 470] }, // фабрика (крупнее для наглядности), склад, подстанция
};
// Переход к виду по имени (кнопки сверху и клавиши 1–5)
function setView(name) {
  if (!dio) return;   // схема ещё загружается
  const views = VIEWS_SCHEMA;
  const conv = (p) => dio.s(...p);
  if (name !== 'top' && !views[name]) return;
  followId = null; updateFollowButton(); stopOrbit();
  if (name === 'top') {
    camera = orthoCam; controls.enabled = false; topControls.enabled = true; tween = null; zoomGoal = null;
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
// Следовать за выбранным самосвалом / отпустить (кнопка и G)
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
// «Наверх» (и Home): плавно к общему виду рудника — откуда угодно (со дна карьера, из неба, из вида сверху)
const btnUp = document.getElementById('btn-up');
if (btnUp) btnUp.addEventListener('click', () => { setView('all'); btnUp.blur(); });
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
  wheelZoomStep(dt);
  (camera === perspCam ? controls : topControls).update();
  if (camera === perspCam) {
    // ближняя плоскость — от расстояния до точки обзора: вблизи 0,5, как раньше, издали больше — точность глубины на
    // дальнем плане выше, полотно, обочина и земля (в десятых долях единицы друг над другом) не мерцают полосами
    const near = Math.max(0.5, Math.min(30, perspCam.position.distanceTo(controls.target) * 0.02));
    if (Math.abs(near - perspCam.near) > near * 0.05) { perspCam.near = near; perspCam.updateProjectionMatrix(); }
  }
  if (weatherBlizzard && scene.fog) {
    // метель: густая дымка от места, куда смотрит камера (видимость 300 м ≈ 150 единиц карты), — вблизи плотная,
    // на общем виде рудник виден сквозь пелену, а не пропадает целиком
    const d = camera === orthoCam ? 1500 : perspCam.position.distanceTo(controls.target);
    scene.fog.near = Math.max(60, d * 0.55 - 150); scene.fog.far = d + 450 + d * 0.35;
  }
  if (dio && camera === perspCam) {   // камера всегда над поверхностью (и в перелёте — не сквозь борт);
    // упёрлась вне перелёта — вверх вместе с целью: взгляд не меняется, поворот мышью у земли поднимает взгляд в небо
    const up = dio.surfaceAt(perspCam.position.x, -perspCam.position.z) + 4 - perspCam.position.y;
    if (up > 0) { perspCam.position.y += up; if (!tween) controls.target.y += up; }
  }
  // масштаб техники — постоянный (MACHINE_SCALE); на дальнем плане её видно по значкам-стрелкам (updateMarkers)
  markerScale = MACHINE_SCALE;
  if (orbitId && !tween && camera === perspCam) {   // облёт: цель — на объекте, камера вращается вокруг
    const obj = byThing(orbitId);
    if (obj) { obj.getWorldPosition(_v); _d.subVectors(_v, controls.target).multiplyScalar(Math.min(1, dt * 4)); controls.target.add(_d); perspCam.position.add(_d); }
  }
}

// Колесо мыши и тачпад: шаг ≈ 11 % расстояния за щелчок колеса (тачпад — пропорционально прокрутке), камера
// подходит к новому расстоянию плавно (≈ 0,3 с, мягкое торможение), без прыжков к земле или вверх
let zoomGoal = null;   // целевое расстояние до цели (перспектива) или целевой zoom (вид сверху)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  let d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  d = Math.max(-150, Math.min(150, d));               // один щелчок колеса ≈ 100 → множитель ≈ 1,11
  const k = Math.exp(d * 0.00105);
  tween = null;
  if (camera === orthoCam) {
    const cur = zoomGoal === null ? orthoCam.zoom : zoomGoal;
    zoomGoal = Math.min(topControls.maxZoom, Math.max(topControls.minZoom, cur / k));
  } else {
    const cur = zoomGoal === null ? perspCam.position.distanceTo(controls.target) : zoomGoal;
    zoomGoal = Math.min(controls.maxDistance, Math.max(controls.minDistance, cur * k));
  }
}, { passive: false });
function wheelZoomStep(dt) {
  if (zoomGoal === null) return;
  const a = 1 - Math.exp(-dt * 9);                    // экспоненциальное приближение: плавное торможение
  if (camera === orthoCam) {
    orthoCam.zoom += (zoomGoal - orthoCam.zoom) * a; orthoCam.updateProjectionMatrix();
    if (Math.abs(zoomGoal - orthoCam.zoom) < 1e-3) zoomGoal = null;
    return;
  }
  _d.subVectors(perspCam.position, controls.target);
  const dist = _d.length();
  const nd = dist + (zoomGoal - dist) * a;
  perspCam.position.copy(controls.target).addScaledVector(_d, nd / (dist || 1));
  if (Math.abs(zoomGoal - nd) < Math.max(0.01, nd * 1e-3)) zoomGoal = null;
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
      models: modelsLib, verticalScale: 1,
    };
    try {
      const mod = await import('./layers/' + name + '.js' + suffix);
      if (typeof mod.init === 'function') await mod.init(ctx);
      if (name === 'haulage') rerouteRoadLines(group);
      layers.push({ name, mod, ctx, errors: 0 });
    } catch (e) {
      console.error('Слой ' + name + ': ошибка загрузки', e);
    }
  }
}

// Слой транспорта рисует линии закрытых дорог прямыми между узлами, а в схеме съезды — спирали вдоль борта:
// отрезок, совпадающий с ребром съезда, заменяем точками его трассы (только картинка; данные слоя те же)
function rerouteRoadLines(group) {
  group.traverse((o) => {
    if (!o.isLineSegments || !o.geometry || !o.geometry.attributes.position) return;
    const a = o.geometry.attributes.position.array, out = [];
    let changed = false;
    for (let i = 0; i + 5 < a.length; i += 6) {
      const e = dio && dio.edges.find((q) => q.path && Math.hypot(q.sa[0] - a[i], q.sa[1] + a[i + 2]) < 4 && Math.hypot(q.sb[0] - a[i + 3], q.sb[1] + a[i + 5]) < 4);
      if (!e) { for (let k = 0; k < 6; k++) out.push(a[i + k]); continue; }
      changed = true;
      const lift = a[i + 1] - e.sa[2];   // подъём линии слоя над полотном
      for (let k = 0; k < e.path.length - 1; k++) {
        const p = e.path[k], q = e.path[k + 1];
        out.push(p[0], p[2] + lift, -p[1], q[0], q[2] + lift, -q[1]);
      }
    }
    if (changed) o.geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  });
}

// ---------------------------------------------------------------- клавиатура (controls.js)
let keyboard = null;
function initKeys() {
  keyboard = initKeyboard({
    camera: () => camera,
    controls: () => (camera === perspCam ? controls : topControls),
    isTop: () => camera === orthoCam,
    setView, goHome: () => setView('all'), toggleFollow, clearSelection,
    stopFly: () => { tween = null; },
    unit: () => mp().unit,
    // высота земли под точкой сцены (sx, sz) — в единицах сцены
    groundY: (sx, sz) => dio.surfaceAt(sx, -sz),
    // границы движения камеры (координаты рудника или схемы): макет и поле вокруг; камера общего вида южнее макета
    bounds: () => { const b = dio.bounds; return { minX: b.minX - 300, maxX: b.maxX + 300, minY: b.minY - 1500, maxY: b.maxY + 300 }; },
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
  // «Обычное»: кадр в разрешении 0,5 от экрана — без видеокарты отрисовка пикселей самая дорогая часть кадра
  renderer.setPixelRatio(high ? 1 : 0.5);
  resize();
  renderer.shadowMap.enabled = high;
  sun.castShadow = high;
  // ореолы фонарей — только ночью (днём не нужны: белые шары на фоне степи); ночью огни горят всегда, как раньше
  if (environment && environment.setQuality) environment.setQuality(lighting === 'night');
  if (environment && environment.setLook) environment.setLook({ cheap: !high, night: lighting === 'night' });
  for (const s of glowSprites) s.visible = high && lighting === 'night';
  // дороги в «Обычном» — без расчёта освещения (ровная лента освещена одинаково)
  for (const [k, m] of Object.entries(roadMats)) {
    const want = high ? 'lambert' : 'basic';
    if (roadMatKind[k] === want) continue;
    const c = m.userData.base ?? m.color.getHex(), next = high ? new THREE.MeshLambertMaterial({ color: c }) : new THREE.MeshBasicMaterial({ color: c });
    next.userData.base = c;
    Object.assign(next, roadOffset(k));
    for (const meshes of Object.values(roadMeshes)) for (const mesh of meshes) if (mesh.material === m) mesh.material = next;
    terrain.traverse((o) => { if (o.material === m) o.material = next; });
    roadMats[k] = next; roadMatKind[k] = want;
  }
  roadNight();
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  const sel = document.getElementById('quality');
  if (sel) sel.value = quality;
}
// дороги без расчёта света («Обычное») ночью темнеют сами (освещённые материалы темнеют от луны)
function roadNight() {
  for (const m of Object.values(roadMats)) {
    if (!m.isMeshBasicMaterial) continue;
    if (m.userData.base === undefined) m.userData.base = m.color.getHex();
    m.color.setHex(m.userData.base).multiplyScalar(lighting === 'night' ? 0.32 : 0.92);
  }
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
  hemi.color.setHex(night ? 0x5d7096 : 0xe3eef8); hemi.groundColor.setHex(night ? 0x2b2620 : 0x8f7a58);
  hemi.intensity = night ? 0.8 : 1.05;
  sun.color.setHex(night ? 0x9fb6ff : 0xffe4bd); sun.intensity = night ? 0.6 : 3.6;   // ночью — луна
  for (const name of ['diorama-grid', 'grid']) {   // сетка фона (если есть) ночью — тёмно-синяя
    const grid = scene.getObjectByName(name);
    if (grid && grid.material) grid.material.color.setHex(night ? 0x34476b : 0xffffff);
  }
  scene.traverse((o) => {   // ореолы прожекторов ночью крупнее
    if (!o.isSprite || !o.userData.glow) return;
    if (!o.userData.baseScale) o.userData.baseScale = o.scale.x;
    o.scale.setScalar(o.userData.baseScale * (night ? 1.7 : 1));
  });
  renderer.toneMappingExposure = night ? EXPOSURE.night : EXPOSURE.day;
  if (modelsLib && modelsLib.setNight) modelsLib.setNight(night);
  roadNight();
  if (environment && environment.setQuality) environment.setQuality(night);   // ореолы фонарей — только ночью
  for (const s of glowSprites) s.visible = quality === 'high' && night;
  if (environment && environment.setLook) environment.setLook({ cheap: quality !== 'high', night });
  if (night) nightSky();
  else renderScenarioBannerSafe();   // днём фон и туман — по погоде (метель)
  updateHeadlights();
  const sel = document.getElementById('lighting');
  if (sel) sel.value = lighting;
  dbgWin.__lighting = lighting;
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
  if (motionLog.on) sampleMotion(now);
  updateDust(dt);
  updateServiceVehicles(dt);
  updatePuffs(dt);
  if (frameNo % 2 === 0) updateClouds(dt * 2);
  updateContactShadows();
  if (frameNo % 15 === 0) updateDownBadges();
  if (frameNo % 30 === 15) updateRoadWaitBadges();
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
      dbgWin.__qualityProbeFps = fps;
    }
  }
  dbgWin.__quality = quality;
  dbgWin.__sceneFrames = (dbgWin.__sceneFrames || 0) + 1;   // счётчик кадров для замера производительности
  dbgWin.__renderInfo = renderer.info.render;
  dbgWin.__mode = mode;
  if (quality === 'high' || frameNo % 2 === 0 || tween) updateLabels();   // в «Обычном» подписи — через кадр
}

// ---------------------------------------------------------------- заправка (общая сцена)
let fuelStationObj = null;
// корень модели объекта слоя (слой регистрирует и якорь подписи, и саму модель — берём самый верхний)
function buildingRoot(thingId) {
  let best = null;
  for (const o of clickable) {
    if (o.userData.thingId !== thingId) continue;
    let r = o; while (r.parent && r.parent.userData.thingId === thingId) r = r.parent;
    if (!best || r !== best) best = r;
  }
  return best;
}
function buildFuelStation() {
  const o = (geometry.objects || []).find((x) => x.kind === 'fuel');
  if (!o || !modelsLib || !modelsLib.fuelStation) return;
  const g = fuelStationObj = modelsLib.fuelStation();
  g.position.copy(toScene(o.position[0], o.position[1], groundAt(o.position[0], o.position[1])));
  terrain.add(g);
  addLabel(g, 'Заправка (ГСМ)', { importance: 3, dy: 12 });
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
  const v = VIEWS_SCHEMA[name];
  const conv = (p) => dio.s(...p);
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
  addLabel(d.anchors.pitFloor, 'Карьер · дно −' + geometry.pit.depth + ' м', { importance: 3, dy: 2, occlude: true });
  const A = geometry.pit.semi_axes_top;
  addLabel(d.anchors.pitName, 'Карьер Бозшаколь · ' + fmt(2 * A[0] / 1000, 1) + ' × ' + fmt(2 * A[1] / 1000, 1) + ' км', { importance: 3, dy: 3 });
  // синий пруд у фабрики — хвостохранилище (реальный объект, data/SOURCES.md): подпись видна и с общего вида
  if (d.anchors.concentrate) addLabel(d.anchors.concentrate, 'Склад концентрата · отгрузка в вагоны', { importance: 2, dy: 2 });
  const tl = dio.D.extra && dio.D.extra.tailings;
  if (d.anchors.tailings && tl) {   // подпись — у восточного края пруда (центр пруда на общем виде у края экрана)
    const anchor = new THREE.Object3D(); anchor.position.copy(dio.s(tl.center[0] + tl.radii[0] * 0.55, tl.center[1], 14));
    d.anchors.tailings.parent.add(anchor);
    addLabel(anchor, 'Хвостохранилище · отходы обогащения фабрик', { importance: 3, dy: 2 });
  }
  // степь уходит в дымку у горизонта: небо и туман одного светлого тона, краёв карты не видно
  scene.background = new THREE.Color(0xdde5ea);
  scene.fog = new THREE.Fog(0xdde5ea, 3500, 22000);
  return {
    group: null,
    setQuality: d.setQuality,
    setLook: d.setLook,
    setWeather({ blizzard = false } = {}) {
      scene.background.setHex(blizzard ? 0xdfe3e7 : 0xdde5ea);
      scene.fog.color.setHex(blizzard ? 0xdfe2e5 : 0xdde5ea);
      weatherBlizzard = blizzard;
      if (!blizzard) { scene.fog.near = 3500; scene.fog.far = 22000; }
    },
    update() {},
  };
}
function buildWorld() {
  applyModeCamera();
  environment = buildSchemaEnvironment();
  buildRoads(); updateRoads();
  buildFuelStation();
  jumpToView('all');
}
// Здания и склады — крупнее для наглядности (enlargeBuildings). Плитки блоков («Содержание меди») — квадраты по сетке блоков в метрах,
// а сетка в схеме сжата в 2 раза: плитку уменьшаем так же (один раз, общая геометрия)
function applySchemaScales() {
  const tiles = scene.getObjectByName('geology-cu-tiles');
  if (tiles) tiles.traverse((m) => {
    if (m.isInstancedMesh && !m.geometry.userData.schemaScaled) { m.geometry.scale(1 / 2, 1, 1 / 2); m.geometry.userData.schemaScaled = true; }
  });
}
// В схеме вся техника ближе 2,5 км «по метрам» слоёв — дальнюю (дальше 150 единиц от камеры) переводим
// в упрощённую детализацию после update слоёв: силуэт тот же, кадров больше
function schemaDetail() {
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
    // упрощённая модель — дальше 450 единиц («Высокое») или 200 («Обычное»: без видеокарты главное — число треугольников)
    o.userData.schemaDetail = camera === orthoCam || _v.distanceTo(_c) > (quality === 'high' ? 450 : 200) ? 'far' : 'full';
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
    if (down && !b) b = downBadges[id] = addLabel(o, '⛔ авария', { importance: 3.5, cls: 'warn alarm', dy: 9 });
    if (b) b.enabled = down;
  }
}
// Самосвал ждёт из-за закрытого съезда: в рейсе (hauling / returning) стоит, а до цели (пункт разгрузки или свой
// экскаватор) нет пути по открытым дорогам. Модель в этом случае ждёт на месте и пробует снова (travel_pending —
// в Ditto его нет), поэтому сцена проверяет путь по графу дорог geometry.json сама. Значок «ждёт: съезд закрыт».
const roadWaitBadges = {}, roadWaitSeen = {};
function reachableOpen(a, b, closed) {
  const seen = new Set([a]), todo = [a];
  while (todo.length) {
    const u = todo.pop();
    if (u === b) return true;
    for (const e of geometry.edges) {
      if (closed.has(e.road)) continue;
      const v = e.from === u ? e.to : (e.to === u ? e.from : null);
      if (v !== null && !seen.has(v)) { seen.add(v); todo.push(v); }
    }
  }
  return false;
}
function waitsForClosedRoad(id, closed) {
  const s = val(id, 'state', '');
  if ((s !== 'hauling' && s !== 'returning') || Math.abs(Number(val(id, 'speed', 0)) || 0) > 0.5) return false;
  const d = val(id, 'destination', '');   // гружёный — пункт разгрузки, порожний — экскаватор, на заправку — fuel-station
  const goal = (geometry.dump_points || {})[d] || (geometry.load_points || {})[d] || (geometry.nodes[d] ? d : null);
  const from = nearestNode(Number(val(id, 'x', 0)), Number(val(id, 'y', 0)));
  return !!(goal && from) && !reachableOpen(from, goal, closed);
}
function updateRoadWaitBadges() {
  if (!geometry || !geometry.edges || !geometry.nodes) return;
  const closed = new Set(Object.keys(geometry.roads || {}).filter((r) => val(NS + ':' + r, 'open', true) === false));
  for (const o of clickable) {
    const id = o.userData.thingId || '';
    if (!id.includes(':truck-') || !o.isObject3D || o.isMesh) continue;
    const waiting = closed.size > 0 && waitsForClosedRoad(id, closed);
    roadWaitSeen[id] = waiting ? (roadWaitSeen[id] || 0) + 1 : 0;   // два замера подряд — не мигает при короткой остановке
    let b = roadWaitBadges[id];
    if (b && b.obj !== o) { b.el.remove(); const i = labels.indexOf(b); if (i >= 0) labels.splice(i, 1); b = roadWaitBadges[id] = null; }
    const on = roadWaitSeen[id] >= 2;
    if (on && !b) b = roadWaitBadges[id] = addLabel(o, 'ждёт: съезд закрыт', { importance: 3.5, cls: 'warn', dy: 9 });
    if (b) b.enabled = on;
  }
}
dbgWin.__roadWait = () => Object.keys(roadWaitBadges).filter((id) => roadWaitBadges[id] && roadWaitBadges[id].enabled);
// Контакт с землёй: мягкое тёмное пятно под каждой машиной — одна InstancedMesh на всю технику, в любом качестве
// (в «Обычном» теней нет, без пятна техника висит над дорогой); размер — по габариту модели, курс — по машине
let contactMesh = null;
const CONTACT_MAX = 128;
const contactSize = new WeakMap();
const _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _cwq = new THREE.Quaternion(), _cp = new THREE.Vector3(), _cs = new THREE.Vector3();
const _cf = new THREE.Vector3(), _cy = new THREE.Vector3(0, 1, 0), _cbox = new THREE.Box3(), _cb = new THREE.Box3(), _cinv = new THREE.Matrix4(), _crel = new THREE.Matrix4();
function contactTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 3, 32, 32, 32);
  gr.addColorStop(0, 'rgba(40,30,20,0.62)'); gr.addColorStop(0.5, 'rgba(40,30,20,0.34)'); gr.addColorStop(1, 'rgba(40,30,20,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function machineFootprint(o) {   // [длина, ширина] модели в её собственных осях (без стрелы ковша — пятно мягкое)
  let s = contactSize.get(o);
  if (s) return s;
  o.updateWorldMatrix(true, true);
  _cinv.copy(o.matrixWorld).invert(); _cbox.makeEmpty();
  o.traverse((c) => {
    if (!c.isMesh || !c.geometry || !c.visible || c.isSprite) return;
    if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
    _crel.multiplyMatrices(_cinv, c.matrixWorld); _cb.copy(c.geometry.boundingBox).applyMatrix4(_crel); _cbox.union(_cb);
  });
  if (_cbox.isEmpty()) return null;
  _cbox.getSize(_cs);
  s = [Math.min(_cs.x, _cs.z * 2.2) * o.scale.x, _cs.z * o.scale.z];
  contactSize.set(o, s);
  return s;
}
function updateContactShadows() {
  if (!contactMesh) {
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    contactMesh = new THREE.InstancedMesh(geo, mat, CONTACT_MAX);
    contactMesh.name = 'contact-shadows'; contactMesh.frustumCulled = false; contactMesh.raycast = () => {};
    scene.add(contactMesh);
  }
  let n = 0;
  for (const o of clickable) {
    if (n >= CONTACT_MAX) break;
    const id = o.userData.thingId || '';
    if (!/:(truck|excavator|drill)-/.test(id) || !o.isObject3D || o.isMesh || !o.visible) continue;
    const s = machineFootprint(o); if (!s) continue;
    o.getWorldPosition(_cp); o.getWorldQuaternion(_cwq);
    _cf.set(1, 0, 0).applyQuaternion(_cwq);
    _cq.setFromAxisAngle(_cy, Math.atan2(-_cf.z, _cf.x));
    _cp.y += 0.25;
    _cs.set(s[0] * 1.3, 1, s[1] * 1.45);
    _cm.compose(_cp, _cq, _cs); contactMesh.setMatrixAt(n++, _cm);
  }
  for (const S of serviceList) {
    if (n >= CONTACT_MAX) break;
    const o = S.o, s = machineFootprint(o); if (!s) continue;
    o.getWorldPosition(_cp); _cp.y += 0.25;
    _cq.setFromAxisAngle(_cy, o.rotation.y);
    _cs.set(s[0] * 1.3, 1, s[1] * 1.45);
    _cm.compose(_cp, _cq, _cs); contactMesh.setMatrixAt(n++, _cm);
  }
  contactMesh.count = n; contactMesh.instanceMatrix.needsUpdate = true;
  contactMesh.material.opacity = lighting === 'night' ? 0.5 : (quality === 'high' ? 0.55 : 1);   // в «Высоком» есть и тени солнца
}
// ---------------------------------------------------------------- живой фон: служебные машины, пыль, облака
// Служебные машины (не двойники, только картинка): поливомоечная, грейдер, пикап мастера — каждая по своему замкнутому
// пути в свободной степи (путь ищется при загрузке: не ближе 35 единиц к дорогам, не у объектов, не в карьере, пруду,
// на ж/д ветке и под зданиями). Скорость — как у самосвалов: км/ч модели × ускорение стенда (≈ ×9,2). Только вперёд,
// плавные дуги — правила движения те же; в замере core/tools/motion_check они «service-*».
const SIM_SPEEDUP = 9.2;
const SERVICE = [
  { id: 'service-water', name: 'Поливомоечная машина', kind: 'water', kmh: 20, near: [700, -760], r: [140, 60] },
  { id: 'service-grader', name: 'Грейдер', kind: 'grader', kmh: 8, near: [-250, 700], r: [100, 45] },
  { id: 'service-pickup', name: 'Пикап мастера', kind: 'pickup', kmh: 35, near: [250, -1050], r: [170, 75] },
];
const serviceList = [];
function serviceModel(kind) {
  const g = new THREE.Group(), mats = {};
  const M = (c) => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c }));
  const box = (w, h, l, c, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), M(c)); m.position.set(x, y, z); g.add(m); return m; };
  let L, W, R;
  if (kind === 'water') {          // поливомоечная: рама, кабина спереди, цистерна
    L = 8.2; W = 2.6; R = 0.6;
    box(2.4, 0.6, 8.2, 0x3b3f45, 0, 1.0, 0); box(2.5, 2.1, 2.2, 0xf2f1ec, 0, 2.35, 2.9);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 5.0, 12), M(0x3f86c6)); tank.rotation.x = Math.PI / 2; tank.position.set(0, 2.5, -1.1); g.add(tank);
  } else if (kind === 'grader') {  // грейдер: длинная жёлтая рама, кабина сзади, отвал посередине
    L = 9.6; W = 2.6; R = 0.7;
    box(1.4, 1.0, 9.6, 0xf2b21b, 0, 1.5, 0); box(2.4, 1.0, 3.2, 0xf2b21b, 0, 1.4, -3.0); box(2.0, 1.9, 1.9, 0xf2b21b, 0, 2.85, -2.4);
    box(3.6, 0.8, 0.25, 0x3b3f45, 0, 0.55, 0.9);
  } else {                         // пикап
    L = 5.3; W = 1.9; R = 0.42;
    box(1.9, 0.75, 5.3, 0xf4f4f0, 0, 0.85, 0); box(1.8, 0.75, 2.3, 0xf4f4f0, 0, 1.6, 0.45); box(1.82, 0.4, 1.0, 0x2d4a66, 0, 1.6, 1.25);
  }
  const wg = new THREE.CylinderGeometry(R, R, 0.5, 10); wg.rotateZ(Math.PI / 2);
  for (const zf of [L / 2 - 1.2, -(L / 2 - 1.3)]) for (const xs of [-W / 2, W / 2]) { const w = new THREE.Mesh(wg, M(0x2a2b2e)); w.position.set(xs, R, zf); g.add(w); }
  // детали — в одну геометрию с цветами вершин: один вызов отрисовки на машину (без видеокарты каждый вызов дорог)
  g.updateMatrixWorld(true);
  const pos = [], nor = [], col = [];
  g.traverse((m) => {
    if (!m.isMesh) return;
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
    const p = geo.attributes.position, n = geo.attributes.normal, c = m.material.color;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.r, c.g, c.b); }
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const one = new THREE.Group();
  one.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true })));
  one.userData.size = { length: L, width: W };
  one.rotation.order = 'YXZ';
  return one;
}
// свободная точка степи (координаты схемы): дороги, конвейер, объекты, карьер, пруд, ж/д ветка, увеличенные здания
function serviceFree(boxes) {
  const D = dio.D, pit = dio.pit, tl = D.extra && D.extra.tailings;
  const busy = Object.entries(D.objects).filter(([id, o]) => o.position && !/^(face|excavator|drill)-/.test(id)).map(([, o]) => o.position);
  const cv = Object.values(D.objects).find((o) => o.kind === 'conveyor' && o.path);
  const seg = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t); };
  return (x, y) => {
    if (((x - pit.cx) / (pit.a + 60)) ** 2 + ((y - pit.cy) / (pit.b + 60)) ** 2 < 1) return false;
    for (const ed of dio.edges) if ((ed.path ? dio.edgeNearest(ed, x, y, 36).d : seg(x, y, ed.sa, ed.sb)) < 35) return false;
    if (cv) for (let i = 0; i + 1 < cv.path.length; i++) if (seg(x, y, cv.path[i], cv.path[i + 1]) < 30) return false;
    for (const p of busy) if (Math.hypot(x - p[0], y - p[1]) < 200) return false;
    if (tl && ((x - tl.center[0]) / (tl.radii[0] + 120)) ** 2 + ((y - tl.center[1]) / (tl.radii[1] + 120)) ** 2 < 1) return false;
    const v = dio.s(x, y, 0);
    for (const b of boxes) if (v.x > b.min.x && v.x < b.max.x && v.z > b.min.z && v.z < b.max.z) return false;
    return true;
  };
}
function buildServiceVehicles() {
  if (!dio || serviceList.length) return;
  const boxes = [];
  for (const e of ENLARGE) for (const id of e.ids) { const o = enlargeTarget(id); if (o) boxes.push(new THREE.Box3().setFromObject(o).expandByScalar(30)); }
  const rail = scene.getObjectByName('rail-siding'); if (rail) boxes.push(new THREE.Box3().setFromObject(rail).expandByScalar(40));
  const free = serviceFree(boxes), N = 240, taken = [];
  for (const sv of SERVICE) {
    let path = null;
    search: for (let d = 0; d <= 900; d += 60) for (let a = 0; a < 12; a++) {
      const cx = sv.near[0] + Math.cos(a * Math.PI / 6) * d, cy = sv.near[1] + Math.sin(a * Math.PI / 6) * d;
      if (taken.some(([tx, ty]) => Math.hypot(cx - tx, cy - ty) < sv.r[0] + 220)) continue;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const t = i / N * Math.PI * 2, x = cx + Math.cos(t) * sv.r[0], y = cy + Math.sin(t) * sv.r[1];
        if (!free(x, y)) continue search;
        pts.push(dio.s(x, y, 0));
      }
      taken.push([cx, cy]); path = pts;
      break;
    }
    if (!path) { console.warn('служебная машина ' + sv.id + ': свободного места для пути нет'); continue; }
    const cum = [0];
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + path[i % N].distanceTo(path[i - 1]));
    const o = serviceModel(sv.kind);
    o.scale.setScalar(1.25);   // техника крупнее в 1,25 раза, как самосвалы
    o.name = sv.id;
    terrain.add(o);
    addLabel(o, sv.name, { importance: 1, dy: 8 });
    serviceList.push({ sv, o, path, cum, len: cum[N], s: (serviceList.length * 0.37) * cum[N], v: sv.kmh / 3.6 / 2 * SIM_SPEEDUP });
  }
}
const _sp0 = new THREE.Vector3(), _sp1 = new THREE.Vector3();
function updateServiceVehicles(dt) {
  if (!serviceList.length) return;
  for (const S of serviceList) {
    S.s = (S.s + S.v * Math.min(dt, 0.1)) % S.len;
    const N = S.path.length;
    let i = 1; while (i < N && S.cum[i] < S.s) i++;
    const a = S.path[(i - 1) % N], b = S.path[i % N], k = (S.s - S.cum[i - 1]) / Math.max(1e-6, S.cum[i] - S.cum[i - 1]);
    _sp0.lerpVectors(a, b, k);
    // курс — по хорде на 6 единиц вперёд (плавно на дугах)
    let j = i, ahead = S.cum[i] - S.s; while (ahead < 6) { j++; ahead += S.path[j % N].distanceTo(S.path[(j - 1) % N]); }
    _sp1.copy(S.path[j % N]);
    const yaw = Math.atan2(_sp1.x - _sp0.x, _sp1.z - _sp0.z);
    const o = S.o, L = S.sv && o.userData.size.length * o.scale.x / 2, W = o.userData.size.width * o.scale.x / 2;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
    const h = (a, b) => dio.surfaceAt(_sp0.x + fx * L * a + lx * W * b, -(_sp0.z + fz * L * a + lz * W * b));
    const hFL = h(1, 1), hFR = h(1, -1), hBL = h(-1, 1), hBR = h(-1, -1);
    o.position.set(_sp0.x, (hFL + hFR + hBL + hBR) / 4, _sp0.z);
    o.rotation.set(Math.asin(Math.max(-0.3, Math.min(0.3, ((hBL + hBR) - (hFL + hFR)) / (4 * L)))), yaw,
      Math.asin(Math.max(-0.3, Math.min(0.3, ((hFL + hBL) - (hFR + hBR)) / (4 * W)))));
  }
}
// Лёгкая пыль за гружёными самосвалами в «Обычном» (в «Высоком» — своя): облачка — одна InstancedMesh, к камере лицом
let puffMesh = null, puffT = 0;
const puffs = [], PUFF_MAX = 96;
const _pm = new THREE.Matrix4(), _pp = new THREE.Vector3(), _ps = new THREE.Vector3(), _pprev = new WeakMap();
function updatePuffs(dt) {
  if (quality === 'high') { if (puffMesh) puffMesh.visible = false; return; }
  if (!puffMesh) {
    puffMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTexture(THREE), color: 0xd9cba6,
      transparent: true, opacity: 0.4, depthWrite: false }), PUFF_MAX);
    puffMesh.name = 'truck-dust'; puffMesh.frustumCulled = false; puffMesh.raycast = () => {};
    scene.add(puffMesh);
  }
  puffMesh.visible = true;
  puffMesh.material.opacity = lighting === 'night' ? 0.16 : 0.4;
  puffT += dt;
  if (puffT > 0.3) {
    puffT = 0;
    for (const o of machineList) {
      const id = o.userData.thingId || '';
      if (id.indexOf(':truck-') < 0 || !(Number(val(id, 'payload', 0)) > 0) || !o.visible) continue;
      const prev = _pprev.get(o); _pprev.set(o, o.position.clone());
      if (!prev || prev.distanceTo(o.position) < 1.5 || prev.distanceTo(o.position) > 60) continue;   // стоит или скачок
      if (puffs.length >= PUFF_MAX) puffs.shift();
      const yaw = o.rotation.y, L = ((o.userData.size && o.userData.size.length) || 12) * (o.scale.x || 1) / 2;
      puffs.push({ x: o.position.x - Math.sin(yaw) * L, y: o.position.y + 1.5, z: o.position.z - Math.cos(yaw) * L, age: 0 });
    }
  }
  let n = 0;
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i]; p.age += dt;
    const k = p.age / 2.2;
    if (k >= 1) { puffs.splice(i, 1); continue; }
    const size = 6 + 16 * k - 10 * k * k;   // раздувается и опадает — гаснет без прозрачности по каждой
    _pp.set(p.x, p.y + 3 * k, p.z); _ps.set(size, size, size);
    _pm.compose(_pp, camera.quaternion, _ps); puffMesh.setMatrixAt(n++, _pm);
  }
  puffMesh.count = n; puffMesh.instanceMatrix.needsUpdate = true;
}
// Облака: мягкие плоские облака вдали над степью (за пределами рудника, чтобы не закрывать его), медленно плывут
let cloudMesh = null;
const clouds = [];
function cloudTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 16; i++) {
    const cx = 40 + rnd() * 176, cy = 44 + rnd() * 40, r = 18 + rnd() * 30;
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 256, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let grassMesh;
function updateClouds(dt) {
  // пучки ковыля — только в «Высоком»: в «Обычном» бюджет кадров без видеокарты (кусты остаются)
  if (grassMesh === undefined) grassMesh = scene.getObjectByName('steppe-grass') || null;
  if (grassMesh) grassMesh.visible = quality === 'high';
  if (!cloudMesh) {
    const geo = new THREE.PlaneGeometry(1, 0.5); geo.rotateX(-Math.PI / 2);
    cloudMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, opacity: 0.9 }), 18);
    cloudMesh.name = 'clouds'; cloudMesh.frustumCulled = false; cloudMesh.raycast = () => {};
    let seed = 41; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 18; i++) {   // кольцо 3,5–9 тыс. единиц от центра, больше к северу (за карьером по умолчанию)
      const a = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * 1.6, r = 3500 + rnd() * 5500;
      clouds.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: 900 + rnd() * 700, s: 700 + rnd() * 900 });
    }
    scene.add(cloudMesh);
  }
  cloudMesh.material.color.setHex(lighting === 'night' ? 0x3a4458 : 0xffffff);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  clouds.forEach((c, i) => {
    c.x += dt * 4; if (c.x > 9500) c.x = -9500;   // ветер с запада, ≈ 4 единицы в секунду
    m.compose(p.set(c.x, c.y, c.z), q, s.set(c.s, 1, c.s)); cloudMesh.setMatrixAt(i, m);
  });
  cloudMesh.instanceMatrix.needsUpdate = true;
  updateCloudShadows(dt, m, q, p, s);
}
// Тени облаков на степи (видны с обычных видов): мягкие тёмные пятна плывут по ветру; над карьером не рисуются
// (плоскость тени висела бы над уступами), ночью выключены
let shadeMesh = null;
const shades = [];
function updateCloudShadows(dt, m, q, p, s) {
  if (!dio) return;
  if (!shadeMesh) {
    const geo = new THREE.PlaneGeometry(1, 0.5); geo.rotateX(-Math.PI / 2);
    shadeMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: cloudMesh.material.map, color: 0x2a2418, transparent: true,
      opacity: 0.16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), 9);
    shadeMesh.name = 'cloud-shadows'; shadeMesh.frustumCulled = false; shadeMesh.raycast = () => {};
    let seed = 77; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 9; i++) shades.push({ x: -3600 + rnd() * 7200, z: -2200 + rnd() * 4400, s: 500 + rnd() * 600 });
    scene.add(shadeMesh);
  }
  // без видеокарты («Обычное») не рисуем: большие прозрачные плоскости — дорогая заливка для программной отрисовки
  shadeMesh.visible = lighting !== 'night' && quality === 'high';
  if (!shadeMesh.visible) return;
  const pit = dio.pit, c0 = dio.s(pit.cx, pit.cy, 0), cA = dio.s(pit.cx + pit.a, pit.cy + pit.b, 0);
  const ax = Math.abs(cA.x - c0.x) + 40, az = Math.abs(cA.z - c0.z) + 40;
  shades.forEach((c, i) => {
    c.x += dt * 4; if (c.x > 4200) c.x = -4200;
    const r = c.s / 2, inPit = ((c.x - c0.x) / (ax + r)) ** 2 + ((c.z - c0.z) / (az + r * 0.5)) ** 2 < 1;
    m.compose(p.set(c.x, 1.2, c.z), q, s.set(inPit ? 0 : c.s, 1, inPit ? 0 : c.s)); shadeMesh.setMatrixAt(i, m);
  });
  shadeMesh.instanceMatrix.needsUpdate = true;
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
// Дно карьера в схеме сжато сильнее всего: буровой в 20–30 м от экскаватора оказался бы внутри него —
// после update слоёв отводим буровые не ближе 24 единиц от экскаваторов (только в схеме, только картинка)
function separateDrills() {
  const ex = clickable.filter((o) => /:excavator-/.test(o.userData.thingId || '') && !o.isMesh);
  for (const o of clickable) {
    if (!/:drill-/.test(o.userData.thingId || '') || o.isMesh) continue;
    for (const e of ex) {
      const dx = o.position.x - e.position.x, dz = o.position.z - e.position.z, d = Math.hypot(dx, dz);
      const R = 26;   // единиц: полкорпуса экскаватора (≈ 10,5) + полкорпуса бурового (≈ 7) + зазор
      if (d >= R) continue;
      const k = d > 0.01 ? R / d : 1;
      o.position.x = e.position.x + (d > 0.01 ? dx * k : R); o.position.z = e.position.z + (d > 0.01 ? dz * k : 0);

    }
  }
}
// Пересечение двух прямоугольников в плане (центр, курс rotation.y, полуразмеры): разделяющая ось
const EXC_HALF = [24 / 2, 16 / 2];   // единиц: экскаватор ×1,4 с поворотной платформой и поручнями (с запасом)
function obbOverlap(a, ahl, ahw, b, bhl, bhw) {
  const ax = Math.sin(a.rotation.y), az = Math.cos(a.rotation.y), bx = Math.sin(b.rotation.y), bz = Math.cos(b.rotation.y);
  const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
  for (const [nx, nz] of [[ax, az], [-az, ax], [bx, bz], [-bz, bx]]) {
    const ra = ahl * Math.abs(ax * nx + az * nz) + ahw * Math.abs(-az * nx + ax * nz);
    const rb = bhl * Math.abs(bx * nx + bz * nz) + bhw * Math.abs(-bz * nx + bx * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}
// Зоны забоев слоя геологии нарисованы в метрах (плоскость или группа плиток ≈ 120 × 60 м), слой каждый кадр ставит им
// масштаб ctx.markerScale — в схеме после обновления слоя ставим 1 : 2, как у карьера
function shrinkFaceZones() {
  for (const o of clickable) {
    if (!/:face-/.test(o.userData.thingId || '')) continue;
    // плоскость (повёрнута в горизонталь: локальные x, y) или группа плиток (x, z сцены): в схеме — 1 : 2
    if (o.isMesh) o.scale.set(1 / 2, 1 / 2, 1);
    else o.scale.set(1 / 2, 1, 1 / 2);
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
  if (dio) {
    shrinkFaceZones();
    for (const o of machineList) if (/:drill-/.test(o.userData.thingId)) o.scale.setScalar(markerScale);   // как остальная техника
    schemaDetail();
    truckTargets();          // самосвалы: цель показа — своя полоса, манёвр у пункта, стоянка у заправки
    separateDrills();
    drillsToBerms();
    drillsOffRoads();
    smoothShifts(dt);        // буровые и экскаваторы — без скачков
    separateDrills();        // никто из буровых не стоит в экскаваторе
    followTrucks(dt);        // самосвалы: показанное место догоняет цель как машина
    animateExcavators(dt);   // экскаватор — к развалу, ковш — из развала в кузов
    groundMachines(dt);
  }
  updateMarkers();
}
// Буровой станок в карьере — на берме своего уступа, вдоль неё (берма ≈ 6 единиц, станок шириной ≈ 6): не в стенке,
// не на полотне и не у съезда (там борт — ровный склон без берм, dio.stepBlend < 1) и не у экскаватора. Ищем по берме ближайшее ровное место (углы корпуса на высоте бермы, ≥ 26
// единиц до экскаватора), сначала на своём уступе, потом на соседних; место запоминается, пока станок слоя не переехал
function drillsToBerms() {
  const P = dio.pit;
  const ex = machineList.filter((e) => e.userData.thingId.indexOf(':excavator-') >= 0);
  for (const o of machineList) {
    if (o.userData.thingId.indexOf(':drill-') < 0) continue;
    const xs = o.position.x, ys = -o.position.z;
    const ds = dio.schemaInset(xs, ys);
    if (ds < 0 || ds >= P.Ds) continue;
    const ud = o.userData, key = Math.round(xs / 4) + ',' + Math.round(ys / 4);
    if (!ud.berm || ud.berm.key !== key || performance.now() - ud.berm.at > 3000) ud.berm = { key, at: performance.now(), spot: bermSpot(xs, ys, ds, ex) };
    const sp = ud.berm.spot;
    o.position.x = sp.x; o.position.z = -sp.y; o.rotation.y = sp.yaw;
  }
}
// Буровой станок на дне: не на полотне дороги и не на откосе у подножия съезда — отводим его от оси ближайшей дороги
// на ровное дно (шагами по 2 единицы, не дальше 60; сначала в свою сторону, потом в другую); место запоминается, пока
// станок слоя не переехал
function drillsOffRoads() {
  const pitEdges = dio.edges.filter((e) => e.pit), CLEAR = dio.roadHalf + 10;
  const uneven = (x, y) => {
    const h = dio.surfaceAt(x, y);
    for (const [dx, dy] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) if (Math.abs(dio.surfaceAt(x + dx, y + dy) - h) > 0.6) return true;
    return false;
  };
  const nearest = (x, y) => {
    let best = null;
    for (const e of pitEdges) { const n = dio.edgeNearest(e, x, y, 80); if (!best || n.d < best.n.d) best = { e, n }; }
    return best;
  };
  const bad = (x, y) => { const b = nearest(x, y); return (b && b.n.d < CLEAR) || uneven(x, y); };
  for (const o of machineList) {
    if (o.userData.thingId.indexOf(':drill-') < 0) continue;
    const xs = o.position.x, ys = -o.position.z;
    if (dio.schemaInset(xs, ys) < dio.pit.Ds) continue;   // на уступах — drillsToBerms
    const ud = o.userData, key = Math.round(xs / 4) + ',' + Math.round(ys / 4);
    if (!ud.floor || ud.floor.key !== key) {
      ud.floor = { key, x: xs, y: ys };
      const b = nearest(xs, ys);
      if (b && b.n.d < 80 && bad(xs, ys)) {
        const q = dio.edgeAt(b.e, b.n.t), side = Math.sign(-q[4] * (xs - q[0]) + q[3] * (ys - q[1])) || 1;
        for (const sg of [side, -side]) {
          let x = xs, y = ys, k = 0;
          for (; k < 30 && bad(x, y); k++) { x += -q[4] * sg * 2; y += q[3] * sg * 2; }
          if (!bad(x, y)) { ud.floor = { key, x, y }; break; }
        }
      }
    }
    o.position.x = ud.floor.x; o.position.z = -ud.floor.y;
  }
}
function bermSpot(xs, ys, ds, ex) {
  const P = dio.pit, k0 = Math.min(P.benches - 1, Math.floor(ds / P.inset));
  const t0 = Math.atan2((ys - P.cy) / (P.b - ds), (xs - P.cx) / (P.a - ds));
  const at = (k, t) => {
    const d = k * P.inset + P.berm / 2, [bx, by] = dio.ringPoint(d, t);
    let tx = -(P.a - d) * Math.sin(t), ty = (P.b - d) * Math.cos(t);
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    return { x: bx, y: by, d, t, tx, ty, yaw: Math.atan2(tx, -ty) };
  };
  const flat = (c) => {
    if (dio.stepBlend(c.x, c.y) < 0.999) return false;   // у съезда (и на его полотне на высоте бермы) — не берма
    const h = dio.benchProfile(c.d);
    for (const u of [0, 7, -7]) if (Math.abs(dio.surfaceAt(c.x + c.tx * u, c.y + c.ty * u) - h) > 0.6) return false;
    for (const v of [2.2, -2.2]) {   // поперёк — по отступу от борта (у концов эллипса берма уже 6 единиц)
      const [qx, qy] = dio.ringPoint(c.d + v, c.t);
      if (Math.abs(dio.surfaceAt(qx, qy) - h) > 0.6) return false;
    }
    return ex.every((e) => Math.hypot(e.position.x - c.x, -e.position.z - c.y) >= 26);
  };
  for (const k of [k0, k0 - 1, k0 + 1, k0 - 2, k0 + 2]) {
    if (k < 0 || k >= P.benches) continue;
    const d = k * P.inset + P.berm / 2, rad = Math.hypot((P.a - d) * Math.sin(t0), (P.b - d) * Math.cos(t0)) || 1;
    for (let i = 0; i <= 100; i++) {   // до 400 единиц в каждую сторону (вдоль съезда ровный склон тянется далеко)
      for (const sg of i ? [1, -1] : [1]) {
        const c = at(k, t0 + sg * i * 4 / rad);
        if (flat(c)) return c;
      }
    }
  }
  return at(k0, t0);   // ровного места рядом нет — как раньше: середина своей бермы
}
// Без телепортов: сдвиг отображения (полоса, место в очереди, разведение) — поправка к месту слоя; она меняется
// плавно (≈ 0,6 с), курс — тоже. Место слоя (rawPos) по-прежнему его собственное
function smoothShifts(dt) {
  const a = 1 - Math.exp(-dt / 0.25), ar = 1 - Math.exp(-dt / 0.2);
  for (const o of machineList) {
    if (o.userData.thingId.indexOf(':truck-') >= 0) continue;
    const raw = o.userData.rawPos, ud = o.userData;
    const ox = o.position.x - raw.x, oz = o.position.z - raw.z;
    if (!ud.shift) ud.shift = { x: ox, z: oz };
    else if (Math.hypot(ox - ud.shift.x, oz - ud.shift.z) > 400) { ud.shift.x = ox; ud.shift.z = oz; }   // перенос слоем
    else { ud.shift.x += (ox - ud.shift.x) * a; ud.shift.z += (oz - ud.shift.z) * a; }
    o.position.x = raw.x + ud.shift.x; o.position.z = raw.z + ud.shift.z;
    // слой мог переставить машину скачком (смена состояния: встала в очередь) — показываем переезд за ≈ 0,5 с
    if (!ud.disp) ud.disp = { x: o.position.x, z: o.position.z };
    const jx = o.position.x - ud.disp.x, jz = o.position.z - ud.disp.z, j = Math.hypot(jx, jz);
    if (j > Math.max(6, 70 * dt) && j < 600) {
      const step = Math.min(j * (1 - Math.exp(-dt / 0.18)), Math.max(1.5, 100 * dt)) / j;
      ud.disp.x += jx * step; ud.disp.z += jz * step; o.position.x = ud.disp.x; o.position.z = ud.disp.z;
    }
    else { ud.disp.x = o.position.x; ud.disp.z = o.position.z; }
    const yaw = o.rotation.y;
    if (ud.dispYaw === undefined) ud.dispYaw = yaw;
    let d = yaw - ud.dispYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    ud.dispYaw += Math.max(-3 * dt, Math.min(3 * dt, d * ar));   // разворот не быстрее 3 рад/с
    o.rotation.y = ud.dispYaw;
  }
}
// Колёса и гусеницы — на поверхности (единая функция высоты dio.surfaceAt + полотно дороги), наклон корпуса —
// по уклону под машиной: продольный (тангаж) и поперечный (крен), сглаженно
const ROAD_LIFT = 0.45;   // полотно дороги над поверхностью (diorama-scene.js roadRibbons)
function groundMachines(dt) {
  const k = 1 - Math.exp(-dt / 0.05);
  for (const o of machineList) {
    const ud = o.userData, s = o.scale.x || 1;
    const size = ud.size || {};
    const L = (size.length || size.l || 12) * s * 0.5, W = (size.width || size.w || 7) * s * 0.5;
    const fx = Math.sin(o.rotation.y), fz = Math.cos(o.rotation.y);     // вперёд (локальная +Z)
    const lx = Math.cos(o.rotation.y), lz = -Math.sin(o.rotation.y);    // локальная +X
    const H = (x, z) => dio.surfaceAt(x, -z);
    const x = o.position.x, z = o.position.z;
    const h0 = H(x, z);
    // опора — четыре угла корпуса (колёса); точка за кромкой уступа (перепад больше 3 единиц) — не опора: на уровне центра
    const near = (h) => (Math.abs(h - h0) > 3 ? h0 : h);
    const c = (a, b) => near(H(x + fx * L * a + lx * W * b, z + fz * L * a + lz * W * b));
    const fl = c(1, 1), fr = c(1, -1), bl = c(-1, 1), br = c(-1, -1);
    const onRoad = ud.thingId.indexOf(':truck-') >= 0 ? ROAD_LIFT : 0;
    // высота и наклон — плоскость через колёса, сразу (без «догона» поверхности: при быстром ходе по съезду и редких
    // кадрах догон давал провал или подскок)
    ud.dispY = (fl + fr + bl + br) / 4 + onRoad;
    o.position.y = ud.dispY;
    const pitch = -Math.atan2((fl + fr - bl - br) / 2, 2 * L), roll = Math.atan2((fl + bl - fr - br) / 2, 2 * W);
    if (o.rotation.order !== 'YXZ') o.rotation.order = 'YXZ';
    ud.tilt = ud.tilt || { p: pitch, r: roll };
    ud.tilt.p += (pitch - ud.tilt.p) * k; ud.tilt.r += (roll - ud.tilt.r) * k;
    o.rotation.x = Math.max(-0.35, Math.min(0.35, ud.tilt.p)); o.rotation.z = Math.max(-0.3, Math.min(0.3, ud.tilt.r));
  }
}
// Если два самосвала всё равно налезают (по габаритам с учётом курса) — задний отходит назад вдоль своего хода;
// два стоящих на разгрузке в одной точке — второй сдвигается в сторону
const TRUCK_L = 15 * 1.25 + 2, TRUCK_W = 8 * 1.25 + 1;   // единиц: самосвал 180 т + зазор
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
// Значки-стрелки над техникой на дальнем плане (дальше markerFar от камеры) и в виде сверху: цвет — груз/состояние
let markerMesh = null;
const _mm = new THREE.Matrix4(), _mq = new THREE.Quaternion(), _ms = new THREE.Vector3(), _mc = new THREE.Color();
function markerColor(id) {
  const st = val(id, 'state', '');
  if (st === 'down' || st === 'failed') return colors.down;
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
    _v.y += 10 * o.scale.y + size * 0.4;
    _mm.compose(_v, _mq, _ms);
    markerMesh.setMatrixAt(n, _mm);
    markerMesh.setColorAt(n, _mc.setHex(markerColor(o.userData.thingId)));
    n++;
  }
  markerMesh.count = n;
  markerMesh.instanceMatrix.needsUpdate = true;
  if (markerMesh.instanceColor) markerMesh.instanceColor.needsUpdate = true;
}
// ---------------------------------------------------------------- самосвалы: цель показа и езда «как машина»
// Модель (bz-haulage) ведёт самосвал по оси дороги и ставит очередь вдоль дороги подъезда с запасом под размер машин
// в схеме. Сцена (только картинка, данные двойников не меняются) задаёт цель показа: на дороге — своя полоса (правее
// оси по ходу); у экскаватора, дробилки, склада глины и отвала — манёвр: подъехать, развернуться, сдать задом 24 м и
// встать (у экскаватора — сбоку от него, у пунктов разгрузки — задом к краю); на заправке и в резерве — стоянка рядом
// с ней (заезд так же, задом). Показанное место догоняет цель как машина: едет передом, поворачивает по дуге, скорость
// меняется плавно; задним ходом — только в конце манёвра и не быстрее 2 м/с
const LANE = 8;   // единиц: от оси дороги (ширина 28) до середины полосы: встречные расходятся с зазором
const QUEUE_SIDE = 12;   // единиц: очередь стоит на обочине — на столько правее своей полосы
// манёвр: задним ходом REV (24 м), радиус поворота R, скорости (единиц/с: вперёд ≈ 6 м/с, задом ≈ 1,9 м/с при ×10),
// место у экскаватора: на AHEAD вперёд от его центра и на SIDE вбок
const MAN = { rev: 12, r: 8, fwd: 28, back: 8.5, ahead: 4, side: 17 };
const FOLLOW = { rMin: 10, acc: 90, dec: 200, vMax: 88, snap: 400 };   // vMax — догон, но не быстрее 1,5 × 50 км/ч модели (ниже порога «телепорта»)
const DUMP_AT = { 'crusher-01': ['crusher', 'crusher-01'], 'stockpile-clay': ['stockpile-clay', 'stockpile-clay'], 'dump-waste-1': ['dump-waste-1', 'dump-waste-1'] };
const PARKED = new Set(['refueling', 'reserve']);
const DEPART = 20;   // единиц: выезд от пункта прямо вперёд, потом — на дорогу
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const planYaw = (ux, uy) => Math.atan2(ux, -uy);   // направление в плане (восток, север) → курс сцены (z = −север)
// пункт, где самосвал стоит: место S (план), наружу u (куда смотрит носом), сторона разворота s
function truckStation(id, st) {
  if (st === 'loading') {
    const exId = val(id, 'excavator', ''), ex = exId && byThing(NS + ':' + exId), nd = exId && dio.D.nodes['face-' + exId.slice(-2)];
    if (!ex || !nd) return null;
    const e0 = ex.userData.rawPos || ex.position, Ex = e0.x, Ey = -e0.z;
    let ux = nd[0] - Ex, uy = nd[1] - Ey; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    const nx = -uy, ny = ux, s = nx * (dio.pit.cx - Ex) + ny * (dio.pit.cy - Ey) >= 0 ? 1 : -1;   // сбоку — со стороны середины карьера
    return { key: 'load:' + exId, S: [Ex + ux * MAN.ahead + nx * s * MAN.side, Ey + uy * MAN.ahead + ny * s * MAN.side], u: [ux, uy], s, ex: exId, E: [Ex, Ey] };
  }
  if (st === 'dumping') {
    const d = DUMP_AT[val(id, 'destination', '')], nd = d && dio.D.nodes[d[0]], ob = d && dio.D.objects[d[1]] && dio.D.objects[d[1]].position;
    if (!nd || !ob) return null;
    let ux = nd[0] - ob[0], uy = nd[1] - ob[1]; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    return { key: 'dump:' + d[0], S: [nd[0], nd[1]], u: [ux, uy], s: 1 };
  }
  return null;
}
// стоянка у заправки: ряды вдоль подъезда к ней с южной стороны (с северной — трасса конвейера), носом к дороге;
// места по порядку: ближний ряд, второй, третий, потом ближе к узлу rim-ne
const PARK_SLOTS = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [5, 0], [3, 1], [2, 2], [6, 0]];
function parkingSpot(k) {
  const N = dio.D.nodes['fuel-station'], R = dio.D.nodes['rim-ne'];
  if (!N || !R) return null;
  let ax = N[0] - R[0], ay = N[1] - R[1]; const L = Math.hypot(ax, ay) || 1; ax /= L; ay /= L;   // подъезд к заправке
  const lx = -ay, ly = ax;                                                                     // влево от подъезда (юг)
  const [i, j] = PARK_SLOTS[k % PARK_SLOTS.length];
  const along = -35 - 13 * i, side = 24 + 24 * j;
  return { key: 'park:' + k, S: [N[0] + ax * along + lx * side, N[1] + ay * along + ly * side], u: [-lx, -ly], s: -1 };
}
// трасса манёвра от показанного места f: подъезд передом, дуга вперёд (разворот на 90°), дуга задом, прямо задом к месту
function buildManeuver(f, st) {
  const [Sx, Sy] = st.S, [ux, uy] = st.u, s = st.s, nx = -uy, ny = ux, r = MAN.r;
  const Tx = Sx + ux * MAN.rev, Ty = Sy + uy * MAN.rev, P1x = Tx + ux * 2 * r, P1y = Ty + uy * 2 * r;
  const pts = [], add = (x, y, hx, hy, rev) => pts.push({ x, y, yaw: planYaw(hx, hy), rev });
  const x0 = f.x, y0 = -f.z, dl = Math.hypot(P1x - x0, P1y - y0), n0 = Math.max(1, Math.ceil(dl / 3));
  const ax = dl > 1 ? (P1x - x0) / dl : -ux, ay = dl > 1 ? (P1y - y0) / dl : -uy;
  for (let i = 0; i <= n0; i++) add(x0 + (P1x - x0) * i / n0, y0 + (P1y - y0) * i / n0, ax, ay, false);
  const C1x = P1x + nx * s * r, C1y = P1y + ny * s * r;
  for (let k = 1; k <= 12; k++) {
    const t = k / 12 * Math.PI / 2, c = Math.cos(t), sn = Math.sin(t);
    add(C1x - r * (nx * s * c + ux * sn), C1y - r * (ny * s * c + uy * sn), nx * s * sn - ux * c, ny * s * sn - uy * c, false);
  }
  const C2x = Tx + nx * s * r, C2y = Ty + ny * s * r;
  for (let k = 11; k >= 0; k--) {
    const t = k / 12 * Math.PI / 2, c = Math.cos(t), sn = Math.sin(t);
    add(C2x + r * (-nx * s * c + ux * sn), C2y + r * (-ny * s * c + uy * sn), nx * s * sn + ux * c, ny * s * sn + uy * c, true);
  }
  for (let i = 1; i <= 6; i++) add(Tx - ux * MAN.rev * i / 6, Ty - uy * MAN.rev * i / 6, ux, uy, true);
  return { key: st.key, pts, i: 0, s: 0, S: [Sx, Sy], T: [Tx, Ty], P1: [P1x, P1y], u: [ux, uy], yaw: planYaw(ux, uy), done: false, at: 0, ex: st.ex, E: st.E, n0: Math.max(0, n0 - 2) };
}
// место у пункта погрузки/разгрузки занято: другой самосвал (не из очереди) ещё у места или у начала разворота
function stationBusy(self, m) {
  if (!/^(load|dump):/.test(m.key)) return false;
  for (const o of machineList) {
    if (o === self || o.userData.thingId.indexOf(':truck-') < 0 || !o.userData.follow) continue;
    if (/^queued_/.test(val(o.userData.thingId, 'state', ''))) continue;
    const f = o.userData.follow, x = f.x, y = -f.z;
    for (const p of [m.S, m.T, m.P1]) if (Math.hypot(x - p[0], y - p[1]) < 22) return true;
  }
  return false;
}
// ребро модели, по которому едет самосвал: в пределах 25 м, вдоль курса (на развилке ближайшее ребро может быть
// соседним — тогда полоса перескочила бы на другую сторону)
function edgeAlong(x, y, h) {
  const hx = Math.sin(h), hy = Math.cos(h);
  let best = null;
  for (const e of dio.edges) {
    const dx = e.rb[0] - e.ra[0], dy = e.rb[1] - e.ra[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - e.ra[0]) * dx + (y - e.ra[1]) * dy) / L2));
    const d = Math.hypot(x - e.ra[0] - dx * t, y - e.ra[1] - dy * t);
    if (d > 25) continue;
    const score = d - 15 * Math.abs((dx * hx + dy * hy) / Math.sqrt(L2));
    if (!best || score < best.score) best = { e, t, d, score };
  }
  return best;
}
// место в очереди у забоя на уступе (есть площадка в diorama.json extra.face_pads): номер — по близости места слоя к узлу
function benchQueueSlot(o, id) {
  const exId = String(val(id, 'excavator', '')), face = 'face-' + exId.slice(-2);
  const pads = (dio.D.extra && dio.D.extra.face_pads) || [];
  if (!pads.some((b) => b.face === face)) return null;
  const sta = truckStation(id, 'loading');
  if (!sta) return null;
  const nd = dio.D.nodes[face], ex = byThing(NS + ':' + exId), e0 = ex.userData.rawPos || ex.position;
  const dist = (q) => { const r = q.userData.rawPos || q.position; return Math.hypot(r.x - nd[0], -r.z - nd[1]); };
  const mine = dist(o);
  let k = 0;
  for (const q of machineList) {
    const qid = q.userData.thingId;
    if (q !== o && qid.indexOf(':truck-') >= 0 && val(qid, 'state', '') === 'queued_load' && String(val(qid, 'excavator', '')) === exId && dist(q) < mine) k++;
  }
  const [ux, uy] = sta.u, nx = -uy, ny = ux, s = sta.s, Ex = e0.x, Ey = -e0.z, a = s * (MAN.side + 24 * (k + 1));
  return [Ex + ux * MAN.ahead + nx * a, Ey + uy * MAN.ahead + ny * a, planYaw(-nx * s, -ny * s)];
}
// цель показа каждого самосвала: o.position / o.rotation.y (место слоя — rawPos — не меняется)
function truckTargets() {
  const pitEdges = dio.edges.filter((e) => e.pit);
  const parked = [];
  for (const o of machineList) {
    const id = o.userData.thingId;
    if (id.indexOf(':truck-') < 0) continue;
    const ud = o.userData, st = val(id, 'state', '');
    if (PARKED.has(st)) { parked.push(o); continue; }
    ud.parkKey = null;
    const sta = truckStation(id, st);
    if (sta) {   // у пункта — по манёвру (followTrucks)
      if (!ud.man || ud.man.key !== sta.key) ud.man = null, ud.station = sta;
      continue;
    }
    if (ud.man) { ud.depart = { S: ud.man.S, u: ud.man.u, yaw: ud.man.yaw, E: ud.man.E }; ud.man = null; }
    // очередь к забою на уступе: подъезд в схеме короткий — стоят на площадке забоя вдоль уступа, за местом погрузки
    // (дальше от экскаватора), бортом к полотну (не на полосе съезда)
    if (st === 'queued_load') {
      const slot = benchQueueSlot(o, id);
      if (slot) { o.position.x = slot[0]; o.position.z = -slot[1]; o.rotation.y = slot[2]; continue; }
    }
    // на дороге: место слоя и направление хода по ребру схемы (знак — по курсу модели)
    const x = Number(val(id, 'x', 0)), y = Number(val(id, 'y', 0)), ne = edgeAlong(x, y, Number(val(id, 'heading', 0)) * Math.PI / 180);
    let tx = 0, ty = 0;
    if (ne) {
      // у своего забоя (на подъезде к нему, ближе 40) — без полосы: рядом экскаватор; проезжающие мимо — по своей полосе
      const face = 'face-' + String(val(id, 'excavator', '')).slice(-2), fp = dio.D.nodes[face];
      const atFace = fp && (ne.e.from === face || ne.e.to === face) && Math.hypot(o.position.x - fp[0], -o.position.z - fp[1]) < 40;
      // стоящий в очереди — на обочине, правее своей полосы: попутные проезжают мимо
      const side = atFace ? 0 : LANE + (/^queued_/.test(st) ? QUEUE_SIDE : 0);
      const q = dio.edgeAt(ne.e, ne.t), h = Number(val(id, 'heading', 0)) * Math.PI / 180;
      const fw = (ne.e.rb[0] - ne.e.ra[0]) * Math.sin(h) + (ne.e.rb[1] - ne.e.ra[1]) * Math.cos(h) >= 0 ? 1 : -1;
      tx = q[3] * fw; ty = q[4] * fw;
      o.position.x += ty * side; o.position.z += tx * side;   // правее оси по ходу (в плане вправо — (ty, −tx); z = −север)
      o.rotation.y = planYaw(tx, ty);
    }
    // съезды и дороги карьера: если цель всё же на откосе — на ближайшую дорогу, не дальше своей полосы от оси
    const xs = o.position.x, ys = -o.position.z;
    if (dio.schemaInset(xs, ys) >= 0) {
      const h0 = dio.surfaceAt(xs, ys);
      let steep = false;
      for (const [dx, dy] of [[9, 0], [-9, 0], [0, 9], [0, -9]]) if (Math.abs(dio.surfaceAt(xs + dx, ys + dy) - h0) > 2.5) { steep = true; break; }
      if (steep) {
        let best = null;
        for (const e of pitEdges) { const n = dio.edgeNearest(e, xs, ys, 80); if (!best || n.d < best.n.d) best = { e, n }; }
        if (best && best.n.d <= 80) {
          const q = dio.edgeAt(best.e, best.n.t), lat = Math.max(-LANE, Math.min(LANE, -q[4] * (xs - q[0]) + q[3] * (ys - q[1])));
          o.position.x = q[0] - q[4] * lat; o.position.z = -(q[1] + q[3] * lat);
        }
      }
    }
    // уезжает от пункта: сначала прямо вперёд от места, где стоял (мимо экскаватора, из-под бункера), — цель на этой
    // прямой вровень с местом слоя; дальше DEPART единиц — на свою дорогу
    const dp = ud.depart;
    if (dp) {
      const along = (o.position.x - dp.S[0]) * dp.u[0] + (-o.position.z - dp.S[1]) * dp.u[1];
      const nearExc = dp.E && Math.hypot(o.position.x - dp.E[0], -o.position.z - dp.E[1]) < 32;   // место модели ещё у кормы экскаватора
      if (nearExc || (along < DEPART && Math.hypot(o.position.x - dp.S[0], -o.position.z - dp.S[1]) < DEPART)) {
        const a = Math.max(0, Math.min(DEPART, along));
        o.position.x = dp.S[0] + dp.u[0] * a; o.position.z = -(dp.S[1] + dp.u[1] * a); o.rotation.y = dp.yaw;
      } else ud.depart = null;
    }
  }
  // стоянка у заправки: место закреплено за машиной, пока она там стоит
  const used = new Set(parked.map((o) => o.userData.parkKey).filter(Boolean));
  for (const o of parked) {
    const ud = o.userData;
    if (!ud.parkKey) { let k = 0; while (used.has('park:' + k)) k++; ud.parkKey = 'park:' + k; used.add(ud.parkKey); }
    const sta = parkingSpot(Number(ud.parkKey.slice(5)));
    if (!sta) continue;
    if (!ud.man || ud.man.key !== sta.key) ud.man = null, ud.station = sta;
  }
}
// показанное место: по манёвру (у пункта) или догоняет цель как машина (поворот по дуге, плавная скорость)
function followTrucks(dt) {
  for (const o of machineList) {
    const id = o.userData.thingId;
    if (id.indexOf(':truck-') < 0) continue;
    const ud = o.userData, tx = o.position.x, tz = o.position.z;
    let f = ud.follow;
    if (!f || (!ud.man && !ud.station && Math.hypot(tx - f.x, tz - f.z) > FOLLOW.snap)) f = ud.follow = { x: tx, z: tz, yaw: o.rotation.y, v: 0, px: tx, pz: tz, vx: 0, vz: 0 };
    if (dt > 0 && isFinite(tx) && isFinite(tz)) {   // скорость цели (сглаженная) — упреждение при погоне
      const k = 1 - Math.exp(-dt / 0.3);
      f.vx += ((tx - f.px) / dt - f.vx) * k; f.vz += ((tz - f.pz) / dt - f.vz) * k;
      if (!isFinite(f.vx) || !isFinite(f.vz)) f.vx = f.vz = 0;
    }
    f.px = tx; f.pz = tz;
    if (ud.station) { if (!ud.man || ud.man.key !== ud.station.key) ud.man = buildManeuver(f, ud.station); ud.station = null; }
    if (ud.man && !ud.man.done && (ud.man.i >= ud.man.n0 || !stationBusy(o, ud.man))) stepManeuver(f, ud.man, dt);
    else if (ud.man && !ud.man.done) f.v = 0;   // место у пункта ещё не освободилось — ждёт, не начиная разворот
    else if (ud.man && ud.man.done) { f.x = ud.man.S[0]; f.z = -ud.man.S[1]; f.yaw = ud.man.yaw; f.v = 0; }
    else chase(f, tx, tz, dt, o);
    o.position.x = f.x; o.position.z = f.z; o.rotation.y = f.yaw;
    // кузов: поднимается назад, только когда самосвал встал задом к краю; опускается плавно
    const want = val(id, 'state', '') === 'dumping' && ud.man && ud.man.done ? 1 : 0;
    ud.bed = Math.max(0, Math.min(1, (ud.bed || 0) + Math.sign(want - (ud.bed || 0)) * dt / (want ? 0.9 : 0.6)));
    if (typeof o.setDumping === 'function') o.setDumping(ud.bed);
  }
}
function stepManeuver(f, m, dt) {
  // скорость по трассе — только пока корпус смотрит по ней (вперёд или, на участке задним ходом, кормой): если трасса
  // уходит в сторону больше чем на 90°, самосвал сначала доворачивает на месте, а не едет боком или задом
  const nb = m.pts[Math.min(m.i + 1, m.pts.length - 1)], align = Math.cos(wrapA(nb.yaw - f.yaw));
  let left = dt * Math.max(0, align);
  while (left > 0 && m.i < m.pts.length - 1) {
    const a = m.pts[m.i], b = m.pts[m.i + 1], v = b.rev ? MAN.back : MAN.fwd, seg = Math.hypot(b.x - a.x, b.y - a.y);
    const need = (seg - m.s) / v;
    if (need > left) { m.s += v * left; left = 0; } else { left -= need; m.i++; m.s = 0; }
  }
  const a = m.pts[m.i], b = m.pts[Math.min(m.i + 1, m.pts.length - 1)], seg = Math.hypot(b.x - a.x, b.y - a.y);
  const t = seg > 0 ? Math.min(1, m.s / seg) : 1;
  f.x = a.x + (b.x - a.x) * t; f.z = -(a.y + (b.y - a.y) * t);
  const w = Math.max(b.rev ? MAN.back : MAN.fwd, 6) / MAN.r;   // курс — по трассе, поворот не круче радиуса манёвра
  f.yaw = wrapA(f.yaw + Math.max(-w * dt, Math.min(w * dt, wrapA(b.yaw - f.yaw))));
  f.v = 0;
  if (m.i >= m.pts.length - 1) { m.done = true; m.at = performance.now(); f.yaw = m.yaw; }
}
function chase(f, tx, tz, dt, self) {
  if (!isFinite(f.x) || !isFinite(f.z) || !isFinite(f.yaw)) { f.x = tx; f.z = tz; f.yaw = 0; f.v = 0; f.vx = f.vz = 0; }
  const dx = tx - f.x, dz = tz - f.z, d = Math.hypot(dx, dz), tsp = Math.hypot(f.vx, f.vz);
  if (d < 0.4 && (tsp < 1 || d < 1e-6)) { f.x = tx; f.z = tz; f.v = 0; return; }   // стоит на месте цели, курс — как подъехал
  const err = wrapA(Math.atan2(dx, dz) - f.yaw);
  if (Math.abs(err) > Math.PI / 2 && d < 3) {   // цель чуть позади (место сдвинулось назад): подтянуться, не разворачиваясь
    const step = Math.min(d, 2 * dt);
    f.x += dx / d * step; f.z += dz / d * step; f.v = 0; return;
  }
  let vt = Math.min(FOLLOW.vMax, tsp + 2.5 * d * Math.max(0, Math.cos(err)));
  if (Math.abs(err) > 0.5) vt = Math.min(vt, Math.max(14, tsp * 0.6));   // большой угол — разворот по дуге, тише
  f.v += Math.max(-FOLLOW.dec * dt, Math.min(FOLLOW.acc * dt, vt - f.v));
  const w = Math.max(f.v, 5) / FOLLOW.rMin;
  f.yaw = wrapA(f.yaw + Math.max(-w * dt, Math.min(w * dt, err)));
  const step = clearAhead(self, f, Math.min(f.v * dt, d + tsp * dt));
  if (step < f.v * dt * 0.5) f.v = step / Math.max(dt, 1e-3);   // впереди машина — тормозит, потом догоняет цель
  f.x += Math.sin(f.yaw) * step; f.z += Math.cos(f.yaw) * step;
}
// Впереди по ходу едет другой самосвал (попутный или пересекающий путь; встречные расходятся по полосам): ближе
// зазора не подъезжать. Если двое мешают друг другу (перекрёсток) — уступает тот, у кого номер больше
function inLane(f, hl, hw, g, ohl, ohw) {
  const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw), dx = g.x - f.x, dz = g.z - f.z;
  const along = dx * fx + dz * fz, lat = Math.abs(-dx * fz + dz * fx);
  const dy = wrapA(g.yaw - f.yaw), c = Math.abs(Math.cos(dy)), sn = Math.abs(Math.sin(dy));
  if (along <= 0 || lat > hw + ohl * sn + ohw * c + 0.5) return null;
  return along - hl - (ohl * c + ohw * sn) - 3;   // свободно до его корпуса с зазором
}
function clearAhead(self, f, step) {
  const half = (o) => { const s = o.scale.x || 1, z = o.userData.size || {}; return [(z.length || 13) * s / 2, (z.width || 8) * s / 2]; };
  const [hl, hw] = half(self), me = self.userData.thingId;
  let lim = step;
  for (const o of machineList) {
    const id = o.userData.thingId, g = o.userData.follow;
    if (o === self || id.indexOf(':truck-') < 0 || !g || Math.abs(g.x - f.x) > 60 || Math.abs(g.z - f.z) > 60) continue;
    if (Math.abs(wrapA(g.yaw - f.yaw)) > 2.4 || (g.v < 1 && Math.hypot(g.vx, g.vz) < 1)) continue;   // встречный или стоит
    const [ohl, ohw] = half(o), free = inLane(f, hl, hw, g, ohl, ohw);
    if (free === null || free > step) continue;
    if (inLane(g, ohl, ohw, f, hl, hw) !== null && me < id) continue;   // мешают друг другу — едет тот, у кого номер меньше
    lim = Math.min(lim, Math.max(0, free));
  }
  return lim;
}
// Экскаватор стоит лицом к своему развалу; когда самосвал встал под погрузку — цикл ковша: зачерпнуть в развале,
// поднять, повернуть к кузову, высыпать, вернуться (≈ 3,5 с — цикл модели при ×10). Без погрузки — ковш поднят над землёй
const heapCache = {};
function animateExcavators(dt) {
  if (!heapCache.at || performance.now() - heapCache.at > 5000) {
    heapCache.at = performance.now(); heapCache.byFace = {};
    scene.traverse((h) => { if (h.name === 'muckpile' && h.userData.face) heapCache.byFace[h.userData.face] = h; });
  }
  const inPlace = {};
  for (const o of machineList) {
    const m = o.userData.man;
    if (m && m.done && m.ex && val(o.userData.thingId, 'state', '') === 'loading') inPlace[m.ex] = m.S;
  }
  for (const o of machineList) {
    const id = o.userData.thingId;
    if (id.indexOf(':excavator-') < 0 || typeof o.setSwing !== 'function') continue;
    const ex = id.split(':')[1], heap = heapCache.byFace['face-' + ex.slice(-2)], ud = o.userData;
    if (heap) o.rotation.y = Math.atan2(heap.position.x - o.position.x, heap.position.z - o.position.z);
    const S = inPlace[ex];
    if (!S || val(id, 'state', '') !== 'loading') { ud.dig = 0; o.setSwing(0); o.setBoom(0.55); continue; }
    const toTruck = wrapA(Math.atan2(S[0] - o.position.x, -S[1] - o.position.z) - o.rotation.y);
    ud.dig = ((ud.dig || 0) + dt / 3.5) % 1;
    const p = ud.dig, ease = (t) => t * t * (3 - 2 * t);
    let sw, bm;
    if (p < 0.3) { sw = 0; bm = 0.12 * ease(p / 0.3); }                            // зачерпывает в развале
    else if (p < 0.55) { const t = ease((p - 0.3) / 0.25); sw = toTruck * t; bm = 0.12 + 0.88 * t; }   // поднимает и поворачивает к кузову
    else if (p < 0.7) { sw = toTruck; bm = 1; }                                       // высыпает
    else { const t = ease((p - 0.7) / 0.3); sw = toTruck * (1 - t); bm = 1 - t; }    // возвращается к развалу
    o.setSwing(sw); o.setBoom(bm);
  }
}

// для проверок: где объект на экране (пиксели холста) — скрипты наводят мышь без перебора точек
// Здания крупнее для наглядности (в 1,6–2 раза; подпись в углу и «?» об этом говорят): каждое растёт от опорной точки —
// дробилка от места разгрузки самосвалов (воронка остаётся у их края), фабрика от восточного торца (там конец конвейера
// и склад), склад глины и заправка от своих подъездов, остальные — от центра. Мельница и флотация — точки на крыше
// главного корпуса: двигаются и растут вместе с ним. Проверка (?debug=1): __buildingConflicts() — пересечения нет.
const ENLARGE = [
  { ids: ['crusher-01'], k: 1.6, pivot: 'node:crusher' },
  { ids: ['plant-sulphide', 'sag-mill-01', 'flotation-01'], k: 1.6, pivot: [-1308, 470] },
  { ids: ['plant-clay'], k: 1.6, pivot: [-231, 484] },   // от северо-западного угла: к северу и западу — дороги и стоянка
  { ids: ['stockpile-coarse'], k: 1.6, pivot: null },
  { ids: ['stockpile-clay'], k: 1.6, pivot: 'node:stockpile-clay' },
  { ids: ['power-grid'], k: 1.8, pivot: null },
  { ids: ['fuel'], k: 1.6, pivot: [-259.6, 395.1], shift: [4, -7] },   // растёт на север (к югу — стоянка, к западу — дорога)
];
function enlargeTarget(id) { return id === 'fuel' ? fuelStationObj : buildingRoot(NS + ':' + id); }
function enlargeBuildings() {
  for (const e of ENLARGE) {
    let pv = null;
    if (typeof e.pivot === 'string') { const n = dio && dio.D.nodes[e.pivot.slice(5)]; if (n) { const v = dio.s(n[0], n[1], 0); pv = [v.x, v.z]; } }
    else if (e.pivot) pv = e.pivot;
    for (const id of e.ids) {
      const o = enlargeTarget(id);
      if (!o || o.userData.enlarged) continue;
      o.userData.enlarged = e.k;
      o.userData.box0 = new THREE.Box3().setFromObject(o);   // габарит до увеличения — для проверки «новых» пересечений
      o.scale.multiplyScalar(e.k);
      if (pv) { o.position.x = pv[0] + (o.position.x - pv[0]) * e.k; o.position.z = pv[1] + (o.position.z - pv[1]) * e.k; }
      if (e.shift) { o.position.x += e.shift[0]; o.position.z += e.shift[1]; }
    }
  }
}
// Кусты, ковыль и камни степи не стоят под увеличенными зданиями и на ж/д ветке (здания растут после сборки степи)
function clearUnderBuildings() {
  const boxes = [];
  for (const e of ENLARGE) for (const id of e.ids) { const o = enlargeTarget(id); if (o) boxes.push(new THREE.Box3().setFromObject(o).expandByScalar(8)); }
  const rail = scene.getObjectByName('rail-siding'); if (rail) boxes.push(new THREE.Box3().setFromObject(rail).expandByScalar(6));
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const name of ['steppe-bushes', 'steppe-grass', 'rocks']) {
    const inst = scene.getObjectByName(name); if (!inst) continue;
    let n = 0;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m); p.setFromMatrixPosition(m);
      if (boxes.some((b) => p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z)) { inst.setMatrixAt(i, zero); n++; }
    }
    if (n) inst.instanceMatrix.needsUpdate = true;
  }
}
// для проверок: пересечения увеличенных зданий с дорогами, конвейером, стоянкой, прудом, карьером и друг с другом
dbgWin.__buildingConflicts = () => {
  const out = [], boxes = {}, box = new THREE.Box3();
  for (const e of ENLARGE) for (const id of e.ids) {
    if (/^(sag-mill|flotation)/.test(id)) continue;
    const o = enlargeTarget(id); if (!o) continue;
    box.setFromObject(o); const b0 = o.userData.box0 || box;
    boxes[id] = { x0: box.min.x + 2, x1: box.max.x - 2, z0: box.min.z + 2, z1: box.max.z - 2,
      old: { x0: b0.min.x + 2, x1: b0.max.x - 2, z0: b0.min.z + 2, z1: b0.max.z - 2 } };
  }
  const inBox = (b, x, z, m) => x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m;
  const inside = (b, x, z, m = 0) => inBox(b, x, z, m) && !inBox(b.old, x, z, m);   // только новое: до увеличения там не было
  const own = { 'crusher-01': 'crusher', fuel: 'fuel-station', 'stockpile-clay': 'stockpile-clay' };
  // дороги: точки по трассам рёбер схемы (кроме конца у своего подъезда)
  for (const ed of dio.edges) {
    const pts = ed.path || [ed.sa, ed.sb];
    for (let i = 0; i + 1 < pts.length; i++) for (let t = 0; t < 1; t += 0.1) {
      const sx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, sy = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      const v = dio.s(sx, sy, 0);
      for (const [id, b] of Object.entries(boxes)) {
        if (!inside(b, v.x, v.z)) continue;
        const nd = own[id] && dio.D.nodes[own[id]];
        if (nd) { const nv = dio.s(nd[0], nd[1], 0); if (Math.hypot(v.x - nv.x, v.z - nv.z) < 26) continue; }
        out.push('дорога ' + ed.from + '>' + ed.to + ' в ' + id + ' (' + v.x.toFixed(0) + ', ' + v.z.toFixed(0) + ')');
      }
    }
  }
  // конвейер (кроме концов: начало у дробилки, конец над складом)
  const cv = (geometry.objects || []).find((o) => o.kind === 'conveyor');
  if (cv) {
    const P = cv.path.map((p) => toScene(p[0], p[1], 0));
    for (let i = 0; i + 1 < P.length; i++) for (let t = 0; t <= 1; t += 0.02) {
      const x = P[i].x + (P[i + 1].x - P[i].x) * t, z = P[i].z + (P[i + 1].z - P[i].z) * t;
      if (Math.hypot(x - P[0].x, z - P[0].z) < 20 || Math.hypot(x - P[P.length - 1].x, z - P[P.length - 1].z) < 40) continue;
      for (const [id, b] of Object.entries(boxes)) if (inside(b, x, z)) out.push('конвейер в ' + id + ' (' + x.toFixed(0) + ', ' + z.toFixed(0) + ')');
    }
  }
  // стоянка у заправки
  for (let k = 0; k < PARK_SLOTS.length; k++) {
    const sp = parkingSpot(k); if (!sp) continue;
    const v = dio.s(sp.S[0], sp.S[1], 0);
    for (const [id, b] of Object.entries(boxes)) if (inside(b, v.x, v.z, 6)) out.push('стоянка ' + k + ' в ' + id);
  }
  // пруд хвостохранилища и карьер (по углам и серединам сторон)
  const tl = dio.D.extra && dio.D.extra.tailings, pit = dio.pit;
  for (const [id, b] of Object.entries(boxes)) {
    for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) / 2, b.z0], [(b.x0 + b.x1) / 2, b.z1], [b.x0, (b.z0 + b.z1) / 2], [b.x1, (b.z0 + b.z1) / 2]]) {
      if (inBox(b.old, x, z, 0)) continue;
      const c = dio.s(0, 0, 0);
      if (tl) { const t0 = dio.s(tl.center[0], tl.center[1], 0), r0 = dio.s(tl.center[0] + tl.radii[0], tl.center[1] + tl.radii[1], 0);
        const rx = Math.abs(r0.x - t0.x), rz = Math.abs(r0.z - t0.z);
        if (((x - t0.x) / rx) ** 2 + ((z - t0.z) / rz) ** 2 < 1) out.push('пруд хвостохранилища у ' + id); }
      if (pit) { const p0 = dio.s(pit.cx, pit.cy, 0), pr = dio.s(pit.cx + pit.a, pit.cy + pit.b, 0);
        const ax = Math.abs(pr.x - p0.x), az = Math.abs(pr.z - p0.z);
        if (((x - p0.x) / ax) ** 2 + ((z - p0.z) / az) ** 2 < 1) out.push('карьер у ' + id); }
      void c;
    }
  }
  // здания друг с другом
  const ids = Object.keys(boxes);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = boxes[ids[i]], b = boxes[ids[j]];
    const ov = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
    if (ov(a, b) && !ov(a.old, b.old)) out.push('здания ' + ids[i] + ' и ' + ids[j]);
  }
  return [...new Set(out)];
};
dbgWin.__service = () => serviceList.map((S) => ({ id: S.sv.id, x: +S.o.position.x.toFixed(1), y: +S.o.position.y.toFixed(1), z: +S.o.position.z.toFixed(1), len: Math.round(S.len) }));
// для проверок производительности: скрыть объекты по имени (или префиксу*) и сменить тональное отображение
dbgWin.__hide = (names, on = false) => { let n = 0; scene.traverse((o) => { if (names.some((x) => x.endsWith('*') ? o.name.startsWith(x.slice(0, -1)) : o.name === x)) { o.visible = on; n++; } }); return n; };
dbgWin.__tone = (t) => { renderer.toneMapping = THREE[t]; scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); }); };
dbgWin.__parkSpots = () => PARK_SLOTS.map((_, k) => { const sp = parkingSpot(k); const v = sp && dio.s(sp.S[0], sp.S[1], 0); return v ? [Math.round(v.x), Math.round(v.z)] : null; });
// для проверок: габариты зданий в сцене (x/z) — подбор увеличения зданий
dbgWin.__buildingBoxes = () => {
  const out = {}, box = new THREE.Box3();
  for (const id of ['crusher-01', 'plant-sulphide', 'plant-clay', 'stockpile-coarse', 'stockpile-clay', 'power-grid', 'sag-mill-01', 'flotation-01']) {
    const o = buildingRoot(NS + ':' + id); if (!o) continue;
    box.setFromObject(o);
    out[id] = { x: [+box.min.x.toFixed(1), +box.max.x.toFixed(1)], z: [+box.min.z.toFixed(1), +box.max.z.toFixed(1)], y: +box.max.y.toFixed(1),
      pos: [+o.position.x.toFixed(1), +o.position.z.toFixed(1)], k: +o.scale.x.toFixed(2) };
  }
  if (fuelStationObj) { box.setFromObject(fuelStationObj); out.fuel = { x: [+box.min.x.toFixed(1), +box.max.x.toFixed(1)], z: [+box.min.z.toFixed(1), +box.max.z.toFixed(1)], pos: [+fuelStationObj.position.x.toFixed(1), +fuelStationObj.position.z.toFixed(1)] }; }
  return out;
};
dbgWin.__screenOf = (thingId) => {
  const o = byThing(thingId); if (!o) return null;
  o.getWorldPosition(_v); _v.y += 3; _v.project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (_v.x + 1) / 2 * r.width, y: r.top + (1 - _v.y) / 2 * r.height, visible: _v.z < 1 };
};
// для проверок: камера — поставить (точка и цель в сцене) и прочитать; кадр сцены — номер для покадровых сравнений
dbgWin.__camera = {
  set(px, py, pz, tx, ty, tz) { setPerspective(); tween = null; zoomGoal = null; stopOrbit(); followId = null;
    perspCam.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update(); markViewButton(''); },
  get() { const p = camera.position, t = controls.target; return { x: p.x, y: p.y, z: p.z, tx: t.x, ty: t.y, tz: t.z, frame: dbgWin.__sceneFrames || 0 }; },
  bounds: () => dio && dio.bounds, surfaceAt: (xs, ys) => (dio ? dio.surfaceAt(xs, ys) : 0),
};
// для проверок: места и курсы техники в сцене (после поправок)
dbgWin.__machineLayout = () => machineList.map((o) => ({ id: o.userData.thingId, x: o.position.x, y: o.position.y, z: o.position.z,
  yaw: o.rotation.y, s: o.scale.x, state: val(o.userData.thingId, 'state', '') }));

// для проверок: «земля одна для всех» — техника на поверхности, дороги не ниже рельефа, машины не налезают.
// Высота машины сравнивается с dio.surfaceAt под ней (у самосвалов — плюс полотно дороги); отрезки дорог —
// вершины лент полотна против поверхности под ними; наложения — самосвалы по габаритам с курсом и самосвал в экскаваторе
const _ray = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0);
dbgWin.__groundCheck = () => {
  // поверхность, как она нарисована: видимые сетки земли, карьера и полотна дорог (не формула)
  const surf = [];
  const roadSet = new Set(Object.values(roadMats));
  terrain.traverse((m) => { if (m.isMesh && (/^diorama-(ground|far|pit|ramp)$/.test(m.name) || roadSet.has(m.material))) {
    let p = m, vis = true; while (p) { if (!p.visible) vis = false; p = p.parent; } if (vis) surf.push(m); } });
  const drawnY = (x, z) => { _ray.set(new THREE.Vector3(x, 2000, z), _down); const h = _ray.intersectObjects(surf, false)[0]; return h ? h.point.y : NaN; };
  const machines = [];
  for (const o of machineList) {
    const want = dio.surfaceAt(o.position.x, -o.position.z) + (o.userData.thingId.indexOf(':truck-') >= 0 ? ROAD_LIFT : 0);
    // колёса: четыре угла корпуса — сколько ниже нарисованной поверхности (утонул) или выше (висит)
    const s = o.scale.x || 1, size = o.userData.size || {}, L = (size.length || 12) * s * 0.4, W = (size.width || 7) * s * 0.4;
    const fx = Math.sin(o.rotation.y), fz = Math.cos(o.rotation.y), lx = fz, lz = -fx;
    let sunk = 0, hang = Infinity;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = o.position.x + fx * L * a + lx * W * b, z = o.position.z + fz * L * a + lz * W * b;
      const g = drawnY(x, z); if (!isFinite(g)) continue;
      const wheelY = o.position.y - Math.sin(o.rotation.x) * L * a + Math.sin(o.rotation.z) * W * b;   // порядок поворотов YXZ
      sunk = Math.max(sunk, g - wheelY); hang = Math.min(hang, wheelY - g);
    }
    machines.push({ id: o.userData.thingId.split(':')[1], dy: +(o.position.y - want).toFixed(3), sunk: +sunk.toFixed(2), hang: +(isFinite(hang) ? hang : 0).toFixed(2) });
  }
  let roadVerts = 0, roadBelow = 0, roadWorst = 0;
  for (const meshes of Object.values(roadMeshes)) for (const m of meshes) {
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const below = dio.surfaceAt(p.getX(i), -p.getZ(i)) - p.getY(i);
      roadVerts++; if (below > 0.5) roadBelow++; roadWorst = Math.max(roadWorst, below);
    }
  }
  const trucks = machineList.filter((o) => o.userData.thingId.indexOf(':truck-') >= 0);
  const ex = machineList.filter((o) => o.userData.thingId.indexOf(':excavator-') >= 0);
  const overlaps = [];
  for (let i = 0; i < trucks.length; i++) for (let j = i + 1; j < trucks.length; j++) {
    if (boxesOverlap(truckBox(trucks[i]), truckBox(trucks[j]))) overlaps.push(trucks[i].userData.thingId.split(':')[1] + '×' + trucks[j].userData.thingId.split(':')[1]);
  }
  for (const t of trucks) for (const e of ex) {
    if (Math.hypot(t.position.x - e.position.x, t.position.z - e.position.z) < 18) overlaps.push(t.userData.thingId.split(':')[1] + '×' + e.userData.thingId.split(':')[1]);
  }
  const worst = machines.reduce((w, m) => (Math.abs(m.dy) > Math.abs(w.dy) ? m : w), { id: '—', dy: 0 });
  const sunkList = machines.filter((m) => m.sunk > 1).map((m) => m.id + ' ' + m.sunk);
  const hangList = machines.filter((m) => m.hang > 1.5).map((m) => m.id + ' ' + m.hang);
  return { machines: machines.length, offGround: machines.filter((m) => Math.abs(m.dy) > 0.5).length, worst, sunkList, hangList,
    roadVerts, roadBelow, roadWorst: +roadWorst.toFixed(3), overlaps };
};

// для проверки движения (core/tools/motion_check): не реже чем раз в 100 мс — место, курс и наклон каждой машины,
// как она нарисована (после всех поправок сцены), колёса относительно поверхности, нижняя точка ковша экскаватора;
// раз в 5 с — контуры развалов. Скрипт забирает накопленное порциями (take)
const motionLog = { on: false, every: 100, last: 0, rows: [], pilesAt: -1e9 };
const _mb = new THREE.Box3(), _mk = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _mv = new THREE.Vector3();
function muckPiles() {   // развал — прямоугольник в плане по видимым кускам насыпи (в осях насыпи)
  const out = [];
  scene.traverse((o) => {
    if (o.name !== 'muckpile' || !o.visible) return;
    o.updateWorldMatrix(true, true);
    _mi.copy(o.matrixWorld).invert();
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    o.traverse((m) => {
      if (!m.isMesh || !m.geometry) return;
      for (let p = m; p && p !== o; p = p.parent) if (!p.visible) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _mb.copy(m.geometry.boundingBox).applyMatrix4(_mk.multiplyMatrices(_mi, m.matrixWorld));
      x0 = Math.min(x0, _mb.min.x); x1 = Math.max(x1, _mb.max.x); z0 = Math.min(z0, _mb.min.z); z1 = Math.max(z1, _mb.max.z);
    });
    if (!isFinite(x0)) return;
    out.push({ face: o.userData.face || '', corners: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => {
      _mv.set(x, 0, z).applyMatrix4(o.matrixWorld); return [+_mv.x.toFixed(2), +_mv.z.toFixed(2)]; }) });
  });
  return out;
}
function sampleMotion(now) {
  if (now - motionLog.last < motionLog.every) return;
  motionLog.last = now;
  const ms = [];
  for (const o of machineList) {
    const id = o.userData.thingId, s = o.scale.x || 1, size = o.userData.size || {};
    const L = (size.length || 12) * s / 2, W = (size.width || 7) * s / 2, truck = id.indexOf(':truck-') >= 0;
    const yaw = o.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {   // колёса (углы корпуса): над (+) или под (−) поверхностью
      const x = o.position.x + fx * L * a + lx * W * b, z = o.position.z + fz * L * a + lz * W * b;
      const wy = o.position.y - Math.sin(o.rotation.x) * L * a + Math.sin(o.rotation.z) * W * b;
      const d = wy - (dio.surfaceAt(x, -z) + (truck ? ROAD_LIFT : 0));
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    const r = o.userData.rawPos || o.position;
    const row = [id.split(':')[1], +o.position.x.toFixed(2), +o.position.y.toFixed(2), +o.position.z.toFixed(2), +yaw.toFixed(4),
      +L.toFixed(2), +W.toFixed(2), val(id, 'state', ''), +lo.toFixed(2), +hi.toFixed(2), +r.x.toFixed(2), +r.z.toFixed(2)];
    if (truck) row.push(Number(val(id, 'speed', 0)) || 0, val(id, 'excavator', ''), val(id, 'destination', ''), Number(val(id, 'x', 0)), Number(val(id, 'y', 0)));
    const bk = o.userData.parts && o.userData.parts.bucketPivot;
    if (bk) {   // ковш: нижняя точка и поверхность под ним
      _mb.setFromObject(bk);
      const bx = (_mb.min.x + _mb.max.x) / 2, bz = (_mb.min.z + _mb.max.z) / 2;
      row.push(+_mb.min.y.toFixed(2), +bx.toFixed(2), +bz.toFixed(2), +dio.surfaceAt(bx, -bz).toFixed(2));
    }
    ms.push(row);
  }
  for (const S of serviceList) {   // служебные машины: те же поля, состояние «service»
    const o = S.o, L = o.userData.size.length * o.scale.x / 2, W = o.userData.size.width * o.scale.x / 2;
    const yaw = o.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = o.position.x + fx * L * a + lx * W * b, z = o.position.z + fz * L * a + lz * W * b;
      const d = o.position.y - Math.sin(o.rotation.x) * L * a + Math.sin(o.rotation.z) * W * b - dio.surfaceAt(x, -z);
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    ms.push([S.sv.id, +o.position.x.toFixed(2), +o.position.y.toFixed(2), +o.position.z.toFixed(2), +yaw.toFixed(4),
      +L.toFixed(2), +W.toFixed(2), 'service', +lo.toFixed(2), +hi.toFixed(2), +o.position.x.toFixed(2), +o.position.z.toFixed(2)]);
  }
  const rec = { t: +now.toFixed(1), f: frameNo, sim: val(NS + ':mine', 'sim_time', ''), m: ms };
  if (now - motionLog.pilesAt > 5000) { motionLog.pilesAt = now; rec.piles = muckPiles(); }
  motionLog.rows.push(rec);
}
dbgWin.__motion = {
  start(every = 100) { motionLog.every = every; motionLog.rows = []; motionLog.last = 0; motionLog.pilesAt = -1e9; motionLog.on = true; },
  stop() { motionLog.on = false; },
  take() { const r = motionLog.rows; motionLog.rows = []; return r; },
  // места для итога по местам: узлы и объекты схемы, трассы съездов (единицы схемы; x — восток, y — север)
  meta: () => ({
    nodes: dio.D.nodes,
    objects: Object.fromEntries(Object.entries(dio.D.objects).filter(([, v]) => v.position).map(([k, v]) => [k, v.position])),
    ramps: dio.edges.filter((e) => /^road-ramp-/.test(e.road)).map((e) => ({ road: e.road, pts: e.path ? e.path.map((p) => [p[0], p[1]]) : [e.sa.slice(0, 2), e.sb.slice(0, 2)] })),
    roads: dio.edges.map((e) => ({ road: e.road, from: e.from, to: e.to, pts: e.path ? e.path.map((p) => [p[0], p[1]]) : [e.sa.slice(0, 2), e.sb.slice(0, 2)] })),
  }),
};

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
    d = Math.max(mp().cam.min * 2.5, len * 2.8);
  } else {                     // здания и площадки — по габаритам, снаружи (≈ 135 м и дальше)
    // клик мог попасть в точку подписи (пустой Object3D внутри модели здания) — габариты берём у модели
    let box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty() && obj.parent && obj.parent !== scene) box = new THREE.Box3().setFromObject(obj.parent);
    if (!box.isEmpty() && box.getSize(new THREE.Vector3()).length() > 2000) box.makeEmpty();   // не весь слой
    const sz = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    d = Math.max(90, Math.max(sz.x, sz.z) * 1.2);
    if (!box.isEmpty()) box.getCenter(_v);
  }
  const to = _v.clone().add(new THREE.Vector3(-d * 0.75, d * 0.45, d * 0.8));
  // облёт идёт по кругу на этой высоте: она должна быть выше борта во все стороны от объекта
  let top = -Infinity;
  for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, r = Math.hypot(d * 0.75, d * 0.8);
    top = Math.max(top, dio.surfaceAt(_v.x + Math.cos(a) * r, -(_v.z + Math.sin(a) * r))); }
  to.y = Math.max(to.y, top + 10);
  flyTo(to, _v.clone());
  orbitId = id; controls.autoRotate = true; controls.autoRotateSpeed = 1.2;
  markViewButton('');
  openCard(id);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopOrbit(); });
canvas.addEventListener('pointerdown', () => { if (orbitId) controls.autoRotate = false; });

// ---------------------------------------------------------------- «Фото местности»: окно со снимком Sentinel-2
// Реальный Бозшаколь — снимок data/terrain/texture.jpg (квадрат 6 × 6 км в координатах рудника, 10 м/пиксель).
// Подписи — места объектов модели (geometry.json); окно закрывается крестиком и Esc, сцена от него не зависит.
const PHOTO_LABELS = [
  ['Карьер', 0, 0], ['Дробилка', -250, -575], ['Сульфидная фабрика', -2700, -760], ['Глинистая фабрика', -300, -1060],
  ['Отвал', 2200, -1100], ['Хвостохранилище (за краем снимка)', -2900, 2650],
];
function initPhoto() {
  const box = document.getElementById('photo'), btn = document.getElementById('btn-photo');
  if (!box || !btn) return;
  const img = document.getElementById('photo-img'), marks = document.getElementById('photo-marks');
  const half = (terrainApi && terrainApi.meta && terrainApi.meta.half_m) || 3000;
  if (!marks.childElementCount) for (const [text, x, y] of PHOTO_LABELS) {
    const el = document.createElement('div'); el.className = 'photo-mark';
    // у края снимка подпись сдвигается внутрь, чтобы не обрезалась
    el.style.left = Math.min(91, Math.max(9, (x + half) / (2 * half) * 100)).toFixed(2) + '%';
    el.style.top = Math.min(95, Math.max(5, (half - y) / (2 * half) * 100)).toFixed(2) + '%';
    el.textContent = text; marks.appendChild(el);
  }
  const attr = document.getElementById('photo-attr');
  if (terrainApi && terrainApi.meta) {
    const src = terrainApi.meta.sources;
    attr.textContent = src.image.attribution + ' (' + src.image.name + ', ' + terrainApi.meta.texture.date + ', 10 м/пиксель). ' +
      'Рельеф для высот модели: ' + src.dem.name + ', ' + src.dem.attribution + '.';
  }
  const close = () => show(false);
  const show = (on) => {
    box.hidden = !on; btn.classList.toggle('active', on); windowShown(close, on);
    if (on && !img.src) img.src = './terrain/' + ((terrainApi && terrainApi.meta && terrainApi.meta.texture.file) || 'texture.jpg');
  };
  btn.addEventListener('click', () => { show(box.hidden); btn.blur(); });
  document.getElementById('photo-close').addEventListener('click', () => show(false));
  box.addEventListener('click', (e) => { if (e.target === box) show(false); });
}

// ---------------------------------------------------------------- путеводитель «Как посмотреть двойник»
// При первом открытии показывается окно; закрывается; кнопка «Как посмотреть» в углу открывает снова.
function initGuide() {
  const box = document.getElementById('guide'), open = document.getElementById('guide-open');
  if (!box) return;
  const close = () => show(false);
  const show = (on) => { box.hidden = !on; windowShown(close, on); };
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
    dio = await loadDiorama(THREE, geometry, terrainApi);
    buildWorld();
    initPhoto();
    initKeys();
    initQuality();
    initLighting();
    initReality();
  } catch (e) { status.textContent = 'ошибка загрузки схемы'; console.error('geometry.json / diorama.json', e); return; }
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
  enlargeBuildings();
  clearUnderBuildings();
  buildServiceVehicles();
  renderPanel();          // значки сценариев — после регистрации объектов слоями
  updateFollowButton();
  markViewButton('all');
  status.textContent = '';
  initGuide();
  requestAnimationFrame(frame);
})();
