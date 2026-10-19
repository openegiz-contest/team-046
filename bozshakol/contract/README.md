# Договор команды: двойник карьера Бозшаколь

Этот документ — общие правила для всех частей рудника. Всё наше лежит в `bozshakol/`.
Правила меняет только координатор; участник, которому нужно изменить общее правило или
общий признак, пишет координатору.

## 1. Структура и владельцы

| Путь | Что это | Владелец |
|---|---|---|
| `bozshakol/compose.yml` | наш слой поверх `deploy/compose/docker-compose.yml`; подключает `core/compose.yml`, `modules/*/compose.yml`, `web/compose.yml` через `include` | координатор |
| `bozshakol/contract/` | этот договор | координатор |
| `bozshakol/core/` | координатор: `bz-setup` (создание двойников), `bz-core` (модельное время, погода, сценарии, итоговые показатели), `bz-advisor` (советник диспетчера, раздел 11), `twins.json`, `geometry.json`, общая библиотека `bzlib/` | координатор |
| `bozshakol/modules/haulage/` | транспорт и диспетчеризация: сервис `bz-haulage`, `twins.json`, `compose.yml`, `Dockerfile`, `README.md` | участник №2 |
| `bozshakol/modules/geology/` | геология, качество руды, буровзрывные работы: сервис `bz-geology` | участник №3 |
| `bozshakol/modules/processing/` | переработка и энергия: сервис `bz-processing` | участник №4 |
| `bozshakol/web/` | 3D-сцена (`bz-web`, nginx), кроме `web/layers/` | координатор |
| `bozshakol/web/layers/haulage.js`, `geology.js`, `processing.js` | 3D-слои модулей | №2, №3, №4 соответственно |
| `bozshakol/grafana/overview.json` | общий дашборд | координатор |
| `bozshakol/grafana/haulage.json`, `geology.json`, `processing.json` | дашборды модулей | №2, №3, №4 |
| `bozshakol/data/SOURCES.md` | источники цифр и допущения | координатор (участники присылают строки) |
| `bozshakol/check.sh` | проверка работающего стенда | координатор |
| корневые `README.md`, `SUBMISSION.md`, `Makefile` (только наши цели) | | координатор |

Участник меняет только свои файлы. Общие файлы участник не трогает: его сервис описан в его
`compose.yml` (подключается через `include` из `bozshakol/compose.yml`), его двойники — в его
`twins.json` (`bz-setup` читает все `modules/*/twins.json`), его дашборд — в его файле в
`bozshakol/grafana/` (Grafana подхватывает папку целиком), его 3D-слой — в его файле в `web/layers/`.

## 2. Имена и иерархия двойников

- Пространство имён: `kz.bozshakol`, двойник — `kz.bozshakol:<имя>`; политика `default:basic_policy`.
- Иерархия — штатным атрибутом платформы `_parents` (по нему приложение OpenEgiz в Grafana строит дерево):

```text
mine
├── pit-central      забои face-*, экскаваторы excavator-*, буровые drill-*, дороги road-*, отвал dump-waste-1
├── dispatch         самосвалы truck-*
├── plant-sulphide   crusher-01, conveyor-01, stockpile-coarse, sag-mill-01, flotation-01
├── plant-clay       stockpile-clay
├── power-grid
└── scenarios
```

- Технологические связи (куда уходит материал) — дополнительным атрибутом `downstream`
  (строка или список thingId), только поверх `_parents`, не вместо.
- Обязательные атрибуты: `name` (по-русски), `kind`, `_parents` (кроме `mine`), основные паспортные
  параметры (грузоподъёмность, производительность и т. п.).
- Признаки — как в шаблоне платформы: `{"properties": {"value": ..., "unit": ...}}`. Единицы — по-русски
  (`т`, `т/ч`, `км/ч`, `% Cu`, `м`, `мин`, `МВт`). Значение — число, строка или логическое; у сценариев
  рядом с `value` лежат параметры.

