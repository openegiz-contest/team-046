// Проверка движения техники в 3D-сцене — числами, по тому, что видно в сцене (не по Ditto).
// Headless Chromium открывает сцену с ?debug=1 при работающем стенде и не реже 10 раз в секунду снимает место, курс и
// наклон каждой машины после всех поправок сцены (window.__motion в web/app.js), затем считает нарушения правил движения
// и сводит их по местам: забои 01–06, дробилка, склад глинистой руды, отвал, заправка, съезды 1 и 2, остальные дороги.
//
//   node motion_check.mjs measure [минут=10] [папка=.]     замер: samples.jsonl, meta.json, summary.json, summary.txt
//   node motion_check.mjs analyze <папка>                   пересчитать итог по уже снятому замеру
//   node motion_check.mjs holes <папка>                     только дыры в рельефе (holes.json), без замера движения
//   node motion_check.mjs video <points.json> <папка> [с=45] ролики с заранее заданных точек камеры (*.webm)
//
// Переменные: URL (по умолчанию http://localhost:8095/), CHROME — путь к Chromium (иначе — из Playwright),
// PLAYWRIGHT_CORE — папка пакета playwright-core, если его нет рядом со скриптом, FFMPEG — ffmpeg для роликов.
//
// Что считается (скорости и время — модельные, с пересчётом по ускорению стенда; 1 единица схемы = 2 м местности):
//   телепорт      — шаг между замерами больше 1,5 × наибольшая скорость (50 км/ч) × время между замерами;
//   наезд         — пересечение контуров (прямоугольники по габаритам модели с курсом): самосвал—самосвал,
//                   самосвал—экскаватор, самосвал—буровой, самосвал—развал;
//   езда задом    — движение против курса быстрее 0,5 м/с вне подъезда под погрузку, к месту разгрузки и на место
//                   стоянки у заправки (последние 40 м, не быстрее 2 м/с);
//   резкий поворот — курс меняется больше чем на 45° меньше чем за 1 модельную секунду на скорости больше 2 м/с
//                   (машина так повернуть не может); для сведения — то же за 1 с реального времени;
//   колёса        — угол корпуса над или под поверхностью больше 0,5 м; ковш — ниже поверхности больше 0,5 м вне развала;
//   стоит без причины — самосвал не двигается больше 3 мин не в очереди, погрузке, разгрузке, заправке, резерве;
//   вне дороги    — центр самосвала не на полотне дороги (ось ± полуширина), не на площадке забоя, не на стоянке и
//                   не у места разгрузки или заправки;
//   наезд на неподвижное — контур самосвала пересекает стойку конвейера, опору ЛЭП, мачту освещения, «твёрдую» клетку
//                   здания (верх выше поверхности больше 2,5 единицы) или ленту конвейера ниже верха самосвала;
//   лишний разворот — за один заезд на разгрузку (дробилка, склад глинистой руды, отвал: ближе 70 единиц к месту)
//                   поворот корпуса больше чем на 150° в одну сторону случился больше одного раза;
//   круг          — на ровной дороге (перепад высоты меньше 4 единиц) без езды задом суммарный поворот корпуса
//                   больше 300° на 150 м пути;
//   дыры в рельефе — сквозные щели, через которые видно фон: сцена с фиолетовым фоном без тумана, фиолетовые пиксели,
//                   луч которых входит в карьер, — с ортокамер над карьером (каждый пиксель — луч сетки: сверху и под
//                   углом) и с 12 заранее заданных точек камеры у бровки; в «Обычном» и «Высоком» качестве (holes.json).
// Нарушение считается один раз на эпизод: подряд идущие замеры с тем же нарушением — один случай.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const URL0 = process.env.URL || 'http://localhost:8095/';
const K = 2;                       // м местности в единице схемы
const VMAX_KMH = 50;               // наибольшая скорость самосвала в модели (предел дорог), км/ч
const WAIT_STATES = new Set(['queued_load', 'loading', 'queued_dump', 'dumping', 'refueling', 'reserve']);
const LOAD_STATES = new Set(['queued_load', 'loading']), DUMP_STATES = new Set(['queued_dump', 'dumping']);
const DUMP_NODE = { 'crusher-01': 'crusher', 'stockpile-clay': 'stockpile-clay', 'dump-waste-1': 'dump-waste-1' };
const PLACES = ['забой 01', 'забой 02', 'забой 03', 'забой 04', 'забой 05', 'забой 06', 'дробилка', 'склад глинистой руды',
  'отвал', 'заправка', 'съезд 1', 'съезд 2', 'прочие дороги'];
