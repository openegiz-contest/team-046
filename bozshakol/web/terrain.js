// Рельеф вокруг карьера Бозшаколь — только высоты (в сцене его нет: сцена одна — схема рудника, diorama.js).
//
// Высоты — Copernicus DEM GLO-30 (bozshakol/data/terrain, квадрат 6 × 6 км); за его пределами — стилизованная
// степь; внутри карьера — бермы модели уступов. Нужны переносу координат в схему (diorama.js): «высота над землёй»
// z − groundAt(x, y) у объектов двойников. Снимок Sentinel-2 показывает окно «Фото местности» (app.js).
//
// Интерфейс (см. contract/README.md, раздел 9):
//   loadTerrain(THREE, geometry) -> {
//     ok, meta, pit, pads,
//     demAt(x, y)      — высота рельефа Copernicus (м) без площадок и дорог,
//     heightAt(x, y)   — высота поверхности: рельеф + выровненные площадки + профиль наземных дорог;
//                        внутри карьера — бермы модели уступов,
//     groundAt(x, y)   — то же, что heightAt (имя для слоёв: «высота земли со всеми правками»),
//     attribution: { dem, image }, bounds: { minX, maxX, minY, maxY } — границы макета
//   }
// Все координаты — рудника (м): X — вдоль длинной оси карьера (≈ восток), Y ≈ север, Z — высота
// относительно борта карьера. В сцену переводит toScene(x, y, z) = (x, z·VZ, −y).

const TERRAIN_URL = './terrain/';
// Макет: прямоугольный участок вокруг рудника (карьер, дробилка, фабрики, хвостохранилище, отвал), м
const BOUNDS = { minX: -5200, maxX: 3000, minY: -3000, maxY: 2600 };
const AREA_HALF = 5200;                 // для обратной совместимости (areaHalf): наибольшая полуширина
const CELL = 60;                        // м: шаг сетки макета (≈ 25 тыс. плоских граней)
const DEM_FADE = 500;                   // м: ширина полосы, где реальный рельеф переходит в степь
const ROAD_HALF_WIDTH = 14;             // м: в этой полосе высота = профиль дороги, цвет — накатанный грунт
const ROAD_SHOULDER = 40;               // м: обочина, плавный переход высоты и цвета
const ROAD_BLEND = 160;                 // м: дальше рельеф свой
const PAD_BLEND = 60;                   // м: откос выровненной площадки

