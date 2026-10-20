"""Правила советника диспетчера (bz-advisor). Чистые функции без платформы — их проверяет
core/tests/test_advisor_rules.py подменой данных.

advise(snap, history, ctx) -> список советов, главный первым. snap — {короткое имя двойника: {признак: значение}},
history — список (модельное время, с; feed_rate; plan_rate; inflow склада) за последний модельный час;
ctx — данные для правила «метель» (срезы парка до метели, накопительный привоз, начало метели).

Каждый совет: id, priority (critical / important / info), level (2 / 1 / 0), title, text (что сделать, с числами),
reason (почему, по каким двойникам), effect (ожидаемый эффект), target (thingId объекта), data (использованные значения).
Пороги — допущения, обоснованы в data/SOURCES.md.
"""
import re
import time as _t

NS = "kz.bozshakol"

CLAY_LIMIT_PCT = 10.0        # глина в питании сульфидной фабрики, выше — совет б)
CLAY_NORM_PCT = 5.0          # «нормальная» глина сульфидных забоев (модель фабрики №4: −0,4 % извлечения на 1 % сверх)
RECOVERY_PER_CLAY = 0.4
PLAN_LIMIT_PCT = 95.0        # выполнение плана за последний модельный час, ниже — совет в)
PLAN_WINDOW_S = 3600         # окно «последний модельный час»
PLAN_MIN_SPAN_S = 3300       # минимум данных в окне «последний час» (55 мин), иначе совет не даётся
WARMUP_S = 3600              # первый модельный час после старта — «рудник разгоняется», правила привоза молчат
RECOVER_WINDOW_S = 900       # последние 15 мин: если привоз уже в норме, совет по привозу снимается
WAIT_LIMIT_MIN = 2.0         # ожидание у экскаватора в «авто», выше — совет г)
WAIT_TARGET_MIN = 1.25       # ориентир Бозшаколя 1–1,5 мин
BASE_SPEED_KMH = 50          # ограничение без метели (mine.speed_limit), если признака нет
BLIZZARD_TRAVEL_SHARE = 0.6  # доля хода в цикле, только если срезов парка до метели мало (иначе — из двойников)
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
    state = str(cr.get("state") or "")
    reason = str(cr.get("stop_reason") or "").strip()
    if state == "running" and not reason:
        # дробилка работает, просто бункер полон — короткая пауза, фабрика не пострадает: к сведению
        bunker, cap = _f(cr, "bunker"), _f(cr, "capacity")
        text = (f"Дробилка временно не принимает: бункер полон ({bunker:.0f} т). "
                f"{k} самосвалов ждут разгрузки — новых к дробилке пока не направлять, бункер освободится за несколько минут.")
        return _advice("crusher", "info", "Бункер дробилки полон", text,
                       f"crusher-01.accepting = false при state = running и пустом stop_reason; бункер {bunker:.0f} т"
                       + (f" при производительности {cap:.0f} т/ч" if cap else "") + f"; очередь у дробилки {k}",
                       "очередь рассосётся без вмешательства; совет снимется, когда дробилка снова примет",
                       "crusher-01", {"crusher-01.accepting": False, "crusher-01.state": state, "crusher-01.bunker": bunker,
                                      "dispatch.queue_crusher": k})
    why = reason or f"дробилка: {state or '—'}"
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
def _clay_face_scenario(snap):
    """Забой сценария clay_face (из параметров двойника scenarios), если сценарий включён."""
    if _f(snap.get("mine") or {}, "scenario_clay_face") < 1:
        return None
    params = (snap.get("scenarios_params") or {}).get("clay_face") or {}
    face = params.get("face")
    return face if face in snap else None


def _trucks_to_crusher(snap, face):
    """Гружёные самосвалы забоя face (экскаватор с тем же номером), которые едут или стоят на дробилку."""
    exc = "excavator-" + face.split("-")[-1]
    return sorted(n for n, f in snap.items() if n.startswith("truck-") and isinstance(f, dict)
                  and f.get("excavator") == exc and f.get("destination") == "crusher-01" and _f(f, "payload") > 0)


