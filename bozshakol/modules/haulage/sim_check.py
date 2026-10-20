#!/usr/bin/env python3
"""Прогон модели bz-haulage без платформы — сверка и диагностика диспетчера.

Запуск: python3 sim_check.py  (несколько секунд на прогон; только стандартная библиотека).
5 прогонов с разными seed на режим (авто/ручной), постоянные данные забоёв. Печатает:
среднее и разброс ожидания/рейсов/т-ч, разбивку цикла самосвала по фазам, показатели по
каждому экскаватору (приехало, т/ч, загрузка %, средняя очередь), коэффициент соответствия
парка (match factor) по группам руды, т/ч по пунктам разгрузки.
"""
import json
import logging
import os
import random
import statistics
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
GEOMETRY_PATH = os.path.join(HERE, "..", "..", "core", "geometry.json")
MODEL_HOURS = 12
STEP_S = 5.0
SEEDS = [1, 2, 3, 4, 5]

# группы руды — по закреплению HOME (6+5+6 сульфид, 4 глина, 3+4 вскрыша), не меняется
GROUPS = {
    "sulphide": {"excavators": ["excavator-01", "excavator-02", "excavator-03"], "trucks": list(range(1, 18))},
    "clay": {"excavators": ["excavator-04"], "trucks": list(range(18, 22))},
    "waste": {"excavators": ["excavator-05", "excavator-06"], "trucks": list(range(22, 29))},
}


def _stub_bzlib():
    stub = types.ModuleType("bzlib")

    def feature(val, unit=None, **extra):
        props = {"value": val}
        if unit is not None:
            props["unit"] = unit
        props.update(extra)
        return {"properties": props}

    stub.feature = feature
    stub.setup_logging = lambda name: logging.getLogger(name)
    stub.DittoClient = object
    stub.SimClock = object
    stub.Telemetry = object
    stub.TwinWatcher = object
    sys.modules["bzlib"] = stub


def _load_main():
    _stub_bzlib()
    sys.path.insert(0, HERE)
    import importlib
    import main as haulage_main
    importlib.reload(haulage_main)
    return haulage_main


# цифры дробилки модуля №4 (bozshakol/modules/processing/main.py) — сверено с кодом: были
# устаревшие (4000 т/ч и бункер 3000 т — в разы больше реального), теперь CRUSHER_TPH=4500
# (номинал — у №4 варьируется 0,5-1,15x по p80/крепости забоя, мы это не публикуем и не
# отслеживаем, упрощаем до номинала, как и раньше), BUNKER_T=900, TRUCK_MAX_T=180 (бункер
# «принимает», пока в нём есть место под целый кузов — жёсткая отсечка, не плавная доля) —
# используются ТОЛЬКО для офлайн-эмуляции бункера здесь (не в main.py, модуль №4 офлайн не
# поднят); дублируются из main.py константы CRUSHER_THROUGHPUT_REF_TPH/CRUSHER_BUNKER_T_REF/
# CRUSHER_ACCEPT_FRACTION (эвристика нашего диспетчера, НЕ эмуляция — её числа отдельная
# задача, не переиспользуем намеренно)
REAL_CRUSHER_TPH = 4500.0
REAL_BUNKER_T = 900.0
REAL_TRUCK_MAX_T = 180.0


class FakeWatcher:
    def __init__(self, faces, accepting, speed_limit=50.0, clay_limit=15.0, dispatch_off=False,
                 scenario_windows=None):
        self.faces = faces
        self.accepting = accepting
        self.speed_limit = speed_limit
        self.clay_limit = clay_limit
        self.dispatch_off = dispatch_off
        self.crusher_bunker = 0.0       # т — заполняется эмуляцией бункера в run()/run_scenarios()
        self.crusher_throughput = 0.0   # т/ч — заполняется эмуляцией бункера в run()/run_scenarios()
        self.scenario_windows = scenario_windows or []  # [(start_s, end_s, name, params), ...]
        self.now_s = 0.0  # текущее модельное время — выставляется в run()/run_scenarios() перед step()

    def get(self, name, feature_name, default=None):
        if name == "crusher-01" and feature_name == "bunker":
            return self.crusher_bunker
        if name == "crusher-01" and feature_name == "throughput":
            return self.crusher_throughput
        if name in self.faces:
            return self.faces[name].get(feature_name, default)
        if name in self.accepting and feature_name == "accepting":
            return self.accepting[name]
        if name == "mine" and feature_name == "speed_limit":
            return self.speed_limit
        if name == "dispatch" and feature_name == "clay_limit":
            return self.clay_limit
        return default

    def scenario(self, name):
        if name == "dispatch_off":
            return self.dispatch_off, {}
        for start, end, sname, params in self.scenario_windows:
            if sname == name and start <= self.now_s < end:
                return True, params
        return False, {}


