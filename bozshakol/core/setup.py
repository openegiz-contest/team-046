#!/usr/bin/env python3
"""bz-setup: создаёт все двойники рудника Бозшаколь в Ditto.

Читает core/twins.json и modules/*/twins.json из TWINS_DIR (bozshakol/ смонтирована
в /mine). Запускается при каждом make bozshakol, поэтому живое состояние не трогает:
  • двойника нет — создаётся целиком (атрибуты и начальные признаки из twins.json);
  • двойник есть — его признаки (features) НЕ перезаписываются: накопительные счётчики
    dispatch, запасы складов, бункер, состояние техники продолжаются с того же места;
    атрибуты (паспортные данные) обновляются из twins.json поверх существующих;
    признаки, которых у двойника ещё нет (новые в twins.json), добавляются по одному;
  • сценарии (kz.bozshakol:scenarios): параметры (face, p80_mm, road…) — из twins.json,
    включён ли сценарий (value) — сохраняется.

Типы двойников (вкладка OpenEgiz → Types в Grafana) — как задумано платформой: тип — это thing
с attributes._isType = true, двойник ссылается на свой тип атрибутом attributes.type = id типа.
  • тип на каждый вид двойников (attributes.kind): kz.bozshakol.types:<kind>, название и описание
    по-русски, признаки — все признаки двойников этого вида из twins.json (значения пустые, единицы — как у них);
  • типа нет — создаётся через Extended API платформы (PUT /api/types/<id>, _isType ставит платформа);
    тип есть — как существующий двойник: атрибуты поверх, новые признаки добавляются, ничего не стирается;
  • двойнику ставится attributes.type (его признаки не трогаются). Повторный запуск — те же id, без дублей.
"""
import glob
import json
import os
import sys
import urllib.error
import urllib.request

from bzlib import DittoClient, setup_logging, tid

log = setup_logging("bz-setup")

TYPES_NS = "kz.bozshakol.types"   # отдельное пространство имён: поиск двойников kz.bozshakol типы не задевает
# вид двойника (attributes.kind) → тип: название и описание по-русски
TYPES = {
    "mine": ("Рудник", "Рудник целиком: модельное время и смена, погода, подача руды на фабрики, медь, включённые сценарии."),
    "pit": ("Карьер", "Карьер: глубина, высота уступа, сколько забоев в работе."),
    "face": ("Забой", "Место выемки на уступе карьера: тип руды, медь и золото, глина, крепость, крупность после взрыва, "
             "остаток взорванной массы, куда везти руду."),
    "drill": ("Буровой станок", "Бурит скважины под взрыв: где стоит, блок, пробурено метров и скважин, скорость бурения, крепость породы."),
    "drill_summary": ("Сводка бурения", "Буровые станки вместе: загрузка, сколько работает и сколько нужно, "
                      "производительность бурения против потребности взрывов, медь в питании — цель и факт."),
    "excavator": ("Экскаватор", "Грузит руду и вскрышу в самосвалы на забое: состояние, забой, очередь самосвалов, погружено тонн и ковшей."),
    "truck": ("Самосвал", "Карьерный самосвал: состояние, место и скорость, груз (руда, глина или вскрыша, медь), куда едет, "
              "от какого экскаватора, топливо, рейсы."),
    "dispatch": ("Диспетчер", "Диспетчеризация самосвалов: режим, ожидание у экскаваторов и на разгрузке, очереди, "
                 "перевезено тонн и меди, рейсы, загрузка парка, топливо, сколько машин нужно и в резерве."),
    "road": ("Дорога", "Участок карьерной дороги (съезд, дорога к дробилке): открыта ли, ограничение скорости, самосвалов на участке."),
    "dump": ("Отвал вскрыши", "Отвал пустой породы (вскрыши): принято тонн, принимает ли, очередь самосвалов."),
    "crusher": ("Дробилка", "Дробилка у борта карьера: состояние, принимает ли самосвалы, тонн в час, бункер, очередь, "
                "медь в питании, крупность и крепость руды, мощность."),
    "conveyor": ("Конвейер", "Ленточный конвейер от дробилки к складу: состояние, тонн в час, скорость, загрузка ленты, время в пути, мощность."),
    "stockpile": ("Склад", "Склад руды: запас, медь и глина, приход и расход, заполнение, на сколько часов хватит, прогноз остановки или переполнения."),
    "plant": ("Фабрика", "Обогатительная фабрика: подача руды, план и его выполнение, медь и глина в питании, извлечение, "
              "медь в концентрате, удельный расход энергии, состояние."),
    "mill": ("Мельница", "Мельница полусамоизмельчения: состояние, тонн в час, мощность, крупность продукта."),
    "flotation": ("Флотация", "Флотация: подача, медь в питании, извлечение меди, концентрат и медь в нём."),
    "power": ("Энергосеть", "Электроснабжение рудника и фабрик: нагрузка по потребителям, энергия за смену, удельный расход, "
              "пики, холостой ход, лимит мощности."),
    "advisor": ("Советник", "Советы диспетчеру (что мешает руднику и что сделать) и сверка модели с реальностью."),
    "scenarios": ("Сценарии", "Сценарии «что если»: включён ли каждый и его параметры (забой, дорога, крупность…)."),
}