const METRICS = [['teleport', 'телепорты'], ['overlap', 'наезды'], ['reverse', 'езда задом'], ['turn', 'резкие повороты'],
  ['wheels', 'колёса над/под поверхностью'], ['bucket', 'ковш в земле'], ['idle', 'стоит без причины'],
  ['offroad', 'вне дороги'], ['static', 'наезд на неподвижное'], ['uturn', 'лишний разворот'], ['loop', 'круг']];
const DEG = Math.PI / 180;

async function browser() {
  const pw = process.env.PLAYWRIGHT_CORE;
  const { chromium } = await import(pw ? pathToFileURL(path.join(pw, 'index.mjs')).href : 'playwright-core');
  return chromium.launch({
    executablePath: process.env.CHROME || undefined, headless: true,
    args: ['--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
}

async function openScene(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('bz-quality', 'normal'); localStorage.setItem('bz-guide-seen', '1'); } catch (e) { /* без хранилища */ } });
  page.on('pageerror', (e) => console.log('ошибка страницы:', e.message));
  await page.goto(URL0 + (URL0.includes('?') ? '&' : '?') + 'debug=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__motion && window.__machineLayout && window.__machineLayout().filter((m) => /truck-/.test(m.id)).length >= 20, null, { timeout: 120000 });
  await page.evaluate(() => { const b = document.getElementById('guide-ok'); if (b && b.offsetParent) b.click(); });
  return page;
}

// ---------------------------------------------------------------- замер
async function measure(minutes, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openScene(ctx);
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(await page.evaluate(() => window.__motion.meta())));
  const out = fs.createWriteStream(path.join(dir, 'samples.jsonl'));
  await page.evaluate(() => window.__motion.start(100));
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < minutes * 60000) {
    await page.waitForTimeout(2000);
    const rows = await page.evaluate(() => window.__motion.take());
    for (const r of rows) out.write(JSON.stringify(r) + '\n');
    n += rows.length;
    if (Math.floor((Date.now() - t0) / 60000) !== Math.floor((Date.now() - t0 - 2000) / 60000)) console.log(`${Math.round((Date.now() - t0) / 60000)} мин, замеров ${n}`);
  }
  await page.evaluate(() => window.__motion.stop());
  await new Promise((res) => out.end(res));
  fs.writeFileSync(path.join(dir, 'holes.json'), JSON.stringify(await holes(page), null, 1));
  await b.close();
  return analyze(dir);
}

