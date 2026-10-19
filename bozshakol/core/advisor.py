#!/usr/bin/env python3
"""bz-advisor — советник диспетчера смены (владелец — координатор).

Читает чужие двойники только через платформу (снимок по HTTP Ditto, дальше события MQTT),
применяет правила из advisor_rules.py и публикует двойник kz.bozshakol:advisor:
advice (JSON-список советов строкой), advice_count, top_advice, level (0–2), advice_ids.
Договор: contract/README.md, раздел «Советник диспетчера».
"""
import json
import time

from advisor_rules import PRIORITY_RU, PLAN_WINDOW_S, advise
from bzlib import DittoClient, Telemetry, TwinWatcher, feature, setup_logging

log = setup_logging("bz-advisor")
PERIOD_S = 5.0

WATCH = ({"mine", "scenarios", "dispatch", "crusher-01", "stockpile-coarse", "stockpile-clay",
          "plant-sulphide", "plant-clay", "road-ramp-1", "road-ramp-2", "road-crusher"}
         | {f"face-{i:02d}" for i in range(1, 7)} | {f"excavator-{i:02d}" for i in range(1, 7)})


def model_seconds(iso):
    """mine.sim_time (ISO) -> секунды; None, если нет."""
    try:
        return time.mktime(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, TypeError):
        return None


def snapshot(watcher):
    """{короткое имя: {признак: значение}} по всем наблюдаемым двойникам."""
    snap = {}
    for name in WATCH:
        feats = watcher.features(name)
        if feats:
            snap[name] = {k: (v.get("properties") or {}).get("value") for k, v in feats.items() if isinstance(v, dict)}
    return snap


def main():
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names=WATCH, client_id="bz-advisor-watch").start()
    telemetry = Telemetry(client_id="bz-advisor").connect()
    history = []          # (модельное время, с; plant-sulphide.feed_rate; plan_rate; stockpile-coarse.inflow) за последний час
    last_ids = None
    while True:
        snap = snapshot(watcher)
        t = model_seconds((snap.get("mine") or {}).get("sim_time"))
        ps = snap.get("plant-sulphide") or {}
        sp = snap.get("stockpile-coarse") or {}
        if t is not None and ps:
            try:
                history.append((t, float(ps.get("feed_rate") or 0.0), float(ps.get("plan_rate") or 0.0),
                                float(sp.get("inflow") or 0.0)))
            except (TypeError, ValueError):
                pass
            history = [h for h in history if t - h[0] <= PLAN_WINDOW_S]
        advice = advise(snap, history)
        top = advice[0] if advice else None
        ids = ",".join(a["id"] for a in advice)
        telemetry.publish("advisor", {
            "advice": feature(json.dumps(advice, ensure_ascii=False), "json"),
            "advice_count": feature(len(advice), "шт"),
            "top_advice": feature(top["text"] if top else "Отклонений нет"),
            "level": feature(top["level"] if top else 0),
            "advice_ids": feature(ids),
        })
        if ids != last_ids:
            for a in advice:
                log.info("[%s] %s — %s", PRIORITY_RU[a["priority"]], a["title"], a["text"])
            if not advice:
                log.info("советов нет")
            last_ids = ids
        time.sleep(PERIOD_S)


if __name__ == "__main__":
    main()
