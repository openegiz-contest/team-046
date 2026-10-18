#!/usr/bin/env python3
"""bz-haulage — транспорт и диспетчеризация (участник №2).

Самосвалы ездят по дорогам из core/geometry.json между экскаваторами и пунктами
разгрузки (дробилка, склад глинистой руды, отвал) циклом «погрузка ковшами по
паспорту экскаватора → ход по мощности и массе своего паспорта → разгрузка →
обратно». Очереди у экскаваторов и на разгрузке. Закреплённое распределение;
в режиме auto диспетчер выбирает экскаватор по ожидаемому времени в пути и
ожидании, с учётом того, принимают ли дробилка/склад и лимита доли глины.

Чужие двойники читаются только через платформу (TwinWatcher): забои face-*
(содержание, глина, скорость погрузки, пункт разгрузки), crusher-01.accepting,
stockpile-clay.accepting, mine.speed_limit, scenarios.
Свои двойники: truck-*, excavator-*, dispatch, road-*, dump-waste-1.
"""
import heapq
import json
import math
import random
import time
from collections import deque

from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging

log = setup_logging("bz-haulage")

# ----------------------------------------------------------------------------------
# Паспорта техники (источники и допущения — см. bozshakol/modules/haulage/README.md,
# таблица «параметр — значение — источник»). Класс самосвала — по capacity_t.
# ----------------------------------------------------------------------------------
TRUCK_PASSPORT = {
    135: dict(  # источник: CAT 785D, cat.com (specalog 18089285) — масса, мощность, скорость, бак
        model="785 (135 т)", capacity_t=135.0, gross_weight_t=249.5, empty_weight_t=114.5,
        power_kw=1082, top_speed_loaded_kmh=54.8, tank_l=1893.0,
        idle_lph=25.0,  # допущение: расход на холостом ходу
    ),
    180: dict(  # источник: CAT 789D, cat.com (specalog 18107706) — масса, мощность, скорость, бак
        model="789D (180 т)", capacity_t=180.0, gross_weight_t=324.3, empty_weight_t=144.3,
        power_kw=1566, top_speed_loaded_kmh=57.2, tank_l=2082.0,
        idle_lph=35.0,  # допущение: расход на холостом ходу
    ),
}

EXCAVATOR_BUCKET_M3 = 22.0            # источник: Hitachi EX3600-7 (модель экскаватора — допущение)
EXCAVATOR_BUCKET_FILL = 0.9           # допущение: коэффициент наполнения ковша
EXCAVATOR_LOOSE_DENSITY_T_M3 = 1.8    # допущение: насыпная плотность разрыхлённой горной массы
EXCAVATOR_BUCKET_T = round(EXCAVATOR_BUCKET_M3 * EXCAVATOR_BUCKET_FILL * EXCAVATOR_LOOSE_DENSITY_T_M3, 1)  # 35.6 т

LOAD_SETUP_S = 30.0                   # допущение: установка самосвала под погрузку перед первым ковшом
BUCKET_CYCLE_S = 32.0                 # допущение: цикл одного ковша; делится на loading_factor забоя
BUCKET_FILL_VAR = (0.92, 1.05)        # разброс фактической массы ковша вокруг EXCAVATOR_BUCKET_T

DUMP_S = 60.0                         # допущение: подъём кузова по паспорту 15-20 с + манёвр у пункта разгрузки
DUMP_POINTS_CONCURRENT = 1            # мест одновременной разгрузки на пункт — как было в заглушке

EFFICIENCY = 0.75                     # допущение: КПД трансмиссии/трансформатора
ROLLING_RESISTANCE = 0.025            # допущение: коэффициент сопротивления качению
G_ACCEL = 9.81
SPEED_DOWN_LOADED_KMH = 30.0          # допущение: тормоз-замедлитель, гружёный на спуске
SPEED_DOWN_EMPTY_KMH = 40.0           # допущение: тормоз-замедлитель, порожний на спуске
# разброс скорости хода — теперь через водителя самосвала (см. блок РАЗБРОС ниже), не общий %

FUEL_L_PER_KWH = 0.256                # 215 г/кВт·ч / 0.84 кг/л (плотность топлива — допущение)

REFUEL_FUEL_PCT = 15.0                # заправляемся, если топлива в баке меньше этого % после разгрузки
REFUEL_MODEL_MIN = 15.0               # модельных минут простоя на заправке (временная реализация)
# ВРЕМЕННО, пока у координатора нет состояния truck-*.state = "refueling" (см. запрос в договор):
# заправка сделана как простой с destination="заправка" при текущем state. Когда состояние появится,
# переключить достаточно в одном месте — см. _start_refuel().

TRUCK_PUBLISH_S = 1.0    # не чаще раза в секунду, как требует протокол (contract/README.md, §7)
SLOW_PUBLISH_S = 5.0
QUEUE_GAP_M = 22.0

CARGO_BY_ORE = {"sulphide": "sulphide", "clay": "clay", "waste": "waste"}
DEST_BY_ORE = {"sulphide": "crusher-01", "clay": "stockpile-clay", "waste": "dump-waste-1"}
# домашние экскаваторы: 6+5+6 на сульфидные забои, 4 на глинистый, 3+4 на вскрышу
HOME = ([1] * 6 + [2] * 5 + [3] * 6 + [4] * 4 + [5] * 3 + [6] * 4)

# -- диспетчер: лимит доли глины в руде, привезённой на дробилку (§4 договора, clay_limit) --
CLAY_WINDOW_T = 2000.0        # т — скользящее окно, по которому считаем clay_share_crusher
CLAY_SOFT_FACTOR = 0.9        # заранее не грузить глинистые забои, если подошли к 90 % лимита
WAIT_WINDOW_MODEL_S = 3600.0  # модельный час — окно для avg_wait_*, trips_per_hour, tph_*
# оценка времени в пути для выбора экскаватора — та же формула хода (_mean_speed), что и у
# самосвала на самом деле (без подобранной отдельной скорости диспетчера и без разброса)
ORE_PREFERENCE_MARGIN_S = 30.0  # «руда важнее вскрыши» (г): только если вскрыша быстрее больше чем на 0,5 мин

# -- план-диспетчер (часть 2 текущей задачи): «план» (целевой т/ч на экскаватор) + «самосвал»
# (к самому отставшему от плана) — как в реальных системах диспетчеризации карьеров --
# plant-sulphide/plant-clay (модуль №4, bozshakol/modules/processing/main.py) публикуют
# только feed_rate (факт) и plan_fulfilment (%, факт/план) — самого значения плана (т/ч)
# нет ни одного признака на платформе, поэтому берём константами: совпадают с собственными
# SAG_TPH/CLAY_TPH модуля №4 и с bozshakol/data/SOURCES.md («Мощность фабрик» — источник
# mining-technology.com, 25 и 5 млн т/год; «Производительность фабрик по часам» — расчёт
# 25 и 5 млн т/год при ≈8770 ч работы) — проектная мощность, не наша подгонка.
PLAN_CRUSHER_TPH = 2850.0   # сульфидная фабрика, т/ч (25 млн т/год)
PLAN_CLAY_TPH = 570.0       # глинистая фабрика, т/ч (5 млн т/год)
PLAN_RECOMPUTE_S = 10.0 * 60.0   # план пересчитывается не реже, чем раз в 10 модельных минут
TRUCK_TIE_BREAK_S = 30.0         # «близкие значения» отставания от плана — 0,5 мин
PLAN_DEFICIT_FALLBACK_S = 1.0e6  # конечный «очень большой» запасной вариант вместо math.inf (см. _plan_deficit_time_s)

