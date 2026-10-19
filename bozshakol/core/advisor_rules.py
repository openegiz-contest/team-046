"""Правила советника диспетчера (bz-advisor). Чистые функции без платформы — их проверяет
core/tests/test_advisor_rules.py подменой данных.

advise(snap, history) -> список советов, главный первым. snap — {короткое имя двойника: {признак: значение}},
history — список (модельное время, с; feed_rate; plan_rate) сульфидной фабрики за последний модельный час.

Каждый совет: id, priority (critical / important / info), level (2 / 1 / 0), title, text (что сделать, с числами),
reason (почему, по каким двойникам), effect (ожидаемый эффект), target (thingId объекта), data (использованные значения).
Пороги — допущения, обоснованы в data/SOURCES.md.
"""
import re

NS = "kz.bozshakol"

CLAY_LIMIT_PCT = 10.0        # глина в питании сульфидной фабрики, выше — совет б)
CLAY_NORM_PCT = 5.0          # «нормальная» глина сульфидных забоев (модель фабрики №4: −0,4 % извлечения на 1 % сверх)
RECOVERY_PER_CLAY = 0.4
PLAN_LIMIT_PCT = 95.0        # выполнение плана за последний модельный час, ниже — совет в)
PLAN_WINDOW_S = 3600         # окно «последний модельный час»
PLAN_MIN_SPAN_S = 2700       # минимум данных в окне (45 мин), иначе совет не даётся
WAIT_LIMIT_MIN = 2.0         # ожидание у экскаватора в «авто», выше — совет г)
WAIT_TARGET_MIN = 1.25       # ориентир Бозшаколя 1–1,5 мин
BASE_SPEED_KMH = 50          # ограничение без метели (mine.speed_limit)
BLIZZARD_TRAVEL_SHARE = 0.6  # доля хода в цикле самосвала (остальное — погрузка, разгрузка, очереди)
BLIZZARD_RESERVE_H = 4.0     # запас склада, который стоит держать на время метели
STOCK_CRIT_H = 2.0           # запас склада меньше — «критично»

LEVEL = {"critical": 2, "important": 1, "info": 0}
PRIORITY_RU = {"critical": "критично", "important": "важно", "info": "к сведению"}
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")


def _f(d, key, default=0.0):
    try:
        v = d.get(key)
        return default if v is None or v == "" else float(v)
    except (TypeError, ValueError, AttributeError):
        return default


def _advice(aid, priority, title, text, reason, effect, target, data):
    return {"id": aid, "priority": priority, "level": LEVEL[priority], "title": title, "text": text,
            "reason": reason, "effect": effect, "target": f"{NS}:{target}" if target else "", "data": data}


def _tid_short(name):
    return name.split(":", 1)[1] if ":" in name else name


# ---------------------------------------------------------------- а) дробилка не принимает
def rule_crusher(snap):
    cr = snap.get("crusher-01") or {}
    if cr.get("accepting") is not False:
        return None
    sp = snap.get("stockpile-coarse") or {}
    d = snap.get("dispatch") or {}
    hours = _f(sp, "hours_left")
    stock = _f(sp, "stock")
    forecast = str(sp.get("stop_forecast") or "").strip()
    k = int(_f(d, "queue_crusher", _f(cr, "trucks_queued")))
    why = str(cr.get("stop_reason") or "").strip() or f"дробилка: {cr.get('state', '—')}"
    if TIME_RE.match(forecast):
        head = f"Фабрика встанет в {forecast} (запас склада {hours:.1f} ч)."
    elif forecast and forecast != "не ожидается":
        head = f"Остановка фабрики: {forecast} (запас склада {hours:.1f} ч)."
    else:
        head = f"Запас склада фабрики {hours:.1f} ч."
    trucks = (f"У дробилки {k} гружёных самосвалов — перевести на вскрышу или в резерв; "
              if k > 0 else "Гружёные самосвалы к дробилке не направлять — на вскрышу или в резерв; ")
    text = head + " " + trucks + "разгрузку руды возобновить, когда дробилка примет."
    priority = "critical" if hours < STOCK_CRIT_H else "important"
    return _advice("crusher", priority, "Дробилка не принимает руду", text,
                   f"crusher-01.accepting = false ({why}); склад крупнодроблёной руды {stock:.0f} т, хватит на {hours:.1f} ч; "
                   f"очередь у дробилки {k}",
                   "очередь у дробилки не растёт, самосвалы заняты вскрышей; фабрика работает со склада, пока он не кончится",
                   "crusher-01", {"crusher-01.accepting": False, "crusher-01.stop_reason": why, "stockpile-coarse.hours_left": hours,
                                  "stockpile-coarse.stock": stock, "stockpile-coarse.stop_forecast": forecast, "dispatch.queue_crusher": k})


