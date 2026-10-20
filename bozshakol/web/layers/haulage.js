// Слой «транспорт»: самосвалы truck-* и экскаваторы excavator-*, модели — из общей библиотеки
// web/models.js (ctx.models). Положение берётся из признаков x, y, z, курс — heading (градусы,
// 0 = север, по часовой). Между обновлениями (раз в секунду) положение плавно интерполируется.
// Координаты дорог для подсветки закрытых съездов — только из ctx.geometry (ничего не прописано руками).
const NS = 'kz.bozshakol:';
const MOVE_TIME = 1.0;        // с — время доезда до новой цели
const FAR_DISTANCE = 2500;    // м — дальше камеры модель идёт в упрощённой детализации
const ROAD_LIFT_M = 3;        // м — на сколько поднять линию закрытой дороги над полотном

const trucks = {};            // thingId -> {group, from, to, t, hFrom, hTo, lastReal:[x,y,z], odometer}
const excavators = {};        // thingId -> {group, phase}
const roadLines = {};         // road id ("road-ramp-1" и т.п.) -> {line, open}
let selectionLine = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}
function av(twin, a, d) {
  const v = twin && twin.attributes && twin.attributes[a];
  return v === undefined || v === null ? d : v;
}
function headingToRad(deg) {
  // как в исправленном примере договора (contract/README.md, §9): «вперёд» модели = +Z,
  // север сцены = −Z — поэтому Math.PI, а не 0, как было
  return Math.PI - (deg || 0) * Math.PI / 180;
}
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ------------------------------------------------------------------- init
export function init(ctx) {
  // экскаваторы создаём сразу по геометрии — видны ещё до первой телеметрии
  for (const o of ctx.geometry.objects || []) {
    if (o.kind !== 'excavator') continue;
    const id = NS + o.id;
    const g = ctx.models.excavator();
    g.position.copy(ctx.toScene(o.position[0], o.position[1], o.position[2]));
    ctx.group.add(g);
    ctx.register(g, id);
    ctx.label(g, 'Экскаватор ' + o.id.slice(-2), 2);
    excavators[id] = { group: g, phase: 0 };
  }

  // линии закрытых дорог — геометрия одна и та же весь сеанс, строим один раз
  const byRoad = {};
  for (const e of ctx.geometry.edges || []) {
    if (!['road-ramp-1', 'road-ramp-2', 'road-crusher'].includes(e.road)) continue;
    (byRoad[e.road] = byRoad[e.road] || []).push(e);
  }
  for (const [road, edges] of Object.entries(byRoad)) {
    const positions = [];
    for (const e of edges) {
      const a = ctx.geometry.nodes[e.from], b = ctx.geometry.nodes[e.to];
      const pa = ctx.toScene(a[0], a[1], a[2] + ROAD_LIFT_M);
      const pb = ctx.toScene(b[0], b[1], b[2] + ROAD_LIFT_M);
      positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    const geom = new ctx.THREE.BufferGeometry();
    geom.setAttribute('position', new ctx.THREE.Float32BufferAttribute(positions, 3));
    const mat = new ctx.THREE.LineBasicMaterial({ color: 0xe6433a });
    const line = new ctx.THREE.LineSegments(geom, mat);
    line.visible = false;
    ctx.group.add(line);
    roadLines[road] = { line, open: true };
  }

  // линия «выбранный самосвал -> его экскаватор»
  const selGeom = new ctx.THREE.BufferGeometry();
  selGeom.setAttribute('position', new ctx.THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const selMat = new ctx.THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  selectionLine = new ctx.THREE.Line(selGeom, selMat);
  selectionLine.visible = false;
  ctx.group.add(selectionLine);
}

// ----------------------------------------------------------------- update
export function update(ctx, twins) {
  for (const [id, twin] of Object.entries(twins)) {
    if (!id.startsWith(NS)) continue;
    const kind = twin.attributes && twin.attributes.kind;
    if (kind === 'truck') updateTruck(ctx, id, twin);
    else if (kind === 'excavator') updateExcavator(ctx, id, twin);
    else if (kind === 'road') updateRoad(ctx, id, twin);
  }

  // движение и детализация самосвалов
  for (const tr of Object.values(trucks)) {
    if (tr.t < 1) {
      tr.t = Math.min(1, tr.t + ctx.dt / MOVE_TIME);
      tr.group.position.lerpVectors(tr.from, tr.to, tr.t);
      tr.group.rotation.y = lerpAngle(tr.hFrom, tr.hTo, tr.t);
    }
    tr.group.scale.setScalar(ctx.markerScale);
    tr.group.setDetail(tr.group.position.distanceTo(ctx.camera.position) > FAR_DISTANCE ? 'far' : 'full');
  }

  // масштаб и детализация экскаваторов + анимация ковша во время погрузки
  for (const ex of Object.values(excavators)) {
    ex.group.scale.setScalar(ctx.markerScale);
    ex.group.setDetail(ex.group.position.distanceTo(ctx.camera.position) > FAR_DISTANCE ? 'far' : 'full');
    if (ex.loading) {
      ex.phase += ctx.dt;
      ex.group.setSwing(Math.sin(ex.phase * 2.2) * 0.5);
      ex.group.setBoom((Math.sin(ex.phase * 1.6) + 1) / 2);
    } else if (ex.phase !== 0 || ex.group.userData.boomAt0 !== true) {
      ex.phase = 0;
      ex.group.setSwing(0);
      ex.group.setBoom(0);
      ex.group.userData.boomAt0 = true;
    }
  }

  updateSelectionLine(ctx);
}

// -------------------------------------------------------------- самосвал
function updateTruck(ctx, id, twin) {
  let tr = trucks[id];
  const x = fv(twin, 'x', 0), y = fv(twin, 'y', 0), z = fv(twin, 'z', 0);
  const target = ctx.toScene(x, y, z);
  const yaw = headingToRad(fv(twin, 'heading', 0));
  const real = [x, y, z];

  if (!tr) {
    const cls = Number(av(twin, 'capacity_t', 135)) >= 160 ? 180 : 135;
    const g = ctx.models.truck({ cls });
    g.position.copy(target);
    g.rotation.y = yaw;
    ctx.group.add(g);
    ctx.register(g, id);
    ctx.label(g, av(twin, 'name', id.slice(NS.length)), 1);
    tr = trucks[id] = {
      group: g, from: target.clone(), to: target.clone(), t: 1, hFrom: yaw, hTo: yaw,
      lastReal: real, odometer: 0,
    };
  } else {
    const moved = dist3(tr.lastReal, real);
    if (moved > 0.01 && moved < 2000) tr.odometer += moved;   // >2000 м — телепорт/рестарт, в одометр не копим
    tr.lastReal = real;
    if (!tr.to.equals(target) || tr.hTo !== yaw) {
      tr.from.copy(tr.group.position);
      tr.to.copy(target);
      tr.hFrom = tr.group.rotation.y;
      tr.hTo = yaw;
      tr.t = 0;
      if (tr.from.distanceTo(tr.to) > 600) { tr.group.position.copy(target); tr.group.rotation.y = yaw; tr.t = 1; }
    }
  }

  const g = tr.group;
  const state = fv(twin, 'state', '');
  const payload = Number(fv(twin, 'payload', 0)) || 0;
  g.setLoad(payload > 0 ? fv(twin, 'cargo_type', 'none') : 'none');
  g.setDumping(state === 'dumping' ? 1 : 0);
  g.setWheels(tr.odometer);
  g.setState(state);
  g.visible = !(x === 0 && y === 0 && z === 0);   // до первой телеметрии не показываем

  const excavator = fv(twin, 'excavator', '');
  tr.lastExcavatorId = excavator ? NS + excavator : null;
}

// ------------------------------------------------------------- экскаватор
function updateExcavator(ctx, id, twin) {
  let ex = excavators[id];
  if (!ex) {
    const g = ctx.models.excavator();
    ctx.group.add(g);
    ctx.register(g, id);
    ctx.label(g, av(twin, 'name', id.slice(NS.length)), 2);
    ex = excavators[id] = { group: g, phase: 0 };
  }
  const x = fv(twin, 'x', 0), y = fv(twin, 'y', 0), z = fv(twin, 'z', 0);
  if (!(x === 0 && y === 0 && z === 0)) ex.group.position.copy(ctx.toScene(x, y, z));
  const state = fv(twin, 'state', '');
  ex.loading = state === 'loading';
  ex.group.setState(state);
  const q = fv(twin, 'queue', 0);
  const name = av(twin, 'name', id.slice(NS.length));
  ex.group.userData.label = name + (state === 'down' ? ' · авария' : '') + ' · очередь: ' + q;
}

// ------------------------------------------------------------ дороги
function updateRoad(ctx, id, twin) {
  const key = id.slice(NS.length);          // "road-ramp-1" и т.п.
  const rl = roadLines[key];
  if (!rl) return;
  const open = fv(twin, 'open', true);
  if (rl.open !== open) {
    rl.open = open;
    rl.line.visible = !open;
  }
}

// ------------------------------------------------- линия выбранного самосвала
function updateSelectionLine(ctx) {
  const sel = ctx.selected;
  const tr = sel && trucks[sel];
  if (!tr) { selectionLine.visible = false; return; }
  // имя экскаватора лежит в признаке excavator самого самосвала — сохранено при последнем update
  const ex = tr.lastExcavatorId && excavators[tr.lastExcavatorId];
  if (!ex) { selectionLine.visible = false; return; }
  const pos = selectionLine.geometry.attributes.position;
  pos.setXYZ(0, tr.group.position.x, tr.group.position.y, tr.group.position.z);
  pos.setXYZ(1, ex.group.position.x, ex.group.position.y, ex.group.position.z);
  pos.needsUpdate = true;
  selectionLine.visible = true;
}