export async function loadTerrain(THREE, geometry) {
  const pit = pitModel(geometry);
  const roads = surfaceRoads(geometry);
  const pads = padsFrom(geometry);
  let meta = null, heights = null;
  try {
    meta = await (await fetch(TERRAIN_URL + 'terrain.json')).json();
    const buf = await (await fetch(TERRAIN_URL + meta.heights.file)).arrayBuffer();
    heights = new Int16Array(buf);
    if (heights.length !== meta.heights.n * meta.heights.n) throw new Error('размер heights.bin не совпадает с terrain.json');
  } catch (err) {
    console.warn('рельеф не загружен, поверхность стилизованная:', err);
    meta = null;
  }
  const n = meta ? meta.heights.n : 0;
  const step = meta ? meta.heights.step_m : 30;
  const half = meta ? meta.half_m : 3000;
  const farLevel = meta ? (meta.heights.min_m + meta.heights.max_m) / 2 - 6 : 0;   // уровень дальней степи

  // --- высоты -----------------------------------------------------------------------------
  function demRaw(x, y) {
    if (!meta) return 0;
    let fx = (x + half) / step, fy = (y + half) / step;
    fx = Math.min(Math.max(fx, 0), n - 1.001);
    fy = Math.min(Math.max(fy, 0), n - 1.001);
    const c0 = Math.floor(fx), r0 = Math.floor(fy), tx = fx - c0, ty = fy - r0;
    const v = heights;
    const top = v[r0 * n + c0] * (1 - tx) + v[r0 * n + c0 + 1] * tx;
    const bot = v[(r0 + 1) * n + c0] * (1 - tx) + v[(r0 + 1) * n + c0 + 1] * tx;
    return (top * (1 - ty) + bot * ty) / 10;
  }
  // стилизованная степь за пределами данных: пологие увалы в 10–20 м, как на реальном рельефе вокруг
  function steppe(x, y) {
    return farLevel + 7 * Math.sin(x / 1300 + 0.4) * Math.cos(y / 900 - 0.7)
      + 4 * Math.sin((x - y) / 520 + 1.3) + 2 * Math.cos((x + 2 * y) / 310);
  }
  function demAt(x, y) {
    const d = half - Math.max(Math.abs(x), Math.abs(y));   // расстояние до края квадрата данных (внутрь > 0)
    let h;
    if (!meta || d <= -DEM_FADE) h = steppe(x, y);
    else if (d >= DEM_FADE) h = demRaw(x, y);
    else { const w = (d + DEM_FADE) / (2 * DEM_FADE); h = demRaw(x, y) * w + steppe(x, y) * (1 - w); }
    return h;                                              // край макета — срез, рельеф до самого края
  }
  function padAt(x, y) {
    let best = null;
    for (const p of pads) {
      const d = p.distance(x, y);                            // < 0 внутри площадки
      if (d < PAD_BLEND && (best === null || d < best.d)) best = { d, level: p.level, dump: p.dump };
    }
    return best;
  }
  function roadAt(x, y) {
    let best = null;
    for (const r of roads) {
      const d = r.distance(x, y);
      if (d < ROAD_BLEND && (best === null || d < best.d)) best = { d, z: r.zAt(x, y) };
    }
    return best;
  }
  function heightAt(x, y) {
    if (pit.inside(x, y)) return pit.benchHeight(x, y);
    let h = demAt(x, y);
    const road = roadAt(x, y);
    if (road) {
      const w = road.d <= ROAD_SHOULDER ? 1 : 1 - (road.d - ROAD_SHOULDER) / (ROAD_BLEND - ROAD_SHOULDER);
      h = h * (1 - w) + road.z * w;
    }
    const pad = padAt(x, y);                               // выровненная площадка главнее профиля дороги
    if (pad) {
      const w = pad.d <= 0 ? 1 : 1 - pad.d / PAD_BLEND;   // площадка выровнена по уровню центра
      h = h * (1 - w) + pad.level * w;
    }
    return h;
  }
  // ровная чаша хвостохранилища (окружение сцены, environment.js) — тоже выровненная площадка
  pads.push({ id: 'tailings', cx: -4050, cy: 250, level: 0,
    distance(px, py) { return (Math.hypot((px + 4050) / 1000, (py - 250) / 700) - 1) * 700; } });
  for (const p of pads) p.level = demAt(p.cx, p.cy);        // уровень площадки — рельеф в её центре

  // --- шум для пятен степи ----------------------------------------------------------------------
  function hash(x, y) {                                      // детерминированный шум 0..1
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }
  function smoothNoise(x, y, cell) {                         // плавный шум: билинейная интерполяция hash на сетке
    const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy);
    let tx = gx - x0, ty = gy - y0;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  // --- макет местности ------------------------------------------------------------------------
  // Участок вокруг рудника как макет на подставке: поверхность плоскими гранями (каждый треугольник —
  // свой цвет и своя нормаль, чёткий свет), спокойная палитра степи с резкими границами пятен,
  // ровные утрамбованные площадки; по краям — срез со слоями грунта, под макетом — подставка.
  const STEPPE = [new THREE.Color(0xcbbf8a), new THREE.Color(0xd5c895), new THREE.Color(0xdfd3a9), new THREE.Color(0xc9b388)];
  const PAD_SOIL = new THREE.Color(0xd0bd96), DUMP_SOIL = new THREE.Color(0xb3aea4), PIT_GROUND = new THREE.Color(0x9a8a70);
  function faceColor(x, y, out) {
    if (pit.inside(x, y)) return out.copy(PIT_GROUND);
    const pad = padAt(x, y);
    if (pad && pad.d <= 6) return out.copy(pad.dump ? DUMP_SOIL : PAD_SOIL);
    const v = 0.7 * smoothNoise(x, y, 1700) + 0.3 * smoothNoise(x + 3000, y - 2000, 650);
    const tone = v < 0.36 ? 0 : v < 0.55 ? 1 : v < 0.68 ? 2 : 3;
    out.copy(STEPPE[tone]);
    return out.multiplyScalar(0.985 + 0.03 * hash(Math.round(x / 7), Math.round(y / 7)));   // лёгкая игра граней
  }
  function surfaceZ(x, y) {
    return pit.inside(x, y) ? pit.benchHeight(x, y) - 30 : heightAt(x, y);   // под моделью уступов — на 30 м ниже берм
  }
  const STRATA = [                          // слои грунта на срезе (сверху вниз): цвет, нижняя граница (м)
    { color: new THREE.Color(0x6a4f36), bottom: (top) => top - 9 },              // почва
    { color: new THREE.Color(0xcfa96f), bottom: () => farLevel - 55 },          // лёсс, суглинок
    { color: new THREE.Color(0xb27a4f), bottom: () => farLevel - 130 },         // глины
    { color: new THREE.Color(0x9a8a78), bottom: () => baseZ + 40 },             // коренные породы
    { color: new THREE.Color(0x7d7369), bottom: () => baseZ },                  // плотные коренные породы
  ];
  const baseZ = -pit.depth - 60;           // основание макета — ниже дна карьера

  const attribution = {
    dem: meta ? 'Рельеф — Copernicus DEM, карьер — модель по открытым данным. ' + meta.sources.dem.attribution + '.' : '',
    image: meta ? meta.sources.image.attribution + '.' : '',
  };
  return { ok: !!meta, meta, pit, pads, demAt, heightAt, groundAt: heightAt, attribution, farLevel, areaHalf: AREA_HALF, bounds: BOUNDS };
}

