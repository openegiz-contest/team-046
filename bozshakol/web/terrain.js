// Рельеф вокруг карьера: Copernicus DEM GLO-30 (высоты) и снимок Sentinel-2 (текстура)
// из bozshakol/data/terrain (отдаются nginx по /terrain/). Карьер — модель уступов из
// geometry.json, вписанная в контур; внутри контура рельеф не рисуется.
//
// Интерфейс (см. contract/README.md, раздел 9):
//   loadTerrain(THREE, geometry) -> { ok, heightAt(x, y), buildGround(scene, {toScene, color}), attribution, meta }
//   heightAt — высота поверхности (м, координаты рудника): вне карьера — рельеф, у наземных дорог —
//   профиль дороги (чтобы техника шла по поверхности), внутри карьера — бермы модели уступов.

const TERRAIN_URL = './terrain/';
const GROUND_SEGMENTS = 120;           // 120 × 120 × 2 ≈ 29 тыс. треугольников
const ROAD_HALF_WIDTH = 40;            // м: в этой полосе высота = профиль дороги
const ROAD_BLEND = 160;                // м: плавный переход к рельефу

export async function loadTerrain(THREE, geometry) {
  const pit = pitModel(geometry);
  const roads = surfaceRoads(geometry);
  let meta = null, heights = null;
  try {
    meta = await (await fetch(TERRAIN_URL + 'terrain.json')).json();
    const buf = await (await fetch(TERRAIN_URL + meta.heights.file)).arrayBuffer();
    heights = new Int16Array(buf);
    if (heights.length !== meta.heights.n * meta.heights.n) throw new Error('размер heights.bin не совпадает с terrain.json');
  } catch (err) {
    console.warn('рельеф не загружен, поверхность плоская:', err);
    meta = null;
  }

  const n = meta ? meta.heights.n : 0;
  const step = meta ? meta.heights.step_m : 30;
  const half = meta ? meta.half_m : 3000;

  function demAt(x, y) {
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

  const EDGE_FADE = 500;   // м: у края квадрата данных рельеф плавно сходит к уровню дальней степи
  const farLevel = meta ? meta.heights.min_m - 1 : -1;
  function edgeWeight(x, y) {
    const d = half - Math.max(Math.abs(x), Math.abs(y));
    return d >= EDGE_FADE ? 0 : 1 - d / EDGE_FADE;
  }
  function heightAt(x, y) {
    if (pit.inside(x, y)) return pit.benchHeight(x, y);
    let h = demAt(x, y);
    const w = edgeWeight(x, y);
    if (w > 0) h = h * (1 - w) + farLevel * w;
    // у наземных дорог поверхность подтягивается к профилю дороги (выемка/насыпь)
    let best = null;
    for (const r of roads) {
      const d = r.distance(x, y);
      if (d < ROAD_BLEND && (best === null || d < best.d)) best = { d, z: r.zAt(x, y) };
    }
    if (best) {
      const w = best.d <= ROAD_HALF_WIDTH ? 1 : 1 - (best.d - ROAD_HALF_WIDTH) / (ROAD_BLEND - ROAD_HALF_WIDTH);
      h = h * (1 - w) + best.z * w;
    }
    return h;
  }

  function buildGround(scene, opts = {}) {
    const ts = opts.toScene || ((x, y, z) => new THREE.Vector3(x, z, -y));
    const group = new THREE.Group();
    group.name = 'terrain';
    const seg = GROUND_SEGMENTS, size = 2 * half;
    const pos = new Float32Array((seg + 1) * (seg + 1) * 3);
    const uv = new Float32Array((seg + 1) * (seg + 1) * 2);
    const col = new Float32Array((seg + 1) * (seg + 1) * 3);
    const idx = [];
    let k = 0, u = 0;
    for (let j = 0; j <= seg; j++) {
      const y = -half + size * j / seg;
      for (let i = 0; i <= seg; i++) {
        const x = -half + size * i / seg;
        // внутри карьера сетка уходит под дно: карьер рисует общая сцена (уступы)
        const z = pit.inside(x, y, 0.97) ? -(pit.depth + 40) : heightAt(x, y);
        const p = ts(x, y, z);
        pos[k++] = p.x; pos[k++] = p.y; pos[k++] = p.z;
        const w = edgeWeight(x, y);           // у края — темнее, в тон дальней степи
        col[(k / 3 - 1) * 3] = col[(k / 3 - 1) * 3 + 1] = col[(k / 3 - 1) * 3 + 2] = 1 - 0.35 * w;
        uv[u++] = (x + half) / size; uv[u++] = (y + half) / size;
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);   // против часовой при взгляде сверху — лицевая сторона вверх
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, vertexColors: true });
    if (meta) {
      new THREE.TextureLoader().load(TERRAIN_URL + meta.texture.file, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 1;
        mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true;
      }, undefined, (err) => console.warn('текстура рельефа не загружена', err));
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain-mesh';
    group.add(mesh);
    // степь дальше квадрата данных: плоская, в тон, с отверстием под карьер (чтобы не закрывать уступы)
    const shape = new THREE.Shape();
    shape.moveTo(-20000, -20000); shape.lineTo(20000, -20000); shape.lineTo(20000, 20000); shape.lineTo(-20000, 20000); shape.closePath();
    const hole = new THREE.Path(); hole.absellipse(0, 0, pit.a * 1.01, pit.b * 1.01, 0, Math.PI * 2, false, 0);
    shape.holes.push(hole);
    // цвет дальней степи — средний цвет края снимка, чтобы граница квадрата не бросалась в глаза
    const far = new THREE.Mesh(new THREE.ShapeGeometry(shape, 48), new THREE.MeshLambertMaterial({ color: 0x807a5e }));
    far.rotation.x = -Math.PI / 2;   // Y фигуры (север) → −Z сцены
    const base = ts(0, 0, meta ? meta.heights.min_m - 1 : -1);
    far.position.y = base.y;
    group.add(far);
    scene.add(group);
    return group;
  }

  const attribution = meta
    ? 'Рельеф — Copernicus DEM, карьер — модель по открытым данным. ' +
      meta.sources.dem.attribution + '. ' + meta.sources.image.attribution + '.'
    : '';
  return { ok: !!meta, heightAt, demAt, buildGround, attribution, meta, pit };
}

// ---------------------------------------------------------------- карьер (модель уступов)
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
    return Math.max(-depth, -level * h);
  }
  return { inside, benchHeight, depth, a, b };
}

// ---------------------------------------------------------------- наземные дороги
function surfaceRoads(geometry) {
  const nodes = geometry.nodes;
  const out = [];
  for (const e of geometry.edges) {
    const A = nodes[e.from], B = nodes[e.to];
    if (!A || !B) continue;
    if (e.road !== 'rim' && e.road !== 'road-crusher') continue;   // только дороги на поверхности
    const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy || 1;
    out.push({
      distance(x, y) {
        const t = Math.min(1, Math.max(0, ((x - A[0]) * dx + (y - A[1]) * dy) / len2));
        return Math.hypot(x - (A[0] + dx * t), y - (A[1] + dy * t));
      },
      zAt(x, y) {
        const t = Math.min(1, Math.max(0, ((x - A[0]) * dx + (y - A[1]) * dy) / len2));
        return A[2] + (B[2] - A[2]) * t;
      },
    });
  }
  return out;
}