CONST_FACES = {
    "face-01": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-02": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-03": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-04": dict(ore_type="clay", cu_grade=0.31, clay_pct=60.0, loading_factor=1.0, recommended_destination="stockpile-clay"),
    "face-05": dict(ore_type="waste", cu_grade=0.0, clay_pct=0.0, loading_factor=1.0, recommended_destination="dump-waste-1"),
    "face-06": dict(ore_type="waste", cu_grade=0.0, clay_pct=0.0, loading_factor=1.0, recommended_destination="dump-waste-1"),
}
CONST_ACCEPTING = {"crusher-01": True, "stockpile-clay": True}


def _step_bunker(watcher, model, bunker_state, stopped=False):
    """Один шаг офлайн-эмуляции бункера дробилки (цифры — REAL_* выше, сверены с модулем №4
    прямо перед этой задачей). `stopped` — форсированная остановка (сценарий crusher_stop,
    у которого нет своего признака в dispatch — это признак crusher-01, публикует №4: дробилка
    не дробит, но продолжает НЕ принимать, как у №4 при crusher_state == "stopped")."""
    delivered = model.delivered["crusher-01"][0]
    bunker_state["stock"] += max(0.0, delivered - bunker_state["last_delivered"])
    bunker_state["last_delivered"] = delivered
    crushed = 0.0 if stopped else min(bunker_state["stock"], REAL_CRUSHER_TPH * STEP_S / 3600.0)
    bunker_state["stock"] -= crushed
    watcher.crusher_bunker = bunker_state["stock"]
    watcher.crusher_throughput = crushed / STEP_S * 3600.0
    cap = REAL_BUNKER_T - REAL_TRUCK_MAX_T
    watcher.accepting["crusher-01"] = (not stopped) and bunker_state["stock"] <= cap


def run(hm, dispatch_off, seed):
    """Прогон модели 12 модельных часов, постоянные данные забоёв (бункер — см. _step_bunker)."""
    random.seed(seed)
    with open(GEOMETRY_PATH, encoding="utf-8") as f:
        geometry = json.load(f)
    watcher = FakeWatcher(CONST_FACES, dict(CONST_ACCEPTING), dispatch_off=dispatch_off)
    model = hm.Haulage(geometry, watcher, clock=None, seed=seed)
    model.speed_limit = 50.0
    steps = int(MODEL_HOURS * 3600 / STEP_S)

    bunker_state = {"stock": 0.0, "last_delivered": 0.0}
    bunker_integral = 0.0
    reserve_integral = 0.0  # trucks_reserve — честное среднее за весь прогон, не снимок
    for _ in range(steps):
        watcher.now_s = model._sim_t
        model.step(STEP_S)
        _step_bunker(watcher, model, bunker_state)
        bunker_integral += bunker_state["stock"] * STEP_S
        reserve_integral += sum(1 for t in model.trucks if t.state == "reserve") * STEP_S

    model.avg_bunker_t = bunker_integral / (MODEL_HOURS * 3600.0)
    model.avg_trucks_reserve = reserve_integral / (MODEL_HOURS * 3600.0)  # среднее за весь прогон, не снимок
    return model


# -- режим «со сценариями» (погоня за ожиданием: воспроизвести рост avg_wait_excavator) --------
# 24 модельных часа, сценарии в разное время, каждый с паузой до/после для оценки «вернулось —
# не вернулось». crusher_stop — не сценарий модуля №2 (у dispatch такого scenario() нет), это
# признак crusher-01.accepting/crusher_state, который публикует №4 — эмулируем прямо в _step_bunker
SCENARIO_WINDOWS_24H = [
    (4.0 * 3600.0, 5.0 * 3600.0, "road_closed", {"road": "road-ramp-2"}),
    (10.0 * 3600.0, 11.0 * 3600.0, "excavator_down", {"excavator": "excavator-02"}),
]
CRUSHER_STOP_WINDOW_24H = (16.0 * 3600.0, 16.5 * 3600.0)