// дыры в рельефе: 12 точек камеры у бровки (через 30° по кругу, высота 140, взгляд на противоположный борт) — заданы
// заранее от размеров карьера; в «Обычном» и «Высоком» качестве (у них разные сетки карьера)
async function holes(page) {
  const out = {};
  for (const q of ['normal', 'high']) {
    await page.evaluate((q) => { const el = document.getElementById('quality'); el.value = q; el.dispatchEvent(new Event('change', { bubbles: true })); }, q);   // список — в свёрнутых «Настройках»
    await page.waitForTimeout(3000);
    out[q] = await page.evaluate(() => window.__motion.holes({ ring12: true }));
  }
  await page.evaluate(() => { const el = document.getElementById('quality'); el.value = 'normal'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  return out;
}

// ---------------------------------------------------------------- разбор
const unwrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function obb(x, z, yaw, hl, hw) { return { x, z, ux: Math.sin(yaw), uz: Math.cos(yaw), hl, hw }; }
function obbOverlap(A, B) {
  const dx = B.x - A.x, dz = B.z - A.z;
  for (const [nx, nz] of [[A.ux, A.uz], [-A.uz, A.ux], [B.ux, B.uz], [-B.uz, B.ux]]) {
    const ra = A.hl * Math.abs(A.ux * nx + A.uz * nz) + A.hw * Math.abs(-A.uz * nx + A.ux * nz);
    const rb = B.hl * Math.abs(B.ux * nx + B.uz * nz) + B.hw * Math.abs(-B.uz * nx + B.ux * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}
function quadOverlap(A, q) {   // прямоугольник машины и выпуклый четырёхугольник развала (x, z сцены)
  const ca = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [A.x + A.ux * A.hl * a - A.uz * A.hw * b, A.z + A.uz * A.hl * a + A.ux * A.hw * b]);
  const axes = [[A.ux, A.uz], [-A.uz, A.ux]];
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; axes.push([-(r[1] - p[1]), r[0] - p[0]]); }
  for (const [nx, nz] of axes) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of ca) { const v = x * nx + z * nz; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for (const [x, z] of q) { const v = x * nx + z * nz; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}
const inQuad = (x, z, q, pad) => { const xs = q.map((p) => p[0]), zs = q.map((p) => p[1]);   // грубо: рамка развала с запасом
  return x >= Math.min(...xs) - pad && x <= Math.max(...xs) + pad && z >= Math.min(...zs) - pad && z <= Math.max(...zs) + pad; };
function segDist(px, py, pts) {
  let m = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
    m = Math.min(m, Math.hypot(px - ax - vx * t, py - ay - vy * t));
  }
  return m;
}

function placeOf(meta) {
  const P = [];
  for (let i = 1; i <= 6; i++) { const e = meta.objects['excavator-0' + i] || meta.nodes['face-0' + i]; if (e) P.push(['забой 0' + i, e[0], e[1], 55]); }
  for (const [name, node, r] of [['дробилка', 'crusher', 55], ['склад глинистой руды', 'stockpile-clay', 55], ['отвал', 'dump-waste-1', 80], ['заправка', 'fuel-station', 60]]) {
    const p = meta.nodes[node]; if (p) P.push([name, p[0], p[1], r]);
  }
  return (x, z) => {   // x, z сцены → место
    const xs = x, ys = -z;
    for (const [name, px, py, r] of P) if (Math.hypot(xs - px, ys - py) < r) return name;
    for (const rp of meta.ramps) if (segDist(xs, ys, rp.pts) < 24) return rp.road === 'road-ramp-1' ? 'съезд 1' : 'съезд 2';
    return 'прочие дороги';
  };
}

function analyze(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const lines = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean);
  const S = lines.map((l) => JSON.parse(l));
  const place = placeOf(meta);
  // ускорение модельного времени: по mine.sim_time в начале и в конце замера
  const sims = S.filter((r) => r.sim).map((r) => [r.t, Date.parse(r.sim)]);
  const speedup = sims.length > 1 ? Math.max(1, (sims[sims.length - 1][1] - sims[0][1]) / (sims[sims.length - 1][0] - sims[0][0])) : 10;
  const unitsPerMps = speedup / K;                 // 1 м/с модели → единиц схемы в секунду реального времени
  const vmax = VMAX_KMH / 3.6 * unitsPerMps;
  const counts = Object.fromEntries(PLACES.map((p) => [p, Object.fromEntries([...METRICS.map(([k]) => [k, 0]), ['turnReal', 0]])]));
  const examples = Object.fromEntries([...METRICS.map(([k]) => [k, []]), ['turnReal', []]]);
  const open = new Map();                          // ключ нарушения → идёт ли эпизод (номер замера)
  const hit = (key, metric, i, pl, what) => {
    const prev = open.get(key);
    open.set(key, i);
    if (prev === i - 1) return;                    // тот же эпизод продолжается
    counts[pl][metric]++;
    if (examples[metric].length < 12) examples[metric].push({ t: +((S[i].t - S[0].t) / 1000).toFixed(1), place: pl, what });
  };
  // --- вне дороги: отрезки дорог (схема), площадки забоев, места разгрузки и заправки, стоянка — сетка 50 единиц
  const HALF = meta.roadHalf || 16, GRID = 50, grid = new Map();
  const cellsOf = (x0, y0, x1, y1, f) => { for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) f(gx + ',' + gy); };
  const put = (item, x0, y0, x1, y1) => cellsOf(x0, y0, x1, y1, (k) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(item); });
  for (const r of meta.roads || []) for (let k = 0; k + 1 < r.pts.length; k++) {
    const [a, b] = [r.pts[k], r.pts[k + 1]];
    put({ seg: [a, b] }, Math.min(a[0], b[0]) - HALF - 2, Math.min(a[1], b[1]) - HALF - 2, Math.max(a[0], b[0]) + HALF + 2, Math.max(a[1], b[1]) + HALF + 2);
  }
  const benchPads = (meta.extra && meta.extra.face_pads) || [];
  for (const [n, p] of Object.entries(meta.nodes)) {
    if (!n.startsWith('face-') || benchPads.some((b) => b.face === n)) continue;
    const r = (p[2] > -(meta.pitDepth || 1e9) + 1 ? 16 : 30) + 2;
    put({ circle: [p[0], p[1], r] }, p[0] - r, p[1] - r, p[0] + r, p[1] + r);
  }
  for (const b of benchPads) { const r = Math.hypot(b.hl, b.hd) + 2; put({ pad: b }, b.c[0] - r, b.c[1] - r, b.c[0] + r, b.c[1] + r); }
  for (const [n, r] of [['crusher', 60], ['stockpile-clay', 60], ['dump-waste-1', 70], ['fuel-station', 70]]) {
    const p = meta.nodes[n]; if (p) put({ circle: [p[0], p[1], r] }, p[0] - r, p[1] - r, p[0] + r, p[1] + r);
  }
  for (const [x, y] of meta.parks || []) put({ circle: [x, y, 14] }, x - 14, y - 14, x + 14, y + 14);
  for (const [x, y, r] of meta.junctions || []) put({ circle: [x, y, r + 1], top: true }, x - r - 1, y - r - 1, x + r + 1, y + r + 1);   // площадки развилок (вне карьера)
  const onRoad = (xs, ys, h) => (grid.get(Math.floor(xs / GRID) + ',' + Math.floor(ys / GRID)) || []).some((it) => {
    if (it.seg) return segDist(xs, ys, it.seg) <= HALF + 1;
    if (it.circle) return (!it.top || h > -2) && Math.hypot(xs - it.circle[0], ys - it.circle[1]) <= it.circle[2];
    const b = it.pad, dx = xs - b.c[0], dy = ys - b.c[1];
    return Math.abs(dx * b.t[0] + dy * b.t[1]) <= b.hl + 2 && Math.abs(-dx * b.t[1] + dy * b.t[0]) <= b.hd + 2;
  });
  // --- неподвижные препятствия (координаты сцены), сетка 40 единиц
  const ST = meta.statics || { belt: [], legs: [], poles: [], cells: [] }, TH = meta.truckH || 5, sgrid = new Map();
  const sput = (item, x0, z0, x1, z1) => { for (let gx = Math.floor(x0 / 40); gx <= Math.floor(x1 / 40); gx++) for (let gz = Math.floor(z0 / 40); gz <= Math.floor(z1 / 40); gz++) { const k = gx + ',' + gz; if (!sgrid.has(k)) sgrid.set(k, []); sgrid.get(k).push(item); } };
  for (const b of ST.belt) for (let k = 0; k + 1 < b.pts.length; k++) {
    const [ax, ay, az] = b.pts[k], [bx, by, bz] = b.pts[k + 1], L = Math.hypot(bx - ax, bz - az);
    if (L < 0.01) continue;
    sput({ o: obb((ax + bx) / 2, (az + bz) / 2, Math.atan2(bx - ax, bz - az), L / 2, b.half), bottom: Math.min(ay, by) - 1.6, top: Math.max(ay, by) + 1.8, what: 'лента конвейера' },
      Math.min(ax, bx) - b.half, Math.min(az, bz) - b.half, Math.max(ax, bx) + b.half, Math.max(az, bz) + b.half);
  }
  for (const [x, z, yaw, h] of ST.legs) sput({ o: obb(x, z, yaw, 0.6, h), what: 'стойка конвейера' }, x - h, z - h, x + h, z + h);
  for (const [x, z, r, what] of ST.poles) sput({ p: [x, z, r], what }, x - r, z - r, x + r, z + r);
  for (const [x, z, yaw, hl, hw, what] of ST.boxes || []) { const r = Math.hypot(hl, hw); sput({ o: obb(x, z, yaw, hl, hw), what }, x - r, z - r, x + r, z + r); }
  for (const [x, z, id] of ST.cells) sput({ o: obb(x, z, 0, (ST.cell || 2) / 2, (ST.cell || 2) / 2), what: 'здание ' + id }, x - 1, z - 1, x + 1, z + 1);
  const staticHit = (A, oa) => {
    for (const it of sgrid.get(Math.floor(A.x / 40) + ',' + Math.floor(A.z / 40)) || []) {
      if (it.p) {
        const dx = it.p[0] - A.x, dz = it.p[1] - A.z, al = dx * oa.ux + dz * oa.uz, ac = -dx * oa.uz + dz * oa.ux;
        if (Math.hypot(Math.max(0, Math.abs(al) - oa.hl), Math.max(0, Math.abs(ac) - oa.hw)) < it.p[2]) return it.what;
      } else if (obbOverlap(oa, it.o) && (it.bottom === undefined || (A.y + TH > it.bottom && A.y < it.top))) return it.what + (it.bottom !== undefined ? ` (низ ${(it.bottom - A.y).toFixed(1)} над самосвалом высотой ${TH.toFixed(1)})` : '');
    }
    return null;
  };
  // --- заезды на разгрузку и окна пути для «круга»
  const visit = {}, loopWin = {}, visitRot = [];
  const turnsOf = (run) => (Math.abs(run) >= 150 * DEG ? 1 + Math.floor((Math.abs(run) - 150 * DEG) / Math.PI) : 0);
  let piles = [];
  const hist = {};                                 // id → [{t, x, z, yaw, st}]
  const idle = {};                                 // id → {since, x, z}
  const T = (r) => ({ id: r[0], x: r[1], y: r[2], z: r[3], yaw: r[4], hl: r[5], hw: r[6], st: r[7], lo: r[8], hi: r[9] });
  for (let i = 0; i < S.length; i++) {
    const rec = S[i];
    if (rec.piles) piles = rec.piles;
    const ms = rec.m.filter((r) => r[1] !== null && r[3] !== null).map((r) => Object.assign(T(r), r[0].startsWith('truck-') ? { v: r[12], exc: r[13], dest: r[14] } : {},
      r[0].startsWith('excavator-') ? { bkY: r[12], bkX: r[13], bkZ: r[14], bkS: r[15] } : {}));
    const byId = Object.fromEntries(ms.map((m) => [m.id, m]));
    const trucks = ms.filter((m) => m.id.startsWith('truck-'));
    const others = ms.filter((m) => !m.id.startsWith('truck-'));
    const service = ms.filter((m) => m.id.startsWith('service-'));   // служебные машины сцены (не двойники) — те же правила
    for (const A of service) for (const E of others) {
      if (E === A || Math.abs(A.x - E.x) > 50 || Math.abs(A.z - E.z) > 50) continue;
      if (obbOverlap(obb(A.x, A.z, A.yaw, A.hl, A.hw), obb(E.x, E.z, E.yaw, E.hl, E.hw))) hit('o' + A.id + E.id, 'overlap', i, place(A.x, A.z), `${A.id} × ${E.id}`);
    }
    for (const m of ms) {
      const pl = place(m.x, m.z);
      if (m.lo < -0.5 || m.hi > 0.5) hit('w' + m.id, 'wheels', i, pl, `${m.id} (${m.st || '—'}): колёса ${m.lo < -0.5 ? 'под поверхностью на ' + (-m.lo).toFixed(1) : 'над поверхностью на ' + m.hi.toFixed(1)}`);
      if (m.bkY !== undefined && m.bkY < m.bkS - 0.5 && !piles.some((p) => inQuad(m.bkX, m.bkZ, p.corners, 4)))
        hit('b' + m.id, 'bucket', i, pl, `${m.id}: ковш ниже поверхности на ${(m.bkS - m.bkY).toFixed(1)}`);
    }
    for (let a = 0; a < trucks.length; a++) {
      const A = trucks[a], oa = obb(A.x, A.z, A.yaw, A.hl, A.hw), pl = place(A.x, A.z);
      for (let b = a + 1; b < trucks.length; b++) {
        const B = trucks[b];
        if (Math.abs(A.x - B.x) > 40 || Math.abs(A.z - B.z) > 40) continue;
        if (obbOverlap(oa, obb(B.x, B.z, B.yaw, B.hl, B.hw))) hit('o' + A.id + B.id, 'overlap', i, pl, `${A.id} (${A.st}) × ${B.id} (${B.st})`);
      }
      for (const E of others) {
        if (Math.abs(A.x - E.x) > 50 || Math.abs(A.z - E.z) > 50) continue;
        if (obbOverlap(oa, obb(E.x, E.z, E.yaw, E.hl, E.hw))) hit('o' + A.id + E.id, 'overlap', i, pl, `${A.id} (${A.st}) × ${E.id}`);
      }
      for (const p of piles) if (quadOverlap(oa, p.corners)) hit('o' + A.id + p.face, 'overlap', i, pl, `${A.id} (${A.st}) × развал ${p.face}`);
      if (!onRoad(A.x, -A.z, A.y)) hit('f' + A.id, 'offroad', i, pl, `${A.id} (${A.st}) в (${A.x.toFixed(0)}, ${A.z.toFixed(0)}), высота ${A.y.toFixed(1)}`);
      const sh = staticHit(A, oa);
      if (sh) hit('s' + A.id + sh.slice(0, 12), 'static', i, pl, `${A.id} (${A.st}) × ${sh}`);
    }
    // по истории каждой машины: шаг, ход назад, поворот, простой
    for (const A of [...trucks, ...service]) {
      const h = hist[A.id] || (hist[A.id] = []);
      h.push({ t: rec.t, x: A.x, z: A.z, yaw: A.yaw, st: A.st, dest: A.dest, exc: A.exc, i });
      while (h.length && rec.t - h[0].t > 1500) h.shift();
      const pl = place(A.x, A.z);
      if (h.length >= 2) {
        const p = h[h.length - 2], dt = (rec.t - p.t) / 1000;
        const dx = A.x - p.x, dz = A.z - p.z, step = Math.hypot(dx, dz);
        if (dt > 0 && step > 1.5 * vmax * dt) hit('t' + A.id, 'teleport', i, pl, `${A.id} (${p.st}→${A.st}): ${(step * K).toFixed(0)} м за ${dt.toFixed(2)} с`);
        const v = dt > 0 ? step / dt : 0;
        if (v > 0.5 * unitsPerMps && step > 0) {
          const back = (dx * Math.sin(A.yaw) + dz * Math.cos(A.yaw)) / step < -0.5;
          if (back) {
            let ok = false;
            // ход между замерами — по состоянию в начале отрезка (модель могла закончить разгрузку посреди заезда задом)
            const st = p.st;
            if (v <= 2 * unitsPerMps) {
              const ex = p.exc && byId[p.exc];
              if (LOAD_STATES.has(st) && ex && Math.hypot(A.x - ex.x, A.z - ex.z) < 45) ok = true;
              const dn = meta.nodes[DUMP_NODE[p.dest]];
              if ((DUMP_STATES.has(st) || st === 'hauling') && dn && Math.hypot(A.x - dn[0], A.z + dn[1]) < 40) ok = true;
              if (st === 'refueling' || st === 'reserve') ok = true;   // заезд задом на место стоянки у заправки
            }
            if (!ok) hit('r' + A.id, 'reverse', i, pl, `${A.id} (${A.st}): задом ${(v / unitsPerMps).toFixed(1)} м/с`);
          }
        }
        // поворот: курс между соседними замерами (≈ 1 модельная секунда) — больше 45° за модельную секунду
        const dtm = dt * speedup, dyaw = Math.abs(unwrap(A.yaw - p.yaw));
        if (dt > 0 && dtm <= 2 && v > 2 * unitsPerMps && dyaw > Math.PI / 4 * Math.max(1, dtm))
          hit('u' + A.id, 'turn', i, pl, `${A.id} (${A.st}): ${(dyaw * 180 / Math.PI).toFixed(0)}° за ${dtm.toFixed(1)} модельных с на ${(v / unitsPerMps).toFixed(1)} м/с`);
        // для сведения — то же за 1 с реального времени (так видит зритель при ускорении модели)
        const q = h.find((s) => rec.t - s.t <= 1000) || h[0];
        const span = (rec.t - q.t) / 1000, dist = Math.hypot(A.x - q.x, A.z - q.z);
        if (span > 0.15 && dist / span > 2 * unitsPerMps && Math.abs(unwrap(A.yaw - q.yaw)) > Math.PI / 4) hit('U' + A.id, 'turnReal', i, pl, '');
      }
      if (A.id.startsWith('truck-')) {
        // лишний разворот: заезд на разгрузку — от подъезда ближе 70 единиц к месту до отъезда дальше 80 после разгрузки
        let vs = visit[A.id];
        const dn = meta.nodes[DUMP_NODE[A.dest]];
        if (!vs && dn && (A.st === 'hauling' || DUMP_STATES.has(A.st)) && Math.hypot(A.x - dn[0], A.z + dn[1]) < 70)
          vs = visit[A.id] = { node: dn, dest: A.dest, run: 0, back: 0, n: 0, yaw: A.yaw, dumped: false, runs: [] };
        if (vs) {
          const dy = unwrap(A.yaw - vs.yaw); vs.yaw = A.yaw;
          if (dy * vs.run >= 0) { vs.run += dy; vs.back = 0; } else { vs.back += dy; if (Math.abs(vs.back) > 15 * DEG) { vs.n += turnsOf(vs.run); vs.runs.push(Math.round(vs.run / DEG)); vs.run = vs.back; vs.back = 0; } }
          if (DUMP_STATES.has(A.st)) vs.dumped = true;
          const dd = Math.hypot(A.x - vs.node[0], A.z + vs.node[1]);
          if (dd > 80 || (vs.dumped && !DUMP_STATES.has(A.st) && A.st !== 'hauling' && dd > 70)) {
            vs.n += turnsOf(vs.run); vs.runs.push(Math.round(vs.run / DEG));
            if (process.env.MC_DEBUG) console.log('заезд', A.id, vs.dest, 'разворотов', vs.n, 'повороты', vs.runs.join(','));
            visitRot.push(vs.runs.reduce((s, r) => s + Math.abs(r), 0));
            if (vs.n > 1) hit('v' + A.id + i, 'uturn', i, pl, `${A.id} у ${vs.dest}: разворотов ${vs.n} (повороты корпуса, °: ${vs.runs.filter((r) => Math.abs(r) >= 20).join(', ')})`);
            delete visit[A.id];
          }
        }
        // круг: окно 75 единиц пути (150 м) — без езды задом, перепад высоты меньше 4, суммарный поворот больше 300°
        const lw = loopWin[A.id] || (loopWin[A.id] = { s: 0, yaw: 0, prev: null, pts: [] });
        if (lw.prev) {
          const dx = A.x - lw.prev.x, dz = A.z - lw.prev.z, st = Math.hypot(dx, dz);
          lw.yaw += unwrap(A.yaw - lw.prev.yaw);
          if (st > 0.05) {
            const rev = (dx * Math.sin(A.yaw) + dz * Math.cos(A.yaw)) / st < -0.5;
            lw.s += st;
            lw.pts.push({ s: lw.s, yaw: lw.yaw, y: A.y, rev });
            while (lw.pts.length && lw.s - lw.pts[0].s > 75) lw.pts.shift();
            const w = lw.pts;
            if (w.length > 5 && w[w.length - 1].s - w[0].s > 60 && !w.some((q) => q.rev)) {
              const ys = w.map((q) => q.y), net = w[w.length - 1].yaw - w[0].yaw;
              if (Math.max(...ys) - Math.min(...ys) < 4 && Math.abs(net) > 300 * DEG) hit('l' + A.id, 'loop', i, pl, `${A.id} (${A.st}): ${Math.round(Math.abs(net) / DEG)}° за ${((w[w.length - 1].s - w[0].s) * K).toFixed(0)} м пути, ${net > 0 ? 'против' : 'по'} часовой`);
            }
          }
        }
        lw.prev = { x: A.x, z: A.z, yaw: A.yaw };
      }
      const d = idle[A.id];
      if (!d || Math.hypot(A.x - d.x, A.z - d.z) > 3 || WAIT_STATES.has(A.st)) idle[A.id] = { since: rec.t, x: A.x, z: A.z };
      else if (rec.t - d.since > 180000) hit('i' + A.id, 'idle', i, pl, `${A.id} (${A.st}) стоит ${((rec.t - d.since) / 60000).toFixed(1)} мин`);
    }
  }
  const dur = S.length > 1 ? (S[S.length - 1].t - S[0].t) / 1000 : 0;
  const totals = Object.fromEntries(METRICS.map(([k]) => [k, PLACES.reduce((s, p) => s + counts[p][k], 0)]));
  let holes = null;
  try { holes = JSON.parse(fs.readFileSync(path.join(dir, 'holes.json'), 'utf8')); } catch (e) { /* замер без проверки дыр */ }
  const holeSum = holes ? Object.fromEntries(Object.entries(holes).map(([q, vs]) => [q, vs.reduce((s, v) => s + v.holes, 0)])) : null;
  visitRot.sort((a, b) => a - b);
  const rot = visitRot.length ? { visits: visitRot.length, median: visitRot[visitRot.length >> 1], over270: visitRot.filter((r) => r > 270).length } : null;
  const summary = { unloadRotation: rot, samples: S.length, seconds: +dur.toFixed(1), perSecond: +(S.length / (dur || 1)).toFixed(1), speedup: +speedup.toFixed(2), totals, holes: holeSum, byPlace: counts, examples };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  const w = [18, ...METRICS.map(([, n]) => Math.max(8, n.length))];
  const row = (cells) => cells.map((c, j) => String(c).padEnd(w[j])).join(' | ');
  const txt = [`замеров ${S.length} за ${dur.toFixed(0)} с (${summary.perSecond} в секунду), ускорение модели ×${summary.speedup}`,
    row(['место', ...METRICS.map(([, n]) => n)]),
    ...PLACES.map((p) => row([p, ...METRICS.map(([k]) => counts[p][k])])),
    row(['ВСЕГО', ...METRICS.map(([k]) => totals[k])]),
    `для сведения: поворотов больше 45° за 1 с реального времени — ${PLACES.reduce((s, p) => s + counts[p].turnReal, 0)}`,
    rot ? `для сведения: заездов на разгрузку ${rot.visits}, поворот корпуса за заезд (сумма по модулю) — медиана ${rot.median}°, больше 270° — ${rot.over270}` : 'заездов на разгрузку нет',
    holes ? `дыры в рельефе (пикселей фона внутри карьера): ${Object.entries(holeSum).map(([q, n]) => (q === 'high' ? 'Высокое' : 'Обычное') + ' ' + n).join(', ')}` +
      Object.entries(holes).flatMap(([q, vs]) => vs.filter((v) => v.holes).map((v) => `\n  ${q === 'high' ? 'Высокое' : 'Обычное'}, ${v.view}: ${v.holes} (места x,z: ${v.spots.map(([k, n]) => k + '×' + n).join('; ')})`)).join('') : 'дыры в рельефе: не проверялись',
    '', 'примеры:',
    ...METRICS.flatMap(([k, n]) => examples[k].slice(0, 6).map((e) => `  ${n}: ${e.t} с, ${e.place}: ${e.what}`))].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.txt'), txt + '\n');
  console.log(txt);
  return summary;
}

