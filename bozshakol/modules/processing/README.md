# Модуль «переработка и энергия» (processing) — участник №4

Сервис `bz-processing` (Python, `main.py`). Владеет двойниками из `twins.json`:
`plant-sulphide`, `plant-clay`, `power-grid`, `crusher-01`, `conveyor-01`, `stockpile-coarse`,
`sag-mill-01`, `flotation-01`, `stockpile-clay`.

Что делает заглушка (замените логику, не меняя протокол из `contract/README.md`):

- дробилка принимает руду по разнице счётчиков `dispatch.delivered_crusher_t` (и `_cu_t`),
  бункер, конвейер ≈ 3 км на склад крупнодроблёной руды, мельница ПСИ с производительностью
  около проектной (2 850 т/ч), флотация с извлечением ≈ 73,4 %, медь в концентрате за смену;
- склад глинистой руды принимает по `dispatch.delivered_clay_t`, фабрика глинистой руды забирает ≈ 570 т/ч;
- `accepting` у дробилки (стоит или бункер полон) и у склада глинистой руды (полон);
- электроснабжение: нагрузка по работающему оборудованию, энергия за смену;
- сценарии: `crusher_stop` (дробилка не принимает → очередь самосвалов, подача падает),
  `sag_maintenance` (мельница на ТО → фабрика стоит, склад растёт).

Свои файлы: `main.py`, `twins.json`, `compose.yml`, `Dockerfile`, `requirements.txt`, этот README,
`web/layers/processing.js`, `grafana/processing.json`. Новые признаки описывайте здесь.
