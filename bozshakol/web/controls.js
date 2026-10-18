// Управление сценой с клавиатуры (дополняет мышь/OrbitControls, не заменяет её).
//   W/A/S/D и стрелки — движение по карте относительно взгляда камеры (камера и цель OrbitControls идут вместе);
//   Q/E — поворот вокруг цели; R/F — выше и дальше / ниже и ближе (как колесо мыши); Shift — втрое быстрее;
//   1–5 — виды; Home — весь рудник; Пробел — следовать за выбранным самосвалом / отпустить;
//   Esc — снять выбор (и выйти из следования); ? или H — подсказка по клавишам.
// В виде «Сверху» (ортокамера): W/A/S/D панорамируют карту, R/F меняют масштаб, Q/E не действуют.
//
// initKeyboard(opts) -> { update(dt), help }
//   opts: camera()         — текущая камера (THREE.Camera)
//         controls()       — текущий OrbitControls
//         setView(name)    — переход к виду all | pit | crusher | plants | top
//         goHome()         — вид «Весь рудник»
//         toggleFollow()   — следовать за выбранным самосвалом / отпустить
//         clearSelection() — закрыть карточку, снять выбор
//         stopFly()        — прервать плавный перелёт (необязательно)
//         groundAt(x, y)   — высота земли, м, координаты рудника
//         toScene(x, y, z) — перевод координат рудника в сцену (x, z·VZ, −y)
//         bounds           — {minX, maxX, minY, maxY} в координатах рудника
//         isTop()          — true, если активен ортографический вид «Сверху»

const SMOOTH = 0.2;        // с: постоянная времени разгона/торможения
const MIN_SPEED = 20;      // м/с: скорость у самой земли
const SPEED_PER_M = 0.6;   // м/с на каждый метр высоты над землёй
const ROT_SPEED = 1.2;     // рад/с: поворот Q/E
const DOLLY_RATE = 0.9;    // 1/с: R/F — множитель расстояния до цели за секунду (e^0,9 ≈ ×2,5)
const ZOOM_RATE = 0.9;     // 1/с: R/F в виде сверху
const MIN_ABOVE = 15;      // м: камера не ниже земли + столько
const TARGET_MARGIN = 500; // м: цель может выйти за bounds не дальше
const CAMERA_MARGIN = 2000;// м: камера — не дальше 2 км за bounds
const VIEW_KEYS = { Digit1: 'all', Digit2: 'pit', Digit3: 'crusher', Digit4: 'plants', Digit5: 'top' };