## 3. Телеметрия и чтение чужих двойников

- Сервис пишет свои двойники **только** сообщениями Ditto protocol в MQTT-топик `telemetry/<thingId>`
  (например `telemetry/kz.bozshakol:truck-01`): команда `modify`, путь `/features`, значение —
  все признаки двойника:

```json
{"topic": "kz.bozshakol/truck-01/things/twin/commands/modify",
 "headers": {"response-required": false, "content-type": "application/json"},
 "path": "/features",
 "value": {"state": {"properties": {"value": "hauling"}}, "speed": {"properties": {"value": 28.5, "unit": "км/ч"}}}}
```

- У каждого двойника ровно один сервис-владелец; только он пишет его признаки. Исключение —
  `scenarios`: его признаки включает и выключает пользователь (3D-страница, curl), модули только читают.
- Чужие двойники модуль читает **только через платформу**: исходящий поток Ditto в MQTT
  (`opentwins/twin/events/kz.bozshakol/<имя>` — подключение `mosquitto-target-connection` из
  `deploy/compose/init` публикует события всех пространств имён, наше в том числе) или HTTP API Ditto
  (`GET /api/2/things/<thingId>`, поиск `GET /api/2/search/things?namespaces=kz.bozshakol`).
  Прямых связей между сервисами (общих файлов, сокетов, своих очередей) нет.
- Общая библиотека `core/bzlib/platform.py` (владелец — координатор) умеет: публиковать признаки в MQTT,
  получать снимок двойников через HTTP, следить за событиями по MQTT, считать модельное время.
  Модуль копирует её в свой образ (`COPY core/bzlib ./bzlib` в Dockerfile, контекст сборки — `bozshakol/`).
  Пользоваться ею не обязательно, но протокол выше — обязателен.

## 4. Поток руды между модулями — накопительными счётчиками

Получатель берёт разницу между соседними значениями счётчика; пропуск сообщения ничего не теряет.

| Двойник (владелец) | Признак | Смысл |
|---|---|---|
| `excavator-01…06` (№2) | `loaded_total` (т), `face` | накопительные тонны, отгруженные из текущего забоя; геология уменьшает остаток забоя по разнице |
| `excavator-*` (№2) | `passes_total`, `queue`, `state` | ковшей всего, очередь самосвалов, состояние |
| `dispatch` (№2) | `delivered_crusher_t`, `delivered_crusher_cu_t` | привезено всего на дробилку: тонны и тонны меди |
| `dispatch` (№2) | `delivered_clay_t`, `delivered_clay_cu_t` | привезено всего на склад глинистой руды |
| `dispatch` (№2) | `delivered_dump_t` | вывезено всего в отвал |
| `dispatch` (№2) | `mode`, `avg_wait_excavator` (мин), `assignments` (json), `trucks_hauling`, `trips_total` | режим и показатели диспетчеризации |
| `dispatch` (№2) | `queue_crusher`, `queue_clay`, `queue_dump` (шт) | самосвалы в очереди на разгрузку; №4 показывает их в `crusher-01.trucks_queued` и `stockpile-clay.trucks_queued` |

Обратная связь — признаками:

| Двойник (владелец) | Признак | Кто читает |
|---|---|---|
| `crusher-01` (№4) | `accepting` (true/false) — принимает ли руду | №2: при `false` самосвалы ждут в очереди у дробилки |
| `stockpile-clay` (№4) | `accepting` | №2 |
| `face-01…06` (№3) | `ore_type` (sulphide/clay/waste), `cu_grade` (% Cu), `au_grade` (г/т), `clay_pct` (%), `p80` (мм), `loading_factor` (коэф. скорости погрузки, 1 = норма), `hardness`, `remaining` (т), `recommended_destination` (crusher-01 / stockpile-clay / dump-waste-1), `blasted` | №2: груз самосвала получает содержание и долю глины забоя; время погрузки делится на `loading_factor`; пункт разгрузки — по `recommended_destination` |
| `mine` (координатор) | `sim_time`, `shift`, `shift_hour`, `temperature`, `wind`, `visibility`, `speed_limit` (км/ч), `scenario_<имя>` (1/0), `active_scenarios` | все: `speed_limit` ограничивает скорость самосвалов (метель) |
| `road-*` (№2) | `open`, `speed_limit` | №2 (своё), 3D-сцена |

