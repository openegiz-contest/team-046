// Слой «переработка»: дробилка, конвейер, склады, фабрики, подстанция, отвал.
// Объекты строятся по core/geometry.json, состояние — из двойников модуля processing.
const NS = 'kz.bozshakol';
const objs = {};     // thingId -> {group, kind, ...}
let mats = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}
function fmtNum(v, digits) {
  return Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export function init(ctx) {
  const THREE = ctx.THREE, c = ctx.colors;
  const lam = (col) => new THREE.MeshLambertMaterial({ color: col });
  mats = {
    building: lam(c.building), roof: lam(c.roof), conveyor: lam(c.conveyor), dark: lam(0x5c5c5c),
    crusher: lam(0x7d8692), crusherStop: lam(c.down), dump: lam(c.dump),
    pileOre: lam(c.stockpileOre), pileClay: lam(c.stockpileClay), substation: lam(0xc9c3b5), mill: lam(0x9aa5b3),
  };
  const P = (o) => ctx.toScene(o.position[0], o.position[1], o.position[2]);

  for (const o of ctx.geometry.objects || []) {
    const id = NS + ':' + o.id;
    let g = null, rec = { kind: o.kind };
    if (o.kind === 'conveyor' && o.path && o.path.length >= 2) {
      const a = ctx.toScene(...o.path[0]), b = ctx.toScene(...o.path[o.path.length - 1]);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.BoxGeometry(8, 3, len), mats.conveyor);
      m.position.copy(a).add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 6, 0));
      m.lookAt(b.clone().add(new THREE.Vector3(0, 6, 0)));
      g = new THREE.Group(); g.add(m);
      rec.belt = m;
      const mid = a.clone().lerp(b, 0.5); mid.y += 8;
      const anchor = new THREE.Object3D(); anchor.position.copy(mid); g.add(anchor);
      rec.labelObj = anchor;
    } else if (o.kind === 'crusher') {
      g = new THREE.Group(); g.position.copy(P(o));
      const body = new THREE.Mesh(new THREE.BoxGeometry(40, 24, 30), mats.crusher); body.position.y = 12;
      const funnel = new THREE.Mesh(new THREE.ConeGeometry(18, 18, 20, 1, true), mats.dark);
      funnel.position.y = 33; funnel.rotation.x = Math.PI;      // воронка остриём вниз
      g.add(body, funnel);
      rec.body = body; rec.labelObj = g; rec.dy = 48;
    } else if (o.kind === 'stockpile') {
      g = new THREE.Group(); g.position.copy(P(o));
      const r = o.radius || 50;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 40, 28), o.id.includes('clay') ? mats.pileClay : mats.pileOre);
      cone.position.y = 20;
      g.add(cone);
      rec.cone = cone; rec.radius = r; rec.labelObj = g; rec.dy = 90;
    } else if (o.kind === 'plant') {
      g = new THREE.Group(); g.position.copy(P(o));
      const [l, w, h] = o.size || [100, 60, 20];
      const body = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), mats.building); body.position.y = h / 2;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(l + 4, 2, w + 4), mats.roof); roof.position.y = h + 1;
      g.add(body, roof);
      rec.body = body; rec.labelObj = g; rec.dy = h + 16;
    } else if (o.kind === 'mill') {
      g = new THREE.Group(); g.position.copy(P(o));
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 14, 16), mats.mill);
      drum.rotation.z = Math.PI / 2; drum.position.y = 36;   // над фабрикой, чтобы было видно
      g.add(drum);
      rec.body = drum; rec.labelObj = g; rec.dy = 48; rec.small = true;
    } else if (o.kind === 'flotation') {
      g = new THREE.Group(); g.position.copy(P(o));
      for (let i = 0; i < 4; i++) {
        const cell = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 8), mats.mill);
        cell.position.set(i * 10 - 15, 33, 0); g.add(cell);
      }
      rec.labelObj = g; rec.dy = 42; rec.small = true;
    } else if (o.kind === 'substation') {
      g = new THREE.Group(); g.position.copy(P(o));
      const [l, w, h] = o.size || [60, 40, 10];
      const body = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), mats.substation); body.position.y = h / 2;
      const mast = new THREE.Mesh(new THREE.BoxGeometry(2, 30, 2), mats.dark); mast.position.set(l / 2 - 5, 15, 0);
      g.add(body, mast);
      rec.labelObj = g; rec.dy = 36; rec.small = true;
    } else if (o.kind === 'dump') {
      g = new THREE.Group(); g.position.copy(P(o));
      const r = o.radius || 200;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 30, 36), mats.dump); cone.position.y = 15;
      g.add(cone);
      rec.labelObj = g; rec.dy = 40;
    }
    if (!g) continue;
    ctx.group.add(g);
    ctx.register(g, id);
    rec.group = g;
    rec.label = ctx.label(rec.labelObj || g, o.id, { dy: rec.dy || 20, small: !!rec.small });
    objs[id] = rec;
  }
}

