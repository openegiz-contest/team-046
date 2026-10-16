# Бозшаколь: цифровой двойник медного карьера на OpenEgiz

Двойник карьера Бозшаколь (KAZ Minerals Bozshakol, Павлодарская область) и пути руды от забоя
до двух обогатительных фабрик — сульфидной и фабрики глинистой руды. Пользователь — горный
диспетчер смены. Описание замысла, модулей и данных — в [SUBMISSION.md](SUBMISSION.md).

## Запуск с нуля

Проверено на Ubuntu 24.04 с Docker 29 и Docker Compose 2.40 (нужно 6 ГБ памяти для Docker).
Все команды выполняются из корня репозитория.

```bash
sudo apt-get update && sudo apt-get install -y make
```

```bash
make bozshakol
```

Эта команда поднимает платформу OpenEgiz (при первом запуске создаёт пароли в `deploy/compose/.env`),
собирает образы рудника, создаёт двойники и запускает сервисы, 3D-сцену и дашборды. Первый запуск
скачивает образы и собирает расширенный API платформы: обычно 10–20 минут в зависимости от сети;
повторный запуск — 2–3 минуты. В конце команда печатает адреса.

Проверка работающего стенда (двойники, телеметрия, сценарии, 3D-страница, история в InfluxDB):

```bash
make bozshakol-check
```

Остановить (данные остаются) и снова поднять:

```bash
make down
```

```bash
make up
```

## Что открыть в браузере

| Что | Адрес | Вход |
|---|---|---|
| 3D-сцена карьера (панель диспетчера, сценарии «что если», карточки двойников) | http://localhost:8095 | не нужен |
| Grafana → Dashboards → папка **Бозшаколь** (обзор, транспорт, геология, переработка и энергия) | http://localhost:3000 | `admin` / значение `GRAFANA_ADMIN_PASSWORD` из `deploy/compose/.env` (его печатает `make bozshakol`) |
| Grafana → приложение **OpenEgiz** → **Twins** — иерархия двойников `kz.bozshakol` | там же | там же |
| Ditto API: все двойники | http://localhost:8080/api/2/search/things?namespaces=kz.bozshakol | `ditto` / `DITTO_PASSWORD` из `deploy/compose/.env` |

Порты задаются в `deploy/compose/.env` (`GRAFANA_PORT`, `DITTO_PORT`, `BOZSHAKOL_WEB_PORT` и другие);
в таблице — значения по умолчанию.

Сценарии «что если» включаются кнопками в 3D-сцене или записью одного признака, например:

```bash
. deploy/compose/.env && curl -u "ditto:$DITTO_PASSWORD" -X PUT -H 'Content-Type: application/json' -d true "http://localhost:$DITTO_PORT/api/2/things/kz.bozshakol:scenarios/features/crusher_stop/properties/value"
```

Отмена — то же самое с `false`. Полный список сценариев — в [bozshakol/contract/README.md](bozshakol/contract/README.md).

## Как устроен репозиторий

| Путь | Содержимое |
|---|---|
| `bozshakol/` | Всё наше. `contract/README.md` — договор команды: имена и иерархия двойников, протокол телеметрии, счётчики, сценарии, владельцы папок |
| `bozshakol/core/` | Координатор: создание двойников (`bz-setup`), модельное время, погода, итоговые показатели (`bz-core`), `geometry.json`, общая библиотека `bzlib/` |
| `bozshakol/modules/haulage/`, `geology/`, `processing/` | Модули: транспорт и диспетчеризация, геология и качество руды, переработка и энергия — по сервису, `twins.json` и README на модуль |
| `bozshakol/web/` | 3D-сцена (three.js локально, nginx), слои модулей в `web/layers/` |
| `bozshakol/grafana/` | Дашборды Grafana |
| `bozshakol/data/SOURCES.md` | Источники цифр и допущения |
| `bozshakol/check.sh` | Проверка работающего стенда |
| `SUBMISSION.md` | Описание решения |
| `examples/mine/` | Пример рудника из шаблона платформы; в решении не используется |
| `OPENEGIZ.md`, `OPENEGIZ.ru.md` | Документация платформы OpenEgiz v1.0.4: требования, Windows/WSL2, устранение неполадок |

Справка о платформе (установка Docker, Windows/WSL2, `make up`, `make smoke`, `make clean`) —
в [OPENEGIZ.ru.md](OPENEGIZ.ru.md) / [OPENEGIZ.md](OPENEGIZ.md).

## Лицензия

Решение распространяется под лицензией MIT, см. [LICENSE](LICENSE).

---

Платформа: [aleka07/openegiz](https://github.com/aleka07/openegiz).
