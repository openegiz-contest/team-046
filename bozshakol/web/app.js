// Общая 3D-сцена карьера Бозшаколь: степь, карьер, дороги, панель диспетчера, журнал событий,
// карточка двойника, связь с Ditto и загрузка слоёв модулей (layers/*.js).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { loadTerrain } from './terrain.js';
import { initKeyboard } from './controls.js';
import { buildPit as buildPitModel } from './pit.js';
import { buildEnvironment } from './environment.js';
import { createModels } from './models.js';

// ---------------------------------------------------------------- палитра
const colors = {
  sulphide: 0x3d8f6e, clay: 0xc8722a, waste: 0x8a8a8a, empty: 0xffffff, down: 0xd32f2f,
  steppe: 0xe6d9a8,
  bench: [0xdcc08e, 0xcfae78],            // бермы (площадки) — два чередующихся светлых тона
  wall: [0x8f6a44, 0x7f5c3a],             // стенки уступов — заметно темнее берм
  benchLine: 0x4a3418, floor: 0xa8a27e,   // контуры кромок; дно карьера — серо-оливковое
  road: 0xb9ad94, ramp: 0xd9cfae, roadEdge: 0x4a3f2e, roadClosed: 0xd32f2f,
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

const toScene = (x, y, z) => new THREE.Vector3(x, z * VZ, -y);
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
renderer.shadowMap.enabled = false;
const scene = new THREE.Scene();
const SKY = 0xdde8f0;
scene.background = new THREE.Color(SKY);   // до загрузки окружения (environment.js ставит небо и туман)
let environment = null;      // небо, туман, хвостохранилище, ЛЭП, ограждение, мачты (environment.js)
let terrainGround = null;    // группа земли (terrain.js), у неё setImagery(on)

const perspCam = new THREE.PerspectiveCamera(50, 1, 2, 30000);
perspCam.position.copy(toScene(0, -5200, 2800));
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
orthoCam.position.set(0, 3000, -1200);
orthoCam.up.set(0, 0, -1);           // север — вверх экрана
orthoCam.lookAt(0, 0, -1200);
let camera = perspCam;

const controls = new OrbitControls(perspCam, canvas);
controls.target.copy(toScene(0, 1500, 0));
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 60;
controls.maxDistance = 14000;
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

scene.add(new THREE.HemisphereLight(0xffffff, 0xcdbd93, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-2500, 2600, 1800);   // низкое солнце с юго-запада: стенки уступов дают разный тон
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
const LABEL_DIST = { 2: 3500, 1: 700 };   // м от камеры, ближе которых показываются подписи важности 2 и 1
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
  const orthoDist = 3000 / orthoCam.zoom;
  camera.getWorldPosition(_c);
  const cand = [];
  for (const L of labels) {
    L.show = false;
    if (!L.enabled || !L.obj.visible || !L.obj.parent) continue;
    L.obj.getWorldPosition(_v); _v.y += L.dy;
    const dist = ortho ? orthoDist : _c.distanceTo(_v);
    const id = thingOf(L.obj);
    const focused = id && (id === openedThing || id === hoverThing);
    let imp = L.importance;
    if (focused) imp = 4;
    if (imp < 3 && dist > (LABEL_DIST[Math.max(1, Math.min(2, Math.round(imp)))] || 2600)) continue;
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
  for (const o of clickable) {
    if (!o.visible || !o.parent || !o.userData.hitRadius) continue;
    o.getWorldPosition(_v);
    const rad = o.userData.hitRadius * markerScale;
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
  if (environment) environment.setBlizzard(blizzard);   // метель: туман сгущается, небо серое
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

function renderPanel() {
  renderDispatcher();
  renderScenarios();
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
  closed: new THREE.MeshLambertMaterial({ color: colors.roadClosed }),
};
// Высота узла дороги в сцене: Z узлов geometry.json уже абсолютные — наземные узлы получают
// высоту рельефа в core/tools/make_geometry.py (их читает и модуль транспорта), ничего не добавляем
function nodePos(n) {
  return toScene(n[0], n[1], n[2] + 1.5);
}
function buildRoads() {
  const ramps = {};   // road -> [точки] для подписи (середина съезда)
  for (const e of geometry.edges) {
    const a = geometry.nodes[e.from], b = geometry.nodes[e.to];
    if (!a || !b) continue;
    const isRamp = /^road-ramp/.test(e.road);
    const pa = nodePos(a), pb = nodePos(b);
    const len = pa.distanceTo(pb);
    const width = isRamp ? 40 : 24;
    const m = new THREE.Mesh(new THREE.BoxGeometry(width, 1.2, len + width), isRamp ? roadMats.ramp : roadMats.open);
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.lookAt(pb);                       // ось Z коробки — вдоль ребра
    m.userData.road = e.road;
    terrain.add(m);
    (roadMeshes[e.road] || (roadMeshes[e.road] = [])).push(m);
    if (isRamp) {
      // тонкая тёмная обводка: чуть шире и чуть ниже самого полотна
      const edge = new THREE.Mesh(new THREE.BoxGeometry(width + 8, 0.8, len + width + 8), roadMats.edge);
      edge.position.copy(m.position); edge.position.y -= 0.5; edge.quaternion.copy(m.quaternion);
      terrain.add(edge);
      (ramps[e.road] || (ramps[e.road] = [])).push(pa, pb);
    }
  }
  for (const [rid, pts] of Object.entries(ramps)) {
    const mid = pts[Math.floor(pts.length / 2)].clone(); mid.y += 2;
    const anchor = new THREE.Object3D(); anchor.position.copy(mid); terrain.add(anchor);
    for (const m of roadMeshes[rid]) m.userData.thingId = NS + ':' + rid;   // клик по полотну — карточка дороги
    register(anchor, NS + ':' + rid, { hitRadius: 0 });
    clickable.push(...roadMeshes[rid]);
    const info = (geometry.roads && geometry.roads[rid]) || {};
    addLabel(anchor, info.name || rid, { importance: 3, dy: 10 });
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
  all: { target: [-300, -500, 0], pos: [-300, -6200, 3400] },
  pit: { target: [0, 0, -80], pos: [300, -2600, 1300] },
  crusher: { target: [-1200, -560, 0], pos: [-1200, -2300, 900] },
  plants: { target: [-2550, -800, 10], pos: [-2550, -2100, 900] },
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
// Переход к виду по имени (кнопки сверху и клавиши 1–5)
function setView(name) {
  if (name !== 'top' && !VIEWS[name]) return;
  followId = null; updateFollowButton();
  if (name === 'top') {
    camera = orthoCam; controls.enabled = false; topControls.enabled = true; tween = null;
  } else {
    const v = VIEWS[name];
    flyTo(toScene(...v.pos), toScene(...v.target));
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
  flyTo(_v.clone().add(new THREE.Vector3(-160, 110, 160)), _v.clone());
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
    if (obj && obj.visible) {
      obj.getWorldPosition(_v);
      _d.subVectors(_v, controls.target).multiplyScalar(Math.min(1, dt * 4));   // камера догоняет плавно
      controls.target.add(_d); perspCam.position.add(_d);
    }
  }
  (camera === perspCam ? controls : topControls).update();
  // масштаб значков: 1 вблизи (< 1,5 км до центра сцены), линейно до 4 на 8 км
  const dist = camera === orthoCam ? 3000 / orthoCam.zoom : perspCam.position.distanceTo(controls.target);
  markerScale = Math.max(1, Math.min(4, 1 + (dist - 1500) / (8000 - 1500) * 3));
}

// ---------------------------------------------------------------- слои
async function loadLayers() {
  for (const name of ['haulage', 'geology', 'processing']) {
    const group = new THREE.Group(); group.name = 'layer-' + name; scene.add(group);
    const ctx = {
      THREE, scene, group, geometry, toScene, register, colors, dt: 0, camera, label: addLabel,
      markerScale, hover: null, selected: null, heightAt: terrainApi.heightAt, groundAt: terrainApi.groundAt,
      models: modelsLib, verticalScale: VZ,
    };
    try {
      const mod = await import('./layers/' + name + '.js');
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
    groundAt: (x, y) => terrainApi.heightAt(x, y),
    toScene,
    bounds: { minX: -area, maxX: area, minY: -area, maxY: area },
  });
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
  for (const L of layers) {
    L.ctx.dt = dt; L.ctx.camera = camera; L.ctx.markerScale = markerScale;
    L.ctx.hover = hoverThing; L.ctx.selected = openedThing;
    try { if (typeof L.mod.update === 'function') L.mod.update(L.ctx, twins); }
    catch (e) { if (L.errors++ % 300 === 0) console.error('Слой ' + L.name + ': ошибка в update', e); }
  }
  renderer.render(scene, camera);
  window.__sceneFrames = (window.__sceneFrames || 0) + 1;   // счётчик кадров для замера производительности
  window.__renderInfo = renderer.info.render;
  updateLabels();
}

// ---------------------------------------------------------------- переключатель «Снимок» и подписи источников
function updateAttribution() {
  const a = document.getElementById('attribution');
  if (!terrainApi || !terrainApi.attribution) { a.hidden = true; return; }
  const on = terrainGround && terrainGround.imageryEnabled && terrainGround.imageryEnabled();
  a.textContent = terrainApi.attribution.dem + (on ? ' ' + terrainApi.attribution.image : '');
  a.hidden = !a.textContent;
}
function initImagery() {
  const box = document.getElementById('imagery-toggle');
  if (box) {
    box.checked = false;
    box.addEventListener('change', () => { if (terrainGround) terrainGround.setImagery(box.checked); updateAttribution(); });
  }
  updateAttribution();
}

// ---------------------------------------------------------------- запуск
(async function main() {
  const status = document.getElementById('load-status');
  try {
    const r = await fetch('/geometry.json'); if (!r.ok) throw new Error('HTTP ' + r.status);
    geometry = await r.json();
    terrainApi = await loadTerrain(THREE, geometry);
    modelsLib = createModels(THREE, colors);   // библиотека моделей для слоёв (ctx.models) и окружения
    terrainGround = terrainApi.buildGround(terrain, { toScene });
    buildPit(); buildRoads();
    environment = buildEnvironment(THREE, geometry, terrainApi, toScene, scene, modelsLib);
    initImagery();
    initKeys();
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
  renderPanel();          // значки сценариев — после регистрации объектов слоями
  updateFollowButton();
  markViewButton('all');
  status.textContent = '';
  requestAnimationFrame(frame);
})();