def rule_clay(snap):
    ps = snap.get("plant-sulphide") or {}
    clay = _f(ps, "feed_clay")
    scen_face = _clay_face_scenario(snap)
    if clay <= CLAY_LIMIT_PCT and not scen_face:
        return None
    faces = []
    for name, f in sorted(snap.items()):
        if not name.startswith("face-") or not isinstance(f, dict):
            continue
        # сульфидный забой с глиной выше порога; при сценарии clay_face геология может пометить забой как clay
        if (f.get("ore_type") == "sulphide" or name == scen_face) and _f(f, "clay_pct") > CLAY_LIMIT_PCT:
            faces.append((name, _f(f, "clay_pct"), f.get("recommended_destination") or ""))
    faces.sort(key=lambda x: (-x[1], x[0]))
    gain = RECOVERY_PER_CLAY * (max(clay, CLAY_NORM_PCT) - CLAY_NORM_PCT)
    if faces:
        face, pct, dest = faces[0]
        trucks = _trucks_to_crusher(snap, face)
        text = f"Забой {face} даёт глину {pct:.0f} % — направлять его руду на склад глинистой руды (stockpile-clay), а не на дробилку."
        if trucks:
            text += f" Сейчас {len(trucks)} гружёных самосвалов этого забоя везут руду на дробилку."
        elif dest == "stockpile-clay":
            text += " Геология уже рекомендует склад глины — проверить, что самосвалы забоя едут туда."
        reason = (f"глина в питании сульфидной фабрики {clay:.1f} % (порог {CLAY_LIMIT_PCT:.0f} %)"
                  + (f"; включён сценарий «глинистый забой» ({face})" if face == scen_face else "")
                  + "; забои с глиной выше порога: " + ", ".join(f"{n} {p:.0f} %" for n, p, _ in faces)
                  + (f"; рекомендованный пункт у {face}: {dest}" if dest else "")
                  + (f"; на дробилку везут: {', '.join(trucks)}" if trucks else ""))
        target = face
        priority = "important" if (clay > CLAY_LIMIT_PCT or trucks) else "info"
    else:
        if clay <= CLAY_LIMIT_PCT:
            return None                 # сценарий включён, но забой ещё не стал глинистым, и в питании глина в норме
        trucks = []
        text = (f"Глина в питании сульфидной фабрики {clay:.1f} % — выше порога {CLAY_LIMIT_PCT:.0f} %; "
                f"глинистый забой по двойникам не определён: проверить забои и рекомендованные пункты разгрузки.")
        reason = f"plant-sulphide.feed_clay = {clay:.1f} %; у сульфидных забоев clay_pct ≤ {CLAY_LIMIT_PCT:.0f} %"
        target = "plant-sulphide"
        priority = "important"
    return _advice("clay", priority, "Глина в питании фабрики", text, reason,
                   f"глина в питании останется около {CLAY_NORM_PCT:.0f} %"
                   + (f", извлечение меди вырастет ≈ на {gain:.1f} %" if gain > 0.05 else ", извлечение меди не упадёт")
                   + f" (модель фабрики: −{RECOVERY_PER_CLAY} % извлечения на 1 % глины сверх {CLAY_NORM_PCT:.0f} %)",
                   target, {"plant-sulphide.feed_clay": clay, "faces": [{"face": n, "clay_pct": p} for n, p, _ in faces],
                            "trucks_to_crusher": trucks})


# ---------------------------------------------------------------- в) план ниже 95 % за час
def _hour_window(history):
    """Окно «последний модельный час» или None, если данных меньше 55 мин."""
    if not history:
        return None
    t_last = history[-1][0]
    window = [h for h in history if t_last - h[0] <= PLAN_WINDOW_S]
    if len(window) < 2 or t_last - window[0][0] < PLAN_MIN_SPAN_S:
        return None
    if t_last - history[0][0] < WARMUP_S:      # первый модельный час после старта — «рудник разгоняется»
        return None
    return window


