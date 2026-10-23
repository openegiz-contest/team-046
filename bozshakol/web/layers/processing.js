// Слой «переработка»: дробилка, конвейер, склады, фабрики, подстанция, отвал.
// Модели — из общей библиотеки ctx.models (web/models.js); положение и размеры — только из
// ctx.geometry (core/geometry.json); состояние — из двойников модуля processing.
// Цвет фонаря над объектом: зелёный — работает, жёлтый — простой, красный — остановка / авария / ремонт.
const NS = 'kz.bozshakol';
const FAR_M = 2500;          // дальше — упрощённые модели (setDetail('far'))
const BULK_DENSITY = 1.6;    // т/м³ — как в main.py: тонны склада → объём штабеля
const DUMP_HEIGHT_M = 40;    // высоты отвала нет в geometry.json — условная (допущение)
const CONVEYOR_STEP_M = 40;  // шаг уплотнения трассы конвейера, чтобы лента шла над рельефом
const objs = {};             // thingId -> {kind, g, anchor, lamp, ...}
let lampMats = null, lampGeo = null;

function fv(twin, f, d) {
  const p = twin && twin.features && twin.features[f] && twin.features[f].properties;
  return p && p.value !== undefined && p.value !== null ? p.value : d;
}
function fmtNum(v, digits) {
  return Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: digits });
}
// состояние → цвет фонаря
function level(state) {
  if (['stopped', 'stop', 'down', 'failed', 'off', 'maintenance'].includes(state)) return 'red';
  if (['idle', 'starved'].includes(state)) return 'amber';
  return 'green';
}
const STATE_RU = { running: '', idle: ' · простой', stopped: ' · стоит', maintenance: ' · ремонт' };

export function init(ctx) {
  const THREE = ctx.THREE, M = ctx.models;
  const lam = (col) => new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.9 });
  lampMats = { green: lam(0x43b36a), amber: lam(0xf2c94c), red: lam(ctx.colors.down || 0xd32f2f) };
  lampGeo = new THREE.SphereGeometry(3, 12, 8);
  // высота объекта: своя из geometry.json, иначе — земля сцены
  const zOf = (o) => (o.position.length > 2 && typeof o.position[2] === 'number' ? o.position[2] : ctx.groundAt(o.position[0], o.position[1]));
  const place = (g, o) => g.position.copy(ctx.toScene(o.position[0], o.position[1], zOf(o)));
  const addLamp = (parent, y) => {
    const m = new THREE.Mesh(lampGeo, lampMats.green); m.position.y = y; parent.add(m); return m;
  };
  const add = (id, rec, labelText, importance, dy) => {
    ctx.group.add(rec.g);
    ctx.register(rec.anchor || rec.g, id, rec.hit !== undefined ? { hitRadius: rec.hit } : undefined);
    if (rec.anchor) ctx.register(rec.g, id, { hitRadius: 0 });   // клик по самой модели — та же карточка
    rec.label = ctx.label(rec.anchor || rec.g, labelText, { importance, dy });
    objs[id] = rec;
  };

  for (const o of ctx.geometry.objects || []) {
    const id = NS + ':' + o.id;
    if (o.kind === 'crusher') {
      const g = M.crusher();
      place(g, o); g.rotation.y = -(o.yaw_deg || 0) * Math.PI / 180;
      add(id, { kind: o.kind, g, model: g, lamp: null }, o.id, 3, 36);
    } else if (o.kind === 'conveyor' && o.path && o.path.length >= 2) {
      // трасса из geometry.json, уплотнённая через CONVEYOR_STEP_M: высота — по точкам трассы,
      // но не ниже земли сцены (иначе лента уходит под рельеф между опорными точками)
      const pts = [];
      for (let i = 0; i + 1 < o.path.length; i++) {
        const [x0, y0, z0] = o.path[i], [x1, y1, z1] = o.path[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / CONVEYOR_STEP_M));
        for (let k = 0; k < n; k++) {
          const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
          pts.push(ctx.toScene(x, y, Math.max(z0 + (z1 - z0) * t, ctx.groundAt(x, y))));
        }
      }
      const [xe, ye, ze] = o.path[o.path.length - 1];
      pts.push(ctx.toScene(xe, ye, Math.max(ze, ctx.groundAt(xe, ye))));
      const g = M.conveyor(pts, { height: 3 });
      const anchor = new THREE.Object3D(); anchor.position.copy(pts[Math.floor(pts.length / 2)]); g.add(anchor);
      const head = new THREE.Object3D(); head.position.copy(pts[0]); g.add(head);
      add(id, { kind: o.kind, g, model: g, anchor, hit: 40, lamp: addLamp(head, 12) }, o.id, 3, 12);
    } else if (o.kind === 'stockpile') {
      const isClay = o.id.includes('clay');
      const g = new THREE.Group(); place(g, o);
      const pile = M.stockpile(0, { color: isClay ? ctx.colors.stockpileClay : ctx.colors.stockpileOre });
      g.add(pile);
      add(id, { kind: o.kind, g, model: pile, lamp: addLamp(g, 2), radius: o.radius || 50, hit: o.radius || 50 }, o.id, 3, 8);
    } else if (o.kind === 'plant' || o.kind === 'substation') {
      const size = o.size || [100, 60, 20];
      const g = M.building(o.kind === 'plant' ? 'main' : 'substation', { size });
      place(g, o);
      const h = size[2] * (o.kind === 'plant' ? 1.3 : 1);   // у главного корпуса мельничный пролёт выше крыши
      // подпись корпуса — над западным торцом, чтобы не закрывать подписи складов у восточного края
      const anchor = new THREE.Object3D(); anchor.position.x = o.kind === 'plant' ? -size[0] * 0.3 : 0; g.add(anchor);
      add(id, { kind: o.kind, g, model: g, anchor, lamp: addLamp(g, h + 6), hit: Math.max(size[0], size[1]) / 2 },
        o.id, 3, h + (o.kind === 'plant' ? 70 : 14));
    } else if (o.kind === 'mill' || o.kind === 'flotation') {
      // мельница и флотация стоят внутри главного корпуса: отдельной модели нет, только точка
      // (клик, подпись, значок сценария) и фонарь состояния над крышей
      const g = new THREE.Group(); place(g, o);
      add(id, { kind: o.kind, g, lamp: addLamp(g, 48), hit: 30 }, o.id, 2, 56);
    } else if (o.kind === 'dump') {
      const g = M.dump(o.radius || 200, DUMP_HEIGHT_M, { tiers: 3 });
      place(g, o);
      add(id, { kind: o.kind, g, model: g, hit: (o.radius || 200) * 0.6 }, o.id, 3, DUMP_HEIGHT_M + 10);
    }
  }
}

