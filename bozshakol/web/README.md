# 3D-сцена рудника (web)

Статическая страница без сборки: nginx (`compose.yml`, `nginx.conf.template`) отдаёт эту папку,
`core/geometry.json` по адресу `/geometry.json`, настройку `/config.json` (`grafanaUrl`) и проксирует
Ditto по `/ditto/...` (пароль подставляет nginx, в браузер он не попадает).

## Файлы

- `index.html`, `style.css` — разметка: холст, слой HTML-подписей, панель слева, карточка двойника справа внизу.
- `app.js` — общая сцена: степь, карьер (уступы из `geometry.pit`), дороги (красные при `road-*.open = false`),
  камеры «3D» и «Сверху», клики по объектам, панель («Рудник», «Диспетчеризация», «Сценарии»), связь с Ditto
  (снимок через поиск, затем SSE; если SSE не открылся за 5 с или оборвался — опрос раз в секунду), загрузка слоёв.
- `layers/haulage.js` — самосвалы и экскаваторы; `layers/geology.js` — забои и буровые;
  `layers/processing.js` — дробилка, конвейер, склады, фабрики, подстанция, отвал.
- `vendor/three/` — three.js 0.160.0 (см. `VERSION.txt`), подключается через importmap, без CDN.

Координаты: `geometry.json` в метрах (X — восток, Y — север, Z — высота), в сцену переводит
`toScene(x, y, z) = Vector3(x, z, -y)` (Y сцены — вверх).

## Как слою добавить объекты

Слой — ES-модуль `layers/<модуль>.js`, экспортирует `init(ctx)` и `update(ctx, twins)`:

- `ctx.THREE`, `ctx.scene`, `ctx.group` (группа слоя — всё своё добавлять сюда), `ctx.geometry`,
  `ctx.toScene(x, y, z)`, `ctx.register(object3d, thingId)` (клик → карточка), `ctx.colors`, `ctx.dt`, `ctx.camera`;
- дополнительно `ctx.label(object3d, text, {dy, small})` — HTML-подпись над объектом; текст меняется через
  `object3d.userData.label = '...'`. Подписей в сцене не больше ~28, крупные объекты — по одной.
- `twins` — объект `thingId → {attributes, features}`, значение признака: `features.<f>.properties.value`.
  `update` вызывается каждый кадр (не чаще 30 кадров/с); слой сам интерполирует положение между обновлениями.

Пример:

```js
export function init(ctx) {
  const m = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(10, 5, 10),
    new ctx.THREE.MeshLambertMaterial({ color: ctx.colors.sulphide }));
  m.position.copy(ctx.toScene(100, 200, -50));
  ctx.group.add(m);
  ctx.register(m, 'kz.bozshakol:my-thing');
  ctx.label(m, 'Мой объект', { dy: 10 });
}
export function update(ctx, twins) {
  const t = twins['kz.bozshakol:my-thing'];
  if (t) m.userData.label = 'Мой объект · ' + t.features.state.properties.value;
}
```

Ограничения ради программного рендера: материалы Lambert/Basic, без теней и постобработки,
суммарно не больше ~30 тыс. треугольников, подписи — только HTML-оверлей.
