// Слой «геология»: забои face-* (плоские площадки, цвет по типу руды) и буровые станки drill-*.
const NS = 'kz.bozshakol';
const faces = {};    // thingId -> {mesh, baseY}
const drills = {};   // thingId -> group
let mats = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}
function fmtNum(v, digits) {
  return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function makeDrill(THREE) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 8), mats.drill);
  body.position.y = 2;
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.6, 20, 1.6), mats.mast);
  mast.position.set(0, 12, 3);
  g.add(body, mast);
  g.scale.setScalar(1.8);
  return g;
}

export function init(ctx) {
  const THREE = ctx.THREE, c = ctx.colors;
  const lam = (col) => new THREE.MeshLambertMaterial({ color: col });
  mats = {
    face: { sulphide: lam(c.sulphide), clay: lam(c.clay), waste: lam(c.waste) },
    drill: lam(c.drill), mast: lam(0x8a97a8),
  };
  for (const o of ctx.geometry.objects || []) {
    const id = NS + ':' + o.id;
    if (o.kind === 'face') {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), mats.face[o.ore_type] || mats.face.waste);
      mesh.rotation.x = -Math.PI / 2;
      const p = ctx.toScene(o.position[0], o.position[1], o.position[2]);
      mesh.position.set(p.x, p.y + 1, p.z);
      ctx.group.add(mesh);
      ctx.register(mesh, id);
      ctx.label(mesh, 'Забой ' + o.id.slice(-2), { dy: 10 });
      faces[id] = { mesh, baseY: p.y + 1 };
    } else if (o.kind === 'drill') {
      const g = makeDrill(THREE);
      g.position.copy(ctx.toScene(o.position[0], o.position[1], o.position[2]));
      ctx.group.add(g);
      ctx.register(g, id);
      ctx.label(g, 'Буровой станок ' + o.id.slice(-2), { dy: 40, small: true });
      drills[id] = g;
    }
  }
}

export function update(ctx, twins) {
  for (const [id, rec] of Object.entries(faces)) {
    const twin = twins[id];
    if (!twin) continue;
    const ore = fv(twin, 'ore_type', 'waste');
    const m = mats.face[ore] || mats.face.waste;
    if (rec.mesh.material !== m) rec.mesh.material = m;
    const blasted = fv(twin, 'blasted', false) === true;
    rec.mesh.position.y = rec.baseY + (blasted ? 3 : 0);   // взорванный забой чуть выше
    const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
    const clay = fv(twin, 'clay_pct', null);
    let text = name + ' · ' + fmtNum(fv(twin, 'cu_grade', 0), 2) + ' % Cu';
    if (ore === 'clay' && clay !== null) text += ' · глина ' + fmtNum(clay, 0) + ' %';
    if (!blasted) text += ' · не взорван';
    rec.mesh.userData.label = text;
  }
  for (const [id, g] of Object.entries(drills)) {
    const twin = twins[id];
    if (!twin) continue;
    const x = fv(twin, 'x', 0), y = fv(twin, 'y', 0), z = fv(twin, 'z', 0);
    if (!(x === 0 && y === 0 && z === 0)) g.position.copy(ctx.toScene(x, y, z));
    const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
    const state = fv(twin, 'state', '');
    const stateRu = { drilling: 'бурение', moving: 'переезд', idle: 'простой', down: 'авария' }[state] || state;
    g.userData.label = name + (stateRu ? ' · ' + stateRu : '');
  }
}