export function update(ctx, twins) {
  for (const [id, rec] of Object.entries(objs)) {
    const twin = twins[id];
    if (!twin) continue;
    const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
    const lo = rec.labelObj || rec.group;
    const state = fv(twin, 'state', '');
    // «idle» — простой без аварии (нет руды), красным красим только реальную остановку
    const stopped = ['stopped', 'stop', 'down', 'maintenance', 'off', 'failed'].includes(state);
    const idleTxt = state === 'idle' ? ' · простой' : (stopped ? ' · стоит' : '');
    if (rec.kind === 'crusher') {
      const accepting = fv(twin, 'accepting', true) !== false;
      const m = (stopped || !accepting) ? mats.crusherStop : mats.crusher;
      if (rec.body.material !== m) rec.body.material = m;
      lo.userData.label = name + (accepting ? '' : ' · не принимает') + idleTxt + ' · ' + fmtNum(fv(twin, 'throughput', 0), 0) + ' т/ч · очередь: ' + fv(twin, 'trucks_queued', 0);
    } else if (rec.kind === 'stockpile') {
      const cap = Number(twin.attributes && twin.attributes.capacity_t) || 100000;
      const stock = Number(fv(twin, 'stock', 0)) || 0;
      const h = 20 + 60 * Math.max(0, Math.min(1, stock / cap));   // высота 20–80 м
      rec.cone.scale.y = h / 40; rec.cone.position.y = h / 2;
      const q = fv(twin, 'trucks_queued', null);
      lo.userData.label = name + ' · ' + fmtNum(stock / 1000, 1) + ' тыс. т' + (q !== null ? ' · очередь: ' + q : '');
    } else if (rec.kind === 'plant') {
      lo.userData.label = name + idleTxt + ' · ' + fmtNum(fv(twin, 'feed_rate', 0), 0) + ' т/ч · план ' + fmtNum(fv(twin, 'plan_fulfilment', 0), 0) + ' %';
    } else if (rec.kind === 'conveyor') {
      lo.userData.label = name + idleTxt + ' · ' + fmtNum(fv(twin, 'throughput', 0), 0) + ' т/ч';
    } else if (rec.kind === 'mill') {
      lo.userData.label = name + (stopped ? ' · ТО' : (state === 'idle' ? ' · простой' : '')) + ' · ' + fmtNum(fv(twin, 'throughput', 0), 0) + ' т/ч';
    } else if (rec.kind === 'flotation') {
      lo.userData.label = name + ' · извлечение ' + fmtNum(fv(twin, 'recovery', 0), 1) + ' %';
    } else if (rec.kind === 'substation') {
      lo.userData.label = name + ' · ' + fmtNum(fv(twin, 'load', 0), 1) + ' МВт';
    } else if (rec.kind === 'dump') {
      lo.userData.label = name + ' · ' + fmtNum(Number(fv(twin, 'received_total', 0)) / 1000, 1) + ' тыс. т';
    } else {
      lo.userData.label = name;
    }
  }
}