# ---------------------------------------------------------------- б) глина в питании
def rule_clay(snap):
    ps = snap.get("plant-sulphide") or {}
    clay = _f(ps, "feed_clay")
    if clay <= CLAY_LIMIT_PCT:
        return None
    faces = []
    for name, f in snap.items():
        if not name.startswith("face-") or not isinstance(f, dict):
            continue
        if f.get("ore_type") == "sulphide" and _f(f, "clay_pct") > CLAY_LIMIT_PCT:
            faces.append((name, _f(f, "clay_pct"), f.get("recommended_destination") or ""))
    faces.sort(key=lambda x: -x[1])
    gain = RECOVERY_PER_CLAY * (clay - CLAY_NORM_PCT)
    if faces:
        face, pct, dest = faces[0]
        text = (f"Забой {face} даёт глину {pct:.0f} % — направлять его руду на склад глинистой руды (stockpile-clay), "
                f"а не на дробилку.")
        reason = (f"глина в питании сульфидной фабрики {clay:.1f} % при пороге {CLAY_LIMIT_PCT:.0f} %; "
                  f"сульфидные забои с глиной выше порога: " + ", ".join(f"{n} {p:.0f} %" for n, p, _ in faces) +
                  (f"; рекомендованный пункт у {face}: {dest}" if dest else ""))
        target = face
    else:
        text = (f"Глина в питании сульфидной фабрики {clay:.1f} % — выше порога {CLAY_LIMIT_PCT:.0f} %; "
                f"глинистый забой по двойникам не определён: проверить забои и рекомендованные пункты разгрузки.")
        reason = f"plant-sulphide.feed_clay = {clay:.1f} %; у сульфидных забоев clay_pct ≤ {CLAY_LIMIT_PCT:.0f} %"
        target = "plant-sulphide"
    return _advice("clay", "important", "Глина в питании фабрики", text, reason,
                   f"глина в питании вернётся к ≈ {CLAY_NORM_PCT:.0f} %, извлечение меди вырастет ≈ на {gain:.1f} % "
                   f"(модель фабрики: −{RECOVERY_PER_CLAY} % извлечения на 1 % глины сверх {CLAY_NORM_PCT:.0f} %)",
                   target, {"plant-sulphide.feed_clay": clay, "faces": [{"face": n, "clay_pct": p} for n, p, _ in faces]})


# ---------------------------------------------------------------- в) план ниже 95 % за час
def rule_plan(snap, history):
    if not history:
        return None
    t_last = history[-1][0]
    window = [h for h in history if t_last - h[0] <= PLAN_WINDOW_S]
    if len(window) < 2 or t_last - window[0][0] < PLAN_MIN_SPAN_S:
        return None
    feeds = [h[1] for h in window]
    plans = [h[2] for h in window if h[2]]
    if not plans:
        return None
    plan = sum(plans) / len(plans)
    feed = sum(feeds) / len(feeds)
    pct = feed / plan * 100 if plan else 100.0
    if pct >= PLAN_LIMIT_PCT:
        return None
    mine = snap.get("mine") or {}
    cr = snap.get("crusher-01") or {}
    sp = snap.get("stockpile-coarse") or {}
    causes, target = [], None
    for name, f in sorted(snap.items()):
        if name.startswith("excavator-") and isinstance(f, dict) and f.get("state") == "down":
            causes.append(f"{name} в аварии — перераспределить его самосвалы на другие забои")
            target = target or name
    for name, f in sorted(snap.items()):
        if name.startswith("road-") and isinstance(f, dict) and f.get("open") is False:
            causes.append(f"дорога {name} закрыта — маршруты через другой съезд")
            target = target or name
    if cr.get("accepting") is False or str(cr.get("state", "")) in ("stopped", "down", "failed"):
        causes.append(f"дробилка не принимает ({cr.get('stop_reason') or cr.get('state')}) — см. совет по дробилке")
        target = target or "crusher-01"
    if _f(sp, "hours_left", 1.0) < 0.25 or _f(sp, "stock", 1.0) <= 0:
        causes.append(f"склад крупнодроблёной руды пуст ({_f(sp, 'stock'):.0f} т) — увеличить привоз руды на дробилку")
        target = target or "stockpile-coarse"
    if _f(mine, "scenario_dispatch_off") >= 1:
        causes.append("диспетчеризация выключена — включить автоматический режим")
        target = target or "dispatch"
    if _f(mine, "scenario_blizzard") >= 1:
        causes.append(f"метель, ограничение {_f(mine, 'speed_limit', BASE_SPEED_KMH):.0f} км/ч — см. совет по метели")
        target = target or "mine"
    if not causes:
        causes.append("причина по двойникам не определена: привоз руды на дробилку ниже плана — проверить забои и очереди")
        target = "plant-sulphide"
    text = (f"Сульфидная фабрика за последний час — {pct:.0f} % плана ({feed:.0f} из {plan:.0f} т/ч). "
            f"Узкое место: {causes[0]}.")
    return _advice("plan", "critical" if pct < 80 else "important", "План фабрики ниже 95 %", text,
                   "среднее plant-sulphide.feed_rate за последний модельный час против plan_rate; " +
                   "; ".join(causes),
                   f"устранение узкого места возвращает подачу к плану {plan:.0f} т/ч",
                   target, {"plan_pct_hour": round(pct, 1), "feed_avg": round(feed, 1), "plan_rate": round(plan, 1), "causes": causes})