def _busiest_excavator(snap):
    """Работающий экскаватор с самой длинной очередью (объект для советов по парку самосвалов)."""
    best = None
    for name, f in sorted(snap.items()):
        if name.startswith("excavator-") and isinstance(f, dict) and f.get("state") != "down":
            q = _f(f, "queue")
            if best is None or q > best[1]:
                best = (name, q)
    return best[0] if best else "excavator-01"


def _bottlenecks(snap):
    """Узкие места по состояниям двойников: список причин с действием и объект первого из них."""
    mine = snap.get("mine") or {}
    cr = snap.get("crusher-01") or {}
    sp = snap.get("stockpile-coarse") or {}
    causes, target = [], None
    d = snap.get("dispatch") or {}
    reserve = int(_f(d, "trucks_reserve"))
    if reserve > 0:
        # недовоз руды при самосвалах в резерве: вернуть в работу K (по trucks_needed модуля транспорта)
        # trucks_needed модуля №2 — среднее число самосвалов, занятых делом (погрузка, рейс, разгрузка, возврат),
        # без очередей; сравниваем с тем же — самосвалами в работе без очередей
        working = sum(1 for st, _ in fleet_sample(snap) if st in ("loading", "hauling", "dumping", "returning")) \
            or int(_f(d, "trucks_hauling"))
        need = _f(d, "trucks_needed", working)
        k = max(1, min(reserve, int(round(need - working))))
        causes.append(f"в резерве {reserve} самосвалов при нехватке руды — вернуть {k} в работу")
        target = "dispatch"
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
    ps = snap.get("plant-sulphide") or {}
    if _f(mine, "scenario_sag_maintenance") >= 1 or str(ps.get("state", "")) == "maintenance":
        causes.append("мельница на ремонте — фабрика не берёт руду со склада; после ремонта подача восстановится сама")
        target = target or "sag-mill-01"
    if _f(mine, "scenario_dispatch_off") >= 1:
        causes.append("диспетчеризация выключена — включить автоматический режим")
        target = target or _busiest_excavator(snap)
    if _f(mine, "scenario_blizzard") >= 1:
        causes.append(f"метель, ограничение {_f(mine, 'speed_limit', BASE_SPEED_KMH):.0f} км/ч — см. совет по метели")
        target = target or "stockpile-coarse"
    if not causes:
        causes.append("причина по двойникам не определена: привоз руды на дробилку ниже плана — проверить забои и очереди")
        target = "plant-sulphide"
    return causes, target


def rule_plan(snap, history):
    """Подача на сульфидную фабрику за последний модельный час ниже 95 % плана."""
    window = _hour_window(history)
    if not window:
        return None
    plans = [h[2] for h in window if h[2]]
    if not plans:
        return None
    plan = sum(plans) / len(plans)
    feed = sum(h[1] for h in window) / len(window)
    pct = feed / plan * 100 if plan else 100.0
    if pct >= PLAN_LIMIT_PCT:
        return None
    causes, target = _bottlenecks(snap)
    text = (f"Сульфидная фабрика за последний час — {pct:.0f} % плана ({feed:.0f} из {plan:.0f} т/ч). "
            f"Узкое место: {causes[0]}.")
    return _advice("plan", "critical" if pct < 80 else "important", "План фабрики ниже 95 %", text,
                   "среднее plant-sulphide.feed_rate за последний модельный час против plan_rate; " +
                   "; ".join(causes),
                   f"устранение узкого места возвращает подачу к плану {plan:.0f} т/ч",
                   target, {"plan_pct_hour": round(pct, 1), "feed_avg": round(feed, 1), "plan_rate": round(plan, 1), "causes": causes})


