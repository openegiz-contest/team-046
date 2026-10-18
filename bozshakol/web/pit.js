// Карьер: модель уступов по geometry.json (pit: полуоси, число уступов, высота уступа, отступ).
// Стенки уступов — рыже-серая порода, бермы — светлее; на бермах и дне — приглушённый оттенок
// руды вокруг забоев (сульфидная зона, глинистая, вскрыша — цвета договора). Верхняя кромка
// повторяет высоту рельефа (terrain.demAt), поэтому борт переходит в степь без щелей и ступенек.
// Съезды (road-ramp-*) — с отбойными валами по внутреннему краю.
//
//   buildPit(THREE, geometry, terrain, toScene, colors, faces) -> THREE.Group
//   faces: [{ x, y, ore: 'sulphide'|'clay'|'waste' }] — забои для оттенка руды (из geometry.objects)

const SEGMENTS = 64;

export function buildPit(THREE, geometry, terrain, toScene, colors, faces) {
  const pit = terrain.pit;
  const group = new THREE.Group();
  group.name = 'pit';
  const wallColors = [new THREE.Color(0x8c6650), new THREE.Color(0x7b6a60)];     // порода: рыжая / серая
  const bermColors = [new THREE.Color(0xb6a483), new THREE.Color(0xa99877)];
  const floorColor = new THREE.Color(0x9a8f74);
  const oreColors = { sulphide: new THREE.Color(colors.sulphide), clay: new THREE.Color(colors.clay), waste: new THREE.Color(colors.waste) };
  const tmp = new THREE.Color();

  function ring(k) {                                     // точки эллипса уступа k (в координатах рудника)
    const ak = pit.a - k * pit.inset, bk = pit.b - k * pit.inset;
    const pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / SEGMENTS * Math.PI * 2;
      pts.push([ak * Math.cos(t), bk * Math.sin(t)]);
    }
    return pts;
  }
  // оттенок руды: ближайший забой в радиусе 600 м даёт до 35 % своего цвета
  function tint(base, x, y, strength = 0.35) {
    tmp.copy(base);
    let best = null;
    for (const f of faces) {
      const d = Math.hypot(x - f.x, y - f.y);
      if (d < 600 && (best === null || d < best.d)) best = { d, ore: f.ore };
    }
    if (best && oreColors[best.ore]) tmp.lerp(oreColors[best.ore], strength * (1 - best.d / 600));
    return tmp;
  }
  function addStrip(outer, inner, zOuter, zInner, baseColor, ore) {
    // zOuter/zInner — число или функция (x, y) -> z
    const pos = [], col = [], idx = [];
    const zo = (p) => typeof zOuter === 'function' ? zOuter(p[0], p[1]) : zOuter;
    const zi = (p) => typeof zInner === 'function' ? zInner(p[0], p[1]) : zInner;
    for (let i = 0; i < SEGMENTS; i++) {
      const po = toScene(outer[i][0], outer[i][1], zo(outer[i]));
      const pi = toScene(inner[i][0], inner[i][1], zi(inner[i]));
      pos.push(po.x, po.y, po.z, pi.x, pi.y, pi.z);
      const c1 = ore ? tint(baseColor, outer[i][0], outer[i][1]) : tmp.copy(baseColor);
      col.push(c1.r, c1.g, c1.b);
      const c2 = ore ? tint(baseColor, inner[i][0], inner[i][1]) : tmp.copy(baseColor);
      col.push(c2.r, c2.g, c2.b);
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
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
    group.add(mesh);
    return mesh;
  }
  function addContour(pts, z, color) {
    const v = pts.map(([x, y]) => toScene(x, y, (typeof z === 'function' ? z(x, y) : z) + 0.5));
    v.push(v[0].clone());
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color })));
  }

  const rimZ = (x, y) => terrain.demAt(x, y);            // верхняя кромка — по рельефу
  let prev = ring(0);
  for (let k = 0; k < pit.count; k++) {
    const next = ring(k + 1);
    const zTop = -k * pit.h, zBot = -(k + 1) * pit.h;
    if (k === 0) {
      addStrip(prev, next, rimZ, 0, bermColors[0], false);                  // откос от борта к первой берме
    } else {
      addStrip(prev, next, zTop, zTop, bermColors[k % 2], true);            // берма (площадка)
    }
    addStrip(next, next, zTop, zBot, wallColors[k % 2], false);             // стенка уступа
    addContour(prev, k === 0 ? rimZ : zTop, 0x4a3418);
    prev = next;
  }
  // дно
  const bottom = prev;
  {
    const shape = new THREE.Shape(bottom.map(([x, y]) => new THREE.Vector2(x, -y)));
    const geo = new THREE.ShapeGeometry(shape, 1);
    const colArr = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const c = tint(floorColor, p.getX(i), -p.getY(i), 0.45);
      colArr.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    const floor = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = toScene(0, 0, -pit.depth).y;
    group.add(floor);
    addContour(bottom, -pit.depth, 0x4a3418);
  }
  // отбойные валы вдоль съездов (по внутреннему краю, к центру карьера)
  const nodes = geometry.nodes;
  const bermMat = new THREE.MeshLambertMaterial({ color: 0x6b5a48, flatShading: true });
  for (const e of geometry.edges) {
    if (!e.road.startsWith('road-ramp')) continue;
    const A = nodes[e.from], B = nodes[e.to];
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const toCenter = Math.atan2(-my, -mx);
    const ox = 14 * Math.cos(toCenter), oy = 14 * Math.sin(toCenter);
    const pa = toScene(A[0] + ox, A[1] + oy, A[2] + 1), pb = toScene(B[0] + ox, B[1] + oy, B[2] + 1);
    const len = pa.distanceTo(pb);
    const berm = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, len), bermMat);
    berm.position.copy(pa).lerp(pb, 0.5);
    berm.lookAt(pb);
    group.add(berm);
  }
  return group;
}