Признаки самосвала (`truck-*`, №2): `state` ∈ {queued_load, loading, hauling, queued_dump, dumping,
returning, refueling, reserve, down}, `x`, `y`, `z` (м, в общих координатах), `heading` (°), `speed` (км/ч), `payload` (т),
`cargo_type` ∈ {sulphide, clay, waste, none}, `cargo_cu` (% Cu), `cargo_clay` (%), `destination`,
`excavator`, `fuel` (%), `trips_total`.

- `refueling` — «на заправке»: самосвал стоит у топливозаправочного пункта (узел `fuel-station` в
  `core/geometry.json`, рядом с дорогой к дробилке; связан ребром с узлом `rim-ne`). Длительность ≈ 15 мин
  модельного времени, примерно раз в смену (по признаку `fuel`); после заправки `fuel` = 100. В сцене
  самосвал на заправке окрашен как порожний (белый).
- `reserve` — «в резерве»: самосвал стоит на стоянке у узла `fuel-station` и не участвует в перевозке
  (не ездит, не грузится, не получает назначений); `payload` = 0, `cargo_type` = none, `destination` = «».
  Вывод в резерв и возврат в работу — решение модуля №2 (например, лишние самосвалы в ручном режиме или
  при остановке дробилки). В сцене самосвал в резерве серо-белый: слой транспорта (№2) передаёт признак
  `state` в модель библиотеки — `g.setState(state)` (для `reserve` библиотека красит кабину и кузов серо-белым,
  для `down` — красным); легенда дополнена.

Итоговые показатели в `mine` (координатор считает по чужим двойникам через платформу):
`ore_to_plants` (т/ч), `plan_fulfilment` (%), `feed_cu` (% Cu), `feed_clay` (%), `cu_concentrate_shift` (т),
`trucks_hauling`. Для этого модуль №4 публикует в `plant-sulphide` и `plant-clay`: `feed_rate`, `feed_cu`,
`feed_clay`, `plan_fulfilment`, `ore_shift_t`, `cu_concentrate_shift`.

## 5. Модельное время

- Все сервисы считают модельное время одинаково: `модельное = старт + (реальное − старт_реальное) × SIM_SPEEDUP`;
  `SIM_SPEEDUP` — одна переменная окружения для всех (по умолчанию 10; задаётся в `deploy/compose/.env`).
- Смена 12 ч; старт модели — 08:00 (дневная смена). Модельное время (`sim_time`, ISO), номер смены (`shift`)
  и час смены (`shift_hour`) публикует `mine`; остальные берут для отображения оттуда, для расчётов —
  свой шаг `dt` в модельных секундах.
- Погода (`temperature`, `wind`, `visibility`) и ограничение скорости `speed_limit` — тоже в `mine`.

## 6. Сценарии «что если»

- Двойник `kz.bozshakol:scenarios`, по признаку на сценарий:
  `{"properties": {"value": false, "<параметр>": ..., "owner": "<модуль>"}}`.
- Включают и выключают сценарий **только записью одного признака** через API Ditto — кнопкой в 3D-сцене
  или curl; никогда заменой всех признаков:

```bash
curl -u "ditto:$DITTO_PASSWORD" -X PUT -H 'Content-Type: application/json' -d true \
  "http://localhost:$DITTO_PORT/api/2/things/kz.bozshakol:scenarios/features/crusher_stop/properties/value"
```

