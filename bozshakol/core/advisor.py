#!/usr/bin/env python3
"""bz-advisor — советник диспетчера смены (владелец — координатор).

Читает чужие двойники только через платформу (снимок по HTTP Ditto, дальше события MQTT),
применяет правила из advisor_rules.py и публикует двойник kz.bozshakol:advisor:
advice (JSON-список советов строкой), advice_count, top_advice, level (0–2), advice_ids.
Договор: contract/README.md, раздел «Советник диспетчера».
"""
import json
import time

from advisor_rules import PRIORITY_RU, PLAN_WINDOW_S, advise, fleet_sample
from bzlib import DittoClient, Telemetry, TwinWatcher, feature, setup_logging

log = setup_logging("bz-advisor")
PERIOD_S = 5.0

WATCH = ({"mine", "scenarios", "dispatch", "crusher-01", "stockpile-coarse", "stockpile-clay",
          "plant-sulphide", "plant-clay", "road-ramp-1", "road-ramp-2", "road-crusher"}
         | {f"face-{i:02d}" for i in range(1, 7)} | {f"excavator-{i:02d}" for i in range(1, 7)}
         | {f"truck-{i:02d}" for i in range(1, 29)})


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
    ctx = {"fleet": [], "deliveries": [], "blizzard_since": None}   # данные для правила «метель»
    while True:
        try:
            history, last_ids = step(watcher, telemetry, history, last_ids, ctx)
        except Exception:                       # любая ошибка правила или публикации не должна ронять сервис
            log.exception("ошибка цикла советника")
        time.sleep(PERIOD_S)


def update_fleet_ctx(ctx, snap, t):
    """Срезы парка за последний час без метели, накопительный привоз руды и вскрыши за 2 ч, начало метели."""
    if ctx["deliveries"] and t < ctx["deliveries"][-1][0]:
        ctx.update(fleet=[], deliveries=[], blizzard_since=None)     # модельное время пошло заново
    blizzard = float((snap.get("mine") or {}).get("scenario_blizzard") or 0) >= 1
    if blizzard and ctx["blizzard_since"] is None:
        ctx["blizzard_since"] = t
    if not blizzard:
        ctx["blizzard_since"] = None
        ctx["fleet"].append((t, fleet_sample(snap)))
        ctx["fleet"] = [x for x in ctx["fleet"] if t - x[0] <= PLAN_WINDOW_S]
    d = snap.get("dispatch") or {}
    try:
        ore = float(d.get("delivered_crusher_t") or 0) + float(d.get("delivered_clay_t") or 0)
        ctx["deliveries"].append((t, ore, float(d.get("delivered_dump_t") or 0)))
    except (TypeError, ValueError):
        pass
    ctx["deliveries"] = [x for x in ctx["deliveries"] if t - x[0] <= 2 * PLAN_WINDOW_S]
    return {"samples_before": [s for _, frame in ctx["fleet"] for s in frame],
            "deliveries": ctx["deliveries"], "blizzard_since": ctx["blizzard_since"]}


def step(watcher, telemetry, history, last_ids, ctx=None):
    """Один цикл: снимок двойников -> история -> советы -> публикация. Возвращает (history, last_ids)."""
    if True:
        snap = snapshot(watcher)
        t = model_seconds((snap.get("mine") or {}).get("sim_time"))
        ps = snap.get("plant-sulphide") or {}
        sp = snap.get("stockpile-coarse") or {}
        rule_ctx = update_fleet_ctx(ctx, snap, t) if (ctx is not None and t is not None) else None
        if t is not None and ps:
            if history and t < history[-1][0]:
                history = []                    # модельное время пошло заново (перезапуск bz-core)
            try:
                history.append((t, float(ps.get("feed_rate") or 0.0), float(ps.get("plan_rate") or 0.0),
                                float(sp.get("inflow") or 0.0)))
            except (TypeError, ValueError):
                pass
            history = [h for h in history if t - h[0] <= PLAN_WINDOW_S]
        advice = advise(snap, history, rule_ctx)
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
        return history, last_ids


if __name__ == "__main__":
    main()
