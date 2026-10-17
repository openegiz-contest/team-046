// Слой «транспорт»: самосвалы truck-* и экскаваторы excavator-*.
// Положение берётся из признаков x, y, z, курс — heading (градусы, 0 = север, по часовой).
// Между обновлениями (раз в секунду) положение плавно интерполируется.
const NS = 'kz.bozshakol';
const MOVE_TIME = 1.0;       // с — время доезда до новой цели
const TRUCK_SCALE = 1.8;

const trucks = {};           // thingId -> {group, bed, cab, from, to, t, hFrom, hTo}
const excavators = {};       // thingId -> {group, house}
let mats = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}

function makeMaterials(THREE, colors) {
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  return {
    chassis: lam(0x4a4a4a), cab: lam(0xf4f1e8), wheel: lam(0x222222),
    bed: { sulphide: lam(colors.sulphide), clay: lam(colors.clay), waste: lam(colors.waste), empty: lam(colors.empty), down: lam(colors.down) },
    exc: lam(colors.excavator), excDark: lam(0xb0771a), excDown: lam(colors.down), boom: lam(0x5a5a5a),
  };
}

// Самосвал: рама + кабина + кузов, вперёд — локальная ось +Z
function makeTruck(THREE) {
  const g = new THREE.Group();
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.5, 2, 12), mats.chassis);
  chassis.position.y = 1.5;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 3.5), mats.cab);
  cab.position.set(0, 4, 4);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(7, 3.2, 8), mats.bed.empty);
  bed.position.set(0, 4.2, -1.8);
  g.add(chassis, cab, bed);
  g.scale.setScalar(TRUCK_SCALE);
  return { group: g, bed, cab };
}

// Экскаватор: гусеничная база + поворотная платформа + стрела
function makeExcavator(THREE) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 12), mats.excDark);
  base.position.y = 1.5;
  const house = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 10), mats.exc);
  house.position.set(0, 6, -1);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 18), mats.boom);
  boom.position.set(0, 11, 9);
  boom.rotation.x = -Math.PI / 5;
  const stick = new THREE.Mesh(new THREE.BoxGeometry(1.2, 10, 1.2), mats.boom);
  stick.position.set(0, 9, 16.5);
  g.add(base, house, boom, stick);
  g.scale.setScalar(1.6);
  return { group: g, house };
}

function headingToYaw(deg) {
  // курс 0 = север (scene −Z), 90 = восток (+X); у Object3D rotation.y=φ поворачивает +Z в (sin φ, 0, cos φ)
  const h = (deg || 0) * Math.PI / 180;
  return Math.atan2(Math.sin(h), -Math.cos(h));
}
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function init(ctx) {
  mats = makeMaterials(ctx.THREE, ctx.colors);
  // экскаваторы создаём сразу по геометрии, чтобы они были видны до первого обновления
  for (const o of ctx.geometry.objects || []) {
    if (o.kind !== 'excavator') continue;
    const id = NS + ':' + o.id;
    const e = makeExcavator(ctx.THREE);
    e.group.position.copy(ctx.toScene(o.position[0], o.position[1], o.position[2]));
    e.group.rotation.y = Math.PI / 2;
    ctx.group.add(e.group);
    ctx.register(e.group, id);
    ctx.label(e.group, 'Экскаватор ' + o.id.slice(-2), { dy: 26 });
    excavators[id] = e;
  }
}

export function update(ctx, twins) {
  const THREE = ctx.THREE;
  for (const [id, twin] of Object.entries(twins)) {
    if (!id.startsWith(NS + ':')) continue;
    const kind = twin.attributes && twin.attributes.kind;
    if (kind === 'truck' || id.includes(':truck-')) updateTruck(ctx, id, twin);
    else if (kind === 'excavator' || id.includes(':excavator-')) updateExcavator(ctx, id, twin);
  }
  // движение самосвалов
  for (const tr of Object.values(trucks)) {
    if (tr.t < 1) {
      tr.t = Math.min(1, tr.t + ctx.dt / MOVE_TIME);
      tr.group.position.lerpVectors(tr.from, tr.to, tr.t);
      tr.group.rotation.y = lerpAngle(tr.hFrom, tr.hTo, tr.t);
    }
  }
}

function updateTruck(ctx, id, twin) {
  let tr = trucks[id];
  const x = fv(twin, 'x', 0), y = fv(twin, 'y', 0), z = fv(twin, 'z', 0);
  const target = ctx.toScene(x, y, z);
  const yaw = headingToYaw(fv(twin, 'heading', 0));
  if (!tr) {
    const t = makeTruck(ctx.THREE);
    t.group.position.copy(target); t.group.rotation.y = yaw;
    ctx.group.add(t.group); ctx.register(t.group, id);
    tr = trucks[id] = { group: t.group, bed: t.bed, from: target.clone(), to: target.clone(), t: 1, hFrom: yaw, hTo: yaw };
  } else if (!tr.to.equals(target) || tr.hTo !== yaw) {
    tr.from.copy(tr.group.position); tr.to.copy(target);
    tr.hFrom = tr.group.rotation.y; tr.hTo = yaw; tr.t = 0;
    // далёкий «телепорт» (> 600 м) — не тянем, ставим сразу
    if (tr.from.distanceTo(tr.to) > 600) { tr.group.position.copy(target); tr.group.rotation.y = yaw; tr.t = 1; }
  }
  // цвет кузова
  const state = fv(twin, 'state', '');
  const payload = Number(fv(twin, 'payload', 0)) || 0;
  let m = mats.bed.empty;
  if (state === 'down') m = mats.bed.down;
  else if (payload > 0) m = mats.bed[fv(twin, 'cargo_type', 'empty')] || mats.bed.empty;
  if (tr.bed.material !== m) tr.bed.material = m;
  tr.group.visible = !(x === 0 && y === 0 && z === 0);   // до первой телеметрии не показываем
}

function updateExcavator(ctx, id, twin) {
  let e = excavators[id];
  if (!e) {
    e = makeExcavator(ctx.THREE);
    ctx.group.add(e.group); ctx.register(e.group, id);
    ctx.label(e.group, (twin.attributes && twin.attributes.name) || id, { dy: 26 });
    excavators[id] = e;
  }
  const x = fv(twin, 'x', 0), y = fv(twin, 'y', 0), z = fv(twin, 'z', 0);
  if (!(x === 0 && y === 0 && z === 0)) e.group.position.copy(ctx.toScene(x, y, z));
  const down = fv(twin, 'state', '') === 'down';
  const m = down ? mats.excDown : mats.exc;
  if (e.house.material !== m) e.house.material = m;
  const q = fv(twin, 'queue', 0);
  const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
  e.group.userData.label = name + (down ? ' · авария' : '') + ' · очередь: ' + q;
}