def rule_inflow(snap, history):
    """Фабрика пока идёт по плану со склада, но привоз руды на дробилку за последний час ниже 95 % плана —
    склад тает; раннее предупреждение с тем же поиском узкого места."""
    window = _hour_window(history)
    if not window or len(window[0]) < 4:
        return None
    plans = [h[2] for h in window if h[2]]
    if not plans:
        return None
    plan = sum(plans) / len(plans)
    feed = sum(h[1] for h in window) / len(window)
    inflow = sum(h[3] for h in window) / len(window)
    if plan <= 0 or feed / plan * 100 < PLAN_LIMIT_PCT:
        return None            # фабрика уже ниже плана — работает rule_plan
    pct = inflow / plan * 100
    if pct >= PLAN_LIMIT_PCT:
        return None
    recent = [h[3] for h in window if window[-1][0] - h[0] <= RECOVER_WINDOW_S]
    if recent and sum(recent) / len(recent) / plan * 100 >= PLAN_LIMIT_PCT:
        return None            # привоз уже восстановился, среднее за час ещё догоняет — совет снимаем
    sp = snap.get("stockpile-coarse") or {}
    hours = _f(sp, "hours_left")
    causes, target = _bottlenecks(snap)
    text = (f"Привоз руды на дробилку за последний час — {pct:.0f} % плана ({inflow:.0f} из {plan:.0f} т/ч); "
            f"фабрика идёт со склада, его хватит на {hours:.1f} ч. Узкое место: {causes[0]}.")
    # фабрика при этом идёт со склада на план — «к сведению» (с запасом в часах); критично при запасе < 2 ч
    return _advice("inflow", "critical" if hours < STOCK_CRIT_H else "info", "Привоз руды ниже плана", text,
                   "среднее stockpile-coarse.inflow за последний модельный час против plant-sulphide.plan_rate; " +
                   "; ".join(causes),
                   f"привоз вернётся к плану {plan:.0f} т/ч, склад перестанет таять",
                   target, {"inflow_pct_hour": round(pct, 1), "inflow_avg": round(inflow, 1), "plan_rate": round(plan, 1),
                            "stockpile-coarse.hours_left": hours, "causes": causes})


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
    if d.get("trucks_needed") not in (None, "") and d.get("trucks_reserve") not in (None, ""):
        needed, reserve = _f(d, "trucks_needed"), int(_f(d, "trucks_reserve"))
        # «в работе» — самосвалы в цикле (очередь, погрузка, рейс, разгрузка) по двойникам truck-*:
        # trucks_needed модуля №2 — среднее число занятых в цикле, а trucks_hauling — только самосвалы в пути
        in_cycle = len(fleet_sample(snap)) or hauling
        k = int(round(in_cycle - needed))
        if k < 1:
            return None                 # модуль транспорта уже держит в работе столько, сколько нужно
        how = (f"модуль транспорта: в работе (в цикле) {in_cycle}, нужно ≈ {needed:.1f} (dispatch.trucks_needed), "
               f"в резерве уже {reserve} (dispatch.trucks_reserve)")
    else:
        k = max(1, queued - working)
        how = f"в очередях у экскаваторов стоит {queued} самосвалов при {working} работающих экскаваторах (по одному грузится)"
    text = (f"Ожидание у экскаватора {wait:.1f} мин при ориентире {WAIT_TARGET_MIN:.1f} мин. "
            f"Лишних самосвалов ≈ {k} — поставить в резерв (state = reserve, стоянка у заправки).")
    return _advice("fleet", "important", "Лишние самосвалы", text,
                   f"dispatch.avg_wait_excavator = {wait:.1f} мин > {WAIT_LIMIT_MIN:.0f} мин в режиме auto; {how}" +
                   (f"; экскаваторы в аварии: {', '.join(downs)}" if downs else ""),
                   f"ожидание у экскаватора снизится к {WAIT_TARGET_MIN:.1f} мин, расход топлива и износ — меньше на ≈ {k} машин",
                   _busiest_excavator(snap), {"dispatch.avg_wait_excavator": wait, "dispatch.trucks_hauling": hauling,
                                "excavator_queue_total": queued, "excavators_working": working, "reserve_estimate": k})


