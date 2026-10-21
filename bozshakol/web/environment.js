// Окружение общей сцены (не слои модулей): светлый фон, туман только в метель, ореолы огней,
// хвостохранилище у фабрики, ЛЭП к подстанции, ограждение промплощадки, мачты освещения карьера.
// Положение хвостохранилища и ЛЭП — допущение (см. data/SOURCES.md).
//
//   buildEnvironment(THREE, geometry, terrain, toScene, scene, models) -> { group, setBlizzard(on), setWeather, setQuality(high), glowAt, update(dt) }
//   models — библиотека web/models.js (ЛЭП, ограждение, мачты); без неё — простые фигуры

export function buildEnvironment(THREE, geometry, terrain, toScene, scene, models) {
  const group = new THREE.Group();
  group.name = 'environment';
  const g = (x, y) => terrain.groundAt(x, y);
  const glows = [];
  const objects = Object.fromEntries((geometry.objects || []).map((o) => [o.id, o]));

  // --- фон и погода: макет на нейтральном светлом фоне; дымка — только в метель ----------------
  const BG_CLEAR = new THREE.Color(0xe9edf0), BG_BLIZZARD = new THREE.Color(0xdfe3e7);
  scene.background = BG_CLEAR.clone();
  const FOG_CLEAR_COLOR = 0xe9edf0, FOG_BLIZZARD_COLOR = 0xdfe2e5;   // метель: светлая снежная дымка
  scene.fog = new THREE.Fog(FOG_CLEAR_COLOR, 30000, 90000);          // в ясную погоду дымки нет

  // --- хвостохранилище к западу от фабрики (допущение по снимку: озеро западнее квадрата данных)
  // гладкая вода с бликом солнца, светлый пляж и насыпная дамба по контуру
  const tailX = -4050, tailY = 250;   // внутри макета (край −5200)
  const tailLevel = g(tailX, tailY);
  const beach = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshLambertMaterial({ color: 0xdcd2b2 }));
  beach.scale.set(1000, 700, 1);
  beach.rotation.x = -Math.PI / 2;
  beach.position.copy(toScene(tailX, tailY, tailLevel + 3.5));
  group.add(beach);
  const water = new THREE.MeshStandardMaterial({ color: 0x7fa3b4, roughness: 0.12, metalness: 0.0, flatShading: false });
  const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 64), water);
  pond.scale.set(880, 600, 1);
  pond.rotation.x = -Math.PI / 2;
  pond.position.copy(toScene(tailX, tailY, tailLevel + 5));
  pond.name = 'tailings-pond';
  group.add(pond);
  // дамба — насыпь-кольцо трапециевидного сечения
  const damShape = new THREE.Shape();
  damShape.moveTo(0, 0); damShape.lineTo(28, 0); damShape.lineTo(20, 7); damShape.lineTo(8, 7); damShape.closePath();
  const damPts = [];
  for (let i = 0; i <= 72; i++) { const t = i / 72 * Math.PI * 2; damPts.push(new THREE.Vector3(1000 * Math.cos(t), 0, 700 * Math.sin(t))); }
  const damGeo = new THREE.ExtrudeGeometry(damShape, { steps: 72, bevelEnabled: false, extrudePath: new THREE.CatmullRomCurve3(damPts, true) });
  const dam = new THREE.Mesh(damGeo, new THREE.MeshLambertMaterial({ color: 0x9c8a6c, flatShading: true }));
  dam.position.copy(toScene(tailX, tailY, tailLevel));
  dam.name = 'tailings-dam';
  group.add(dam);

  // --- ЛЭП: от края карты к подстанции и от подстанции к фабрике ----------------------------
  const sub = objects['power-grid'] ? objects['power-grid'].position : [-2450, -950, 0];
  const plant = objects['plant-sulphide'] ? objects['plant-sulphide'].position : [-2700, -760, 0];
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x6d6a66 });
  const wireMat = new THREE.LineBasicMaterial({ color: 0x3a3a3a });
  function powerLine(from, to, stepM) {
    if (models && models.powerLine) {                       // библиотека моделей: опоры с изоляторами и провисом
      const len0 = Math.hypot(to[0] - from[0], to[1] - from[1]), n0 = Math.max(2, Math.round(len0 / stepM));
      const pts = [];
      for (let i = 0; i <= n0; i++) { const t = i / n0, x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t; pts.push(toScene(x, y, g(x, y))); }
      group.add(models.powerLine(pts, { height: 20 }));
      return;
    }
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const nPoles = Math.max(2, Math.round(len / stepM));
    const tops = [];
    for (let i = 0; i <= nPoles; i++) {
      const t = i / nPoles, x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t;
      const base = g(x, y);
      const pole = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 22, 1.2), poleMat); mast.position.y = 11;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.6), poleMat); arm.position.y = 20;
      pole.add(mast, arm);
      pole.position.copy(toScene(x, y, base));
      const dir = Math.atan2(to[0] - from[0], to[1] - from[1]);
      pole.rotation.y = -dir + Math.PI / 2;
      group.add(pole);
      tops.push(pole.position.clone().add(new THREE.Vector3(0, 20, 0)));
    }
    for (const dy of [0, -1.2]) {
      const pts = tops.map((p) => p.clone().add(new THREE.Vector3(0, dy, 0)));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
    }
  }
  powerLine([-5150, -2950], [sub[0], sub[1]], 220);   // от края макета
  powerLine([sub[0], sub[1]], [plant[0] + 160, plant[1] - 60], 100);

  // --- ограждение промплощадки фабрики ----------------------------------------------------------
  const fenceMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
  function fence(rect) {
    const [x0, y0, x1, y1] = rect;
    if (models && models.fence) {
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toScene(x, y, g(x, y)));
      group.add(models.fence(pts, { step: 8, height: 2 }));
      return;
    }
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    const pts = [];
    for (let s = 0; s < 4; s++) {
      const [ax, ay] = corners[s], [bx, by] = corners[s + 1];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / 40));
      for (let i = 0; i <= n; i++) {
        const x = ax + (bx - ax) * i / n, y = ay + (by - ay) * i / n;
        const base = g(x, y);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.5, 0.4), fenceMat);
        post.position.copy(toScene(x, y, base)).add(new THREE.Vector3(0, 1.9, 0));
        post.userData.detail = true;
        group.add(post);
        pts.push(post.position.clone().add(new THREE.Vector3(0, 1.4, 0)));
      }
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x777777 })));
  }
  fence([plant[0] - 420, plant[1] - 330, plant[0] + 420, plant[1] + 260]);

  // --- мачты освещения по борту карьера ---------------------------------------------------------
  const mastMat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  const pit = terrain.pit;
  for (let i = 0; i < 10; i++) {
    const t = i / 10 * Math.PI * 2;
    const x = pit.a * 1.04 * Math.cos(t), y = pit.b * 1.08 * Math.sin(t);
    const base = g(x, y);
    let mast;
    if (models && models.lightMast) mast = models.lightMast(30);
    else {
      mast = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 30, 6), mastMat); pole.position.y = 15;
      const head = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1.5), lampMat); head.position.y = 30;
      mast.add(pole, head);
    }
    mast.position.copy(toScene(x, y, base));
    group.add(mast);
    glowAt(mast.position.clone().add(new THREE.Vector3(0, 30 + 2, 0)), 0xfff1c4, 70);
  }

  scene.add(group);

  // ореол — спрайт с аддитивным смешиванием (огни мачт); видимость управляется качеством
  function glowAt(position, color, size) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(THREE), color, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, fog: true }));
    sp.position.copy(position); sp.scale.set(size, size, 1); sp.userData.glow = true;
    group.add(sp);
    glows.push(sp);
    return sp;
  }

  function setWeather({ blizzard = false, visibility = 5000 } = {}) {
    const vis = Math.max(100, Number(visibility) || 5000);
    const on = !!blizzard;
    scene.fog.color.setHex(on ? FOG_BLIZZARD_COLOR : FOG_CLEAR_COLOR);
    // в метель туман рисуется не плотнее, чем при видимости 1000 м (нижний предел для отображения);
    // сама модель (mine.visibility, ограничение скорости) не меняется
    const fogVis = on ? Math.max(vis, 1000) : vis;
    scene.fog.near = on ? fogVis * 0.4 : fogVis * 1.4;
    scene.fog.far = fogVis * 5;
    scene.background.copy(on ? BG_BLIZZARD : BG_CLEAR);
    if (!on) { scene.fog.near = 30000; scene.fog.far = 90000; }   // ясно — без дымки
  }
  function setBlizzard(on) { setWeather({ blizzard: on, visibility: on ? 300 : 5000 }); }
  function setQuality(high) { for (const sp of glows) sp.visible = !!high; }
  return { group, setBlizzard, setWeather, setQuality, glowAt, update() {} };
}

// Радиальная текстура ореола (рисуется кодом, 64 × 64): общая для всех огней сцены
let _glowTex = null;
export function glowTexture(THREE) {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}