export function initKeyboard(opts) {
  const o = Object.assign({
    setView() {}, goHome() {}, toggleFollow() {}, clearSelection() {}, stopFly() {},
    groundAt: () => 0, isTop: () => false,
    bounds: { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 },
  }, opts);
  const VZ = o.toScene ? o.toScene(0, 0, 1).y : 1;   // вертикальное преувеличение сцены
  const pressed = new Set();                          // зажатые клавиши (e.code)
  // сглаженные скорости: vx, vz — в сцене, м/с; rot — рад/с; dolly — 1/с
  const vel = { x: 0, z: 0, rot: 0, dolly: 0 };
  const help = makeHelp();

  function typingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  const isMove = (code) => /^(Key[WASDQERF]|Arrow(Up|Down|Left|Right)|Shift(Left|Right))$/.test(code);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (typingTarget(e.target)) return;
    const code = e.code;
    if (isMove(code)) {
      if (!pressed.has(code) && !code.startsWith('Shift')) o.stopFly();   // ручное движение прерывает перелёт
      pressed.add(code);
      if (code.startsWith('Arrow')) e.preventDefault();   // стрелки не прокручивают страницу
      return;
    }
    // одноразовые команды: кнопка под фокусом не должна «нажаться» ещё раз пробелом
    if (e.target && e.target.tagName === 'BUTTON') e.target.blur();
    if (VIEW_KEYS[code]) { o.setView(VIEW_KEYS[code]); e.preventDefault(); return; }
    if (code === 'Home') { o.goHome(); e.preventDefault(); return; }
    if (code === 'Space') { o.toggleFollow(); e.preventDefault(); return; }
    if (code === 'Escape') { if (help.visible) help.hide(); o.clearSelection(); return; }
    if (e.key === '?' || code === 'KeyH') { help.toggle(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => { pressed.delete(e.code); });
  window.addEventListener('blur', () => pressed.clear());   // ушли из окна — все клавиши отпущены

  const axis = (plus, minus) => (plus ? 1 : 0) - (minus ? 1 : 0);
  const smooth = (cur, goal, dt) => cur + (goal - cur) * (1 - Math.exp(-dt / SMOOTH));
  const has = (...codes) => codes.some((c) => pressed.has(c));

  function update(dt) {
    if (!(dt > 0)) return;
    const cam = o.camera(), ctl = o.controls();
    if (!cam || !ctl) return;
    const fwd = axis(has('KeyW', 'ArrowUp'), has('KeyS', 'ArrowDown'));
    const side = axis(has('KeyD', 'ArrowRight'), has('KeyA', 'ArrowLeft'));
    const rot = axis(has('KeyQ'), has('KeyE'));
    const upDown = axis(has('KeyR'), has('KeyF'));
    const boost = has('ShiftLeft', 'ShiftRight') ? 3 : 1;
    const top = o.isTop();
    const pos = cam.position, tgt = ctl.target;

    // --- направление движения: горизонтальная проекция взгляда (сверху — север вверх экрана)
    let fx, fz;
    if (top) { fx = 0; fz = -1; }
    else {
      fx = tgt.x - pos.x; fz = tgt.z - pos.z;
      const l = Math.hypot(fx, fz);
      if (l < 1e-3) { fx = 0; fz = -1; } else { fx /= l; fz /= l; }
    }
    const rx = -fz, rz = fx;   // вправо от направления взгляда (ось Y сцены — вверх)

    // --- скорость: от высоты камеры над землёй (сверху — от масштаба)
    let speed;
    if (top) speed = Math.max(MIN_SPEED, SPEED_PER_M * 3000 / (cam.zoom || 1));
    else {
      const h = pos.y - o.groundAt(pos.x, -pos.z) * VZ;
      speed = Math.max(MIN_SPEED, SPEED_PER_M * Math.max(0, h) / VZ);
    }
    speed *= boost;
    let gx = fx * fwd + rx * side, gz = fz * fwd + rz * side;
    const gl = Math.hypot(gx, gz);
    if (gl > 1e-6) { gx = gx / gl * speed; gz = gz / gl * speed; }
    vel.x = smooth(vel.x, gx, dt); vel.z = smooth(vel.z, gz, dt);
    vel.rot = smooth(vel.rot, top ? 0 : rot * ROT_SPEED * boost, dt);
    vel.dolly = smooth(vel.dolly, upDown * (top ? ZOOM_RATE : DOLLY_RATE) * boost, dt);
    const moving = Math.abs(vel.x) + Math.abs(vel.z) > 0.05 || Math.abs(vel.rot) > 1e-3 || Math.abs(vel.dolly) > 1e-3;
    if (!moving) { vel.x = vel.z = vel.rot = vel.dolly = 0; return; }

    // --- движение: камера и цель вместе
    const dx = vel.x * dt, dz = vel.z * dt;
    pos.x += dx; pos.z += dz; tgt.x += dx; tgt.z += dz;

    if (top) {
      if (Math.abs(vel.dolly) > 1e-3) {
        const z = Math.exp(vel.dolly * dt) * (cam.zoom || 1);
        cam.zoom = Math.min(ctl.maxZoom || Infinity, Math.max(ctl.minZoom || 0, z));
        cam.updateProjectionMatrix();
      }
    } else {
      // поворот вокруг цели (вокруг вертикальной оси)
      if (Math.abs(vel.rot) > 1e-3) {
        const a = vel.rot * dt, c = Math.cos(a), s = Math.sin(a);
        const ox = pos.x - tgt.x, oz = pos.z - tgt.z;
        pos.x = tgt.x + ox * c - oz * s;
        pos.z = tgt.z + ox * s + oz * c;
      }
      // выше и дальше / ниже и ближе: расстояние до цели растёт или падает по экспоненте
      if (Math.abs(vel.dolly) > 1e-3) {
        const ox = pos.x - tgt.x, oy = pos.y - tgt.y, oz = pos.z - tgt.z;
        const d = Math.hypot(ox, oy, oz);
        const nd = Math.min(ctl.maxDistance || Infinity, Math.max(ctl.minDistance || 1, d * Math.exp(vel.dolly * dt)));
        const k = d > 1e-6 ? nd / d : 1;
        pos.set(tgt.x + ox * k, tgt.y + oy * k, tgt.z + oz * k);
      }
    }
    clamp(cam, ctl, top);
    ctl.update();
  }

  // Границы: цель — в пределах bounds с запасом, камера — не дальше 2 км за bounds, не ниже земли + 15 м
  function clamp(cam, ctl, top) {
    const b = o.bounds, pos = cam.position, tgt = ctl.target;
    // в сцене: x = x рудника, z = −y рудника
    let sx = clampDelta(tgt.x, b.minX - TARGET_MARGIN, b.maxX + TARGET_MARGIN);
    let sz = clampDelta(tgt.z, -b.maxY - TARGET_MARGIN, -b.minY + TARGET_MARGIN);
    tgt.x += sx; tgt.z += sz; pos.x += sx; pos.z += sz;
    sx = clampDelta(pos.x, b.minX - CAMERA_MARGIN, b.maxX + CAMERA_MARGIN);
    sz = clampDelta(pos.z, -b.maxY - CAMERA_MARGIN, -b.minY + CAMERA_MARGIN);
    tgt.x += sx; tgt.z += sz; pos.x += sx; pos.z += sz;
    if (!top) {
      const minY = o.groundAt(pos.x, -pos.z) * VZ + MIN_ABOVE;
      if (pos.y < minY) pos.y = minY;
    }
  }
  const clampDelta = (v, lo, hi) => (v < lo ? lo - v : v > hi ? hi - v : 0);

  return { update, help };
}

// Подсказка по клавишам: элементы #help (плашка), #btn-help (кнопка «?»), #help-hint (строка внизу справа)
function makeHelp() {
  const box = document.getElementById('help');
  const btn = document.getElementById('btn-help');
  const hint = document.getElementById('help-hint');
  const h = {
    get visible() { return !!box && !box.hidden; },
    show() { if (box) box.hidden = false; if (btn) btn.classList.add('active'); },
    hide() { if (box) box.hidden = true; if (btn) btn.classList.remove('active'); },
    toggle() { if (h.visible) h.hide(); else h.show(); },
  };
  if (btn) btn.addEventListener('click', () => { h.toggle(); btn.blur(); });
  if (hint) hint.addEventListener('click', () => h.toggle());
  const close = box && box.querySelector('#help-close');
  if (close) close.addEventListener('click', () => h.hide());
  return h;
}