# ---------------------------------------------------------------- д) метель
MOVING_LOADED = ("hauling",)                   # гружёный в пути
MOVING_EMPTY = ("returning",)                  # порожний в пути
CYCLE_STATES = ("queued_load", "loading", "hauling", "queued_dump", "dumping", "returning")   # самосвал в работе
FALLBACK_LOADED_KMH = (30.0, 30.0, 12.0)       # если данных до метели нет: гружёный по ровной, на спуске, в гору
FALLBACK_EMPTY_KMH = (40.0, 40.0, 25.0)        # порожний по ровной, на спуске, в гору (паспортные допущения модуля №2)
BLIZZARD_MEASURE_MIN_S = 1800                  # фактическое изменение привоза — после 30 модельных минут метели


def fleet_sample(snap):
    """Срез парка из двойников truck-*: [(состояние, скорость км/ч)] для самосвалов в работе."""
    out = []
    for name, f in sorted(snap.items()):
        if name.startswith("truck-") and isinstance(f, dict) and f.get("state") in CYCLE_STATES:
            out.append((f.get("state"), _f(f, "speed")))
    return out


def haul_slowdown(samples, limit):
    """Во сколько раз упадёт вывоз горной массы при ограничении limit, по срезам парка ДО метели.
    samples — [(состояние, скорость)] за последний час без метели. Каждый срез — равный отрезок времени, поэтому
    путь на нём ∝ v, а время на тот же путь при ограничении — v / min(v, limit): время хода растёт в
    mean(v / min(v, limit)) раз. Доля хода в цикле s — доля срезов «в пути» среди самосвалов в работе.
    Вывоз ∝ 1 / ((1 − s) + s · рост_хода). Возвращает (доля вывоза, s, ср. скорость гружёных, порожних, источник)."""
    moving = [(st, v) for st, v in samples if st in MOVING_LOADED + MOVING_EMPTY and v > 1.0]
    source = "по скоростям самосвалов за час до метели"
    if len(moving) < 20:
        moving = [("hauling", v) for v in FALLBACK_LOADED_KMH] + [("returning", v) for v in FALLBACK_EMPTY_KMH]
        share = BLIZZARD_TRAVEL_SHARE
        source = "по паспортным скоростям (данных до метели мало)"
    else:
        share = len(moving) / max(1, len(samples))
    growth = sum(v / min(v, limit) for _, v in moving) / len(moving)
    ratio = 1.0 / ((1 - share) + share * growth)
    loaded = [v for st, v in moving if st in MOVING_LOADED]
    empty = [v for st, v in moving if st in MOVING_EMPTY]
    avg = lambda xs: sum(xs) / len(xs) if xs else 0.0
    return ratio, share, avg(loaded), avg(empty), source


def measured_change(deliveries, t_start):
    """Фактическое изменение привоза руды и вскрыши: час до метели против метели (≥ 30 мин).
    deliveries — [(t, руда т накопительно, вскрыша т накопительно)]; t_start — начало метели (модельные с)."""
    if not deliveries or t_start is None:
        return None
    t_last = deliveries[-1][0]
    if t_last - t_start < BLIZZARD_MEASURE_MIN_S:
        return None
    before = [d for d in deliveries if t_start - 3600 <= d[0] <= t_start]
    during = [d for d in deliveries if d[0] >= t_start]
    if len(before) < 2 or len(during) < 2 or before[-1][0] - before[0][0] < 1800:
        return None
    rate = lambda xs, i: (xs[-1][i] - xs[0][i]) / ((xs[-1][0] - xs[0][0]) / 3600.0)
    ore_b, ore_d = rate(before, 1), rate(during, 1)
    w_b, w_d = rate(before, 2), rate(during, 2)
    if ore_b <= 0 or w_b <= 0:
        return None
    return {"ore_pct": (ore_d / ore_b - 1) * 100, "waste_pct": (w_d / w_b - 1) * 100,
            "ore_before": ore_b, "ore_during": ore_d, "waste_before": w_b, "waste_during": w_d,
            "minutes": (t_last - t_start) / 60.0}