// ------------------------------------------------------------------ карьер (модель уступов)
function pitModel(geometry) {
  const p = geometry.pit;
  const [a, b] = p.semi_axes_top;
  const inset = p.inset_per_bench, h = p.bench_height, count = p.bench_count, depth = p.depth;
  function inside(x, y, scale = 1) {
    return (x / (a * scale)) ** 2 + (y / (b * scale)) ** 2 < 1;
  }
  function benchHeight(x, y) {
    let level = 0;
    for (let k = 1; k <= count; k++) {
      const ak = a - k * inset, bk = b - k * inset;
      if (ak <= 0 || bk <= 0) break;
      if ((x / ak) ** 2 + (y / bk) ** 2 < 1) level = k; else break;
    }
    return level >= count ? -depth : -level * h;   // последний уровень — дно
  }
  return { inside, benchHeight, depth, a, b, inset, h, count };
}

// ------------------------------------------------------------------ наземные дороги
function surfaceRoads(geometry) {
  const nodes = geometry.nodes;
  const out = [];
  for (const e of geometry.edges) {
    const A = nodes[e.from], B = nodes[e.to];
    if (!A || !B) continue;
    if (e.road !== 'rim' && e.road !== 'road-crusher') continue;   // только дороги на поверхности
    const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy || 1;
    const t = (x, y) => Math.min(1, Math.max(0, ((x - A[0]) * dx + (y - A[1]) * dy) / len2));
    out.push({
      road: e.road, from: e.from, to: e.to,
      distance(x, y) { const s = t(x, y); return Math.hypot(x - (A[0] + dx * s), y - (A[1] + dy * s)); },
      zAt(x, y) { const s = t(x, y); return A[2] + (B[2] - A[2]) * s; },
    });
  }
  return out;
}

// ------------------------------------------------------------------ выровненные площадки у объектов
function padsFrom(geometry) {
  const out = [];
  for (const o of geometry.objects || []) {
    if (!o.position) continue;
    const [x, y] = o.position;
    if (o.kind === 'plant' || o.kind === 'substation' || o.kind === 'crusher' || o.kind === 'fuel') {
      const [l, w] = o.size || [60, 60];
      const hx = l / 2 + 60, hy = w / 2 + 60;
      out.push({ id: o.id, cx: x, cy: y, level: 0,
        distance(px, py) { return Math.max(Math.abs(px - x) - hx, Math.abs(py - y) - hy); } });
    } else if (o.kind === 'stockpile' || o.kind === 'dump') {
      const r = (o.radius || 50) + 40;
      out.push({ id: o.id, cx: x, cy: y, level: 0, dump: o.kind === 'dump', distance(px, py) { return Math.hypot(px - x, py - y) - r; } });
    }
  }
  return out;
}
