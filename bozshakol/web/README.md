# 3D-сцена рудника (web)

Статическая страница без сборки: nginx (`compose.yml`, `nginx.conf.template`) отдаёт эту папку,
`core/geometry.json` по адресу `/geometry.json`, настройку `/config.json` (`grafanaUrl`) и проксирует
Ditto по `/ditto/...` (пароль подставляет nginx, в браузер он не попадает).

## Файлы

- `index.html`, `style.css` — разметка: холст, слой HTML-подписей, панель слева, карточка двойника справа внизу.
- `app.js` — общая сцена: карьер (бермы и стенки уступов разного тона, контуры кромок, дно, съезды с обводкой;
  вертикальное преувеличение ×1,5 через `toScene`, подпись в углу), дороги (красные при `road-*.open = false`),
  кнопки-виды («Весь рудник», «Карьер», «Дробилка и конвейер», «Фабрики», «Сверху (карта)», «Следовать за самосвалом»)
  с плавными переходами, клики и наведение (с «хитбоксами»), подписи с важностью и защитой от наложения,
  панель диспетчера (смена и модельное время, карточки фабрик с планом/фактом, транспорт, погода), журнал событий,
  плашка и значки активных сценариев, легенда, связь с Ditto (снимок через поиск, затем SSE; если SSE не открылся
  за 5 с или оборвался — опрос раз в секунду), загрузка слоёв.
- `terrain.js` — рельеф степи: `loadTerrain(THREE, geometry)` → `{ok, heightAt(x, y), buildGround(scene), attribution}`.
  Сейчас заглушка (ровная степь с отверстием под карьер, `heightAt = 0`); настоящий рельеф подключается заменой
  этого файла, `app.js` не меняется; `attribution` показывается мелким текстом в углу сцены.
- `layers/haulage.js` — самосвалы и экскаваторы; `layers/geology.js` — забои и буровые;
  `layers/processing.js` — дробилка, конвейер, склады, фабрики, подстанция, отвал.
- `vendor/three/` — three.js 0.160.0 (см. `VERSION.txt`), подключается через importmap, без CDN.

Координаты: `geometry.json` в метрах (X — восток, Y — север, Z — высота), в сцену переводит
`toScene(x, y, z) = Vector3(x, z, -y)` (Y сцены — вверх).

## Как слою добавить объекты

Слой — ES-модуль `layers/<модуль>.js`, экспортирует `init(ctx)` и `update(ctx, twins)`:

- `ctx.THREE`, `ctx.scene`, `ctx.group` (группа слоя — всё своё добавлять сюда), `ctx.geometry`,
  `ctx.toScene(x, y, z)`, `ctx.register(object3d, thingId, {hitRadius})` (клик → карточка; «хитбокс» по умолчанию 25 м × `markerScale`),
  `ctx.colors`, `ctx.dt`, `ctx.camera`, `ctx.markerScale` (множитель размера значков техники по удалению камеры),
  `ctx.hover` / `ctx.selected` (thingId под курсором / выбранный), `ctx.heightAt(x, y)`, `ctx.verticalScale`;
- `ctx.label(object3d, text, importance)` — HTML-подпись над объектом; важность 3 — всегда видна, 2 — при приближении
  или выборе, 1 — при наведении/выборе. Старая форма `ctx.label(obj, text, {dy, small})` работает (важность по виду
  двойника). Текст меняется через `object3d.userData.label = '...'`. Подписи, налезающие на более важные, прячутся;
  видимых не больше ~30.
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
суммарно не больше ~40 тыс. треугольников, подписи — только HTML-оверлей.