- Модули только читают (через события `opentwins/twin/events/kz.bozshakol/scenarios` и HTTP). Отмена = выключить (`false`).
- **Сценарии в истории (InfluxDB, Grafana).** Одиночная запись признака через API Ditto попадает в InfluxDB
  полем без имени признака, поэтому сам двойник `scenarios` на графиках не виден. Координатор (`bz-core`)
  публикует вместе с остальными признаками `mine` (каждые 5 с) числовой признак `scenario_<имя>`
  (1 — включён, 0 — выключен) для каждого сценария и строковый `active_scenarios` — список включённых
  по-русски через запятую («нет», если ничего не включено). Для графиков и аннотаций в дашбордах модулей
  брать `mine.scenario_<имя>`: поле InfluxDB `value_scenario_<имя>_properties_value`,
  `thingId = kz.bozshakol:mine`. Реагировать на сценарий модули по-прежнему должны по двойнику `scenarios`.

| Сценарий | Владелец реакции | Параметры | Что происходит |
|---|---|---|---|
| `blizzard` | координатор | `visibility_m`, `speed_limit_kmh` | метель: видимость и ограничение скорости в `mine` |
| `dispatch_off` | №2 | — | диспетчеризация выключена: закреплённое распределение, ожидание растёт |
| `road_closed` | №2 | `road` | дорога закрыта (`road-*.open = false`), маршруты перестраиваются |
| `excavator_down` | №2 | `excavator` | экскаватор сломан, его самосвалы перераспределяются |
| `clay_face` | №3 | `face`, `clay_pct` | сульфидный забой оказался глинистым: доля глины и рекомендуемый пункт разгрузки меняются |
| `bad_blast` | №3 | `face`, `p80_mm` | неудачный взрыв: крупность растёт, скорость погрузки падает |
| `crusher_stop` | №4 | — | дробилка стоит, `accepting = false`, очередь растёт, подача на фабрику падает |
| `sag_maintenance` | №4 | — | мельница на ТО: фабрика не принимает со склада, склад растёт |

## 7. Частота и объём

- Подвижная техника (самосвалы) — не чаще 1 сообщения в секунду на двойник; остальное — раз в 5–10 с
  или при изменении. Публикуется всегда весь набор признаков двойника.
- Образы: одна база `python:3.12-slim`, библиотеки с закреплёнными версиями (`paho-mqtt==2.1.0`);
  лишних загрузок не добавлять.

## 8. Порты и пароли

- Порты — только из `deploy/compose/.env` со значениями по умолчанию как в шаблоне (`GRAFANA_PORT=3000`,
  `DITTO_PORT=8080`, `EXTENDED_API_PORT=8085`, `UNITY_PORT=8090`, `INFLUXDB_PORT=8086`, `MQTT_PORT=1883`);
  наш: `BOZSHAKOL_WEB_PORT=8095` (3D-страница, слушает `127.0.0.1`; `make bozshakol` дописывает строку
  в `.env`, если её нет). В коде номера портов напрямую не писать: внутри сети Compose сервисы обращаются
  по именам (`mosquitto:1883`, `ditto-nginx:80`), снаружи — по переменным из `.env`.
- Пароли берутся из `.env` через переменные окружения Compose; в код, страницу и репозиторий не попадают.
  3D-страница ходит в Ditto через прокси nginx (`/ditto/…`), который сам добавляет заголовок авторизации.

## 9. 3D-сцена и слои

- Общая сцена (`web/index.html`, `web/app.js`) строит карьер, дороги, конвейер, здания, панель и карточку
  двойника, загружает слои `web/layers/haulage.js`, `geology.js`, `processing.js` (ES-модули).