// ---------------------------------------------------------------- ролики с заранее заданных точек
// points.json: [{ "name": "zaboy-01", "target": [x, y, z], "az": 200, "dist": 100, "el": 35 }] — цель в координатах сцены
// (y = null — по поверхности),
// камера на расстоянии dist единиц от цели, под углом el° к горизонту, азимут az° (0 — с севера, по часовой)
// Запись — кадры экрана Chromium (CDP screencast) с их временем, 25 кадров/с, кодирует ffmpeg из поставки Playwright
// (FFMPEG — путь к нему); ролик начинается, когда сцена загружена и камера поставлена, и идёт целиком seconds секунд
async function video(pointsFile, dir, seconds) {
  const points = JSON.parse(fs.readFileSync(pointsFile, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const { spawn } = await import('node:child_process');
  const FPS = 25, W = 1280, H = 720;
  const b = await browser();
  for (const p of points) {
    const ctx = await b.newContext({ viewport: { width: W, height: H } });
    const page = await openScene(ctx);
    const el = (p.el ?? 35) * Math.PI / 180, az = (p.az ?? 0) * Math.PI / 180, d = p.dist ?? 100, [tx, , tz] = p.target;
    // высота цели не задана — по поверхности схемы под ней
    const ty = p.target[1] ?? await page.evaluate(([x, z]) => window.__camera.surfaceAt(x, -z), [tx, tz]);
    const cam = [tx + Math.sin(az) * Math.cos(el) * d, ty + Math.sin(el) * d, tz - Math.cos(az) * Math.cos(el) * d];
    await page.evaluate(([c, t]) => window.__camera.set(c[0], c[1], c[2], t[0], t[1], t[2]), [cam, [tx, ty, tz]]);
    await page.waitForTimeout(1500);
    const out = path.join(dir, p.name + '.webm');
    const ff = spawn(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(FPS), '-i', 'pipe:0',
      '-y', '-an', '-r', String(FPS), '-c:v', 'vp8', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-speed', '8', '-b:v', '2M',
      '-vf', `pad=${W}:${H}:0:0:gray,crop=${W}:${H}:0:0`, out]);
    const done = new Promise((res) => ff.on('close', res));
    const cdp = await ctx.newCDPSession(page);
    let prev = null, start = null, count = 0;
    const put = (ts) => {   // предыдущий кадр держится на экране до времени следующего
      const n = Math.max(0, Math.round((ts - start) * FPS) - count);
      for (let i = 0; i < n && prev; i++) ff.stdin.write(prev);
      count += n;
    };
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const ts = f.metadata.timestamp;
      if (start === null) start = ts;
      if (ts - start > seconds) return;
      put(ts);
      prev = Buffer.from(f.data, 'base64');
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await page.waitForTimeout(seconds * 1000 + 300);
    await cdp.send('Page.stopScreencast').catch(() => {});
    if (start !== null) put(start + seconds);
    ff.stdin.end();
    await done;
    await ctx.close();
    console.log(`${p.name}.webm — ${seconds} с (${count} кадров) с точки ${cam.map((c) => c.toFixed(0)).join(', ')}, цель ${[tx, ty, tz].map((c) => c.toFixed(0)).join(', ')}`);
  }
  await b.close();
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'measure') await measure(Number(a1) || 10, a2 || '.');
else if (cmd === 'analyze') analyze(a1 || '.');
else if (cmd === 'video') await video(a1, a2 || '.', Number(a3) || 45);
else if (cmd === 'holes') {
  const dir = a1 || '.', b = await browser();
  const page = await openScene(await b.newContext({ viewport: { width: 1280, height: 800 } }));
  await page.waitForTimeout(3000);
  fs.mkdirSync(dir, { recursive: true });
  const h = await holes(page);
  fs.writeFileSync(path.join(dir, 'holes.json'), JSON.stringify(h, null, 1));
  await b.close();
  for (const [q, vs] of Object.entries(h)) for (const v of vs) console.log(q, '|', v.view, '|', v.holes, v.spots.map(([k, n]) => k + '×' + n).join('; '));
  if (fs.existsSync(path.join(dir, 'samples.jsonl'))) analyze(dir);
} else console.log('node motion_check.mjs measure [минут] [папка] | analyze <папка> | holes <папка> | video <points.json> <папка> [секунд]');