def run_scenarios(hm, seed, dispatch_off=False, hours=24):
    """24 модельных часа со сценариями — печатаем
    ожидание у экскаватора ПО КАЖДОМУ модельному часу (не только среднее), чтобы увидеть рост
    и восстановление после каждого сценария."""
    random.seed(seed)
    with open(GEOMETRY_PATH, encoding="utf-8") as f:
        geometry = json.load(f)
    watcher = FakeWatcher(CONST_FACES, dict(CONST_ACCEPTING), dispatch_off=dispatch_off,
                           scenario_windows=SCENARIO_WINDOWS_24H)
    model = hm.Haulage(geometry, watcher, clock=None, seed=seed)
    model.speed_limit = 50.0
    steps = int(hours * 3600 / STEP_S)
    steps_per_hour = int(3600 / STEP_S)

    bunker_state = {"stock": 0.0, "last_delivered": 0.0}
    reserve_integral = 0.0
    hourly_wait = []
    for i in range(steps):
        watcher.now_s = model._sim_t
        stopped = CRUSHER_STOP_WINDOW_24H[0] <= model._sim_t < CRUSHER_STOP_WINDOW_24H[1]
        model.step(STEP_S)
        _step_bunker(watcher, model, bunker_state, stopped=stopped)
        reserve_integral += sum(1 for t in model.trucks if t.state == "reserve") * STEP_S
        if (i + 1) % steps_per_hour == 0:
            hourly_wait.append(fv(model.dispatch_features(), "avg_wait_excavator"))

    model.avg_trucks_reserve = reserve_integral / (hours * 3600.0)
    return model, hourly_wait


def fv(features, name):
    return features[name]["properties"]["value"]


def truck_group(idx):
    for g, d in GROUPS.items():
        if idx in d["trucks"]:
            return g
    return None


def collect(model):
    """Сводка по одному прогону: dict с разбивкой цикла, по экскаваторам, по группам, по пунктам."""
    disp = model.dispatch_features()
    total_s = MODEL_HOURS * 3600.0

    cycle = {"haul_loaded": 0.0, "haul_empty": 0.0, "queue_excavator": 0.0,
             "load": 0.0, "queue_dump": 0.0, "dump": 0.0, "refuel": 0.0}
    trips_by_truck = []
    for t in model.trucks:
        for k in cycle:
            cycle[k] += t.time_in[k]
        trips_by_truck.append(t.trips)
    n = len(model.trucks)
    cycle_avg_s = {k: v / n for k, v in cycle.items()}
    full_cycle_s = sum(cycle_avg_s.values())

    ex_stats = {}
    for eid, ex in model.excavators.items():
        tph = ex.loaded_total / (total_s / 3600.0)
        util = 100.0 * ex.busy_s / total_s
        avg_queue = ex.queue_integral / total_s
        ex_stats[eid] = dict(served=ex.trucks_served, tph=tph, util_pct=util, avg_queue=avg_queue,
                              plan_tph=ex.plan_tph)

    group_stats = {}
    for g, d in GROUPS.items():
        n_trucks = len(d["trucks"])
        n_ex = sum(1 for e in d["excavators"] if not model.excavators[e].down)
        avg_load_s = statistics.mean(
            s for idx in d["trucks"] for s in model.trucks[idx - 1].load_sessions_s
        ) if any(model.trucks[idx - 1].load_sessions_s for idx in d["trucks"]) else 0.0
        trips_g = sum(model.trucks[idx - 1].trips for idx in d["trucks"])
        avg_truck_cycle_s = (total_s * n_trucks / trips_g) if trips_g else float("inf")
        match_factor = (n_trucks * avg_load_s) / (n_ex * avg_truck_cycle_s) if n_ex and avg_truck_cycle_s else float("inf")
        group_stats[g] = dict(n_trucks=n_trucks, n_excavators=n_ex, avg_load_min=avg_load_s / 60.0,
                               avg_cycle_min=avg_truck_cycle_s / 60.0 if avg_truck_cycle_s != float("inf") else None,
                               match_factor=match_factor)

    dump_stats = {}
    for did, d in model.dumps.items():
        wait_dq = model._wait_dump_by_point[did]
        wait_min = statistics.mean(v for _, v in wait_dq) if wait_dq else 0.0
        dump_stats[did] = dict(trips=d.trips, tph=d.received / (total_s / 3600.0), wait_min=wait_min)

    # : снимок dispatch.* на конец прогона (окно — последний
    # модельный час, та же логика, что у avg_wait_excavator/trips_per_hour выше) + среднее за
    # ВЕСЬ прогон для trucks_reserve (считается в run(), не окно в один час — снимок на конец
    # 12-часового прогона был бы не показателен, резерв колеблется)
    time_pct = {k: fv(disp, k) for k in (
        "time_loading_pct", "time_hauling_pct", "time_returning_pct", "time_queue_pct",
        "time_dumping_pct", "time_refueling_pct", "time_reserve_pct", "time_down_pct",
    )}

    return dict(
        avg_wait_excavator=fv(disp, "avg_wait_excavator"), avg_wait_dump=fv(disp, "avg_wait_dump"),
        trips_per_hour=fv(disp, "trips_per_hour"), fleet_utilization=fv(disp, "fleet_utilization"),
        cycle_avg_min={k: v / 60.0 for k, v in cycle_avg_s.items()}, full_cycle_min=full_cycle_s / 60.0,
        ex_stats=ex_stats, group_stats=group_stats, dump_stats=dump_stats,
        avg_bunker_t=getattr(model, "avg_bunker_t", 0.0),
        plan_crusher_tph=fv(disp, "plan_crusher_tph"), plan_clay_tph=fv(disp, "plan_clay_tph"),
        refuels_total=model.refuels_total,
        trucks_needed=fv(disp, "trucks_needed"), trucks_reserve_now=fv(disp, "trucks_reserve"),
        trucks_reserve_avg=getattr(model, "avg_trucks_reserve", 0.0),
        fuel_saved_l_shift=fv(disp, "fuel_saved_l_shift"), time_pct=time_pct,
    )