- Интерфейс слоя: модуль экспортирует `init(ctx)` и `update(ctx, twins)`.
  - `ctx.THREE` — three.js; `ctx.scene` — сцена; `ctx.group` — группа слоя (всё своё добавлять в неё);
    `ctx.geometry` — `core/geometry.json`; `ctx.toScene(x, y, z)` — перевод координат рудника (м) в сцену;
    `ctx.register(object3d, thingId)` — сделать объект кликабельным (карточка двойника);
    `ctx.colors` — палитра (`sulphide`, `clay`, `waste`, `empty`, `down`, …); `ctx.dt` — секунды с прошлого кадра.
  - `twins` — объект `thingId → {attributes, features}` с текущими значениями (`features.<f>.properties.value`),
    обновляется из Ditto (SSE или опрос раз в секунду). `update` вызывается каждый кадр: слой сам
    плавно интерполирует положение между обновлениями.
  - Слой рисует только объекты своего модуля (техника — haulage; забои, буровые — geology;
    дробилка, конвейер, склады, фабрики — processing). Все подписи — по-русски.
- Цвета самосвалов: гружёный — по грузу (сульфидная руда — медно-зелёный, глинистая — рыжий, вскрыша — серый),
  порожний — белый, авария (`down`) — красный.

- Дополнительные возможности `ctx` (общая сцена, добавлено; старые вызовы работают как прежде):
  - `ctx.label(object3d, text, importance)` — третий аргумент-число — важность подписи: 3 — крупные объекты
    (карьер, дробилка, конвейер, фабрики, отвал, склады), видны всегда; 2 — забои, экскаваторы, буровые: видны при
    приближении камеры (< 3,5 км) или при выборе; 1 — самосвалы: только при наведении мыши, выборе или сильном
    приближении (< 700 м). Старая форма `ctx.label(obj, text, {dy, small})` сохранена: важность берётся по виду
    двойника (крупные объекты 3, самосвалы 1, остальное 2); можно передать `{dy, small, importance}`.
    Подписи, перекрывающие уже размещённую более важную, скрываются; видимых — не больше ~30. Текст по-прежнему
    меняется через `object3d.userData.label`.
  - `ctx.markerScale` — число, пересчитывается каждый кадр по расстоянию камеры (1 вблизи < 1,5 км, линейно до 4
    на 8 км). Слой умножает на него масштаб своих значков техники (например, `group.scale.setScalar(BASE * ctx.markerScale)`
    в `update`), чтобы самосвалы и экскаваторы были видны на общем плане.
  - `ctx.register(object3d, thingId, {hitRadius})` — как раньше, плюс необязательный радиус «хитбокса» (м, по умолчанию 25):
    клик и наведение засчитываются в невидимую сферу радиусом `hitRadius × ctx.markerScale` вокруг объекта.
  - `ctx.hover` — thingId объекта под курсором (или `null`), `ctx.selected` — thingId выбранного объекта
    (открыта карточка) — обновляются каждый кадр; слой может подсвечивать свой объект.
  - `ctx.heightAt(x, y)` — высота поверхности, м, в координатах рудника: вне карьера — рельеф Copernicus DEM
    (`data/terrain`), у наземных дорог — профиль дороги, внутри карьера — бермы модели уступов. Высоты в
    `core/geometry.json` (узлы, объекты) и признаки `x, y, z` двойников уже абсолютные (включают рельеф), их
    ставить как есть; `heightAt` нужен только для объектов, у которых своей высоты нет.
  - `ctx.groundAt(x, y)` — высота земли со всеми правками сцены (рельеф + выровненные площадки у зданий,
    складов и отвалов + профиль наземных дорог; внутри карьера — бермы уступов), м. Именно на неё ставить
    всё, что стоит на земле: `g.position.copy(ctx.toScene(x, y, ctx.groundAt(x, y)))`.
  - `ctx.models` — общая библиотека моделей `web/models.js` (владелец — координатор): детальные
    низкополигональные модели в метрах, низ на y = 0, «вперёд» = +Z. Фабрики:
    `truck({cls: 135|180})` (методы `setDumping(t)`, `setLoad(type)`, `setState(state)`, `setWheels(dist)`),
    `excavator()` (`setSwing(rad)`, `setBoom(t)`, `setState`), `drill()` (`setMast(up)`, `setState`),
    `crusher()` (`setState('running'|'idle'|'stopped')`), `conveyor(points, {height, step})` (`setFlow(tph, dt)`),
    `building('main'|'thickener'|'warehouse'|'substation'|'office', {size})`, `stockpile(volume_m3, {color})`
    (`setVolume(v)`), `dump(radius, height, {tiers})`, `lightMast(h)`, `powerLine(points)`, `fence(points)`.
    У всех — `setDetail('full'|'far')` для дальнего плана. Пример для слоя транспорта:

```js
export function init(ctx) {
  state.trucks = {};
  for (const id of truckIds) {
    const g = ctx.models.truck({ cls: capacity(id) === 180 ? 180 : 135 });
    ctx.group.add(g); ctx.register(g, id); ctx.label(g, name(id), 1);
    state.trucks[id] = g;
  }
}
export function update(ctx, twins) {
  for (const [id, g] of Object.entries(state.trucks)) {
    const f = twins[id] && twins[id].features; if (!f) continue;
    const v = (k) => f[k] && f[k].properties.value;
    g.position.copy(ctx.toScene(v('x'), v('y'), v('z')));      // x, y, z двойника уже включают рельеф
    g.rotation.y = Math.PI - v('heading') * Math.PI / 180;     // heading: 0 = север, по часовой; «вперёд» модели = +Z, север сцены = −Z
    g.scale.setScalar(ctx.markerScale);                          // заметность на общем плане
    g.setLoad(v('payload') > 0 ? v('cargo_type') : 'none');
    g.setDumping(v('state') === 'dumping' ? 1 : 0);
    g.setState(v('state'));
    g.setDetail(g.position.distanceTo(ctx.camera.position) > 2500 ? 'far' : 'full');
  }
}
```

    Высота в сцене преувеличена ×1,5 (`ctx.verticalScale`); модели в метрах без этого множителя —
    только положение (через `toScene`) учитывает его.
  - `ctx.verticalScale` — вертикальное преувеличение рельефа (1,5); `ctx.toScene` уже учитывает его, размеры
    собственных моделей (высота кузова, стрелы) слой оставляет в метрах без множителя.
- Сценарии в сцене: плашка «Активные сценарии» сверху, значок «⚠ …» над объектом из параметров сценария
  (`crusher_stop` → `crusher-01`, `sag_maintenance` → `sag-mill-01`, `road_closed` → `road`, `excavator_down` → `excavator`,
  `clay_face`/`bad_blast` → `face`), `blizzard` — дымка на всей сцене, `dispatch_off` — отметка в панели транспорта.
  Объект ищется по `thingId`, переданному в `ctx.register`, поэтому важно регистрировать объекты под именами двойников.
- Журнал событий в панели строится из изменений двойников: сценарии, `crusher-01.state`/`accepting`,
  `stockpile-clay.accepting`, `excavator-*.state = down`, `road-*.open`, `truck-*.state = down`; время — `mine.sim_time`.

## 10. Данные и допущения

Исходные цифры — в `data/SOURCES.md` со ссылками. Всё, чего нет в источниках, помечается «допущение»
с обоснованием. Новые признаки модуль добавляет свободно и описывает в своём `README.md`; признаки,
которые читают другие модули (таблицы в разделе 4), меняются только через координатора.

## 11. Советник диспетчера

Двойник `kz.bozshakol:advisor` (`_parents`: `mine`), сервис `bz-advisor` в `core/` (владелец — координатор).
Это то, ради чего двойник существует: подсказать диспетчеру смены конкретное решение с цифрами и причиной.
Советник читает чужие двойники только через платформу и ничего в них не пишет.

Признаки `advisor` (публикуются каждые 5 с вместе):