def rule_blizzard(snap, ctx=None):
    mine = snap.get("mine") or {}
    if _f(mine, "scenario_blizzard") < 1:
        return None
    ctx = ctx or {}
    limit = _f(mine, "speed_limit", BASE_SPEED_KMH) or BASE_SPEED_KMH
    ratio, share, v_loaded, v_empty, source = haul_slowdown(ctx.get("samples_before") or [], limit)
    drop = max(0.0, (1 - ratio) * 100)
    sp = snap.get("stockpile-coarse") or {}
    hours = _f(sp, "hours_left")
    fact = measured_change(ctx.get("deliveries") or [], ctx.get("blizzard_since"))
    text = (f"Метель: ограничение {limit:.0f} км/ч. До метели гружёные шли в среднем {v_loaded:.0f} км/ч, "
            f"порожние {v_empty:.0f} км/ч, ход — {share * 100:.0f} % цикла: вывоз горной массы упадёт примерно на {drop:.0f} %.")
    if fact:
        text += (f" За {fact['minutes']:.0f} мин метели: руда {fact['ore_pct']:+.0f} %, вскрыша {fact['waste_pct']:+.0f} %"
                 + (" — диспетчер держит руду за счёт вскрыши." if fact["ore_pct"] > fact["waste_pct"] + 5 else "."))
    text += f" Держать запас склада крупнодроблёной руды не меньше {BLIZZARD_RESERVE_H:.0f} ч (сейчас {hours:.1f} ч)."
    priority = "critical" if hours < BLIZZARD_RESERVE_H else "important"
    reason = (f"mine.scenario_blizzard = 1, mine.speed_limit = {limit:.0f} км/ч, видимость {_f(mine, 'visibility'):.0f} м; "
              f"оценка {source}: время хода растёт, когда скорость выше ограничения; вывоз = 1 / ((1 − доля хода) + доля хода × рост времени хода)")
    if fact:
        reason += (f"; факт по dispatch.delivered_*: руда {fact['ore_before']:.0f} → {fact['ore_during']:.0f} т/ч, "
                   f"вскрыша {fact['waste_before']:.0f} → {fact['waste_during']:.0f} т/ч")
    data = {"mine.speed_limit": limit, "haul_drop_pct": round(drop, 1), "travel_share": round(share, 2),
            "speed_loaded_before": round(v_loaded, 1), "speed_empty_before": round(v_empty, 1),
            "stockpile-coarse.hours_left": hours, "reserve_hours": BLIZZARD_RESERVE_H}
    if fact:
        data.update({k: round(v, 1) for k, v in fact.items()})
    return _advice("blizzard", priority, "Метель", text, reason,
                   "фабрика переживёт просадку привоза за счёт склада; при запасе ниже порога — сократить вскрышу в пользу руды",
                   "stockpile-coarse", data)


def rule_warmup(snap, history):
    """Первый модельный час после старта: правила привоза ещё не работают — так и сказать."""
    if not history:
        return None
    t0, t1 = history[0][0], history[-1][0]
    if t1 - t0 >= WARMUP_S:
        return None
    ready = t0 + WARMUP_S
    hhmm = _t.strftime("%H:%M", _t.localtime(ready))
    return _advice("warmup", "info", "Рудник разгоняется",
                   f"К сведению: рудник разгоняется после старта — данные о привозе за час будут к {hhmm}.",
                   f"данных о привозе руды {int((t1 - t0) / 60)} модельных минут из 60, нужных для оценки «привоз ниже плана»",
                   "после первого модельного часа советник сравнит привоз с планом и назовёт узкое место, если оно есть",
                   "crusher-01", {"history_min": round((t1 - t0) / 60, 1), "ready_at": hhmm})


def advise(snap, history=None, ctx=None):
    """Все правила; главный совет первым (по уровню, затем по порядку правил).
    ctx — накопленные сервисом данные: samples_before (срезы парка за час до метели), deliveries, blizzard_since."""
    out = []
    hist = history or []
    for rule in (rule_crusher, rule_clay, lambda s: rule_plan(s, hist), lambda s: rule_inflow(s, hist), rule_fleet,
                 lambda s: rule_blizzard(s, ctx), lambda s: rule_warmup(s, hist)):
        a = rule(snap)
        if a:
            out.append(a)
    out.sort(key=lambda a: -a["level"])
    return out