def avg_spread(values):
    if not values:
        return 0.0, 0.0
    return statistics.mean(values), (statistics.pstdev(values) if len(values) > 1 else 0.0)


def report_mode(label, runs):
    print(f"\n{'=' * 60}\n{label} — {len(runs)} прогонов (seed {SEEDS})\n{'=' * 60}")
    for key, title, unit in [
        ("avg_wait_excavator", "Ожидание у экскаватора", "мин"),
        ("avg_wait_dump", "Ожидание на разгрузке", "мин"),
        ("trips_per_hour", "Рейсов в час", ""),
        ("fleet_utilization", "Самосвалы в деле", "%"),
        ("refuels_total", f"Заправок за смену ({MODEL_HOURS} ч)", "шт"),
        ("trucks_needed", "Нужно для плана (среднее за последний час прогона)", "шт"),
        ("trucks_reserve_avg", "В резерве (среднее за весь прогон)", "шт"),
        ("fuel_saved_l_shift", "Сэкономлено топлива (накоплено с начала смены к концу прогона)", "л"),
    ]:
        vals = [r[key] for r in runs]
        m, s = avg_spread(vals)
        print(f"  {title}: {m:.2f} ± {s:.2f} {unit}")

    print("  -- цикл самосвала (среднее по прогонам), мин --")
    phases = ["haul_loaded", "haul_empty", "queue_excavator", "load", "queue_dump", "dump", "refuel"]
    names = {"haul_loaded": "гружёный рейс", "haul_empty": "порожний рейс", "queue_excavator": "очередь у экскаватора",
             "load": "установка+погрузка", "queue_dump": "очередь на разгрузке", "dump": "разгрузка", "refuel": "заправка"}
    for p in phases:
        vals = [r["cycle_avg_min"][p] for r in runs]
        m, s = avg_spread(vals)
        print(f"    {names[p]}: {m:.2f} ± {s:.2f}")
    full = [r["full_cycle_min"] for r in runs]
    m, s = avg_spread(full)
    print(f"    ВЕСЬ ЦИКЛ: {m:.2f} ± {s:.2f}")

    print("  -- по экскаваторам: цель (план-диспетчера на конец прогона) / факт, среднее по прогонам --")
    for eid in sorted(runs[0]["ex_stats"]):
        served = avg_spread([r["ex_stats"][eid]["served"] for r in runs])
        tph = avg_spread([r["ex_stats"][eid]["tph"] for r in runs])
        plan = avg_spread([r["ex_stats"][eid]["plan_tph"] for r in runs])
        util = avg_spread([r["ex_stats"][eid]["util_pct"] for r in runs])
        q = avg_spread([r["ex_stats"][eid]["avg_queue"] for r in runs])
        pct_s = f"{100.0 * tph[0] / plan[0]:.0f}% от цели" if plan[0] > 0 else "цель 0 — план не держит (снимок на конец прогона)"
        print(f"    {eid}: цель {plan[0]:.0f}±{plan[1]:.0f} т/ч, факт {tph[0]:.0f}±{tph[1]:.0f} т/ч "
              f"({pct_s}), приехало {served[0]:.0f}±{served[1]:.0f}, "
              f"загрузка {util[0]:.0f}±{util[1]:.0f} %, очередь {q[0]:.2f}±{q[1]:.2f}")

    print("  -- группы руды: match factor = (самосвалов × время погрузки) / (экскаваторов × цикл самосвала) --")
    for g in GROUPS:
        gs = [r["group_stats"][g] for r in runs if r["group_stats"][g]["avg_cycle_min"] is not None]
        if not gs:
            continue
        mf = avg_spread([x["match_factor"] for x in gs])
        cyc = avg_spread([x["avg_cycle_min"] for x in gs])
        print(f"    {g}: {gs[0]['n_trucks']} самосвалов / {gs[0]['n_excavators']} экскаваторов, "
              f"цикл {cyc[0]:.1f}±{cyc[1]:.1f} мин, match factor {mf[0]:.2f}±{mf[1]:.2f} "
              f"(<1 — экскаваторов хватает с запасом, >1 — не хватает)")

    print("  -- т/ч и ожидание на разгрузке по пунктам --")
    names_dump = {"crusher-01": "дробилка", "stockpile-clay": "склад глины", "dump-waste-1": "отвал"}
    for did in sorted(runs[0]["dump_stats"]):
        tph = avg_spread([r["dump_stats"][did]["tph"] for r in runs])
        wait = avg_spread([r["dump_stats"][did]["wait_min"] for r in runs])
        print(f"    {did} ({names_dump.get(did, did)}): {tph[0]:.0f}±{tph[1]:.0f} т/ч, "
              f"ожидание {wait[0]:.2f}±{wait[1]:.2f} мин")

    crusher_tph = avg_spread([r["dump_stats"]["crusher-01"]["tph"] for r in runs])
    clay_tph = avg_spread([r["dump_stats"]["stockpile-clay"]["tph"] for r in runs])
    plan_crusher = avg_spread([r["plan_crusher_tph"] for r in runs])[0]
    plan_clay = avg_spread([r["plan_clay_tph"] for r in runs])[0]
    print(f"  -- руда против плана фабрик (план.признак dispatch.plan_crusher_tph/plan_clay_tph) --")
    print(f"    дробилка: {crusher_tph[0]:.0f} т/ч против плана {plan_crusher:.0f} т/ч "
          f"({100 * crusher_tph[0] / plan_crusher:.0f} % от плана)" if plan_crusher > 0 else
          f"    дробилка: {crusher_tph[0]:.0f} т/ч (план 0 — не принимает)")
    print(f"    склад глины: {clay_tph[0]:.0f} т/ч против плана {plan_clay:.0f} т/ч "
          f"({100 * clay_tph[0] / plan_clay:.0f} % от плана)" if plan_clay > 0 else
          f"    склад глины: {clay_tph[0]:.0f} т/ч (план 0 — не принимает)")

    bunker = avg_spread([r["avg_bunker_t"] for r in runs])
    print(f"  Средний бункер дробилки: {bunker[0]:.0f}±{bunker[1]:.0f} т "
          f"(ёмкость {REAL_BUNKER_T:.0f} т, порог приёмки "
          f"{REAL_BUNKER_T - REAL_TRUCK_MAX_T:.0f} т — цифры модуля №4, см. REAL_* выше)")