# ---------------------------------------------------------------- г) ожидание у экскаватора
def rule_fleet(snap):
    d = snap.get("dispatch") or {}
    if str(d.get("mode", "auto")) != "auto":
        return None
    wait = _f(d, "avg_wait_excavator")
    if wait <= WAIT_LIMIT_MIN:
        return None
    hauling = int(_f(d, "trucks_hauling"))
    queued, working, downs = 0, 0, []
    for name, f in sorted(snap.items()):
        if name.startswith("excavator-") and isinstance(f, dict):
            if f.get("state") == "down":
                downs.append(name)
            else:
                working += 1
                queued += int(_f(f, "queue"))
    needed = d.get("trucks_needed")
    if needed not in (None, ""):
        k = max(1, hauling - int(_f(d, "trucks_needed")))
        how = f"модуль транспорта считает нужными {int(_f(d, 'trucks_needed'))} из {hauling} самосвалов в работе"
    else:
        k = max(1, queued - working)
        how = f"в очередях у экскаваторов стоит {queued} самосвалов при {working} работающих экскаваторах (по одному грузится)"
    text = (f"Ожидание у экскаватора {wait:.1f} мин при ориентире {WAIT_TARGET_MIN:.1f} мин. "
            f"Лишних самосвалов ≈ {k} — поставить в резерв (state = reserve, стоянка у заправки).")
    return _advice("fleet", "important", "Лишние самосвалы", text,
                   f"dispatch.avg_wait_excavator = {wait:.1f} мин > {WAIT_LIMIT_MIN:.0f} мин в режиме auto; {how}" +
                   (f"; экскаваторы в аварии: {', '.join(downs)}" if downs else ""),
                   f"ожидание у экскаватора снизится к {WAIT_TARGET_MIN:.1f} мин, расход топлива и износ — меньше на ≈ {k} машин",
                   "dispatch", {"dispatch.avg_wait_excavator": wait, "dispatch.trucks_hauling": hauling,
                                "excavator_queue_total": queued, "excavators_working": working, "reserve_estimate": k})


# ---------------------------------------------------------------- д) метель
def rule_blizzard(snap):
    mine = snap.get("mine") or {}
    if _f(mine, "scenario_blizzard") < 1:
        return None
    limit = _f(mine, "speed_limit", BASE_SPEED_KMH) or BASE_SPEED_KMH
    ratio = 1.0 / ((1 - BLIZZARD_TRAVEL_SHARE) + BLIZZARD_TRAVEL_SHARE * BASE_SPEED_KMH / limit)
    drop = max(0.0, (1 - ratio) * 100)
    sp = snap.get("stockpile-coarse") or {}
    hours = _f(sp, "hours_left")
    text = (f"Метель: скорость ограничена до {limit:.0f} км/ч — привоз руды упадёт примерно на {drop:.0f} %; "
            f"держать запас склада крупнодроблёной руды не меньше {BLIZZARD_RESERVE_H:.0f} ч (сейчас {hours:.1f} ч).")
    priority = "critical" if hours < BLIZZARD_RESERVE_H else "important"
    return _advice("blizzard", priority, "Метель", text,
                   f"mine.scenario_blizzard = 1, mine.speed_limit = {limit:.0f} км/ч (обычно {BASE_SPEED_KMH}); видимость "
                   f"{_f(mine, 'visibility'):.0f} м; доля хода в цикле самосвала {BLIZZARD_TRAVEL_SHARE:.0%} (допущение)",
                   "фабрика переживёт просадку привоза за счёт склада; при запасе ниже порога — сократить вскрышу в пользу руды",
                   "mine", {"mine.speed_limit": limit, "haul_drop_pct": round(drop, 1), "stockpile-coarse.hours_left": hours,
                            "reserve_hours": BLIZZARD_RESERVE_H})


def advise(snap, history=None):
    """Все правила; главный совет первым (по уровню, затем по порядку правил)."""
    out = []
    for rule in (rule_crusher, rule_clay, lambda s: rule_plan(s, history or []), rule_fleet, rule_blizzard):
        a = rule(snap)
        if a:
            out.append(a)
    out.sort(key=lambda a: -a["level"])
    return out
