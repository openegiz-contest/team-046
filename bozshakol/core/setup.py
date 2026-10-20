#!/usr/bin/env python3
"""bz-setup: создаёт все двойники рудника Бозшаколь в Ditto (одноразово).

Читает core/twins.json и modules/*/twins.json из TWINS_DIR (bozshakol/ смонтирована
в /mine). PUT идемпотентен: повторный запуск ничего не ломает — атрибуты и
начальные признаки обновляются, двойники не дублируются. Признаки сценариев
при повторном запуске сохраняются (включённый сценарий не сбрасывается).
"""
import glob
import json
import os
import sys
import urllib.error

from bzlib import DittoClient, setup_logging

log = setup_logging("bz-setup")


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
    created = updated = 0
    for thing_id, body in twins.items():  # родители идут раньше детей (порядок файлов)
        existing = None
        try:
            existing = ditto.retry(lambda: ditto.get_thing(thing_id, "features"))
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
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
    log.info("готово: создано %d, обновлено %d, всего %d двойников", created, updated, len(twins))
    return 0


if __name__ == "__main__":
    sys.exit(main())