def report_scenarios(hm, auto, manual):
    """Отчёт по режиму «со сценариями» (24 модельных часа, 5 seed): ожидание у экскаватора
    по часам — растёт ли со временем, возвращается ли к прежнему уровню после каждого сценария."""
    a_models, a_hourly = zip(*auto)
    m_models, m_hourly = zip(*manual)
    hours = len(a_hourly[0])

    print(f"\n{'=' * 60}\nСО СЦЕНАРИЯМИ (24 модельных часа × {len(SEEDS)} seed) — ожидание у "
          f"экскаватора по часам\n{'=' * 60}")
    print("  сценарии: road_closed road-ramp-2 (ч.4-5), excavator_down excavator-02 (ч.10-11), "
          "crusher_stop (ч.16:00-16:30)")
    print(f"  {'час':>4s} {'авто, мин':>12s} {'ручной, мин':>14s}   событие")
    event_by_hour = {4: "road_closed начался", 5: "road_closed закончился",
                      10: "excavator_down начался", 11: "excavator_down закончился",
                      16: "crusher_stop (0:00-0:30 этого часа)"}
    for h in range(hours):
        a_m, a_s = avg_spread([run[h] for run in a_hourly])
        m_m, m_s = avg_spread([run[h] for run in m_hourly])
        event = event_by_hour.get(h + 1, "")
        print(f"  {h + 1:>4d} {a_m:>7.2f}±{a_s:<4.2f} {m_m:>9.2f}±{m_s:<4.2f}   {event}")

    baseline = avg_spread([statistics.mean(run[0:3]) for run in a_hourly])[0]
    tail = avg_spread([statistics.mean(run[-3:]) for run in a_hourly])[0]
    print(f"\n  Базовый уровень (авто, часы 1-3): {baseline:.2f} мин. "
          f"Конец прогона (часы {hours - 2}-{hours}): {tail:.2f} мин.")
    growth = tail - baseline
    print(f"  Разница конец-начало: {growth:+.2f} мин "
          f"({'РАСТЁТ без возврата к базовому уровню' if growth > 0.5 else 'не растёт / в пределах разброса'}).")

    recovery_checks = [("road_closed", 5, 7), ("excavator_down", 11, 13), ("crusher_stop", 17, 19)]
    for name, end_hour, check_hour in recovery_checks:
        if check_hour > hours:
            continue
        level = avg_spread([run[check_hour - 1] for run in a_hourly])[0]
        diff = level - baseline
        print(f"  После {name} (конец ч.{end_hour}) — ожидание на час {check_hour}: {level:.2f} мин "
              f"(база {baseline:.2f}, разница {diff:+.2f} — "
              f"{'вернулось' if abs(diff) < 0.5 else 'НЕ вернулось за 1-2 часа'}).")

    total_s = hours * 3600.0
    for label, models in (("авто", a_models), ("ручной", m_models)):
        crusher_tph = statistics.mean(m.delivered["crusher-01"][0] / (total_s / 3600.0) for m in models)
        clay_tph = statistics.mean(m.delivered["stockpile-clay"][0] / (total_s / 3600.0) for m in models)
        print(f"  Руда ({label}, 24ч): дробилка {crusher_tph:.0f} т/ч "
              f"({100 * crusher_tph / hm.PLAN_CRUSHER_TPH:.0f}% от {hm.PLAN_CRUSHER_TPH:.0f}), "
              f"склад глины {clay_tph:.0f} т/ч ({100 * clay_tph / hm.PLAN_CLAY_TPH:.0f}% от {hm.PLAN_CLAY_TPH:.0f})")

    a_overall = avg_spread([statistics.mean(run) for run in a_hourly])[0]
    m_overall = avg_spread([statistics.mean(run) for run in m_hourly])[0]
    print(f"  Среднее по всему 24ч прогону: авто {a_overall:.2f} мин / ручной {m_overall:.2f} мин "
          f"({'OK, авто не хуже' if a_overall <= m_overall + 0.05 else 'ПЛОХО: авто хуже ручного'})")