def type_id(kind):
    return f"{TYPES_NS}:{kind}"


def type_bodies(twins):
    """Тело типа на каждый вид двойников: признаки — объединение признаков двойников этого вида (значения пустые)."""
    bodies = {}
    for body in twins.values():
        kind = (body.get("attributes") or {}).get("kind")
        if kind not in TYPES:
            continue
        name, description = TYPES[kind]
        t = bodies.setdefault(type_id(kind), {"policyId": body.get("policyId", "default:basic_policy"),
                                              "attributes": {"name": name, "description": description, "kind": kind},
                                              "features": {}})
        for fname, feat in (body.get("features") or {}).items():
            props = ((feat or {}).get("properties") or {})
            t["features"].setdefault(fname, {"properties": {k: (v if k == "unit" else None) for k, v in props.items()}})
    return bodies


def link_type(thing_id, body):
    """Двойник ссылается на свой тип: attributes.type = id типа — так хранит OpenEgiz двойник, созданный из типа.
    Атрибут type занят платформой: своё значение type (так было у crusher-01: «гирационная», теперь в twins.json
    это crusher_type) переносится в <kind>_type — для старых данных."""
    attrs = dict(body.get("attributes") or {})
    kind = attrs.get("kind")
    if kind not in TYPES:
        return body
    own = attrs.get("type")
    if own is not None and own != type_id(kind):
        attrs.setdefault(f"{kind}_type", own)
        log.info("%s: атрибут type — ссылка на тип в OpenEgiz; своё значение «%s» хранится в %s_type", thing_id, own, kind)
    attrs["type"] = type_id(kind)
    return dict(body, attributes=attrs)