# -- дробилка как узкое место (bozshakol/modules/processing/main.py, модуль №4 — только читаем) --
# запасные значения на случай, если признаки crusher-01.bunker/throughput ещё не пришли;
# совпадают с CRUSHER_TPH/BUNKER_T у №4 (его допущение, см. bozshakol/data/SOURCES.md:
# «запас ≈1.4 к средней подаче 2850 т/ч; бункер вмещает ≈20 самосвалов»), а не наша подгонка
CRUSHER_THROUGHPUT_REF_TPH = 4000.0
CRUSHER_BUNKER_T_REF = 3000.0
CRUSHER_ACCEPT_FRACTION = 0.85  # №4 перестаёт принимать при bunker >= BUNKER_T * 0.85
CRUSHER_OVERFLOW_MARGIN_S = 300.0  # допущение: на вскрышу из-за дробилки — только если это даёт
                                    # выигрыш больше 5 мин, короткая обычная очередь не считается

# ----------------------------------------------------------------------------------
# РАЗБРОС (допущения, заданы до сверки — числа не трогать по её результату).
# Всё случайное — через один генератор self.rng (Random(seed)), для воспроизводимости.
# Распределение не названо в задаче для установки/разгрузки (п.3, п.5) — взято логнормальное,
# как явно задано для цикла ковша (п.1): время не бывает отрицательным, и так же параметризуется
# средним и коэффициентом вариации. Источник по разбросу времени цикла экскаватора/самосвала не
# нашёл — см. README (просьба к координатору/источник, если появится).
# ----------------------------------------------------------------------------------
BUCKET_CYCLE_CV = 0.15        # логнормальный разброс цикла ковша (среднее — BUCKET_CYCLE_S/factor)
LOAD_SETUP_CV = 0.3           # логнормальный разброс установки под погрузку (среднее — LOAD_SETUP_S)
DUMP_CV = 0.2                 # логнормальный разброс разгрузки (среднее — DUMP_S)
EXCAVATOR_OPERATOR_MULT_RANGE = (0.90, 1.10)  # машинист экскаватора — множитель скорости погрузки на смену
TRUCK_DRIVER_SHIFT_MULT_RANGE = (0.92, 1.05)  # водитель самосвала — множитель скорости на смену
TRUCK_DRIVER_TRIP_STD = 0.07   # водитель самосвала — разброс на рейс, нормальный, среднее 1.0
TRUCK_DRIVER_TRIP_CLIP = 0.15  # обрезка на ±15 %
EXCAVATOR_SHORT_STOP_MEAN_S = 60.0 * 60.0        # экспоненциальный интервал между остановками, среднее 60 мин
EXCAVATOR_SHORT_STOP_DURATION_S = (3.0 * 60.0, 10.0 * 60.0)  # равномерно 3-10 мин
# состояние экскаватора на время короткой остановки (зачистка/передвижка) — в договоре нет
# отдельного значения «не грузит, но не down» для экскаватора (есть только для состояний
# самосвала); не стали придумывать новое — используем уже существующее "idle" (экскаватор и
# так «не грузит» в этом состоянии между самосвалами, разница лишь в причине простоя)
EXCAVATOR_SHORT_STOP_STATE = "idle"


def _lognormal(rng, mean, cv):
    """Положительная случайная величина со средним mean и коэффициентом вариации cv."""
    sigma2 = math.log(1.0 + cv * cv)
    mu = math.log(mean) - sigma2 / 2.0
    return rng.lognormvariate(mu, math.sqrt(sigma2))


# ------------------------------------------------------------------ дороги
class Roads:
    def __init__(self, geometry):
        self.nodes = {k: tuple(v) for k, v in geometry["nodes"].items()}
        self.adj = {n: [] for n in self.nodes}
        self.edge_road = {}
        for e in geometry["edges"]:
            a, b = e["from"], e["to"]
            self.adj[a].append((b, e["length_m"], e["grade_pct"], e["road"]))
            self.adj[b].append((a, e["length_m"], -e["grade_pct"], e["road"]))
            self.edge_road[(a, b)] = self.edge_road[(b, a)] = e["road"]
        self.limits = {k: v["speed_limit_kmh"] for k, v in geometry["roads"].items()}
        self.closed = set()

    def path(self, start, goal):
        """Кратчайший путь по открытым дорогам (Дейкстра, вес — «утяжелённая на подъёме» длина); None — недостижимо."""
        if start == goal:
            return [start]
        dist = {start: 0.0}
        prev = {}
        heap = [(0.0, start)]
        while heap:
            d, n = heapq.heappop(heap)
            if n == goal:
                break
            if d > dist.get(n, math.inf):
                continue
            for m, length, grade, road in self.adj[n]:
                if road in self.closed:
                    continue
                nd = d + length * (1.0 + max(0.0, grade) / 10.0)
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    prev[m] = n
                    heapq.heappush(heap, (nd, m))
        if goal not in prev:
            return None
        out = [goal]
        while out[-1] != start:
            out.append(prev[out[-1]])
        return out[::-1]

    def edge(self, a, b):
        for m, length, grade, road in self.adj[a]:
            if m == b:
                return length, grade, road
        raise KeyError((a, b))


# ------------------------------------------------------------------ техника
class Truck:
    def __init__(self, index, roads, home):
        self.id = f"truck-{index:02d}"
        cls = 135 if index <= 22 else 180
        p = TRUCK_PASSPORT[cls]
        self.cls = cls
        self.capacity = p["capacity_t"]
        self.empty_weight_t = p["empty_weight_t"]
        self.power_kw = p["power_kw"]
        self.top_speed_loaded_kmh = p["top_speed_loaded_kmh"]
        self.tank_l = p["tank_l"]
        self.idle_lph = p["idle_lph"]
        self.buckets_needed = round(self.capacity / EXCAVATOR_BUCKET_T)

        self.roads = roads
        self.home = home            # домашний экскаватор
        self.excavator = home
        self.state = "queued_load"
        self.node = roads_load_node(roads, home)
        self.pos = list(roads.nodes[self.node])
        self.heading = 0.0
        self.speed = 0.0
        self.payload = 0.0
        self.cargo_type = "none"
        self.cargo_cu = 0.0
        self.cargo_clay = 0.0
        self.destination = ""
        self.fuel = 100.0  # настоящее начальное значение задаёт Haulage.__init__ через self.rng
        self.trips = 0
        self.path = []
        self.seg_pos = 0.0
        self.timer = 0.0
        self.wait = 0.0                 # ожидание в очереди у экскаватора (с прибытия)
        self.dump_wait = 0.0            # ожидание в очереди на разгрузке
        self.setup_done = False
        self.buckets_done = 0
        self.refuel_timer = 0.0
        self.queue_index = 0
        # -- разброс (водитель) --
        self.driver_shift_mult = 1.0    # множитель скорости на смену, равномерно 0.92-1.05
        self.trip_mult = 1.0            # множитель скорости на рейс, нормальный ±7%, обрезан ±15%
        self.setup_duration_s = LOAD_SETUP_S   # разыгрывается заново на каждую установку под погрузку
        self.dump_duration_s = DUMP_S          # разыгрывается заново на каждую разгрузку
        self.current_cycle_s = None            # текущий (разыгранный) цикл ковша, пока он не завершён
        # -- только для диагностики (sim_check.py): время по фазам цикла, не влияет на поведение --
        self.time_in = {"haul_loaded": 0.0, "haul_empty": 0.0, "queue_excavator": 0.0,
                         "load": 0.0, "queue_dump": 0.0, "dump": 0.0, "refuel": 0.0}
        self.load_sessions_s = []  # длительности завершённых установка+погрузка, с
        self._load_session_start_s = 0.0

    def features(self):
        return {
            "state": feature(self.state),
            "x": feature(round(self.pos[0], 1), "м"), "y": feature(round(self.pos[1], 1), "м"),
            "z": feature(round(self.pos[2], 1), "м"),
            "heading": feature(round(self.heading, 1), "°"), "speed": feature(round(self.speed, 1), "км/ч"),
            "payload": feature(round(self.payload, 1), "т"), "cargo_type": feature(self.cargo_type),
            "cargo_cu": feature(round(self.cargo_cu, 3), "% Cu"), "cargo_clay": feature(round(self.cargo_clay, 1), "%"),
            "destination": feature(self.destination), "excavator": feature(self.excavator),
            "fuel": feature(round(self.fuel, 1), "%"), "trips_total": feature(self.trips, "рейсов"),
        }