| Признак | Что это |
|---|---|
| `advice` | JSON-список советов строкой, главный совет первым (см. поля ниже) |
| `advice_count` | число советов (шт) |
| `top_advice` | текст главного совета; «Отклонений нет», если советов нет |
| `level` | уровень главного совета: 2 — критично, 1 — важно, 0 — к сведению или нет советов |
| `advice_ids` | идентификаторы советов через запятую (для журнала событий в сцене) |

Поля одного совета в `advice`: `id` (crusher / clay / plan / inflow / fleet / blizzard), `priority` (critical / important / info),
`level` (2 / 1 / 0), `title`, `text` (что сделать, с числами), `reason` (почему: какие двойники и значения),
`effect` (ожидаемый эффект), `target` (thingId объекта, к которому относится совет), `data` (использованные значения).

Правила детерминированные и объяснимые (`core/advisor_rules.py`, проверяются `core/tests/test_advisor_rules.py`
подменой данных; пороги — допущения, обоснованы в `data/SOURCES.md`):

| id | Когда | Данные | Совет |
|---|---|---|---|
| `crusher` | `crusher-01.accepting = false` | `crusher-01.stop_reason`, `stockpile-coarse.hours_left`, `stop_forecast`, `dispatch.queue_crusher` | «Фабрика встанет в ЧЧ:ММ (запас N ч). У дробилки K гружёных самосвалов — перевести на вскрышу или в резерв; разгрузку руды возобновить, когда дробилка примет». Критично при запасе < 2 ч. Если дробилка `running` без `stop_reason` (просто полон бункер) — только «к сведению»: «Бункер дробилки полон, новых самосвалов не направлять» |
| `clay` | `plant-sulphide.feed_clay` > 10 % | `face-*.ore_type`, `clay_pct`, `recommended_destination` | «Забой face-0X даёт глину Y % — направлять его руду на склад глинистой руды»; эффект — прирост извлечения ≈ 0,4 % на 1 % глины сверх 5 % |
| `plan` | среднее `plant-sulphide.feed_rate` за последний модельный час < 95 % `plan_rate` (нужно ≥ 45 мин данных) | `excavator-*.state`, `road-*.open`, `crusher-01`, `stockpile-coarse`, `mine.scenario_*` | «Фабрика за час — P % плана. Узкое место: …» (экскаватор в аварии, закрытая дорога, дробилка, пустой склад, выключенная диспетчеризация, метель). Критично при < 80 % |
| `inflow` | фабрика идёт по плану, но среднее `stockpile-coarse.inflow` за последний час < 95 % `plan_rate` | те же, что у `plan`, и `stockpile-coarse.hours_left` | «Привоз руды на дробилку за час — P % плана; фабрика идёт со склада, его хватит на N ч. Узкое место: …» — раннее предупреждение. Критично при запасе < 2 ч |
| `fleet` | `dispatch.mode = auto` и `avg_wait_excavator` > 2 мин (ориентир Бозшаколя 1–1,5 мин) | `dispatch.trucks_hauling`, `trucks_needed` (если модуль №2 публикует), `excavator-*.queue` | «Лишних самосвалов ≈ K — поставить в резерв (`reserve`)»; K = `trucks_hauling − trucks_needed`, иначе очередь у экскаваторов минус число работающих экскаваторов |
| `blizzard` | `mine.scenario_blizzard = 1` | `mine.speed_limit`, `stockpile-coarse.hours_left` | «Скорость ограничена до N км/ч — привоз руды упадёт ≈ на X %; держать запас склада не меньше 4 ч»; X = 1 − 1 / (0,4 + 0,6·50/N). Критично при запасе < 4 ч |

В 3D-сцене советы показаны блоком «Советы диспетчеру» вверху панели (главный крупно, цвет по приоритету),
значком «совет» над объектом `target`; клик по совету ведёт камеру к объекту; появление и снятие совета
попадает в журнал событий. В Grafana (обзорный дашборд) — число советов и главный совет во времени.
Модуль №2 может публиковать `dispatch.trucks_needed` (требуемое число самосвалов) — советник возьмёт его вместо оценки.

