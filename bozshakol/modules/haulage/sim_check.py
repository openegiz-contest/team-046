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


class FakeWatcher:
    def __init__(self, faces, accepting, speed_limit=50.0, clay_limit=15.0, dispatch_off=False):
        self.faces = faces
        self.accepting = accepting
        self.speed_limit = speed_limit
        self.clay_limit = clay_limit
        self.dispatch_off = dispatch_off
        self.crusher_bunker = 0.0       # т — заполняется эмуляцией бункера в run()
        self.crusher_throughput = 0.0   # т/ч — заполняется эмуляцией бункера в run()

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


def run(hm, dispatch_off, seed):
    """Прогон модели; бункер дробилки эмулируется ЗДЕСЬ (не в main.py) ровно по логике и
    цифрам модуля №4 (bozshakol/modules/processing/main.py, только читали, не меняли):
    бункер пополняется разницей dispatch.delivered_crusher_t, срабатывает throughput
    т/ч (CRUSHER_THROUGHPUT_REF_TPH), accepting=false при заполнении >= 85 % ёмкости
    (CRUSHER_BUNKER_T_REF) — те же константы, что main.py использует в _crusher_wait_s,
    единый источник (hm.CRUSHER_*), не продублированные числа."""
    random.seed(seed)
    with open(GEOMETRY_PATH, encoding="utf-8") as f:
        geometry = json.load(f)
    watcher = FakeWatcher(CONST_FACES, dict(CONST_ACCEPTING), dispatch_off=dispatch_off)
    model = hm.Haulage(geometry, watcher, clock=None, seed=seed)
    model.speed_limit = 50.0
    steps = int(MODEL_HOURS * 3600 / STEP_S)

    bunker_stock = 0.0
    last_delivered = 0.0
    bunker_integral = 0.0
    cap = hm.CRUSHER_BUNKER_T_REF * hm.CRUSHER_ACCEPT_FRACTION
    for _ in range(steps):
        model.step(STEP_S)
        delivered = model.delivered["crusher-01"][0]
        bunker_stock += max(0.0, delivered - last_delivered)
        last_delivered = delivered
        crushed = min(bunker_stock, hm.CRUSHER_THROUGHPUT_REF_TPH * STEP_S / 3600.0)
        bunker_stock -= crushed
        watcher.crusher_bunker = bunker_stock
        watcher.crusher_throughput = crushed / STEP_S * 3600.0
        watcher.accepting["crusher-01"] = bunker_stock < cap
        bunker_integral += bunker_stock * STEP_S

    model.avg_bunker_t = bunker_integral / (MODEL_HOURS * 3600.0)  # для отчёта (часть 4)
    return model


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
        ex_stats[eid] = dict(served=ex.trucks_served, tph=tph, util_pct=util, avg_queue=avg_queue)

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

    return dict(
        avg_wait_excavator=fv(disp, "avg_wait_excavator"), avg_wait_dump=fv(disp, "avg_wait_dump"),
        trips_per_hour=fv(disp, "trips_per_hour"), fleet_utilization=fv(disp, "fleet_utilization"),
        cycle_avg_min={k: v / 60.0 for k, v in cycle_avg_s.items()}, full_cycle_min=full_cycle_s / 60.0,
        ex_stats=ex_stats, group_stats=group_stats, dump_stats=dump_stats,
        avg_bunker_t=getattr(model, "avg_bunker_t", 0.0),
        plan_crusher_tph=fv(disp, "plan_crusher_tph"), plan_clay_tph=fv(disp, "plan_clay_tph"),
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

    print("  -- по экскаваторам (среднее по прогонам) --")
    for eid in sorted(runs[0]["ex_stats"]):
        served = avg_spread([r["ex_stats"][eid]["served"] for r in runs])
        tph = avg_spread([r["ex_stats"][eid]["tph"] for r in runs])
        util = avg_spread([r["ex_stats"][eid]["util_pct"] for r in runs])
        q = avg_spread([r["ex_stats"][eid]["avg_queue"] for r in runs])
        print(f"    {eid}: приехало {served[0]:.0f}±{served[1]:.0f}, {tph[0]:.0f}±{tph[1]:.0f} т/ч, "
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
          f"(ёмкость {_HM.CRUSHER_BUNKER_T_REF:.0f} т, порог приёмки "
          f"{_HM.CRUSHER_BUNKER_T_REF * _HM.CRUSHER_ACCEPT_FRACTION:.0f} т)")


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

    print(f"\n{'=' * 60}\nСВЕРКА (план-диспетчер, часть 3; цели плана поправлены на факт KAZ Minerals Q4 2025: "
          f"3360/715 т/ч) — main.py, choose_excavator/_best_candidate\n{'=' * 60}")
    print("""
  Что получилось лучше в «авто» (план-диспетчер, часть 2):
  - Загрузка экскаваторов РАВНОМЕРНЕЕ при любых целях плана: сульфидная группа —
    39/39/39 % (было в «ручном», при закреплённом HOME — 52/38/42 %), вскрыша —
    71/71 % (было 42/79 %). Это не зависит от абсолютной величины целевого т/ч —
    план-диспетчер выравнивает нагрузку МЕЖДУ экскаваторами одной руды в любом случае.
  - Руда относительно плана: с поправленными целями (3360/715 т/ч, факт KAZ Minerals
    Q4 2025 — см. параметр PLAN_CRUSHER_TPH/PLAN_CLAY_TPH в main.py) дробилка
    ≈108 % от плана (БЫЛО бы вне ±10 % со старой проектной мощностью 2850 — там было
    129 %) — теперь ПОПАДАЕТ в требуемые ±10 %. Склад глины ≈133 % от плана 715 —
    ближе, чем было (166 % от 570), но всё ещё вне ±10 %.

  Что НЕ получилось — честно, без подгонки параметров под результат:
  - С поправленными (более реалистичными, близкими к факту) целями плана ожидание у
    экскаватора в «авто» (≈1.8-1.9 мин) снова НЕ лучше «ручного» (≈1.4 мин) — хотя с
    прежними, заниженными целями (2850/570) после фикса двух настоящих ошибок
    реализации (см. историю коммитов) «авто» было ощутимо лучше (≈1.05 мин). Похожая
    картина наблюдалась до этих фиксов. Гипотеза (не доказанная экспериментом, но
    согласуется с устройством алгоритма): при более высоких/реалистичных целях
    фактическая добыча (у сульфидных экскаваторов «честно» ≈3600-3700 т/ч) близка к
    цели (3360), поэтому «отставание от плана» у разных экскаваторов группы колеблется
    в небольшом диапазоне — чаще попадает в полосу «близких значений» (разница
    < TRUCK_TIE_BREAK_S = 0,5 мин, порог задан в задаче, не параметр для подгонки), и
    выбор чаще уходит на tie-break «путь+ожидание» (похож на простую «ближайшую
    очередь», которая, как было найдено ранее в этой же задаче, сама по себе не лучше
    закреплённого распределения). При старых, заниженных целях отставание было
    устойчиво большим и однозначным (все экскаваторы были далеко впереди плана), tie-
    break почти не включался. Решение не принимал сам: это либо такое же устройство
    алгоритма (deficit-dispatch в учебном виде), либо требует отдельного решения — не
    стал менять TRUCK_TIE_BREAK_S или добавлять новую логику, т.к. это не входило в
    поправку («цели плана», не алгоритм) — см. «Что вам решить» в отчёте по задаче.
  - Причина разрыва по руде (даже 108-133 %, не 100 %) структурная, не в выборе
    экскаватора: самосвалы закреплены за типом руды через HOME (17 сульфидных + 4
    глинистых, НЕ менять по условию задачи) — их суммарная честная провозная
    способность физически больше, чем новый план (3360+715=4075 т/ч), хоть и ближе к
    нему, чем раньше. Единственный тормоз сейчас — реактивный (бункер дробилки
    заполняется → crusher-01.accepting=false → избыток на вскрышу); у склада глины
    аналога «бункера» нет вообще — поэтому там разрыв больше и ничем не сдерживается.
""")


if __name__ == "__main__":
    main()
