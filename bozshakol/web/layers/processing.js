// Слой «переработка»: дробилка, конвейер, склады, фабрики, подстанция, отвал.
// Модели — из общей библиотеки ctx.models (web/models.js); положение и размеры — только из
// ctx.geometry (core/geometry.json); состояние — из двойников модуля processing.
// Сигнальная лампа на корпусе (маленький цилиндр ≈ 2,4 м на краю крыши, у склада, у головы конвейера):
// зелёный — работает, жёлтый — простой / ожидание руды, красный — остановка / авария / ремонт.
// В виде сверху лампы чуть увеличиваются (иначе их не видно), в 3D — в натуральную величину.
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
  const lam = (col, k = 0.6) => new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: k });
  // общая палитра состояний сцены (как у техники): норма — спокойный бирюзовый, внимание — янтарный,
  // тревога — красно-пурпурный (отличим при дальтонизме); при тревоге над объектом — значок ⚠ с пульсом
  const C = ctx.colors;
  lampMats = { green: lam(C.stateOk ?? 0x22b8a6, 0.35), amber: lam(C.stateWarn ?? 0xffb526), red: lam(C.down ?? 0xd1236a, 0.8) };
  lampGeo = new THREE.CylinderGeometry(1.2, 1.2, 1.6, 12);   // сигнальная лампа: Ø 2,4 м, высота 1,6 м
  // высота объекта: своя из geometry.json, иначе — земля сцены
  const zOf = (o) => (o.position.length > 2 && typeof o.position[2] === 'number' ? o.position[2] : ctx.groundAt(o.position[0], o.position[1]));
  const place = (g, o) => g.position.copy(ctx.toScene(o.position[0], o.position[1], zOf(o)));
  const addLamp = (parent, y, x = 0, z = 0) => {
    const m = new THREE.Mesh(lampGeo, lampMats.green); m.position.set(x, y + 0.8, z); parent.add(m); return m;
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
      // корпус дробилки в модели — к востоку (+X) от площадки разгрузки: центр корпуса x = 18,5 м, крыша 16,8 м
      // (models.js, crusherGeos). Подпись и лампа — на корпусе, а не над площадкой и не на верху привода (26,5 м)
      const BODY_X = 18.5, ROOF_Y = 16.8;
      const anchor = new THREE.Object3D(); anchor.position.set(BODY_X, ROOF_Y, 0); g.add(anchor);
      const lamp = addLamp(g, ROOF_Y, BODY_X + 4.5, 6.5);                       // на краю крыши корпуса
      if (g.userData.parts && g.userData.parts.lamp) g.userData.parts.lamp.visible = false;   // вторая лампа модели не нужна
      add(id, { kind: o.kind, g, model: g, anchor, lamp, hit: 30 }, o.id, 3, 6);
    } else if (o.kind === 'conveyor' && o.path && o.path.length >= 2) {
      // трасса из geometry.json, уплотнённая через CONVEYOR_STEP_M: высота — по точкам трассы,
      // но не ниже земли сцены (иначе лента уходит под рельеф между опорными точками)
      const pts = [];
      // начало ленты — внутри портала у разгрузки дробилки (портал строит общая сцена: короб 7 м назад от первой точки
      // трассы, проём под ленту на высоте 1,6–4,0 м); лента идёт по проёму и выходит из портала наружу.
      // Точки трассы geometry.json не меняются: добавлена точка внутри портала, первая точка опущена до высоты проёма.
      const LIFT = 3, BELT_IN_PORTAL_M = 2.8;
      // Портал — за площадкой разгрузки дробилки: на ctx.conveyorGallery единиц сцены по трассе от первой точки
      // (общая сцена строит там портал, до него лента в подземной галерее). Ищем это место на трассе рудника.
      const GAL = ctx.conveyorGallery || 0;
      let i0 = 0, t0 = 0;
      if (GAL > 0) {
        const s0 = ctx.toScene(o.path[0][0], o.path[0][1], 0);
        const far = (i, t) => { const [x0, y0] = o.path[i], [x1, y1] = o.path[i + 1], q = ctx.toScene(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0); return Math.hypot(q.x - s0.x, q.z - s0.z); };
        search: for (let i = 0; i + 1 < o.path.length; i++) for (let k = 1; k <= 40; k++) {
          if (far(i, k / 40) < GAL) continue;
          let lo = (k - 1) / 40, hi = k / 40;
          for (let it = 0; it < 24; it++) { const m = (lo + hi) / 2; if (far(i, m) >= GAL) hi = m; else lo = m; }
          i0 = i; t0 = hi; break search;
        }
      }
      const P = (i, t) => { const [x0, y0, z0] = o.path[i], [x1, y1, z1] = o.path[i + 1]; return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t]; };
      {
        const [ax, ay] = P(i0, t0), [bx, by] = o.path[i0 + 1];
        const L0 = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L0, uy = (by - ay) / L0;
        for (const back of [6.5, 0]) {
          const x = ax - ux * back, y = ay - uy * back;
          const p = ctx.toScene(x, y, BELT_IN_PORTAL_M); p.y -= LIFT;     // конвейер поднимает ленту на LIFT над точкой
          pts.push(p);
        }
      }
      // у дорог — точки чаще (эстакада: плавный подъём и спуск), в остальном — через CONVEYOR_STEP_M
      const half = ctx.roadHalf || 16, NEAR_U = half + 8, RAMP_U = 50;
      const roadD = (p) => (ctx.roadDist ? ctx.roadDist(p.x, -p.z) : Infinity);
      for (let i = i0; i + 1 < o.path.length; i++) {
        const [x0, y0, z0] = o.path[i], [x1, y1, z1] = o.path[i + 1];
        const ta = i === i0 ? t0 : 0, len = Math.hypot(x1 - x0, y1 - y0) * (1 - ta);
        const n = Math.max(1, Math.ceil(len / 8));
        let since = 0;
        for (let k = 1; k < n; k++) {                                     // первая точка — у портала
          const t = ta + (1 - ta) * k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
          since += len / n;
          const p = ctx.toScene(x, y, Math.max(z0 + (z1 - z0) * t, ctx.groundAt(x, y)));
          if (since >= CONVEYOR_STEP_M - 1e-6 || roadD(p) < NEAR_U + RAMP_U + 20) { pts.push(p); since = 0; }
        }
        if (i + 2 < o.path.length) pts.push(ctx.toScene(x1, y1, Math.max(z1, ctx.groundAt(x1, y1))));
      }
      const [xe, ye, ze] = o.path[o.path.length - 1];
      pts.push(ctx.toScene(xe, ye, Math.max(ze, ctx.groundAt(xe, ye))));
      // точка трассы у самой реальной дороги переносится в схеме на дорогу, а не на трассу: такие точки уходят в сторону
      // от прямой между соседями — без них лента не делает зигзаг посреди эстакады
      for (let pass = 0, cut = 1; pass < 8 && cut; pass++) {   // подряд могут уйти две-три точки — повторяем, пока убираются
        cut = 0;
        for (let i = pts.length - 2; i >= 3; i--) {
          const a = pts[i - 1], b = pts[i + 1], p = pts[i], vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2));
          if (Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t) > 2.5) { pts.splice(i, 1); cut++; }
        }
      }
      // эстакада: где трасса проходит над дорогой (лента ближе half + 5 к её оси — над полотном или обочиной), лента
      // поднята с просветом не меньше двух высот самосвала (ctx.truckHeight); подъём и спуск — плавно вдоль трассы
      // (RAMP_U единиц пути); стойки — не ближе half + 4 к оси дороги
      const OVER = 2 * (ctx.truckHeight || 9) + 1.6 + 1.5;   // над точкой: просвет + низ галереи под лентой + запас
      const sAt = [0];
      for (let i = 1; i < pts.length; i++) sAt.push(sAt[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const cross = pts.map((p, i) => i >= 2 && roadD(p) < half + 5);
      const lifts = pts.map((p, i) => {
        if (i < 2) return LIFT;                                           // в портале
        let dmin = Infinity;
        for (let j = 0; j < pts.length; j++) if (cross[j]) dmin = Math.min(dmin, Math.abs(sAt[i] - sAt[j]));
        const k = Math.max(0, Math.min(1, 1 - (dmin - 6) / RAMP_U));
        return LIFT + (OVER - LIFT) * k * k * (3 - 2 * k);
      });
      const g = M.conveyor(pts, { height: LIFT, lifts, legOk: (x, z) => !ctx.roadDist || ctx.roadDist(x, -z) > half + 4 });
      const anchor = new THREE.Object3D(); anchor.position.copy(pts[Math.floor(pts.length / 2)]); g.add(anchor);
      const head = new THREE.Object3D(); head.position.copy(pts[2] || pts[1]); g.add(head);   // лампа — сразу за порталом
      add(id, { kind: o.kind, g, model: g, anchor, hit: 40, lamp: addLamp(head, 4) }, o.id, 3, 12);
    } else if (o.kind === 'stockpile') {
      const isClay = o.id.includes('clay');
      const g = new THREE.Group(); place(g, o);
      const pile = M.stockpile(0, { color: isClay ? ctx.colors.stockpileClay : ctx.colors.stockpileOre });
      g.add(pile);
      // лампа — у края площадки склада, не на штабеле (штабель растёт и закрывал бы её)
      add(id, { kind: o.kind, g, model: pile, lamp: addLamp(g, 1.5, (o.radius || 50) * 0.85, 0), radius: o.radius || 50, hit: o.radius || 50 }, o.id, 3, 8);
    } else if (o.kind === 'plant' || o.kind === 'substation') {
      const size = o.size || [100, 60, 20];
      const g = M.building(o.kind === 'plant' ? 'main' : 'substation', { size });
      place(g, o);
      const h = size[2] * (o.kind === 'plant' ? 1.3 : 1);   // у главного корпуса мельничный пролёт выше крыши
      // подпись корпуса — над западным торцом, чтобы не закрывать подписи складов у восточного края
      const anchor = new THREE.Object3D(); anchor.position.x = o.kind === 'plant' ? -size[0] * 0.3 : 0; g.add(anchor);
      // лампа — на краю крыши корпуса (у угла), а не шаром над серединой
      const lamp = addLamp(g, size[2] + 1, size[0] / 2 - 4, size[1] / 2 - 4);
      add(id, { kind: o.kind, g, model: g, anchor, lamp, hit: Math.max(size[0], size[1]) / 2 },
        o.id, 3, h + (o.kind === 'plant' ? 70 : 14));
    } else if (o.kind === 'mill' || o.kind === 'flotation') {
      // мельница и флотация стоят внутри главного корпуса: отдельной модели нет, только точка
      // (клик, подпись, значок сценария) и сигнальная лампа на крыше над ними
      // (мельница — на крыше мельничного пролёта ≈ 1,3 × высоты корпуса, флотация — на основной крыше)
      const g = new THREE.Group(); place(g, o);
      const plantH = ((ctx.geometry.objects || []).find((x) => x.id === 'plant-sulphide') || {}).size?.[2] || 30;
      add(id, { kind: o.kind, g, lamp: addLamp(g, o.kind === 'mill' ? plantH * 1.3 + 0.6 : plantH + 1), hit: 30 }, o.id, 2, 56);
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
    // лампы в натуральную величину; только в виде сверху (ортокамера) — крупнее, чтобы были видны
    const lampScale = ctx.camera && ctx.camera.isOrthographicCamera ? Math.min(6, Math.max(3, 1.5 * (ctx.markerScale || 1))) : 1;
    if (rec.lamp) rec.lamp.scale.setScalar(lampScale);
    if (!twin) { if (rec.kind === 'conveyor') rec.model.setFlow(0, ctx.dt); continue; }
    const name = (twin.attributes && twin.attributes.name) || id.split(':')[1];
    const state = fv(twin, 'state', '');
    let lamp = level(state), text = name;

    if (rec.kind === 'crusher') {
      const accepting = fv(twin, 'accepting', true) !== false;
      rec.model.setState(state);                                     // красный корпус и фонарь — стоит
      text += (state === 'idle' ? ' · ожидание руды' : (STATE_RU[state] ?? '')) + (accepting ? '' : ' · не принимает') + ' · ' +
        fmtNum(state === 'running' ? fv(twin, 'throughput', 0) : 0, 0) +
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
      // текущий темп (т/ч против плана т/ч) и отдельно — выполнение плана за смену (сменный факт ÷ сменный план)
      text += (STATE_RU[state] ?? '') + ' · ' + fmtNum(fv(twin, 'feed_rate', 0), 0) + ' т/ч (план ' + fmtNum(fv(twin, 'plan_rate', 0), 0) +
        ') · за смену ' + fmtNum(fv(twin, 'plan_fulfilment', 0), 0) + ' %';
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
    // тревога — не только цветом: значок ⚠ с коротким текстом причины, рамка пульсирует (CSS .label.alarm)
    if (lamp === 'red' && rec.lamp) {
      const why = rec.kind === 'stockpile' ? (fv(twin, 'full', false) === true ? 'склад полон' : 'не принимает')
        : rec.kind === 'substation' ? 'перегрузка сети' : 'стоит';
      // важность 4 — не прячется за другими подписями; выше значка сценария над тем же объектом
      if (!rec.alarm) rec.alarm = ctx.label(rec.anchor || rec.g, '⚠ ' + why, { importance: 4, cls: 'warn alarm', dy: ((rec.label && rec.label.dy) || 10) + 40 });
      rec.alarm.text = '⚠ ' + why; rec.alarm.enabled = true;
    } else if (rec.alarm) rec.alarm.enabled = false;
    obj.userData.label = text;
  }
}