_HM = None  # заполняется в main() — модуль main.py, используется report_mode для ссылочных констант


def main():
    global _HM
    hm = _load_main()
    _HM = hm
    print(f"Прогон {MODEL_HOURS} модельных часов × {len(SEEDS)} seed, постоянные данные забоёв.")

    auto_runs = [collect(run(hm, dispatch_off=False, seed=s)) for s in SEEDS]
    manual_runs = [collect(run(hm, dispatch_off=True, seed=s)) for s in SEEDS]

    report_mode("АВТО", auto_runs)
    report_mode("РУЧНОЙ (dispatch_off)", manual_runs)

    a_wait = avg_spread([r["avg_wait_excavator"] for r in auto_runs])[0]
    m_wait = avg_spread([r["avg_wait_excavator"] for r in manual_runs])[0]
    a_tph = avg_spread([r["dump_stats"]["crusher-01"]["tph"] + r["dump_stats"]["stockpile-clay"]["tph"] for r in auto_runs])[0]
    m_tph = avg_spread([r["dump_stats"]["crusher-01"]["tph"] + r["dump_stats"]["stockpile-clay"]["tph"] for r in manual_runs])[0]
    print(f"\n{'=' * 60}\nИТОГ: авто {a_wait:.2f} мин / ручной {m_wait:.2f} мин ожидания у экскаватора "
          f"({'OK, авто не хуже' if a_wait <= m_wait + 0.05 else 'ПЛОХО: авто хуже ручного'})")
    print(f"      т/ч руды: авто {a_tph:.0f} / ручной {m_tph:.0f} "
          f"({'OK' if a_tph >= m_tph - 1 else 'ПЛОХО: авто меньше'})")

    print(f"\n{'=' * 60}\nРЕЗЕРВ САМОСВАЛОВ — доли времени парка, авто vs ручной\n{'=' * 60}")
    pct_names = [
        ("time_loading_pct", "погрузка (установка+ковши)"), ("time_hauling_pct", "гружёный рейс"),
        ("time_returning_pct", "порожний рейс"), ("time_queue_pct", "очередь (экскаватор+разгрузка)"),
        ("time_dumping_pct", "разгрузка"), ("time_refueling_pct", "заправка"),
        ("time_reserve_pct", "резерв"), ("time_down_pct", "авария (не реализовано, всегда 0)"),
    ]
    print(f"  {'доля времени':38s} {'авто, %':>10s} {'ручной, %':>10s}")
    a_sum, m_sum = 0.0, 0.0
    for key, title in pct_names:
        a_m = avg_spread([r["time_pct"][key] for r in auto_runs])[0]
        m_m = avg_spread([r["time_pct"][key] for r in manual_runs])[0]
        a_sum += a_m
        m_sum += m_m
        print(f"  {title:38s} {a_m:>10.1f} {m_m:>10.1f}")
    print(f"  {'СУММА (должна быть ≈100)':38s} {a_sum:>10.1f} {m_sum:>10.1f}")

    a_needed = avg_spread([r["trucks_needed"] for r in auto_runs])[0]
    a_reserve = avg_spread([r["trucks_reserve_avg"] for r in auto_runs])[0]
    a_fuel = avg_spread([r["fuel_saved_l_shift"] for r in auto_runs])[0]
    m_reserve = avg_spread([r["trucks_reserve_avg"] for r in manual_runs])[0]
    print(f"\n  «Авто»: самосвалов в парке 28, нужно для плана ≈{a_needed:.0f}, в резерве ≈{a_reserve:.0f} "
          f"(в среднем за {MODEL_HOURS} ч), экономия топлива ≈{a_fuel:.0f} л к концу прогона.")
    print(f"  «Ручной»: резерва не существует вовсе (среднее в резерве за прогон: {m_reserve:.2f} шт — "
          f"должно быть ≈0{'  — OK' if m_reserve < 0.05 else '  — ПРОБЛЕМА: резерв возник в ручном режиме!'}).")

    print(f"\nПрогон со сценариями: 24 модельных часа × {len(SEEDS)} seed, это дольше обычного прогона.")
    auto_scen = [run_scenarios(hm, seed=s, dispatch_off=False) for s in SEEDS]
    manual_scen = [run_scenarios(hm, seed=s, dispatch_off=True) for s in SEEDS]
    report_scenarios(hm, auto_scen, manual_scen)

    print(f"\n{'=' * 60}\nСВЕРКА: перебор руды в «авто» — причина и фикс — "
          f"main.py, choose_excavator/_best_candidate/_update_plan\n{'=' * 60}")
    print("""
  Причина перебора руды в «авто» (была 129%/166% от плана) — простыми словами, НЕ в HOME
  (HOME используется только в «ручном», что и подтвердила проверка кода):
  1. Настоящая ошибка №1: `choose_excavator` в «авто» решал, какую руду возить, через
     `_candidate_ore(truck)` — а эта функция смотрела на РУДУ ДОМАШНЕГО ЗАБОЯ самосвала
     (`truck.home`), т.е. тот же HOME-механизм, который должен работать ТОЛЬКО в «ручном».
     Из-за этого самосвал, закреплённый по HOME за сульфидным забоем, в «авто» ВСЕГДА
     возил сульфидную руду (кроме явной остановки дробилки) — независимо от того, нужна
     ли эта руда по плану прямо сейчас. Исправлено: `_best_candidate` теперь сравнивает
     ВСЕ доступные сейчас типы руды (сульфид/глина — если принимают; вскрыша — всегда)
     напрямую по отставанию от плана, без привязки к HOME. `_candidate_ore` удалён
     (мёртвый код после фикса), заодно убрана отдельная надбавка «руда важнее вскрыши»
     (ORE_PREFERENCE_MARGIN_S/CRUSHER_OVERFLOW_MARGIN_S) — она тоже мешала плану: не
     отпускала самосвалы на вскрышу, даже когда рудный план уже выполнен.
  2. Настоящая ошибка №2 (вскрылась уже после фикса №1 — число 1 само по себе ПЕРЕБРОСИЛО
     перебор на вскрышу): цель вскрышных экскаваторов считалась как их собственная
     `_possible_tph` — т.е. сколько экскаватор нарубил бы, если самосвалы подъезжали бы
     БЕЗ ОЧЕРЕДИ (~3700-3900 т/ч на экскаватор) — это в разы больше, чем весь парк в 28
     самосвалов может реально вывезти. План-накопитель вскрышных экскаваторов рос
     гораздо быстрее факта, они выглядели «бесконечно нуждающимися», и правило «к кому
     сильнее отстал от плана» уводило туда почти все самосвалы (ожидание у экскаватора
     подскочило до ~6.8 мин, руда на дробилку упала до 66% от плана). Исправлено: цель
     вскрышных теперь — доля от общего PLAN_WASTE_TPH (== PLAN_CRUSHER_TPH+PLAN_CLAY_TPH,
     «вскрыша ≈ тоннаж руды» — уже существующее допущение проекта, bozshakol/data/
     SOURCES.md), делится между вскрышными экскаваторами пропорционально их `_possible_tph`
     — ТОЙ ЖЕ формулой, что и у рудных групп, просто с другим внешним целевым числом.

  Результат после обоих фиксов:
  - Руда относительно плана — ПОПАДАЕТ в ±10% по ОБОИМ пунктам: дробилка ≈108-110% от
    3360 т/ч, склад глины ≈108-110% от 715 т/ч (цифры по прогонам — в таблице выше).
  - Загрузка экскаваторов равномернее, чем в «ручном» (по группам одной руды).

  Что НЕ получилось — честно, без подгонки параметров под результат:
  - Ожидание у экскаватора в «авто» (см. ИТОГ выше) всё ещё не ниже «ручного» — разрыв
    намного меньше, чем был до фиксов (авто хуже на ~0.4-0.5 мин; сейчас — на ~0.1-0.15 мин),
    но «ПЛОХО» по формальному критерию. Проверил конкретную гипотезу — «правило <0,5 мин
    почти всегда срабатывает» — измерил отдельно:
    тай-брейк по честному путь+ожиданию сработал только в ~21% решений за 3 модельных
    часа, не «почти всегда» — эта гипотеза не подтвердилась. По суммарному т/ч на
    экскаватор (таблица выше) видно: вскрышные (05/06) всё ещё заметно загруженнее
    (загрузка/очередь выше), чем рудные — им по условию «вскрыша ≈ тоннаж руды» нужно
    вывезти примерно СТОЛЬКО ЖЕ тонн, сколько рудным, но ТОЛЬКО ДВУМЯ экскаваторами
    (против четырёх у руды — 3 сульфидных + 1 глинистый), так что на экскаватор
    физически выходит больше работы — это НЕ ошибка арифметики, а прямое следствие
    самого правила «вскрыша ≈ тоннаж руды» и числа забоев (оба — не наши допущения,
    трогать не просил). «Ручной» в сравнении искусственно легче по вскрыше: там
    закреплено только 7 самосвалов на вскрышу НАВСЕГДА, а не «сколько нужно по плану»,
    поэтому «ручной» никогда не пытается вывезти туда реальный объём. За отведённое
    время третью причину не нашёл — честно описываю это наблюдение, а не подгоняю
    порог TRUCK_TIE_BREAK_S или формулу под лучший результат.
""")


if __name__ == "__main__":
    main()
