// Проверка движения техники в 3D-сцене — числами, по тому, что видно в сцене (не по Ditto).
// Headless Chromium открывает сцену с ?debug=1 при работающем стенде и не реже 10 раз в секунду снимает место, курс и
// наклон каждой машины после всех поправок сцены (window.__motion в web/app.js), затем считает нарушения правил движения
// и сводит их по местам: забои 01–06, дробилка, склад глинистой руды, отвал, заправка, съезды 1 и 2, остальные дороги.
//
//   node motion_check.mjs measure [минут=10] [папка=.]     замер: samples.jsonl, meta.json, summary.json, summary.txt
//   node motion_check.mjs analyze <папка>                   пересчитать итог по уже снятому замеру
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
//   стоит без причины — самосвал не двигается больше 3 мин не в очереди, погрузке, разгрузке, заправке, резерве.
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
  ['wheels', 'колёса над/под поверхностью'], ['bucket', 'ковш в земле'], ['idle', 'стоит без причины']];

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
  await b.close();
  return analyze(dir);
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
    }
    // по истории каждой машины: шаг, ход назад, поворот, простой
    for (const A of trucks) {
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
      const d = idle[A.id];
      if (!d || Math.hypot(A.x - d.x, A.z - d.z) > 3 || WAIT_STATES.has(A.st)) idle[A.id] = { since: rec.t, x: A.x, z: A.z };
      else if (rec.t - d.since > 180000) hit('i' + A.id, 'idle', i, pl, `${A.id} (${A.st}) стоит ${((rec.t - d.since) / 60000).toFixed(1)} мин`);
    }
  }
  const dur = S.length > 1 ? (S[S.length - 1].t - S[0].t) / 1000 : 0;
  const totals = Object.fromEntries(METRICS.map(([k]) => [k, PLACES.reduce((s, p) => s + counts[p][k], 0)]));
  const summary = { samples: S.length, seconds: +dur.toFixed(1), perSecond: +(S.length / (dur || 1)).toFixed(1), speedup: +speedup.toFixed(2), totals, byPlace: counts, examples };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  const w = [18, ...METRICS.map(([, n]) => Math.max(8, n.length))];
  const row = (cells) => cells.map((c, j) => String(c).padEnd(w[j])).join(' | ');
  const txt = [`замеров ${S.length} за ${dur.toFixed(0)} с (${summary.perSecond} в секунду), ускорение модели ×${summary.speedup}`,
    row(['место', ...METRICS.map(([, n]) => n)]),
    ...PLACES.map((p) => row([p, ...METRICS.map(([k]) => counts[p][k])])),
    row(['ВСЕГО', ...METRICS.map(([k]) => totals[k])]),
    `для сведения: поворотов больше 45° за 1 с реального времени — ${PLACES.reduce((s, p) => s + counts[p].turnReal, 0)}`, '', 'примеры:',
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
else console.log('node motion_check.mjs measure [минут] [папка] | analyze <папка> | video <points.json> <папка> [секунд]');
