// Рельеф и земля вокруг карьера Бозшаколь.
//
// Высоты — Copernicus DEM GLO-30 (bozshakol/data/terrain, квадрат 6 × 6 км); дальше, до 10 × 10 км,
// рельеф плавно переходит в стилизованную степь, за ней — ровная степь до горизонта. Материал свой:
// цвета вершин (сухая трава по высоте и уклону, грунтовые площадки у объектов, накатанные дороги),
// затенение — обычный свет сцены. Спутниковый снимок Sentinel-2 — отдельный слой-наложение,
// включается переключателем «Снимок» (setImagery). Карьер — модель уступов (pit.js), здесь он
// только вырезан в сетке земли.
//
// Интерфейс (см. contract/README.md, раздел 9):
//   loadTerrain(THREE, geometry) -> {
//     ok, meta, pit, pads,
//     demAt(x, y)      — высота рельефа Copernicus (м) без площадок и дорог,
//     heightAt(x, y)   — высота поверхности: рельеф + выровненные площадки + профиль наземных дорог;
//                        внутри карьера — бермы модели уступов,
//     groundAt(x, y)   — то же, что heightAt (имя для слоёв: «высота земли со всеми правками»),
//     buildGround(scene, { toScene }) -> group с методом group.setImagery(on),
//     attribution: { dem, image }
//   }
// Все координаты — рудника (м): X — вдоль длинной оси карьера (≈ восток), Y ≈ север, Z — высота
// относительно борта карьера. В сцену переводит toScene(x, y, z) = (x, z·VZ, −y).