export function update(ctx, twins) {
  const cam = ctx.camera && ctx.camera.position;
  for (const [id, rec] of Object.entries(objs)) {
    const twin = twins[id];
    const obj = rec.anchor || rec.g;
    if (rec.model && rec.model.setDetail && cam) {
      const far = obj.getWorldPosition(rec._p || (rec._p = new ctx.THREE.Vector3())).distanceTo(cam) > FAR_M;
      if (rec.far !== far) { rec.model.setDetail(far ? 'far' : 'full'); rec.far = far; }
    }
    if (rec.lamp) rec.lamp.scale.setScalar(Math.min(3, ctx.markerScale || 1));
    if (!twin) { if (rec.kind === 'conveyor') rec.model.setFlow(0, ctx.dt); continue; }
    const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
    const state = fv(twin, 'state', '');
    let lamp = level(state), text = name;

    if (rec.kind === 'crusher') {
      const accepting = fv(twin, 'accepting', true) !== false;
      rec.model.setState(state);                                     // красный корпус и фонарь — стоит
      text += (STATE_RU[state] ?? '') + (accepting ? '' : ' · не принимает') + ' · ' + fmtNum(fv(twin, 'throughput', 0), 0) +
        ' т/ч · бункер ' + fmtNum(fv(twin, 'bunker', 0), 0) + ' т · очередь: ' + fv(twin, 'trucks_queued', 0);
      const why = fv(twin, 'stop_reason', '');
      if (state === 'stopped' && why) text += ' · ' + why;
    } else if (rec.kind === 'conveyor') {
      const running = state === 'running';
      const tph = running ? Math.max(Number(fv(twin, 'intake', 0)), Number(fv(twin, 'throughput', 0)), 300) : 0;
      rec.model.setFlow(tph, ctx.dt);                                 // кучки руды едут по ленте
      text += (STATE_RU[state] ?? '') + ' · ' + fmtNum(fv(twin, 'length', 0) / 1000, 2) + ' км · ' +
        fmtNum(fv(twin, 'intake', 0), 0) + ' т/ч с дробилки · на ленте ' + fmtNum(fv(twin, 'load', 0), 0) + ' т · ' +
        fmtNum(fv(twin, 'power', 0), 0) + ' кВт';
      const advice = fv(twin, 'advice', '');
      if (advice) { text += ' · ⚡ ' + advice; lamp = 'amber'; }               // рекомендация по холостому ходу
    } else if (rec.kind === 'stockpile') {
      const stock = Number(fv(twin, 'stock', 0)) || 0;
      rec.model.setVolume(Number(fv(twin, 'volume', stock / BULK_DENSITY)));
      rec.lamp.position.y = (rec.model.userData.height || 0) + 6;
      const hours = fv(twin, 'hours_left', null);
      text += ' · ' + fmtNum(stock / 1000, 1) + ' тыс. т';
      if (id.endsWith(':stockpile-coarse')) {
        // тревога — только по правилу модели (alarm): дробилка не принимает или склад убывает > 15 модельных минут
        const full = fv(twin, 'full', false) === true, alarm = fv(twin, 'alarm', false) === true;
        const expect = alarm && fv(twin, 'stop_expected', false) === true;
        const overflow = fv(twin, 'overflow_expected', false) === true;   // растёт > 15 мин или мельница на ремонте
        lamp = full ? 'red' : ((expect || overflow) ? 'amber' : 'green');
        if (full) text += ' · полон';
        else if (overflow) {
          const hf = Number(fv(twin, 'hours_to_full', -1));
          text += ' · ' + fv(twin, 'overflow_forecast', '') + (hf >= 0 ? ' · до переполнения ' + fmtNum(hf, 1) + ' ч' : '');
        } else if (alarm && hours !== null) {
          text += ' · хватит на ' + fmtNum(hours, 1) + ' ч';
          if (expect) text += ' · фабрика встанет в ' + fv(twin, 'stop_forecast', '—');
        } else text += ' · запас в норме';
      } else {
        if (hours !== null) text += ' · хватит на ' + fmtNum(hours, 1) + ' ч';
        const accepting = fv(twin, 'accepting', true) !== false;
        lamp = accepting ? 'green' : 'red';
        if (!accepting) text += ' · не принимает';
        const q = fv(twin, 'trucks_queued', null);
        if (q) text += ' · очередь: ' + q;
      }
    } else if (rec.kind === 'plant') {
      text += (STATE_RU[state] ?? '') + ' · ' + fmtNum(fv(twin, 'feed_rate', 0), 0) + ' / ' + fmtNum(fv(twin, 'plan_rate', 0), 0) +
        ' т/ч · план ' + fmtNum(fv(twin, 'plan_fulfilment', 0), 0) + ' %';
      const grid = twins[NS + ':power-grid'];
      if (id.endsWith(':plant-sulphide') && grid) {                     // мельничный корпус — мощность мельниц
        text += ' · мельницы ' + fmtNum(fv(grid, 'mills', 0), 1) + ' МВт · ' + fmtNum(fv(twin, 'specific_energy', 0), 1) + ' кВт·ч/т';
        if (fv(twin, 'power_limited', false) === true)
          text += ' · предел мощности: −' + fmtNum(fv(twin, 'power_limit_lost_ore', 0), 0) + ' т/ч';
      } else if (grid) text += ' · ' + fmtNum(fv(grid, 'clay_plant', 0), 1) + ' МВт';
    } else if (rec.kind === 'mill') {
      text += (STATE_RU[state] ?? '') + ' · ' + fmtNum(fv(twin, 'throughput', 0), 0) + ' т/ч · ' + fmtNum(fv(twin, 'mills_power', 0), 1) + ' МВт';
    } else if (rec.kind === 'flotation') {
      text += ' · извлечение ' + fmtNum(fv(twin, 'recovery', 0), 1) + ' %';
    } else if (rec.kind === 'substation') {
      // цвет — по нагрузке: норма / близко к пределу (> 90 %) / превышение; предел — сценарий power_limit или подключённая мощность
      const limitOn = fv(twin, 'limit_on', false) === true;
      const cap = limitOn ? Number(fv(twin, 'limit_mw', 0)) : Number(fv(twin, 'supply_mw', 0));
      const lvl = fv(twin, 'load_level', 'normal');
      lamp = lvl === 'over' ? 'red' : (lvl === 'near' ? 'amber' : 'green');
      text += ' · ' + fmtNum(fv(twin, 'load', 0), 1) + ' из ' + fmtNum(cap, 0) + ' МВт' + (limitOn ? ' (предел энергосистемы)' : '') +
        ' · потери холостого хода ' + fmtNum(fv(twin, 'idle_power', 0), 0) + ' кВт';
    } else if (rec.kind === 'dump') {
      text += ' · ' + fmtNum(Number(fv(twin, 'received_total', 0)) / 1000, 1) + ' тыс. т';
    }
    if (rec.lamp) { const m = lampMats[lamp]; if (rec.lamp.material !== m) rec.lamp.material = m; }
    obj.userData.label = text;
  }
}