def roads_load_node(roads, excavator):
    return f"face-{excavator[-2:]}"


class Excavator:
    def __init__(self, index, roads, geometry):
        self.id = f"excavator-{index:02d}"
        self.face = f"face-{index:02d}"
        self.node = roads_load_node(roads, self.id)
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.pos = obj["position"]
        self.state = "idle"
        self.queue = []       # самосвалы в очереди (объекты)
        self.loading = None
        self.loaded_total = 0.0
        self.passes_total = 0
        self.down = False
        # -- только для диагностики (sim_check.py) --
        self.busy_s = 0.0          # время, когда кто-то грузился
        self.queue_integral = 0.0  # интеграл длины очереди по времени (для среднего)
        self.trucks_served = 0
        # -- разброс (машинист, короткие остановки) --
        self.operator_mult = 1.0       # множитель скорости погрузки на смену, равномерно 0.90-1.10
        self.next_short_stop_at = None  # момент (модельное время, с), когда наступит следующая остановка
        self.short_stop_until = 0.0     # до какого момента активна текущая остановка (0 — не остановлен)
        # -- план-диспетчер (часть 2) --
        self.plan_tph = 0.0             # текущая целевая производительность, т/ч (пересчёт — см. _update_plan)
        self.plan_target_cum_t = 0.0    # накопленный план (интеграл plan_tph по времени), т — для «отставания»

    def features(self):
        return {
            "state": feature("down" if self.down else self.state), "face": feature(self.face),
            "x": feature(self.pos[0], "м"), "y": feature(self.pos[1], "м"), "z": feature(self.pos[2], "м"),
            "queue": feature(len(self.queue), "шт"),
            "loaded_total": feature(round(self.loaded_total, 1), "т"),
            "passes_total": feature(self.passes_total, "ковшей"),
        }


class DumpPoint:
    def __init__(self, name, node, roads):
        self.id = name
        self.node = node
        self.pos = roads.nodes[node]
        self.queue = []
        self.dumping = None
        self.accepting = True
        self.received = 0.0
        self.trips = 0  # диагностика: сколько самосвалов разгрузилось здесь


