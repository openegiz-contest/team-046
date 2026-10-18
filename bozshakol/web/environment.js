// Окружение общей сцены (не слои модулей): небо с градиентом и дымкой у горизонта, туман (метель),
// хвостохранилище у фабрики, ЛЭП к подстанции, ограждение промплощадки, мачты освещения карьера.
// Положение хвостохранилища и ЛЭП — допущение (см. data/SOURCES.md).
//
//   buildEnvironment(THREE, geometry, terrain, toScene, scene, models) -> { group, setBlizzard(on), update(dt) }
//   models — библиотека web/models.js (ЛЭП, ограждение, мачты); без неё — простые фигуры

export function buildEnvironment(THREE, geometry, terrain, toScene, scene, models) {
  const group = new THREE.Group();
  group.name = 'environment';
  const g = (x, y) => terrain.groundAt(x, y);
  const objects = Object.fromEntries((geometry.objects || []).map((o) => [o.id, o]));

  // --- небо: купол с градиентом (зенит → дымка у горизонта), туман ---------------------------
  const skyGeo = new THREE.SphereGeometry(40000, 24, 12);
  const skyColors = [];
  const zenith = new THREE.Color(0xb7d4ee), horizon = new THREE.Color(0xf3f0e9);
  const pos = skyGeo.attributes.position;
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, pos.getY(i) / 40000));          // 0 у горизонта, 1 в зените
    tmp.copy(horizon).lerp(zenith, Math.pow(t, 0.55));
    skyColors.push(tmp.r, tmp.g, tmp.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyColors, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.name = 'sky';
  group.add(sky);
  // Туман — по дальности видимости mine.visibility: в ясную погоду (≈ 5 км) дымка только у горизонта
  // (туман начинается за 1,4 видимости и полный на 5), в метель (300 м) — плотный туман по той же величине.
  const FOG_CLEAR_COLOR = 0xeae6dc, FOG_BLIZZARD_COLOR = 0xc8cfd6;
  scene.fog = new THREE.Fog(FOG_CLEAR_COLOR, 7000, 25000);
  scene.background = null;

  // --- хвостохранилище к западу от фабрики (допущение по снимку: озеро западнее квадрата данных)
  const tailX = -4300, tailY = 150;
  const tailLevel = g(tailX, tailY);
  // пляж (светлый песок и ил) вокруг серо-голубой воды, снаружи — дамба
  const beach = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshLambertMaterial({ color: 0xd8cfb0 }));
  beach.scale.set(1180, 820, 1);
  beach.rotation.x = -Math.PI / 2;
  beach.position.copy(toScene(tailX, tailY, tailLevel + 0.6));
  group.add(beach);
  const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshLambertMaterial({ color: 0x7f9fae }));
  pond.scale.set(1050, 700, 1);
  pond.rotation.x = -Math.PI / 2;
  pond.position.copy(toScene(tailX, tailY, tailLevel + 0.9));
  pond.name = 'tailings-pond';
  group.add(pond);
  const dam = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 48), new THREE.MeshLambertMaterial({ color: 0x8f8068, side: THREE.DoubleSide }));
  dam.scale.set(1180, 820, 1);
  dam.rotation.x = -Math.PI / 2;
  dam.position.copy(toScene(tailX, tailY, tailLevel + 1.2));
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
  powerLine([-4950, -3200], [sub[0], sub[1]], 220);
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
  }

  scene.add(group);

  function setWeather({ blizzard = false, visibility = 5000 } = {}) {
    const vis = Math.max(100, Number(visibility) || 5000);
    const on = !!blizzard;
    scene.fog.color.setHex(on ? FOG_BLIZZARD_COLOR : FOG_CLEAR_COLOR);
    scene.fog.near = on ? vis * 0.4 : vis * 1.4;
    scene.fog.far = on ? vis * 5 : vis * 5;
    const zen = on ? new THREE.Color(0xc9d0d6) : zenith, hor = on ? new THREE.Color(0xd5d8dc) : horizon;
    const c = skyGeo.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, pos.getY(i) / 40000));
      tmp.copy(hor).lerp(zen, Math.pow(t, 0.55));
      c.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    c.needsUpdate = true;
  }
  function setBlizzard(on) { setWeather({ blizzard: on, visibility: on ? 300 : 5000 }); }
  return { group, setBlizzard, setWeather, update() {} };
}