const TERRAIN_URL = './terrain/';
const AREA_HALF = 5000;                 // земля 10 × 10 км
const GROUND_SEGMENTS = 112;            // 112² × 2 ≈ 25 тыс. треугольников
const DEM_FADE = 500;                   // м: ширина полосы, где реальный рельеф переходит в степь
const ROAD_HALF_WIDTH = 14;             // м: в этой полосе высота = профиль дороги, цвет — накатанный грунт
const ROAD_SHOULDER = 40;               // м: обочина, плавный переход высоты и цвета
const ROAD_BLEND = 160;                 // м: дальше рельеф свой
const PAD_BLEND = 60;                   // м: откос выровненной площадки
const OUTER_FADE = 900;                 // м: у края земли 10 × 10 км высота сходит к уровню дальней степи

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
    // у края земли — плавно к уровню дальней ровной степи (без ступеньки на горизонте)
    const e = AREA_HALF - Math.max(Math.abs(x), Math.abs(y));
    if (e < OUTER_FADE) { const w = Math.max(0, e / OUTER_FADE); h = h * w + (farLevel - 2) * (1 - w); }
    return h;
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
    const pad = padAt(x, y);
    if (pad) {
      const w = pad.d <= 0 ? 1 : 1 - pad.d / PAD_BLEND;   // площадка выровнена по уровню центра
      h = h * (1 - w) + pad.level * w;
    }
    const road = roadAt(x, y);
    if (road) {
      const w = road.d <= ROAD_SHOULDER ? 1 : 1 - (road.d - ROAD_SHOULDER) / (ROAD_BLEND - ROAD_SHOULDER);
      h = h * (1 - w) + road.z * w;
    }
    return h;
  }
  for (const p of pads) p.level = demAt(p.cx, p.cy);        // уровень площадки — рельеф в её центре

  // --- цвет земли ---------------------------------------------------------------------------
  // Степь — пятна сухой травы разных оттенков (жёлто-зелёные, соломенные, бурые) двух масштабов;
  // вокруг объектов — утоптанный тёмный грунт; дороги — светлое полотно с тёмной обочиной; отвалы — серые.
  const C = {
    grassLow: new THREE.Color(0x9c9a5a), grassHigh: new THREE.Color(0xd0bf7c),
    grassGreen: new THREE.Color(0x8a9a52), grassBrown: new THREE.Color(0x9c7d50), grassStraw: new THREE.Color(0xdcc98a),
    soil: new THREE.Color(0x6e5e44), dumpSoil: new THREE.Color(0x8f8d87),
    road: new THREE.Color(0xd4c8a8), shoulder: new THREE.Color(0x7e6d52),
    pitGround: new THREE.Color(0x8d8068), far: new THREE.Color(0xc2b57a),
  };
  const tmp = new THREE.Color();
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
  function colorAt(x, y, h, out) {
    const t = Math.min(1, Math.max(0, (h - (farLevel - 15)) / 45));          // низины темнее и зеленее
    out.copy(C.grassLow).lerp(C.grassHigh, t);
    const n1 = smoothNoise(x, y, 520), n2 = smoothNoise(x + 3000, y - 2000, 170);
    if (n1 > 0.55) out.lerp(C.grassBrown, (n1 - 0.55) * 1.4);                 // бурые пятна
    else if (n1 < 0.4) out.lerp(C.grassGreen, (0.4 - n1) * 1.2);               // жёлто-зелёные пятна
    out.lerp(C.grassStraw, (n2 - 0.5) * 0.5);                                   // мелкие соломенные пятна
    const slope = Math.hypot(demAt(x + 25, y) - demAt(x - 25, y), demAt(x, y + 25) - demAt(x, y - 25)) / 50;
    out.multiplyScalar(1 - Math.min(0.22, slope * 1.4));                      // склоны чуть темнее
    const pad = padAt(x, y);
    if (pad) out.lerp(pad.dump ? C.dumpSoil : C.soil, pad.d <= 0 ? 0.92 : 0.92 * (1 - pad.d / PAD_BLEND));
    // у края земли цвет сходит к цвету дальней степи — граница сетки не видна
    const e = AREA_HALF - Math.max(Math.abs(x), Math.abs(y));
    if (e < OUTER_FADE) out.lerp(C.far, 1 - Math.max(0, e / OUTER_FADE));
    const road = roadAt(x, y);
    if (road && road.d < ROAD_SHOULDER + 24) {
      if (road.d <= ROAD_HALF_WIDTH) out.lerp(C.road, 0.95);                 // полотно
      else out.lerp(C.shoulder, 0.75 * Math.max(0, 1 - (road.d - ROAD_HALF_WIDTH) / (ROAD_SHOULDER + 24 - ROAD_HALF_WIDTH)));   // обочина
    }
    return out;
  }

  // --- сетка земли ----------------------------------------------------------------------------
  function buildGround(scene, opts = {}) {
    const ts = opts.toScene || ((x, y, z) => new THREE.Vector3(x, z, -y));
    const group = new THREE.Group();
    group.name = 'terrain';
    const seg = GROUND_SEGMENTS, size = 2 * AREA_HALF;
    const count = (seg + 1) * (seg + 1);
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const idx = [];
    let k = 0, c = 0, u = 0;
    for (let j = 0; j <= seg; j++) {
      const y = -AREA_HALF + size * j / seg;
      for (let i = 0; i <= seg; i++) {
        const x = -AREA_HALF + size * i / seg;
        let h, color;
        if (pit.inside(x, y)) {                              // грубый карьер под моделью уступов: на 30 м ниже берм,
          h = pit.benchHeight(x, y) - 30;                      // чтобы треугольники сетки не прорезали стенки
          color = tmp.copy(C.pitGround);
        } else {
          h = heightAt(x, y);
          color = colorAt(x, y, h, tmp);
        }
        const p = ts(x, y, h);
        pos[k++] = p.x; pos[k++] = p.y; pos[k++] = p.z;
        col[c++] = color.r; col[c++] = color.g; col[c++] = color.b;
        uv[u++] = (x + half) / (2 * half); uv[u++] = (y + half) / (2 * half);
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + 1, cc = a + seg + 1, d = cc + 1;
        idx.push(a, b, cc, b, d, cc);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    ground.name = 'ground';
    group.add(ground);

    // степь до горизонта: ровная плоскость с квадратным отверстием под сетку земли
    const farShape = new THREE.Shape();
    farShape.moveTo(-30000, -30000); farShape.lineTo(30000, -30000); farShape.lineTo(30000, 30000); farShape.lineTo(-30000, 30000); farShape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-AREA_HALF, -AREA_HALF); hole.lineTo(AREA_HALF, -AREA_HALF); hole.lineTo(AREA_HALF, AREA_HALF); hole.lineTo(-AREA_HALF, AREA_HALF); hole.closePath();
    farShape.holes.push(hole);
    const farMesh = new THREE.Mesh(new THREE.ShapeGeometry(farShape, 1), new THREE.MeshLambertMaterial({ color: C.far, side: THREE.DoubleSide }));
    farMesh.rotation.x = -Math.PI / 2;   // Y фигуры (север) → −Z сцены
    farMesh.position.y = ts(0, 0, farLevel - 2).y;
    farMesh.name = 'steppe-far';
    group.add(farMesh);

    // слой «Снимок»: та же земля внутри квадрата данных с текстурой Sentinel-2, чуть выше, по умолчанию скрыт
    const overlay = buildImagery(THREE, ts, meta, half, pit, heightAt);
    overlay.visible = false;
    group.add(overlay);
    group.setImagery = (on) => { overlay.visible = !!on; };
    group.imageryEnabled = () => overlay.visible;
    scene.add(group);
    return group;
  }

  const attribution = {
    dem: meta ? 'Рельеф — Copernicus DEM, карьер — модель по открытым данным. ' + meta.sources.dem.attribution + '.' : '',
    image: meta ? meta.sources.image.attribution + '.' : '',
  };
  return { ok: !!meta, meta, pit, pads, demAt, heightAt, groundAt: heightAt, buildGround, attribution, farLevel, areaHalf: AREA_HALF };
}

// ------------------------------------------------------------------ наложение снимка (6 × 6 км)
function buildImagery(THREE, ts, meta, half, pit, heightAt) {
  const group = new THREE.Group();
  group.name = 'imagery';
  if (!meta) return group;
  const seg = 96, size = 2 * half;
  const pos = new Float32Array((seg + 1) * (seg + 1) * 3), uv = new Float32Array((seg + 1) * (seg + 1) * 2);
  const idx = [];
  let k = 0, u = 0;
  for (let j = 0; j <= seg; j++) {
    const y = -half + size * j / seg;
    for (let i = 0; i <= seg; i++) {
      const x = -half + size * i / seg;
      const z = pit.inside(x, y, 0.985) ? -(pit.depth + 40) : heightAt(x, y) + 0.6;
      const p = ts(x, y, z);
      pos[k++] = p.x; pos[k++] = p.y; pos[k++] = p.z;
      uv[u++] = (x + half) / size; uv[u++] = (y + half) / size;
    }
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  new THREE.TextureLoader().load(TERRAIN_URL + meta.texture.file, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 1; mat.map = tex; mat.needsUpdate = true;
  }, undefined, (err) => console.warn('текстура снимка не загружена', err));
  group.add(new THREE.Mesh(geo, mat));
  return group;
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
    if (o.kind === 'plant' || o.kind === 'substation' || o.kind === 'crusher') {
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