class ExtendedApi:
    """Extended API OpenEgiz (через него типы создаёт и вкладка Types в Grafana). Входящей авторизации у него нет."""

    def __init__(self, url=None):
        self.url = (url or os.environ.get("EXTENDED_URL", "http://extended-api:8080")).rstrip("/")

    def put_type(self, thing_id, body):
        req = urllib.request.Request(f"{self.url}/api/types/{thing_id}", data=json.dumps(body).encode(), method="PUT",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status


def get_existing(ditto, thing_id):
    try:
        return ditto.retry(lambda: ditto.get_thing(thing_id, "thingId,attributes,features"))
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        return None


def update_existing(ditto, thing_id, existing, body):
    """Существующий двойник или тип: признаки не трогаем (иначе сбрасываются счётчики и запасы), атрибуты —
    из twins.json поверх существующих, признаки, которых ещё нет, — добавляем по одному.
    Возвращает (изменены ли атрибуты, сколько признаков добавлено)."""
    new_attrs = dict(existing.get("attributes") or {})
    new_attrs.update(body.get("attributes") or {})
    changed = new_attrs != (existing.get("attributes") or {})
    if changed:
        ditto.retry(lambda: ditto._request("PUT", f"/api/2/things/{tid(thing_id)}/attributes", new_attrs))
    added = 0
    have = existing.get("features") or {}
    for name, feat in (body.get("features") or {}).items():
        if name not in have:   # новый признак — добавляем, остальные не трогаем
            ditto.retry(lambda: ditto._request("PUT", f"/api/2/things/{tid(thing_id)}/features/{name}", feat))
            added += 1
    return changed, added


def setup_types(ditto, twins, ext):
    """Типы: нет — создаётся через Extended API; есть — дополняется (ничего не стирается)."""
    created = kept = 0
    ext_ok = True
    for thing_id, body in type_bodies(twins).items():
        existing = get_existing(ditto, thing_id)
        if existing:
            update_existing(ditto, thing_id, existing, body)
            kept += 1
            continue
        if ext_ok:
            try:
                ditto.retry(lambda: ext.put_type(thing_id, body))
                created += 1
                continue
            except (urllib.error.URLError, OSError) as exc:   # HTTPError — тоже URLError
                ext_ok = False
                log.warning("Extended API не ответил (%s) — типы пишутся прямо в Ditto с _isType=true", exc)
        ditto.retry(lambda: ditto.put_thing(thing_id, dict(body, attributes=dict(body["attributes"], _isType=True))))
        created += 1
    log.info("типы (%s): создано %d, существующих %d", TYPES_NS, created, kept)


def load_all(twins_dir):
    files = [os.path.join(twins_dir, "core", "twins.json")]
    files += sorted(glob.glob(os.path.join(twins_dir, "modules", "*", "twins.json")))
    twins = {}
    for path in files:
        if not os.path.exists(path):
            log.warning("нет файла %s", path)
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for thing_id, body in data.items():
            if thing_id in twins:
                log.error("двойник %s описан дважды (второй раз в %s)", thing_id, path)
                sys.exit(1)
            twins[thing_id] = body
        log.info("%-45s %3d двойников", os.path.relpath(path, twins_dir), len(data))
    return twins


def main():
    twins_dir = os.environ.get("TWINS_DIR", "/mine")
    ditto = DittoClient()
    twins = load_all(twins_dir)
    setup_types(ditto, twins, ExtendedApi())   # сначала типы — двойники ссылаются на них
    created = updated = attrs = added = 0
    for thing_id, body in twins.items():  # родители идут раньше детей (порядок файлов)
        body = link_type(thing_id, body)
        existing = get_existing(ditto, thing_id)
        if existing and not thing_id.endswith(":scenarios"):
            changed, n = update_existing(ditto, thing_id, existing, body)
            attrs += changed
            added += n
            updated += 1
            continue
        if existing and thing_id.endswith(":scenarios"):
            # включён ли сценарий (value) — сохраняем; параметры (face, p80_mm, road…) — из twins.json;
            # сценарии, которых нет в twins.json, оставляем как есть
            merged = {}
            for name, feat_body in body.get("features", {}).items():
                props = dict(feat_body.get("properties", {}))
                old_props = (existing.get("features", {}).get(name) or {}).get("properties", {})
                if "value" in old_props:
                    props["value"] = old_props["value"]
                merged[name] = {"properties": props}
            for name, feat_body in existing.get("features", {}).items():
                merged.setdefault(name, feat_body)
            body = dict(body, features=merged)
        status = ditto.retry(lambda: ditto.put_thing(thing_id, body))
        if status == 201:
            created += 1
        else:
            updated += 1
    log.info("готово: создано %d, существующих %d (признаки сохранены; атрибуты обновлены у %d, "
             "добавлено новых признаков %d), всего %d двойников", created, updated, attrs, added, len(twins))
    return 0


if __name__ == "__main__":
    sys.exit(main())
