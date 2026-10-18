// Карьер: модель уступов по geometry.json (pit: полуоси, число уступов, высота уступа, отступ).
// Каждый уступ — ступень: светлая плоская берма (площадка) и крутая стенка (≈ 58°, как в паспорте
// карьера) из рыже-серой породы, затенённая по направлению на солнце (юго-запад). Верхняя кромка
// повторяет высоту рельефа (terrain.demAt), поэтому борт переходит в степь без щелей и ступенек.
// На дне — пятна руды по зонам забоев (приглушённые цвета договора). Съезды (road-ramp-*) —
// с отбойными валами по внутреннему краю.
//
//   buildPit(THREE, geometry, terrain, toScene, colors, faces) -> THREE.Group
//   faces: [{ x, y, ore: 'sulphide'|'clay'|'waste' }] — забои для оттенка руды (из geometry.objects)

const SEGMENTS = 72;
const SUN = [-0.7, -0.7];                 // направление на солнце в плане (юго-запад), как у света сцены

export function buildPit(THREE, geometry, terrain, toScene, colors, faces) {
  const pit = terrain.pit;
  const group = new THREE.Group();
  group.name = 'pit';
  const bermW = 12;                                    // ширина бермы, м; остальное отступа — заложение стенки
  const wallRun = Math.max(4, pit.inset - bermW);      // горизонтальное заложение стенки (≈ 9,4 м при 58°)
  const bermColor = new THREE.Color(0xcfc0a0);
  const wallRust = new THREE.Color(0x8a5f45), wallGrey = new THREE.Color(0x6f6762);
  const floorColor = new THREE.Color(0xa09482);
  const oreColors = { sulphide: new THREE.Color(colors.sulphide), clay: new THREE.Color(colors.clay), waste: new THREE.Color(colors.waste) };
  const tmp = new THREE.Color();

  function ring(inset) {                               // точки эллипса, отступившего внутрь на inset (м)
    const ak = pit.a - inset, bk = pit.b - inset;
    const pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / SEGMENTS * Math.PI * 2;
      pts.push([ak * Math.cos(t), bk * Math.sin(t)]);
    }
    return pts;
  }
  // освещённость стенки: внутренняя нормаль эллипса против направления на солнце
  function wallShade(x, y) {
    const nx = -x / (pit.a * pit.a), ny = -y / (pit.b * pit.b);
    const n = Math.hypot(nx, ny) || 1;
    const d = (nx / n) * SUN[0] + (ny / n) * SUN[1];
    return 0.72 + 0.4 * Math.max(0, d);
  }
  // оттенок руды: ближайший забой в радиусе 500 м
  function tint(base, x, y, strength) {
    tmp.copy(base);
    let best = null;
    for (const f of faces) {
      const d = Math.hypot(x - f.x, y - f.y);
      if (d < 500 && (best === null || d < best.d)) best = { d, ore: f.ore };
    }
    if (best && oreColors[best.ore]) tmp.lerp(oreColors[best.ore], strength * (1 - best.d / 500));
    return tmp;
  }
  function addStrip(outer, inner, zOuter, zInner, colorFn) {
    const pos = [], col = [], idx = [];
    const zo = (p) => typeof zOuter === 'function' ? zOuter(p[0], p[1]) : zOuter;
    const zi = (p) => typeof zInner === 'function' ? zInner(p[0], p[1]) : zInner;
    for (let i = 0; i < SEGMENTS; i++) {
      const po = toScene(outer[i][0], outer[i][1], zo(outer[i]));
      const pi = toScene(inner[i][0], inner[i][1], zi(inner[i]));
      pos.push(po.x, po.y, po.z, pi.x, pi.y, pi.z);
      const c1 = colorFn(outer[i][0], outer[i][1]); col.push(c1.r, c1.g, c1.b);
      const c2 = colorFn(inner[i][0], inner[i][1]); col.push(c2.r, c2.g, c2.b);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = 2 * i, b = 2 * i + 1, c = 2 * ((i + 1) % SEGMENTS), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    group.add(mesh);
    return mesh;
  }

  const rimZ = (x, y) => terrain.demAt(x, y);          // верхняя кромка — по рельефу
  const bermFn = () => tmp.copy(bermColor);
  for (let k = 0; k < pit.count; k++) {
    const zTop = -k * pit.h;
    const zBot = k === pit.count - 1 ? -pit.depth : -(k + 1) * pit.h;
    const outer = ring(k * pit.inset);                 // наружная кромка бермы k
    const crest = ring(k * pit.inset + bermW);         // бровка стенки
    const toe = ring((k + 1) * pit.inset);             // подошва стенки = кромка следующей бермы
    // берма (у первого уступа — откос от борта на высоте рельефа к отметке 0)
    addStrip(outer, crest, k === 0 ? rimZ : zTop, zTop, bermFn);
    // стенка: рыжая порода вверху, серая внизу; темнее на теневой стороне
    const rock = tmp.clone().copy(wallRust).lerp(wallGrey, k / Math.max(1, pit.count - 1));
    addStrip(crest, toe, zTop, zBot, (x, y) => tmp.copy(rock).multiplyScalar(wallShade(x, y)));
  }
  // дно: пятна руды по зонам забоев
  const bottom = ring(pit.count * pit.inset);
  {
    const shape = new THREE.Shape(bottom.map(([x, y]) => new THREE.Vector2(x, -y)));
    const geo = new THREE.ShapeGeometry(shape, 1);
    const colArr = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const c = tint(floorColor, p.getX(i), -p.getY(i), 0.55);
      colArr.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    const floor = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = toScene(0, 0, -pit.depth).y;
    group.add(floor);
    // пятна руды крупнее: диски вокруг забоев на дне и бермах
    for (const f of faces) {
      if (!oreColors[f.ore]) continue;
      const z = terrain.heightAt(f.x, f.y);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(140, 24),
        new THREE.MeshLambertMaterial({ color: tmp.copy(floorColor).lerp(oreColors[f.ore], 0.5).getHex() }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.copy(toScene(f.x, f.y, z + 0.4));
      group.add(disc);
    }
  }
  // отбойные валы вдоль съездов (по внутреннему краю, к центру карьера)
  const nodes = geometry.nodes;
  const bermMat = new THREE.MeshLambertMaterial({ color: 0x5e4d3b });
  for (const e of geometry.edges) {
    if (!e.road.startsWith('road-ramp')) continue;
    const A = nodes[e.from], B = nodes[e.to];
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const toCenter = Math.atan2(-my, -mx);
    const ox = 28 * Math.cos(toCenter), oy = 28 * Math.sin(toCenter);
    const pa = toScene(A[0] + ox, A[1] + oy, A[2] + 1.5), pb = toScene(B[0] + ox, B[1] + oy, B[2] + 1.5);
    const len = pa.distanceTo(pb);
    const berm = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, len), bermMat);
    berm.position.copy(pa).lerp(pb, 0.5);
    berm.lookAt(pb);
    group.add(berm);
  }
  return group;
}