# ------------------------------------------------------------------ модель
class Haulage:
    def __init__(self, geometry, watcher, clock, seed=42):
        self.geometry = geometry
        self.watcher = watcher
        self.clock = clock
        self.roads = Roads(geometry)
        self.excavators = {f"excavator-{i:02d}": Excavator(i, self.roads, geometry) for i in range(1, 7)}
        self.trucks = [Truck(i, self.roads, f"excavator-{HOME[i - 1]:02d}") for i in range(1, 29)]
        self.dumps = {name: DumpPoint(name, node, self.roads) for name, node in geometry["dump_points"].items()}
        for t in self.trucks:
            self.excavators[t.excavator].queue.append(t)
        self.mode = "auto"
        self.delivered = {"crusher-01": [0.0, 0.0], "stockpile-clay": [0.0, 0.0], "dump-waste-1": [0.0, 0.0]}
        self.trips = 0
        self.waits = []            # последние ожидания у экскаватора, мин (скользящее для совместимости)
        self.road_open = {r: True for r in ("road-ramp-1", "road-ramp-2", "road-crusher")}
        self.rng = random.Random(seed)  # единственный генератор случайности в модели (п.7 разброса)
        for t in self.trucks:
            t.fuel = self.rng.uniform(60, 100)
        self._current_shift = None  # пересчитать машинистов/водителей при первом read_scenarios()
        self.clay_limit_pct = 15.0
        self.fuel_used_l_total = 0.0
        self.refuels_total = 0
        # -- план-диспетчер (часть 2) --
        self.plan_crusher_tph = 0.0
        self.plan_clay_tph = 0.0
        self._last_plan_update_t = -math.inf  # форсируем расчёт плана на первом же шаге
        self._plan_inputs = None
        # скользящие окна за последний модельный час для сверки (деque из (sim_time_s, значение))
        self._wait_exc = deque()     # (t, минуты ожидания у экскаватора)
        self._wait_dump = deque()    # (t, минуты ожидания на разгрузке) — по всем пунктам вместе
        # то же самое, но отдельно по пунктам — для диагностики (sim_check.py, часть 4 сверки);
        # dispatch.avg_wait_dump (признак из договора) остаётся общим, как было
        self._wait_dump_by_point = {did: deque() for did in ("crusher-01", "stockpile-clay", "dump-waste-1")}
        self._trips_log = deque()    # (t,) — момент завершения разгрузки (рейса)
        self._tph_log = {"crusher-01": deque(), "stockpile-clay": deque(), "dump-waste-1": deque()}  # (t, тонн)
        self._clay_crusher_log = deque()  # (тонн, тонн_глины) — последние CLAY_WINDOW_T тонн на дробилку
        self._clay_crusher_total_t = 0.0
        self._clay_crusher_total_clay_t = 0.0
        self._sim_t = 0.0
        # начальное положение: часть самосвалов уже в пути, чтобы сцена была живой
        for t in self.trucks[::3]:
            ex = self.excavators[t.excavator]
            ex.queue.remove(t)
            self._load_instantly(t, ex)
            self._depart(t)

    # -- чтение платформы --------------------------------------------------
    def face_info(self, excavator):
        face = self.excavators[excavator].face
        w = self.watcher
        ore = w.get(face, "ore_type", "sulphide")
        return {
            "ore": ore,
            "cu": float(w.get(face, "cu_grade", 0.39) or 0.0),
            "clay": float(w.get(face, "clay_pct", 5.0) or 0.0),
            "factor": max(0.2, float(w.get(face, "loading_factor", 1.0) or 1.0)),
            "dest": w.get(face, "recommended_destination", DEST_BY_ORE.get(ore, "crusher-01")),
        }

    def read_scenarios(self):
        w = self.watcher
        off, _ = w.scenario("dispatch_off")
        self.mode = "manual" if off else "auto"
        closed, p = w.scenario("road_closed")
        road = p.get("road", "road-ramp-2")
        for r in self.road_open:
            self.road_open[r] = not (closed and r == road)
        self.roads.closed = {r for r, ok in self.road_open.items() if not ok}
        down, p = w.scenario("excavator_down")
        ex_down = p.get("excavator", "excavator-02")
        for ex in self.excavators.values():
            ex.down = down and ex.id == ex_down
        self.dumps["crusher-01"].accepting = bool(w.get("crusher-01", "accepting", True))
        self.dumps["stockpile-clay"].accepting = bool(w.get("stockpile-clay", "accepting", True))
        self.speed_limit = float(w.get("mine", "speed_limit", 50) or 50)
        self.clay_limit_pct = float(w.get("dispatch", "clay_limit", 15) or 15)
        shift = w.get("mine", "shift", 1)
        if shift != self._current_shift:
            self._current_shift = shift
            self._reroll_shift_multipliers()

    def _reroll_shift_multipliers(self):
        """Новая смена — у каждого экскаватора свой машинист, у каждого самосвала свой водитель
        (п.2, п.4 разброса); через self.rng, чтобы прогон был воспроизводим по seed."""
        for ex in self.excavators.values():
            ex.operator_mult = self.rng.uniform(*EXCAVATOR_OPERATOR_MULT_RANGE)
        for t in self.trucks:
            t.driver_shift_mult = self.rng.uniform(*TRUCK_DRIVER_SHIFT_MULT_RANGE)

    # -- план (часть 2 текущей задачи: «план» → целевой т/ч на каждый экскаватор) -------
    def _possible_tph(self, ex):
        """Собственная возможная производительность экскаватора, т/ч — если бы самосвалы
        подходили без очереди: с учётом loading_factor забоя (платформа) и множителя
        машиниста на смену (операнд operator_mult, п.2 разброса — не трогаем сам разброс,
        только читаем текущее значение)."""
        info = self.face_info(ex.id)
        cycle_s = BUCKET_CYCLE_S / info["factor"] / ex.operator_mult
        return EXCAVATOR_BUCKET_T * 3600.0 / cycle_s if cycle_s > 0 else 0.0

    def _update_plan(self):
        """Целевой т/ч для дробилки/склада глины — план фабрики (0, если сейчас не
        принимает); делится между работающими экскаваторами своей руды пропорционально их
        возможной производительности. Вскрышным — весь остаток пропускной способности
        парка, т.е. их собственная полная возможная производительность (их никто не
        ограничивает планом фабрики)."""
        self.plan_crusher_tph = PLAN_CRUSHER_TPH if self.dumps["crusher-01"].accepting else 0.0
        self.plan_clay_tph = PLAN_CLAY_TPH if self.dumps["stockpile-clay"].accepting else 0.0
        targets = {"sulphide": self.plan_crusher_tph, "clay": self.plan_clay_tph}
        possible = {ex.id: (0.0 if ex.down else self._possible_tph(ex)) for ex in self.excavators.values()}
        ore_of = {ex.id: self.face_info(ex.id)["ore"] for ex in self.excavators.values()}
        for ex in self.excavators.values():
            if ex.down:
                ex.plan_tph = 0.0
            elif ore_of[ex.id] == "waste":
                ex.plan_tph = possible[ex.id]
            else:
                group_total = sum(possible[e.id] for e in self.excavators.values()
                                   if not e.down and ore_of[e.id] == ore_of[ex.id])
                ex.plan_tph = targets.get(ore_of[ex.id], 0.0) * possible[ex.id] / group_total if group_total > 0 else 0.0

    def _maybe_update_plan(self):
        """Пересчёт плана не реже раза в 10 модельных минут, и сразу же при смене входных
        данных плана (поломка экскаватора, дробилка/склад перестали принимать)."""
        inputs = (self.dumps["crusher-01"].accepting, self.dumps["stockpile-clay"].accepting,
                  tuple(ex.down for ex in self.excavators.values()))
        if self._sim_t - self._last_plan_update_t >= PLAN_RECOMPUTE_S or inputs != self._plan_inputs:
            self._update_plan()
            self._last_plan_update_t = self._sim_t
            self._plan_inputs = inputs

    def _committed_tons(self, ex):
        """Тонны, уже «зачтённые» экскаватору в счёт плана: фактически погруженное плюс то,
        что довезут уже закреплённые за ним самосвалы (грузится сейчас / стоит в очереди /
        едет сюда порожним) — чтобы отставание не росло у экскаватора, у которого самосвалов
        уже достаточно, просто они пока не доехали.
        Для того, кто грузится сейчас — только ОСТАТОК до полной вместимости (capacity -
        payload), не вся capacity: уже погруженные ковши этого самосвала попадают в
        ex.loaded_total ПОКОВШОВО по ходу погрузки (_loading), так что полная capacity
        задвоила бы их (баг, найденный проверкой части 2)."""
        total = ex.loaded_total
        if ex.loading:
            total += ex.loading.capacity - ex.loading.payload
        for t in ex.queue:
            total += t.capacity
        for t in self.trucks:
            if t.state == "returning" and t.destination == ex.id and t is not ex.loading and t not in ex.queue:
                total += t.capacity
        return total

    def _plan_deficit_time_s(self, ex):
        """На сколько секунд экскаватор отстаёт от своего план-графика (п.3 части 2: «у кого
        по план-графику следующее обслуживание должно было начаться раньше»). Положительное —
        отстаёт (нужен самосвал раньше), отрицательное — идёт с опережением плана. Конечный
        «очень большой» запасной вариант вместо math.inf (не 0 т/ч цели, но отставание есть) —
        чтобы разность score'ов в _best_candidate никогда не давала inf-inf=nan (баг, найденный
        проверкой части 2: при score=nan сравнение «близко к лучшему» ложно для всех кандидатов,
        список кандидатов для выбора пустеет, и min() падает)."""
        deficit_t = ex.plan_target_cum_t - self._committed_tons(ex)
        if ex.plan_tph > 0:
            return deficit_t / (ex.plan_tph / 3600.0)
        return PLAN_DEFICIT_FALLBACK_S if deficit_t > 0 else 0.0

    # -- выбор экскаватора ---------------------------------------------------
    def _candidate_ore(self, truck):
        """Какую руду должен сейчас возить самосвал — обычно как у домашнего забоя, но если
        пункт разгрузки этой руды не принимает (crusher_stop/sag_maintenance), едем на вскрышу,
        пока он не примет снова — выбор ниже считается заново на каждом освобождении самосвала,
        так что возврат на руду происходит сам, без отдельного кода."""
        home_ore = self.face_info(self.excavators[truck.home].id)["ore"]
        if home_ore == "sulphide" and not self.dumps["crusher-01"].accepting:
            return "waste"
        if home_ore == "clay" and not self.dumps["stockpile-clay"].accepting:
            return "waste"
        return home_ore

    def _truck_load_time_s(self, truck):
        """Оценка полного времени погрузки самосвала (без текущего loading_factor забоя — это
        эвристика диспетчера для сравнения экскаваторов, а не точный прогноз)."""
        return LOAD_SETUP_S + BUCKET_CYCLE_S * truck.buckets_needed

    def _load_elapsed_s(self, truck, cycle_s):
        """Сколько из времени погрузки самосвал УЖЕ потратил (чтобы считать остаток, не всё заново)."""
        if not truck.setup_done:
            return truck.timer
        return LOAD_SETUP_S + truck.buckets_done * cycle_s + truck.timer

    def _path_time_s(self, truck, start_node, nodes):
        """Время в пути по списку узлов (от start_node через nodes), той же формулой хода
        (_mean_speed), что и реальное движение, — без случайного разброса (средние значения)."""
        total = 0.0
        prev = start_node
        for nxt in nodes:
            length, grade, road = self.roads.edge(prev, nxt)
            v_kmh = self._mean_speed(truck, grade, road)
            if v_kmh > 0:
                total += length / (v_kmh / 3.6)
            prev = nxt
        return total

    def _eta_s(self, truck, dest_node):
        """Оценка времени прибытия честной формулой хода (та же, что и реальное движение, без
        разброса): для самосвала, уже едущего именно туда, — по остатку ЕГО текущего пути
        (первое недоехавшее ребро + остальные); иначе — по кратчайшему маршруту от текущего узла."""
        if truck.path and truck.path[-1] == dest_node:
            length, grade, road = self.roads.edge(truck.node, truck.path[0])
            remaining = max(0.0, length - truck.seg_pos)
            v_kmh = self._mean_speed(truck, grade, road)
            total = remaining / (v_kmh / 3.6) if v_kmh > 0 else 0.0
            return total + self._path_time_s(truck, truck.path[0], truck.path[1:])
        path = self.roads.path(truck.node, dest_node)
        if path is None:
            return None
        return self._path_time_s(truck, truck.node, path[1:])  # path включает truck.node первым элементом

    def _excavator_free_at_s(self, ex):
        """Честно смоделировать очередь экскаватора (без нашего самосвала) и найти, через
        сколько секунд он освободится: кто уже грузится — по остатку его времени; кто стоит в
        очереди — по порядку, каждый добавляет своё полное время; кто ещё едет — по своему ETA,
        вставляется в очередь по времени прибытия (а не как будто уже стоит на месте)."""
        cycle_s = BUCKET_CYCLE_S / self.face_info(ex.id)["factor"]
        t_free = 0.0
        if ex.loading:
            t_free = max(0.0, self._truck_load_time_s(ex.loading) - self._load_elapsed_s(ex.loading, cycle_s))
        for t in ex.queue:
            t_free += self._truck_load_time_s(t)
        pending = []
        for t in self.trucks:
            if t is ex.loading or t in ex.queue:
                continue
            if t.state == "returning" and t.destination == ex.id:
                eta = self._eta_s(t, ex.node)
                if eta is not None:
                    pending.append((eta, self._truck_load_time_s(t)))
        pending.sort()
        for eta, svc in pending:
            t_free = max(t_free, eta) + svc
        return t_free

    def _crusher_wait_s(self):
        """Ожидаемое ожидание на дробилке для ещё одного гружёного самосвала — по очереди
        (честно, как у экскаватора) и по бункеру. Бункер и пропускную способность берём из
        признаков crusher-01 (bunker/throughput), которые публикует модуль №4 — читаем через
        платформу, его код не трогаем. Порог приёмки (85 % ёмкости) и ёмкость/пропускная
        способность по умолчанию — те же цифры, что у №4 (его допущение, source см. README):
        CRUSHER_BUNKER_T_REF/CRUSHER_THROUGHPUT_REF_TPH ниже."""
        dump = self.dumps["crusher-01"]
        t_free = max(0.0, DUMP_S - dump.dumping.timer) if dump.dumping else 0.0
        t_free += len(dump.queue) * DUMP_S
        bunker = self.watcher.get("crusher-01", "bunker", None)
        throughput = self.watcher.get("crusher-01", "throughput", None)
        if bunker is None:
            return t_free
        throughput = throughput or CRUSHER_THROUGHPUT_REF_TPH
        cap = CRUSHER_BUNKER_T_REF * CRUSHER_ACCEPT_FRACTION
        fill_frac = min(1.0, max(0.0, bunker) / cap) if cap > 0 else 0.0
        # чем ближе бункер к порогу приёмки, тем дольше реально придётся ждать — оценка:
        # время, за которое дробилка освобождает «буферную» часть бункера (от порога до верха)
        # нелинейно (куб): почти не штрафуем, пока бункер не заполнен всерьёз — резкий рост
        # только у самого порога приёмки, иначе лишние самосвалы уходят на вскрышу раньше,
        # чем дробилка реально испытывает недостаток руды
        buffer_t = CRUSHER_BUNKER_T_REF * (1.0 - CRUSHER_ACCEPT_FRACTION)
        bunker_wait_s = (fill_frac ** 3) * buffer_t / (throughput / 3600.0) if throughput > 0 else 0.0
        return t_free + bunker_wait_s

    def _best_candidate(self, truck, ore, near_clay_limit):
        """Экскаватор нужной руды, который сильнее всего отстаёт от своего план-задания к
        моменту прибытия самосвала (часть 2 текущей задачи — «самый нуждающийся экскаватор»):
        score = время в пути + отставание от плана сейчас (эквивалент «на сколько раньше
        относительно прибытия должно было начаться следующее обслуживание»); при разнице
        < 0,5 мин (TRUCK_TIE_BREAK_S) — выбор по честному «путь + ожидание», как раньше.
        Возвращает (id экскаватора, честная оценка «путь + ожидание») — само «честное» время
        используется ВЫШЕ (choose_excavator) для сравнения с вскрышей и ожидания у дробилки,
        а не для выбора между экскаваторами одной руды."""
        candidates = []
        for ex in self.excavators.values():
            if ex.down:
                continue
            info = self.face_info(ex.id)
            if info["ore"] != ore:
                continue
            if near_clay_limit and ore == "sulphide" and info["clay"] > self.clay_limit_pct:
                continue
            my_eta = self._eta_s(truck, ex.node)
            if my_eta is None:
                continue
            honest_start = max(my_eta, self._excavator_free_at_s(ex))
            score = my_eta + self._plan_deficit_time_s(ex)
            candidates.append((score, honest_start, ex.id))
        if not candidates:
            return None, math.inf
        best_score = max(c[0] for c in candidates)
        near = [c for c in candidates if best_score - c[0] < TRUCK_TIE_BREAK_S] or candidates
        chosen = min(near, key=lambda c: c[1])[2]
        # честная оценка «путь + ожидание» для сравнения с вскрышей (CRUSHER_OVERFLOW_MARGIN_S,
        # ORE_PREFERENCE_MARGIN_S в choose_excavator) — минимум по ВСЕМ кандидатам этой руды, а
        # не время у того, кого выбрали по плану: иначе «самый отставший от плана» экскаватор
        # (у которого честная очередь может быть куда длиннее минимальной) искусственно портил
        # бы эту оценку и без причины разворачивал самосвалы на вскрышу
        best_start = min(c[1] for c in candidates)
        return chosen, best_start

    def choose_excavator(self, truck):
        home = self.excavators[truck.home]
        if self.mode == "manual":
            # закреплённое распределение; если домашний сломан — просто ждём у него (п.1 части 4)
            return home.id
        # crusher_stop/sag_maintenance: правило обязательное, не смягчаем «руда важнее вскрыши» —
        # рудный пункт разгрузки сейчас физически не принимает, рудных там грузить незачем
        target_ore = self._candidate_ore(truck)
        # (в) доля глины на дробилке близка к лимиту — не грузить на неё ещё более глинистые забои
        near_clay_limit = (
            self._clay_crusher_total_t > 0 and self.clay_limit_pct > 0
            and (100.0 * self._clay_crusher_total_clay_t / self._clay_crusher_total_t)
                >= CLAY_SOFT_FACTOR * self.clay_limit_pct
        )
        best, best_start = self._best_candidate(truck, target_ore, near_clay_limit)
        crusher_bound = target_ore == "sulphide" and best is not None
        if crusher_bound:
            # дробилка — общее узкое место для всех сульфидных экскаваторов разом: прибавляем
            # честную оценку ожидания там к времени начала погрузки (п.4 части 2)
            best_start = best_start + self._crusher_wait_s()
        # «руда важнее вскрыши» (г), но не любой ценой, и ТОЛЬКО там, где вскрыша — реальная
        # альтернатива: у дробилки (сульфидные экскаваторы) или когда своей руды не нашлось
        # совсем. Глинистые самосвалы (единственный свой экскаватор-04, без узкого места на
        # дробилке) на вскрышу из-за «выгоднее по времени» не переманиваем — это не их случай.
        if target_ore != "waste" and (crusher_bound or best is None):
            # а) кандидатов нужной руды нет совсем — сравниваем с вскрышей по обычному порогу (0,5 мин);
            # б) дробилка перегружена — порог шире (CRUSHER_OVERFLOW_MARGIN_S): короткая обычная
            #    очередь не должна разом разворачивать четверть парка на вскрышу
            margin = CRUSHER_OVERFLOW_MARGIN_S if crusher_bound else ORE_PREFERENCE_MARGIN_S
            waste_best, waste_start = self._best_candidate(truck, "waste", near_clay_limit=False)
            if waste_best is not None and (best is None or waste_start + margin < best_start):
                return waste_best
        if best:
            return best
        # ничего не подошло — домашний как раньше, а если и он сломан — любой работающий
        if not home.down:
            return home.id
        working = next((e.id for e in self.excavators.values() if not e.down), None)
        return working or home.id

    # -- погрузка ------------------------------------------------------------
    def _load_instantly(self, truck, ex):
        info = self.face_info(ex.id)
        truck.payload = truck.capacity
        truck.cargo_type = CARGO_BY_ORE.get(info["ore"], "waste")
        truck.cargo_cu, truck.cargo_clay = info["cu"], info["clay"]
        truck.destination = info["dest"] if info["dest"] in self.dumps else DEST_BY_ORE.get(info["ore"], "dump-waste-1")
        ex.loaded_total += truck.payload

    def _depart(self, truck):
        """Гружёный самосвал едет на свой пункт разгрузки."""
        # новый рейс — новый случайный множитель скорости водителя (п.4 разброса)
        truck.trip_mult = min(1.0 + TRUCK_DRIVER_TRIP_CLIP, max(1.0 - TRUCK_DRIVER_TRIP_CLIP,
                               self.rng.gauss(1.0, TRUCK_DRIVER_TRIP_STD)))
        dest = self.dumps[truck.destination]
        path = self.roads.path(truck.node, dest.node)
        if path is None:  # дорога закрыта — ждём на месте
            truck.state = "queued_dump"
            truck.speed = 0.0
            truck.path = []
            return
        truck.path = path[1:]
        truck.seg_pos = 0.0
        truck.state = "hauling"

    def _return(self, truck):
        truck.excavator = self.choose_excavator(truck)
        ex = self.excavators[truck.excavator]
        path = self.roads.path(truck.node, ex.node)
        if path is None:
            truck.state = "queued_load"
            truck.speed = 0.0
            truck.path = []
            if truck not in ex.queue:
                ex.queue.append(truck)
            return
        truck.path = path[1:]
        truck.seg_pos = 0.0
        truck.state = "returning"
        truck.destination = ex.id

    def _start_refuel(self, truck):
        # ВРЕМЕННО: пока в договоре нет truck.state = "refueling" — стоим под видом "returning".
        # Когда координатор добавит состояние, здесь достаточно поменять truck.state на "refueling".
        truck.state = "returning"
        truck.speed = 0.0
        truck.path = []
        truck.destination = "заправка"
        truck.refuel_timer = REFUEL_MODEL_MIN * 60.0

    # -- движение ------------------------------------------------------------
    def _mean_speed(self, truck, grade_pct, road):
        """Средняя скорость по формуле мощности/паспорта, БЕЗ случайного разброса — та же
        физика, что и в _speed(), используется и для реального хода (там поверх неё добавляется
        разброс водителя), и диспетчером для честной оценки времени в пути (без допущенной
        отдельной скорости — ровно то же самое, чем едет самосвал)."""
        loaded = truck.payload > 0
        grade_frac = grade_pct / 100.0
        if grade_frac < 0:
            # на спуске мощность не ограничивает скорость — работает тормоз-замедлитель (допущение)
            v_kmh = SPEED_DOWN_LOADED_KMH if loaded else SPEED_DOWN_EMPTY_KMH
        else:
            mass_kg = (truck.empty_weight_t + truck.payload) * 1000.0
            resistance = grade_frac + ROLLING_RESISTANCE
            v_ms = EFFICIENCY * truck.power_kw * 1000.0 / (mass_kg * G_ACCEL * resistance)
            v_kmh = v_ms * 3.6
        # паспортный максимум по факту один (не разделён на гружёный/порожний) — применяем к обоим состояниям
        return min(v_kmh, truck.top_speed_loaded_kmh, self.roads.limits.get(road, 50), self.speed_limit)

    def _speed(self, truck, grade_pct, road):
        # разброс — водитель самосвала: множитель на смену × множитель на рейс (п.4 разброса),
        # вместо старого общего SPEED_VARIANCE
        return self._mean_speed(truck, grade_pct, road) * truck.driver_shift_mult * truck.trip_mult

    def _edge_fuel_l(self, truck, grade_pct, length_m):
        """Топливо на отрезке length_m при уклоне grade_pct; на спуске (гравитация помогает) — 0."""
        grade_frac = grade_pct / 100.0
        resistance = grade_frac + ROLLING_RESISTANCE
        if resistance <= 0 or length_m <= 0:
            return 0.0
        mass_kg = (truck.empty_weight_t + truck.payload) * 1000.0
        energy_j = mass_kg * G_ACCEL * resistance * length_m / EFFICIENCY
        energy_kwh = energy_j / 3_600_000.0
        return energy_kwh * FUEL_L_PER_KWH

    def _consume_fuel(self, truck, liters):
        if liters <= 0:
            return
        truck.fuel = max(0.0, truck.fuel - liters / truck.tank_l * 100.0)
        self.fuel_used_l_total += liters

    def _move(self, truck, dt):
        while dt > 0 and truck.path:
            nxt = truck.path[0]
            length, grade, road = self.roads.edge(truck.node, nxt)
            if road in self.roads.closed:
                # дорога закрылась под колёсами — перестроить маршрут
                goal = truck.path[-1]
                path = self.roads.path(truck.node, goal)
                if path is None:
                    truck.speed = 0.0
                    return
                truck.path = path[1:]
                continue
            v = self._speed(truck, grade, road)
            truck.speed = v
            step = v / 3.6 * dt
            remaining = length - truck.seg_pos
            if step < remaining:
                truck.seg_pos += step
                self._place(truck, nxt, truck.seg_pos / length)
                self._consume_fuel(truck, self._edge_fuel_l(truck, grade, step))
                return
            dt -= remaining / (v / 3.6)
            self._consume_fuel(truck, self._edge_fuel_l(truck, grade, remaining))
            truck.node = nxt
            truck.path.pop(0)
            truck.seg_pos = 0.0
            self._place(truck, nxt, 1.0)
        if not truck.path:
            truck.speed = 0.0
            self._arrived(truck)

    def _place(self, truck, nxt, frac):
        a, b = self.roads.nodes[truck.node], self.roads.nodes[nxt]
        truck.pos = [a[i] + (b[i] - a[i]) * frac for i in range(3)]
        truck.heading = (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360

    def _arrived(self, truck):
        if truck.state == "hauling":
            if self._reroute_if_not_accepting(truck):
                return  # переадресован на отвал — продолжает ехать, в очередь пока не встаёт
            truck.state = "queued_dump"
            truck.timer = 0.0
            truck.dump_wait = 0.0
            self.dumps[truck.destination].queue.append(truck)
        elif truck.state == "returning":
            truck.state = "queued_load"
            truck.wait = 0.0
            self.excavators[truck.excavator].queue.append(truck)

    def _reroute_if_not_accepting(self, truck):
        """Пункт разгрузки перестал принимать (crusher_stop/sag_maintenance) — везём на отвал
        вскрыши вместо того, чтобы встать в очередь, которая никогда не продвинется."""
        dump = self.dumps[truck.destination]
        if dump.accepting or truck.destination == "dump-waste-1":
            return False
        return self._reroute_to_dest(truck, "dump-waste-1")

    def _reroute_to_dest(self, truck, dest_id):
        dest = self.dumps[dest_id]
        path = self.roads.path(truck.node, dest.node)
        if path is None:
            return False
        truck.destination = dest_id
        truck.path = path[1:]
        truck.seg_pos = 0.0
        truck.state = "hauling"
        return True

    # -- шаг модели ----------------------------------------------------------
    def step(self, dt):
        self.read_scenarios()
        self._sim_t += dt
        self._trim_windows()
        self._maybe_update_plan()
        for ex in self.excavators.values():
            ex.plan_target_cum_t += ex.plan_tph / 3600.0 * dt
        for truck in self.trucks:
            self._consume_fuel(truck, truck.idle_lph * dt / 3600.0)   # холостой ход — всегда, пока включён
            if truck.refuel_timer > 0:
                truck.time_in["refuel"] += dt
                truck.refuel_timer = max(0.0, truck.refuel_timer - dt)
                truck.speed = 0.0
                if truck.refuel_timer == 0.0:
                    truck.fuel = 100.0
                    self.refuels_total += 1
                    truck.destination = ""
                    self._return(truck)
            elif truck.state == "hauling":
                truck.time_in["haul_loaded"] += dt
                self._move(truck, dt)
            elif truck.state == "returning":
                truck.time_in["haul_empty"] += dt
                self._move(truck, dt)
            elif truck.state == "queued_load":
                truck.time_in["queue_excavator"] += dt
                truck.wait += dt
            elif truck.state == "queued_dump":
                truck.time_in["queue_dump"] += dt
                truck.dump_wait += dt
            elif truck.state == "loading":
                truck.time_in["load"] += dt
                self._loading(truck, dt)
            elif truck.state == "dumping":
                truck.time_in["dump"] += dt
                self._dumping(truck, dt)
        for ex in self.excavators.values():
            if ex.loading:
                ex.busy_s += dt
            ex.queue_integral += len(ex.queue) * dt
            self._excavator(ex)
        for dump in self.dumps.values():
            if not dump.accepting and dump.id != "dump-waste-1" and dump.queue:
                # уже стоявшие в очереди, когда пункт перестал принимать — тоже на отвал,
                # иначе будут ждать бесконечно (дробилка/склад снова начнут принимать не скоро)
                stuck = dump.queue
                dump.queue = []
                for truck in stuck:
                    if not self._reroute_to_dest(truck, "dump-waste-1"):
                        dump.queue.append(truck)  # пути нет совсем — только ждать на месте
            self._dump_point(dump)
        self._queue_positions()

    def _excavator(self, ex):
        if ex.down:
            if ex.loading:
                ex.queue.insert(0, ex.loading)
                ex.loading.state = "queued_load"
                ex.loading = None
            ex.state = "down"
            if self.mode == "auto":
                for truck in list(ex.queue):  # авто-диспетчер уводит самосвалы к другому экскаватору
                    ex.queue.remove(truck)
                    self._return(truck)
            return
        # короткие остановки (зачистка, передвижка) — п.6 разброса: интервал экспоненциальный,
        # среднее 60 мин; длительность равномерно 3-10 мин; не трогает труков в пути, только
        # приостанавливает начало новой погрузки (и прерывает текущую, если она шла)
        if ex.next_short_stop_at is None:
            ex.next_short_stop_at = self._sim_t + self.rng.expovariate(1.0 / EXCAVATOR_SHORT_STOP_MEAN_S)
        if self._sim_t >= ex.next_short_stop_at and self._sim_t >= ex.short_stop_until:
            duration = self.rng.uniform(*EXCAVATOR_SHORT_STOP_DURATION_S)
            ex.short_stop_until = self._sim_t + duration
            ex.next_short_stop_at = ex.short_stop_until + self.rng.expovariate(1.0 / EXCAVATOR_SHORT_STOP_MEAN_S)
        if self._sim_t < ex.short_stop_until:
            if ex.loading:
                ex.queue.insert(0, ex.loading)
                ex.loading.state = "queued_load"
                ex.loading = None
            ex.state = EXCAVATOR_SHORT_STOP_STATE
            return
        if ex.loading is None and ex.queue:
            truck = ex.queue.pop(0)
            ex.loading = truck
            truck.state = "loading"
            truck.timer = 0.0
            truck.setup_done = False
            truck.buckets_done = 0
            truck.setup_duration_s = _lognormal(self.rng, LOAD_SETUP_S, LOAD_SETUP_CV)  # п.3 разброса
            truck.current_cycle_s = None  # на случай, если грузился раньше и был прерван остановкой
            truck._load_session_start_s = truck.time_in["load"]   # диагностика
            wait_min = truck.wait / 60.0
            self.waits.append(wait_min)
            self.waits = self.waits[-30:]
            self._wait_exc.append((self._sim_t, wait_min))
        ex.state = "loading" if ex.loading else "idle"

    def _loading(self, truck, dt):
        ex = self.excavators[truck.excavator]
        info = self.face_info(ex.id)
        truck.timer += dt
        if not truck.setup_done:
            if truck.timer < truck.setup_duration_s:
                return
            truck.timer -= truck.setup_duration_s
            truck.setup_done = True
        while truck.buckets_done < truck.buckets_needed:
            if truck.current_cycle_s is None:
                # цикл ковша — логнормальный разброс (п.1), / loading_factor забоя, / машинист (п.2);
                # один розыгрыш на ковш (не на каждый dt-тик) — держим, пока ковш не завершён
                truck.current_cycle_s = _lognormal(self.rng, BUCKET_CYCLE_S, BUCKET_CYCLE_CV) / info["factor"] / ex.operator_mult
            if truck.timer < truck.current_cycle_s:
                break
            truck.timer -= truck.current_cycle_s
            truck.current_cycle_s = None
            bucket = min(EXCAVATOR_BUCKET_T * self.rng.uniform(*BUCKET_FILL_VAR), truck.capacity - truck.payload)
            if bucket <= 0:
                truck.buckets_done = truck.buckets_needed
                break
            truck.cargo_cu = (truck.cargo_cu * truck.payload + info["cu"] * bucket) / (truck.payload + bucket)
            truck.cargo_clay = (truck.cargo_clay * truck.payload + info["clay"] * bucket) / (truck.payload + bucket)
            truck.payload += bucket
            truck.buckets_done += 1
            ex.passes_total += 1
            ex.loaded_total += bucket
        if truck.buckets_done >= truck.buckets_needed:
            truck.cargo_type = CARGO_BY_ORE.get(info["ore"], "waste")
            truck.destination = info["dest"] if info["dest"] in self.dumps else DEST_BY_ORE.get(info["ore"], "dump-waste-1")
            truck.load_sessions_s.append(truck.time_in["load"] - truck._load_session_start_s)  # диагностика
            ex.trucks_served += 1
            ex.loading = None
            self._depart(truck)

    def _dump_point(self, dump):
        if dump.dumping is None and dump.queue and dump.accepting:
            truck = dump.queue.pop(0)
            dump.dumping = truck
            truck.state = "dumping"
            truck.timer = 0.0
            truck.dump_duration_s = _lognormal(self.rng, DUMP_S, DUMP_CV)  # п.5 разброса
            wait_min = truck.dump_wait / 60.0
            self._wait_dump.append((self._sim_t, wait_min))
            self._wait_dump_by_point[dump.id].append((self._sim_t, wait_min))

    def _dumping(self, truck, dt):
        dump = self.dumps[truck.destination]
        truck.timer += dt
        if truck.timer >= truck.dump_duration_s:
            counters = self.delivered[dump.id]
            counters[0] += truck.payload
            counters[1] += truck.payload * truck.cargo_cu / 100.0
            dump.received += truck.payload
            self._tph_log[dump.id].append((self._sim_t, truck.payload))
            if dump.id == "crusher-01":
                self._clay_crusher_total_t += truck.payload
                self._clay_crusher_total_clay_t += truck.payload * truck.cargo_clay / 100.0
                self._clay_crusher_log.append((truck.payload, truck.payload * truck.cargo_clay / 100.0))
                while self._clay_crusher_total_t > CLAY_WINDOW_T and len(self._clay_crusher_log) > 1:
                    t, ct = self._clay_crusher_log.popleft()
                    self._clay_crusher_total_t -= t
                    self._clay_crusher_total_clay_t -= ct
            truck.payload = 0.0
            truck.cargo_type = "none"
            truck.cargo_cu = truck.cargo_clay = 0.0
            truck.trips += 1
            self.trips += 1
            self._trips_log.append(self._sim_t)
            dump.trips += 1
            dump.dumping = None
            if truck.fuel < REFUEL_FUEL_PCT:
                self._start_refuel(truck)
            else:
                self._return(truck)

    def _trim_windows(self):
        horizon = self._sim_t - WAIT_WINDOW_MODEL_S
        for dq in (self._wait_exc, self._wait_dump, self._trips_log):
            while dq and (dq[0][0] if isinstance(dq[0], tuple) else dq[0]) < horizon:
                dq.popleft()
        for dq in self._tph_log.values():
            while dq and dq[0][0] < horizon:
                dq.popleft()
        for dq in self._wait_dump_by_point.values():
            while dq and dq[0][0] < horizon:
                dq.popleft()

    def _queue_positions(self):
        """Стоящие самосвалы выстраиваются цепочкой от точки — очередь видна в 3D."""
        for ex in self.excavators.values():
            self._line_up(ex.node, ex.loading, ex.queue)
        for dump in self.dumps.values():
            self._line_up(dump.node, dump.dumping, dump.queue)

    def _line_up(self, node, active, queue):
        p = self.roads.nodes[node]
        back = None
        for m, *_ in self.roads.adj[node]:
            back = self.roads.nodes[m]
            break
        if back is None:
            return
        d = [back[i] - p[i] for i in range(3)]
        n = math.hypot(d[0], d[1]) or 1.0
        d = [d[0] / n, d[1] / n, 0.0]
        if active:
            active.pos = [p[0], p[1], p[2]]
            active.speed = 0.0
        for i, truck in enumerate(queue):
            gap = (i + 1) * QUEUE_GAP_M
            truck.pos = [p[0] + d[0] * gap, p[1] + d[1] * gap, p[2]]
            truck.speed = 0.0
            truck.heading = (math.degrees(math.atan2(-d[0], -d[1])) + 360) % 360

    # -- публикация ----------------------------------------------------------
    def dispatch_features(self):
        hauling = sum(1 for t in self.trucks if t.state in ("hauling", "returning"))
        queued = sum(1 for t in self.trucks if t.state in ("queued_load", "queued_dump"))
        assignments = {t.id: t.excavator for t in self.trucks}
        hours = min(1.0, self._sim_t / WAIT_WINDOW_MODEL_S) if self._sim_t > 0 else 0.0
        window_h = max(hours, 1e-6)
        avg_wait_exc = (sum(v for _, v in self._wait_exc) / len(self._wait_exc)) if self._wait_exc else 0.0
        avg_wait_dump = (sum(v for _, v in self._wait_dump) / len(self._wait_dump)) if self._wait_dump else 0.0
        trips_per_hour = len(self._trips_log) / window_h
        tph = {k: sum(v for _, v in dq) / window_h for k, dq in self._tph_log.items()}
        # "в деле" = не стоит в очереди (ни на погрузке, ни на разгрузке); у грузовиков нет
        # отдельного state="down" (ломаются только экскаваторы) — простой у сломанного экскаватора
        # уже учтён через queued_load, отдельно вычитать не нужно (было задвоение).
        fleet_utilization = 100.0 * max(0, len(self.trucks) - queued) / len(self.trucks)
        clay_share = (100.0 * self._clay_crusher_total_clay_t / self._clay_crusher_total_t
                      if self._clay_crusher_total_t > 0 else 0.0)
        return {
            "mode": feature(self.mode),
            "avg_wait_excavator": feature(round(avg_wait_exc, 2), "мин"),
            "avg_wait_dump": feature(round(avg_wait_dump, 2), "мин"),
            "trucks_hauling": feature(hauling, "шт"),
            "trucks_down": feature(sum(1 for t in self.trucks if t.state == "down"), "шт"),
            "assignments": feature(json.dumps(assignments), "json"),
            "delivered_crusher_t": feature(round(self.delivered["crusher-01"][0], 1), "т"),
            "delivered_crusher_cu_t": feature(round(self.delivered["crusher-01"][1], 3), "т Cu"),
            "delivered_clay_t": feature(round(self.delivered["stockpile-clay"][0], 1), "т"),
            "delivered_clay_cu_t": feature(round(self.delivered["stockpile-clay"][1], 3), "т Cu"),
            "delivered_dump_t": feature(round(self.delivered["dump-waste-1"][0], 1), "т"),
            "trips_total": feature(self.trips, "рейсов"),
            "queue_crusher": feature(len(self.dumps["crusher-01"].queue), "шт"),
            "queue_clay": feature(len(self.dumps["stockpile-clay"].queue), "шт"),
            "queue_dump": feature(len(self.dumps["dump-waste-1"].queue), "шт"),
            "trips_per_hour": feature(round(trips_per_hour, 1), "рейсов/ч"),
            "tph_crusher": feature(round(tph["crusher-01"], 1), "т/ч"),
            "tph_clay": feature(round(tph["stockpile-clay"], 1), "т/ч"),
            "tph_dump": feature(round(tph["dump-waste-1"], 1), "т/ч"),
            "fleet_utilization": feature(round(fleet_utilization, 1), "%"),
            "fuel_used_l": feature(round(self.fuel_used_l_total, 1), "л"),
            "refuels_total": feature(self.refuels_total, "шт"),
            "clay_share_crusher": feature(round(clay_share, 2), "%"),
            "clay_limit": feature(self.clay_limit_pct, "%"),
            "plan_crusher_tph": feature(round(self.plan_crusher_tph, 1), "т/ч"),
            "plan_clay_tph": feature(round(self.plan_clay_tph, 1), "т/ч"),
        }

    def road_features(self, road):
        on_road = 0
        for t in self.trucks:
            if t.path and self.roads.edge_road.get((t.node, t.path[0])) == road:
                on_road += 1
        return {
            "open": feature(self.road_open[road]),
            "speed_limit": feature(min(self.roads.limits[road], int(self.speed_limit)), "км/ч"),
            "trucks_on_road": feature(on_road, "шт"),
        }


def main():
    with open("geometry.json", encoding="utf-8") as f:
        geometry = json.load(f)
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios", "mine", "crusher-01", "stockpile-clay"}
                          | {f"face-0{i}" for i in range(1, 7)}, client_id="bz-haulage-watch").start()
    telemetry = Telemetry(client_id="bz-haulage").connect()
    clock = SimClock()
    model = Haulage(geometry, watcher, clock)
    model.speed_limit = 50.0
    last_slow = 0.0
    while True:
        dt = clock.tick()
        # шаг не больше 5 модельных секунд — чтобы очереди и погрузка считались точно
        while dt > 0:
            sub = min(dt, 5.0)
            model.step(sub)
            dt -= sub
        for truck in model.trucks:
            telemetry.publish(truck.id, truck.features())
        now = time.monotonic()
        if now - last_slow >= SLOW_PUBLISH_S:
            last_slow = now
            for ex in model.excavators.values():
                telemetry.publish(ex.id, ex.features())
            telemetry.publish("dispatch", model.dispatch_features())
            for road in model.road_open:
                telemetry.publish(road, model.road_features(road))
            dump = model.dumps["dump-waste-1"]
            telemetry.publish("dump-waste-1", {
                "received_total": feature(round(dump.received, 1), "т"), "accepting": feature(True),
                "trucks_queued": feature(len(dump.queue), "шт"),
            })
            states = {}
            for t in model.trucks:
                states[t.state] = states.get(t.state, 0) + 1
            log.info("режим %s, состояния %s, доставлено на дробилку %.0f т, очередь у дробилки %d",
                     model.mode, states, model.delivered["crusher-01"][0], len(model.dumps["crusher-01"].queue))
        time.sleep(TRUCK_PUBLISH_S)


if __name__ == "__main__":
    main()
