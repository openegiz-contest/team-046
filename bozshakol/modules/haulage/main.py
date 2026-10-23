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

from bzlib import NAMESPACE, DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging

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
REFUEL_MODEL_MIN = 15.0               # модельных минут простоя на заправке, по договору (fuel-station)

# -- резерв самосвалов (задача «Резерв самосвалов», затем «Долгое восстановление» часть 2 —
# резерв на уровне ВСЕГО ПАРКА, не по экскаваторам) --
RESERVE_REFUEL_FUEL_PCT = 50.0        # порог из текста задачи: топливо < 50% перед резервом — сначала заправка
RESERVE_MARGIN = 0.10                 # запас сверх Σ trucks_needed по доступным экскаваторам — допущение
                                       # МОДУЛЯ из текста задачи («часть 2»), см. README
WARMUP_MODEL_S = 30.0 * 60.0          # первые 30 модельных минут после старта — резерв = 0 (разгон),
                                       # число из текста задачи («часть 2»)
RESERVE_SURPLUS_TRUCKS = 2            # порог «лишних» для гистерезиса входа в резерв — число из текста задачи
RESERVE_SURPLUS_HOLD_S = 10.0 * 60.0  # излишек >= RESERVE_SURPLUS_TRUCKS должен держаться непрерывно столько
                                       # модельных минут, прежде чем начинать отправлять в резерв — текст задачи
RESERVE_ENTRY_INTERVAL_S = 5.0 * 60.0 # не чаще одного самосвала в резерв за это модельное время — текст задачи
# «не работает» = не считается в fleet_utilization/trucks_needed как занятый планом; резерв сюда же —
# по условию задачи: резервный самосвал не работающий, даже если формально не в очереди
NOT_WORKING_STATES = ("queued_load", "queued_dump", "refueling", "reserve")

TRUCK_PUBLISH_S = 1.0    # не чаще раза в секунду, как требует протокол (contract/README.md, §7)
SLOW_PUBLISH_S = 5.0
QUEUE_GAP_M = 22.0

CARGO_BY_ORE = {"sulphide": "sulphide", "clay": "clay", "waste": "waste"}
DEST_BY_ORE = {"sulphide": "crusher-01", "clay": "stockpile-clay", "waste": "dump-waste-1"}
# домашние экскаваторы: 6+5+6 на сульфидные забои, 4 на глинистый, 3+4 на вскрышу
HOME = ([1] * 6 + [2] * 5 + [3] * 6 + [4] * 4 + [5] * 3 + [6] * 4)

# -- диспетчер: лимит доли глины в руде, привезённой на дробилку --
# clay_limit в договоре нет (проверено координатором) — это константа МОДУЛЯ (допущение,
# не из договора), просто публикуется в dispatch как справочное значение.
CLAY_LIMIT_PCT = 15.0         # допущение: предел доли глины в руде на дробилке
CLAY_WINDOW_T = 2000.0        # т — скользящее окно, по которому считаем clay_share_crusher
CLAY_SOFT_FACTOR = 0.9        # заранее не грузить глинистые забои, если подошли к 90 % лимита
WAIT_WINDOW_MODEL_S = 3600.0  # модельный час — окно для avg_wait_*, trips_per_hour, tph_*
# оценка времени в пути для выбора экскаватора — та же формула хода (_mean_speed), что и у
# самосвала на самом деле (без подобранной отдельной скорости диспетчера и без разброса)
# УДАЛЕНО: ORE_PREFERENCE_MARGIN_S/CRUSHER_OVERFLOW_MARGIN_S — отдельная
# надбавка «руда важнее вскрыши» в choose_excavator. Она была лишней и мешала плану: решение
# «какую руду возить» принималось по HOME самосвала (см. удалённый _candidate_ore), а margin
# ещё и не давал уйти на вскрышу, даже когда план рудных уже выполнен — вместе это и объясняет,
# почему руда на дробилку/склад превышала план. Теперь _best_candidate сравнивает руду и
# вскрышу напрямую по тому же отставанию от плана, без искусственной надбавки.

# -- план-диспетчер: «план» (целевой т/ч на экскаватор) + «самосвал»
# (к самому отставшему от плана) — как в реальных системах диспетчеризации карьеров --
# plant-sulphide/plant-clay (модуль №4, bozshakol/modules/processing/main.py) публикуют
# только feed_rate (факт) и plan_fulfilment (%, факт/план) — самого значения плана (т/ч)
# нет ни одного признака на платформе. Целевые т/ч для диспетчера — фактическая ДОБЫЧА, не
# переработка и не проектная мощность: самосвалы возят добытую руду, поэтому сравниваем
# именно с добычей (источник: KAZ Minerals, Q4 2025 Production report, bozshakol/data/
# SOURCES.md, строка «Добыча руды 2025» — 35,5 млн т за год, ≈4050 т/ч в среднем ÷ ≈8770
# ч/год; разбивка на сульфидную/глинистую часть — 3360 и 715 т/ч, в сумме ≈4075 т/ч, близко
# к средней добыче). Эти цифры — цель ИМЕННО нашего диспетчера, а не модуля №4: у него
# внутри другие (проектная мощность, его допущение) — SAG_TPH=2850.0/CLAY_TPH=570.0,
# т. е. №4 и наш план-диспетчер ориентируются на разные числа; мы это не правим (не наш код).
PLAN_CRUSHER_TPH = 3360.0   # сульфидная, т/ч — факт добычи 2025 (KAZ Minerals Q4 2025, см. выше)
PLAN_CLAY_TPH = 715.0       # глинистая, т/ч — факт добычи 2025 (KAZ Minerals Q4 2025, см. выше)
# вскрыша: «весь остаток пропускной способности парка» — НЕ собственная _possible_tph каждого
# вскрышного экскаватора (была бы в разы больше провозной способности парка, см. _update_plan),
# а доля от целого PLAN_WASTE_TPH, тем же способом, что и рудные группы. Величина — «вскрыша ≈
# тоннаж руды», уже существующее допущение проекта (bozshakol/data/SOURCES.md, строка «Число и
# типы забоев»), т.е. PLAN_WASTE_TPH = PLAN_CRUSHER_TPH + PLAN_CLAY_TPH — не наша подгонка.
PLAN_WASTE_TPH = PLAN_CRUSHER_TPH + PLAN_CLAY_TPH
PLAN_RECOMPUTE_S = 10.0 * 60.0   # план пересчитывается не реже, чем раз в 10 модельных минут
TRUCK_TIE_BREAK_S = 30.0         # «близкие значения» отставания от плана — 0,5 мин
PLAN_DEFICIT_FALLBACK_S = 1.0e6  # конечный «очень большой» запасной вариант вместо math.inf (см. _plan_deficit_time_s)
# допущение: диспетчер не пытается «отыграть» больше
# 1-2 упущенных рейсов сразу — иначе после восстановления обслуживания (дорога открылась,
# экскаватор почин) весь парк одновременно бросается к ОДНОМУ экскаватору с огромным накопленным
# долгом (настоящий баг — план-долг не ограничен сверху). Берём больший класс самосвала
# (180 т) — щедрее предел, число 2 — прямо из текста задачи, не подбирал под результат.
PLAN_DEFICIT_CAP_TRUCKS = 2.0
PLAN_DEFICIT_CAP_T = PLAN_DEFICIT_CAP_TRUCKS * TRUCK_PASSPORT[180]["capacity_t"]
# средний груз по составу парка (22×135 т + 6×180 т) — для правила «сколько самосвалов нужно
# экскаватору» (N = целевой т/ч × цикл в часах / средний груз, см. _trucks_needed)
AVG_PAYLOAD_T = (22 * TRUCK_PASSPORT[135]["capacity_t"] + 6 * TRUCK_PASSPORT[180]["capacity_t"]) / 28.0

# -- дробилка как узкое место (bozshakol/modules/processing/main.py, модуль №4 — только читаем) --
# запасные значения на случай, если признаки crusher-01.bunker/throughput ещё не пришли;
# совпадают с CRUSHER_TPH/BUNKER_T у №4 (его допущение, см. bozshakol/data/SOURCES.md:
# «запас ≈1.4 к средней подаче 2850 т/ч; бункер вмещает ≈20 самосвалов»), а не наша подгонка
CRUSHER_THROUGHPUT_REF_TPH = 4000.0
CRUSHER_BUNKER_T_REF = 3000.0
CRUSHER_ACCEPT_FRACTION = 0.85  # №4 перестаёт принимать при bunker >= BUNKER_T * 0.85

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


# -- доли времени парка по состояниям --
# полный перебор состояния самосвала из договора (contract/README.md, §«Признаки самосвала»):
# queued_load/queued_dump -> одна доля «очередь» (п.6 задачи: «очередь у экскаватора и на
# разгрузке — вместе»), остальные состояния — каждое своей долей; суммируются к 100%, т.к.
# каждый самосвал всегда ровно в одном из этих состояний
STATE_TIME_PCT_KEY = {
    "loading": "loading", "hauling": "hauling", "returning": "returning",
    "queued_load": "queue", "queued_dump": "queue",
    "dumping": "dumping", "refueling": "refueling", "reserve": "reserve", "down": "down",
}
TIME_PCT_FEATURES = ("loading", "hauling", "returning", "queue", "dumping", "refueling", "reserve", "down")


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

    def escape_path(self, start, goal):
        """Для самосвала в `start`, у которого нет обычного пути (по открытым дорогам) до
        `goal`, потому что он оказался ВНУТРИ закрытого участка (закрытие по имени дороги
        закрывает сразу все её звенья — середина такого участка заперта с обеих сторон, см.
        README/задача «road_closed»): кратчайший путь ДО БЛИЖАЙШЕГО узла, ОТКУДА `goal`
        СНОВА достижим обычным путём, — по тем же (пока ещё формально закрытым) рёбрам,
        которыми самосвал уже сюда заехал, не по новой/придуманной дороге. Тупиковый
        отросток с формально открытым ребром (например face-06 — floor, пока ramp-2 рядом
        закрыт) НЕ считается выходом сам по себе — проверяем именно достижимость `goal`, а
        не «есть хоть одно открытое ребро» (настоящий баг первой версии, найденный на
        проверке: самосвал «не считался» запертым из-за такого тупика и просто стоял).
        None — `goal` недостижим вообще ниоткуда (честно сдаёмся, см. `_route_from`)."""
        dist = {start: 0.0}
        prev = {}
        heap = [(0.0, start)]
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, math.inf):
                continue
            if n != start and self.path(n, goal) is not None:
                out = [n]
                while out[-1] != start:
                    out.append(prev[out[-1]])
                return out[::-1]
            for m, length, grade, road in self.adj[n]:
                nd = d + length
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    prev[m] = n
                    heapq.heappush(heap, (nd, m))
        return None

    def on_closed_segment(self, node):
        """Узел лежит на (сейчас формально) закрытом участке — у него есть хотя бы одно
        закрытое прилегающее звено. Используется, чтобы отличить самосвал, который
        действительно заперт на закрытом участке (ему нужна эвакуация, `escape_path`), от
        любого другого, для которого обычного объезда к конкретной цели просто нет —
        закрытые звенья ему, как и всем остальным, недоступны (задача «road_closed-2»,
        цель 1: раньше `_route_from` звал `escape_path` для ЛЮБОГО провала `path()`, из-за
        чего самосвал, стоящий на совершенно открытом узле, мог получить маршрут через
        закрытую дорогу — настоящий баг, найденный диагностикой)."""
        return any(road in self.closed for _, _, _, road in self.adj.get(node, []))

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
        self.travel_pending = False     # дороги к цели сейчас нет (road_closed) — ждём и пробуем снова
        self.travel_kind = None         # "depart"/"return"/"refuel"/"reserve" — куда именно едем, для повтора
        self.evac_until = None          # едет по формально ЗАКРЫТОЙ дороге до этого узла (эвакуация из
                                         # запертого участка, задача «road_closed») — до него закрытость
                                         # этих звеньев не считаем «разрывом под колёсами»
        self.entering_reserve = False   # едет на fuel-station, чтобы встать в резерв (не на дозаправку)
        self.reserve_since_s = 0.0      # момент входа в резерв (self._sim_t) — диагностика
        # -- разброс (водитель) --
        self.driver_shift_mult = 1.0    # множитель скорости на смену, равномерно 0.92-1.05
        self.trip_mult = 1.0            # множитель скорости на рейс, нормальный ±7%, обрезан ±15%
        self.setup_duration_s = LOAD_SETUP_S   # разыгрывается заново на каждую установку под погрузку
        self.dump_duration_s = DUMP_S          # разыгрывается заново на каждую разгрузку
        self.current_cycle_s = None            # текущий (разыгранный) цикл ковша, пока он не завершён
        # -- только для диагностики (sim_check.py): время по фазам цикла, не влияет на поведение --
        self.time_in = {"haul_loaded": 0.0, "haul_empty": 0.0, "queue_excavator": 0.0,
                         "load": 0.0, "queue_dump": 0.0, "dump": 0.0, "refuel": 0.0, "reserve": 0.0}
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
        # -- план-диспетчер --
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
        self.clay_limit_pct = CLAY_LIMIT_PCT
        self.fuel_used_l_total = 0.0
        self.refuels_total = 0
        # -- план-диспетчер --
        self.plan_crusher_tph = 0.0
        self.plan_clay_tph = 0.0
        self._last_plan_update_t = -math.inf  # форсируем расчёт плана на первом же шаге
        self._plan_inputs = None
        self._committed_baseline = {}  # {excavator.id: loaded_total на момент старта диспетчера} — см. _committed_tons
        self._closed_prev = set()  # предыдущий roads.closed — для мгновенного пересчёта маршрутов при смене road_closed
        # скользящие окна за последний модельный час для сверки (деque из (sim_time_s, значение))
        self._wait_exc = deque()     # (t, минуты ожидания у экскаватора)
        self._wait_dump = deque()    # (t, минуты ожидания на разгрузке) — по всем пунктам вместе
        # то же самое, но отдельно по пунктам — для диагностики (sim_check.py, сверка);
        # dispatch.avg_wait_dump (признак из договора) остаётся общим, как было
        self._wait_dump_by_point = {did: deque() for did in ("crusher-01", "stockpile-clay", "dump-waste-1")}
        self._trips_log = deque()    # (t,) — момент завершения разгрузки (рейса)
        self._tph_log = {"crusher-01": deque(), "stockpile-clay": deque(), "dump-waste-1": deque()}  # (t, тонн)
        self._clay_crusher_log = deque()  # (тонн, тонн_глины) — последние CLAY_WINDOW_T тонн на дробилку
        self._clay_crusher_total_t = 0.0
        self._clay_crusher_total_clay_t = 0.0
        # -- резерв самосвалов (текущая задача) --
        # (t, dt, {state: шт}, расход_топлива_за_этот_шаг_л) — для fleet-wide time_*_pct и
        # trucks_needed/fuel_saved_l_shift за последний модельный час (окно — как у _wait_exc и т.п.)
        self._fleet_state_log = deque()
        self._shift_reserve_s = 0.0  # накоплено секунд в резерве за ТЕКУЩУЮ смену (сброс — см. read_scenarios)
        # -- резерв на уровне парка (часть 2 «долгого восстановления») --
        self._reserve_surplus_since_t = None  # момент, с которого излишек >= RESERVE_SURPLUS_TRUCKS держится
        self._last_reserve_entry_t = -math.inf  # момент последнего входа в резерв (плавность)
        self._target_working_val = 0.0  # кэш _target_working() на текущий шаг — см. _reserve_surplus
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
        if self.roads.closed != self._closed_prev:
            # road_closed включился/выключился — пересчитываем маршруты СРАЗУ для всех, кого
            # это касается, не дожидаясь, пока каждый физически доедет до разрыва (задача
            # «road_closed», часть 2: «маршрут проходит через закрытый участок — пересчитать
            # маршрут сразу от текущего положения»)
            self._replan_all_for_road_change()
            self._closed_prev = set(self.roads.closed)
        down, p = w.scenario("excavator_down")
        ex_down = p.get("excavator", "excavator-02")
        for ex in self.excavators.values():
            ex.down = down and ex.id == ex_down
        self.dumps["crusher-01"].accepting = bool(w.get("crusher-01", "accepting", True))
        self.dumps["stockpile-clay"].accepting = bool(w.get("stockpile-clay", "accepting", True))
        self.speed_limit = float(w.get("mine", "speed_limit", 50) or 50)
        shift = w.get("mine", "shift", 1)
        if shift != self._current_shift:
            self._current_shift = shift
            self._reroll_shift_multipliers()
            self._shift_reserve_s = 0.0  # новая смена — копим fuel_saved_l_shift с нуля

    def _reroll_shift_multipliers(self):
        """Новая смена — у каждого экскаватора свой машинист, у каждого самосвала свой водитель
        (п.2, п.4 разброса); через self.rng, чтобы прогон был воспроизводим по seed."""
        for ex in self.excavators.values():
            ex.operator_mult = self.rng.uniform(*EXCAVATOR_OPERATOR_MULT_RANGE)
        for t in self.trucks:
            t.driver_shift_mult = self.rng.uniform(*TRUCK_DRIVER_SHIFT_MULT_RANGE)

    # -- план («план» → целевой т/ч на каждый экскаватор) -------
    def _possible_tph(self, ex):
        """Собственная возможная производительность экскаватора, т/ч — если бы самосвалы
        подходили без очереди: с учётом loading_factor забоя (платформа) и множителя
        машиниста на смену (операнд operator_mult, п.2 разброса — не трогаем сам разброс,
        только читаем текущее значение)."""
        info = self.face_info(ex.id)
        cycle_s = BUCKET_CYCLE_S / info["factor"] / ex.operator_mult
        return EXCAVATOR_BUCKET_T * 3600.0 / cycle_s if cycle_s > 0 else 0.0

    def _excavator_cut_off(self, ex):
        """Экскаватор физически не обслуживается — не получает цель (`plan_tph = 0`) в
        `_update_plan` и не копит план-долг (`plan_target_cum_t`, пауза в `step()`): сломан
        (`ex.down`), отрезан закрытой дорогой (честная проверка путём от fuel-station — узла,
        который сам никогда не закрывается, т.к. не на съездах road-ramp-1/2/road-crusher),
        забой исчерпан (`remaining` — признак геологии, в договоре есть, просто раньше не
        читали). КОРОТКАЯ остановка (`EXCAVATOR_SHORT_STOP_*`, п.6 разброса — сам разброс не
        трогаем) сюда намеренно НЕ входит, хотя в тексте задачи названа одной из причин —
        проверено прогоном (`sim_check.py`, режим «со сценариями»): если на каждую короткую
        3-10-минутную остановку (±раз в час на экскаватор) переставать копить план-долг или
        перебрасывать её долю плана на остальных экскаваторов группы, план «дёргается» чаще,
        чем самосвалы успевают доехать — ожидание у экскаватора становится ХУЖЕ (не лучше), а
        руда у «авто» уходит ниже 90% от плана (настоящее эмпирическое наблюдение по трём
        отдельным прогонам, не предположение). Короткие остановки — единственная из четырёх
        причин, которую отдельно НЕ гасим: они и так короткие, укладываются под общий предел
        PLAN_DEFICIT_CAP_T (ниже) без вреда для точности руды. На ВЫБОР экскаватора самосвалом
        (`_best_candidate`) ничего из этого не влияет — там уже есть честная проверка
        достижимости по пути (`_eta_s`), её не трогаем."""
        if ex.down:
            return True
        if self.roads.path("fuel-station", ex.node) is None:
            return True
        remaining = self.watcher.get(ex.face, "remaining", None)
        if remaining is not None and float(remaining) <= 0.0:
            return True
        return False

    def _update_plan(self):
        """Целевой т/ч для дробилки/склада глины — план добычи (0, если сейчас не принимает);
        делится между работающими экскаваторами своей руды пропорционально их возможной
        производительности (`_possible_tph`). Вскрышным — тоже доля от ОБЩЕГО целевого т/ч,
        а не собственная необузданная `_possible_tph` каждого (была настоящая ошибка:
        `_possible_tph` — это сколько экскаватор нарубит, если самосвалы подходят
        БЕЗ ОЧЕРЕДИ, т.е. теоретический потолок ~3700-3900 т/ч на экскаватор — в разы больше,
        чем реально способен вывезти весь парк в 28 самосвалов; поставленный целью напрямую,
        он делал план-накопитель вскрышных экскаваторов «бесконечно голодным», и правило
        «кто сильнее отстал от плана» почти всегда выбирало вскрышу, а не руду — это и есть
        причина перебора руды цели в «авто», НЕ HOME). Целевой т/ч для вскрыши — PLAN_WASTE_TPH
        (== план руды, «вскрыша ≈ тоннаж руды» — уже существующее допущение проекта,
        bozshakol/data/SOURCES.md), делится между работающими вскрышными экскаваторами
        пропорционально их возможной производительности — так же, как у рудных групп.
        Структурно недоступные экскаваторы (`_excavator_cut_off` — сломан/отрезан/забой
        исчерпан) не получают цель (`plan_tph = 0`) и не входят в `group_total` своей группы
        — план-долг не копится, пока их физически не обслуживают (настоящий баг: раньше
        проверялось только `ex.down`). Короткие остановки сюда не входят — см. `_excavator_cut_off`."""
        self.plan_crusher_tph = PLAN_CRUSHER_TPH if self.dumps["crusher-01"].accepting else 0.0
        self.plan_clay_tph = PLAN_CLAY_TPH if self.dumps["stockpile-clay"].accepting else 0.0
        targets = {"sulphide": self.plan_crusher_tph, "clay": self.plan_clay_tph, "waste": PLAN_WASTE_TPH}
        available = {ex.id: not self._excavator_cut_off(ex) for ex in self.excavators.values()}
        possible = {ex.id: (self._possible_tph(ex) if available[ex.id] else 0.0) for ex in self.excavators.values()}
        ore_of = {ex.id: self.face_info(ex.id)["ore"] for ex in self.excavators.values()}
        for ex in self.excavators.values():
            if not available[ex.id]:
                ex.plan_tph = 0.0
                continue
            group_total = sum(possible[e.id] for e in self.excavators.values()
                               if available[e.id] and ore_of[e.id] == ore_of[ex.id])
            ex.plan_tph = targets.get(ore_of[ex.id], 0.0) * possible[ex.id] / group_total if group_total > 0 else 0.0

    def _maybe_update_plan(self):
        """Пересчёт плана не реже раза в 10 модельных минут, и сразу же при смене состава
        ДОСТУПНЫХ экскаваторов (`_excavator_cut_off` — поломка/отрезанность дорогой/забой
        исчерпан, уже учитывает `roads.closed` внутри честной проверкой пути) или приёмки
        дробилки/склада. Короткая остановка (`ex.short_stop_until`) сюда НЕ входит —
        `_update_plan` (доля группы) от неё не зависит, см. `_excavator_cut_off`; добавление
        её сюда проверено и отклонено: план пересчитывался бы практически каждый тик (короткие
        остановки часты — ~раз в час на каждый из 6 экскаваторов) без какой-либо пользы.
        В тексте задачи про долгое восстановление после `road_closed` предлагалось ещё и
        ОБНУЛЯТЬ план-долг (`plan_target_cum_t`) при смене состава — пробовал (и обнуление
        только на поломку/отрезанность, и дополнительно на смену приёмки дробилки/склада):
        ухудшало ожидание и точность руды к плану на устойчивом прогоне БЕЗ сценариев вовсе
        (прогон: без обнуления — 1,18 мин/96% от плана; с обнулением — 2,34 мин/97% от плана
        при той же старой проверке `_plan_deficit_time_s`, т.е. разница именно от обнуления).
        Отказался от обнуления: симметричный предел `PLAN_DEFICIT_CAP_T` в `_plan_deficit_time_s`
        (ниже) сам по себе уже решает долгое восстановление — после смены состава опережение/
        отставание само пересчитывается на актуальный `plan_tph`, разница лишь не стирается
        искусственно, а чем дальше во времени накопленный долг от предела, тем меньше у него
        итогового влияния на выбор (все экскаваторы с долгом у предела неотличимы между собой
        по score), так что нет причины ещё и обнулять его вручную — лишняя операция делает
        только хуже (проверено, не предположение)."""
        available = tuple(not self._excavator_cut_off(ex) for ex in self.excavators.values())
        inputs = (self.dumps["crusher-01"].accepting, self.dumps["stockpile-clay"].accepting, available)
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
        задвоила бы их (баг, найденный при проверке).
        `ex.loaded_total` — ОБЩИЙ накопительный счётчик с начала смены, восстанавливается из
        Ditto при перезапуске (часть «долгое восстановление», восстановление счётчиков) — а
        `plan_target_cum_t`, с которым он сравнивается в `_plan_deficit_time_s`, после
        перезапуска ВСЕГДА начинается с нуля (план-долг — внутренняя величина диспетчера, не
        договорный счётчик, восстанавливать его не просили). Без поправки это создавало
        огромный искусственный «перегон» план-долга у ВСЕХ экскаваторов сразу после
        перезапуска (на живом стенде после нескольких часов работы — многие тысячи тонн),
        который «прижимал» всех к симметричному пределу одновременно — а поскольку предел
        переводится в секунды делением на `plan_tph`, у вскрышных (plan_tph почти вдвое выше
        рудных) штраф в секундах выходил слабее, и весь парк после перезапуска уезжал на
        вскрышу (настоящая причина, найденная диагностикой на стенде: `_committed_baseline`
        — снимок `loaded_total` на момент старта ДИСПЕТЧЕРА — отнимается, чтобы план-долг
        всегда начинал считать с нуля в рамках текущего запуска, как и раньше, когда
        восстановления счётчиков не было вовсе."""
        total = ex.loaded_total - self._committed_baseline.get(ex.id, 0.0)
        if ex.loading:
            total += ex.loading.capacity - ex.loading.payload
        for t in ex.queue:
            total += t.capacity
        for t in self.trucks:
            if t.state == "returning" and t.destination == ex.id and t is not ex.loading and t not in ex.queue:
                total += t.capacity
        return total

    def _cycle_time_estimate_s(self, ex):
        """Честная оценка полного цикла самосвала к этому экскаватору (погрузка + путь туда +
        разгрузка + путь обратно), усреднённая по составу парка (22×135 т + 6×180 т) — та же
        честная физика хода/погрузки, что у `_eta_s`/`_truck_load_time_s`, без разброса и без
        текущей очереди (эвристика диспетчера, не точный прогноз). Нужна для `_trucks_needed`."""
        info = self.face_info(ex.id)
        dest_id = info["dest"] if info["dest"] in self.dumps else DEST_BY_ORE.get(info["ore"], "dump-waste-1")
        dest = self.dumps[dest_id]
        total_s, total_n = 0.0, 0
        for cls, n in ((135, 22), (180, 6)):
            ref = next((t for t in self.trucks if t.cls == cls), None)
            if ref is None:
                continue
            there = self.roads.path(ex.node, dest.node)
            back = self.roads.path(dest.node, ex.node)
            travel_s = (self._path_time_s(ref, ex.node, there[1:]) if there else 0.0) + \
                       (self._path_time_s(ref, dest.node, back[1:]) if back else 0.0)
            cycle_s = self._truck_load_time_s(ref, info["factor"]) + travel_s + DUMP_S
            total_s += cycle_s * n
            total_n += n
        return total_s / total_n if total_n else 0.0

    def _trucks_needed(self, ex):
        """Сколько самосвалов нужно экскаватору ПРЯМО СЕЙЧАС, чтобы держать его целевой т/ч:
        N = plan_tph × цикл_часов / средний_груз_т (AVG_PAYLOAD_T). Часть задачи «долгое
        восстановление», п.3 — правило для резерва: РАБОТАЕТ С ПЕРВОЙ СЕКУНДЫ, без накопленной
        истории (в отличие от `_plan_deficit_time_s`/`plan_target_cum_t`, которому нужно время,
        чтобы план-долг стал осмысленным — именно это вызывало всплеск резерва сразу после
        старта стенда, см. отчёт)."""
        if ex.plan_tph <= 0:
            return 0.0
        cycle_s = self._cycle_time_estimate_s(ex)
        return ex.plan_tph * (cycle_s / 3600.0) / AVG_PAYLOAD_T

    def _target_working(self):
        """Сколько самосвалов должно быть В РАБОТЕ (не в резерве) прямо сейчас — резерв решается
        для ВСЕГО ПАРКА разом, не по экскаваторам (часть 2 задачи «долгое восстановление», после
        часть 3 того же модуля — старое правило `_plan_needs_truck`/`_assigned_trucks` по
        экскаватору убрано как конфликтующее, см. `_check_reserve_exits`/`_return`). Σ
        `_trucks_needed(ex)` по ДОСТУПНЫМ экскаваторам (`_excavator_cut_off` — так же, как в
        `_update_plan`) плюс запас RESERVE_MARGIN (10%, допущение из текста задачи), но не
        меньше Σ + 1 — чтобы при малом Σ (мало доступных экскаваторов/план маленький) запас не
        обращался в 0 из-за округления 10% вниз до целого."""
        total_needed = sum(self._trucks_needed(ex) for ex in self.excavators.values()
                            if not self._excavator_cut_off(ex))
        return math.ceil(max(total_needed * (1.0 + RESERVE_MARGIN), total_needed + 1.0))

    def _working_count(self):
        """Самосвалов «в работе» прямо сейчас — не в резерве и не сломан (`down`); состояние
        `reserve`/`down` не считаются работой, остальные (очередь, погрузка, гружёный рейс,
        разгрузка, обратный путь, заправка) — считаются, как и в `_target_working`/`_trucks_needed`
        (формула Литтла — пайплайн самосвалов в полном цикле, не мгновенный «едет/стоит»)."""
        return sum(1 for t in self.trucks if t.state not in ("reserve", "down"))

    def _reserve_surplus(self):
        """Сколько самосвалов сейчас сверх `_target_working` (0, если недостача — проверка
        входа в резерв смотрит именно на это, выхода — на сам недобор, см. `_return`/
        `_check_reserve_exits`). Берёт `_target_working_val` — посчитанный раз за шаг в `step()`,
        а не свежий вызов `_target_working()`: тот обходит все 6 экскаваторов с поиском пути
        (`_cycle_time_estimate_s`), и внутри одного шага он не меняется (план-долг/доступность
        считаются раньше в `_maybe_update_plan`) — считать его на каждого самосвала в
        `_check_reserve_exits` было настоящей проблемой производительности, найденной при
        проверке (sim_check.py на 12ч стал заметно медленнее после части 2)."""
        return self._working_count() - self._target_working_val

    def _update_reserve_hysteresis(self):
        """Вызывается каждый шаг (`step`): следит, держится ли излишек >= RESERVE_SURPLUS_TRUCKS
        НЕПРЕРЫВНО RESERVE_SURPLUS_HOLD_S модельных секунд подряд — гистерезис входа в резерв
        (часть 2 задачи, «плавность»): если держится дольше, не останавливается в середине из-за
        случайного колебания на одну секунду, а просто обновляет момент начала при разрыве."""
        if self._reserve_surplus() >= RESERVE_SURPLUS_TRUCKS:
            if self._reserve_surplus_since_t is None:
                self._reserve_surplus_since_t = self._sim_t
        else:
            self._reserve_surplus_since_t = None

    def _reserve_entry_allowed(self):
        """Можно ли отправить СЛЕДУЮЩЕГО освободившегося самосвала в резерв прямо сейчас — часть 2:
        разгон (`WARMUP_MODEL_S`) — резерва вообще нет; иначе — гистерезис (излишек держится
        `RESERVE_SURPLUS_HOLD_S` подряд, см. `_update_reserve_hysteresis`) и плавность (не чаще
        одного самосвала за `RESERVE_ENTRY_INTERVAL_S`). Проверка излишка — ещё раз, на текущий
        момент (не только по факту, что гистерезис «накопился»): если он уже погашен другим
        самосвалом, вошедшим в резерв секундами раньше в тот же тик, не отправляем лишнего."""
        if self._sim_t < WARMUP_MODEL_S:
            return False
        if (self._reserve_surplus_since_t is None
                or self._sim_t - self._reserve_surplus_since_t < RESERVE_SURPLUS_HOLD_S):
            return False
        if self._sim_t - self._last_reserve_entry_t < RESERVE_ENTRY_INTERVAL_S:
            return False
        return self._reserve_surplus() >= RESERVE_SURPLUS_TRUCKS

    def _plan_deficit_time_s(self, ex):
        """На сколько секунд экскаватор отстаёт от своего план-графика («у кого по
        план-графику следующее обслуживание должно было начаться раньше»). Положительное —
        отстаёт (нужен самосвал раньше), отрицательное — идёт с опережением плана. Предел
        ТОЛЬКО сверху (`min(x, PLAN_DEFICIT_CAP_T)`, как в haulage/reserve, #7) — испытывался
        и симметричный предел (ограничение с обеих сторон плюс единая, не зависящая от
        `plan_tph`, мера перевода в секунды — чтобы рудные и вскрышные весили одинаково), но
        на живом стенде ни один из двух вариантов не дал устойчиво ≤2 мин ожидания и ≥90%
        руды нарастающим итогом за первые 2 модельных часа (финальная проверка задачи «долгое
        восстановление») — выбран этот, более простой и ближе к #7, вариант. Честно: при
        `road_closed` восстановление снова может занимать ощутимое время (см. README,
        «Сверка с реальностью») — компромисс, не идеальное решение.
        Конечный «очень большой» запасной вариант (`PLAN_DEFICIT_FALLBACK_S`) вместо
        `math.inf`, когда `plan_tph <= 0` — чтобы разность score'ов в `_best_candidate`
        никогда не давала `inf-inf=nan` (баг, найденный проверкой)."""
        deficit_t = min(ex.plan_target_cum_t - self._committed_tons(ex), PLAN_DEFICIT_CAP_T)
        if ex.plan_tph > 0:
            return deficit_t / (ex.plan_tph / 3600.0)
        return PLAN_DEFICIT_FALLBACK_S if deficit_t > 0 else 0.0

    # -- выбор экскаватора ---------------------------------------------------
    def _truck_load_time_s(self, truck, factor=1.0):
        """Оценка полного времени погрузки самосвала — С учётом `loading_factor` забоя
        (`factor`, передаёт вызывающий — честная оценка, не разброс: у вскрышных забоёв порода
        твёрже, `loading_factor` ≈ 0.76-0.77 против ≈1.0 у рудных, реальный цикл ковша ЗАМЕТНО
        длиннее). Без этого (было раньше: всегда `factor=1.0`) — настоящая нестыковка единиц,
        найденная при сравнении живого стенда с `sim_check.py` (задача «стенд против
        sim_check»): `_excavator_free_at_s` уже считает ОСТАТОК погрузки честно, через
        `cycle_s = BUCKET_CYCLE_S / factor`, а «полное время» для вычитания остатка брало ОТСЮДА
        — без `factor`, т.е. занижало полное время погрузки у медленных (вскрышных)
        экскаваторов на те же ≈24-30%, из-за чего диспетчер считал их свободными РАНЬШЕ, чем
        они реально освобождались, и направлял туда больше самосвалов, чем они успевали
        обслужить — очередь там росла. `operator_mult` (машинист, разброс) сюда намеренно НЕ
        входит — это честная оценка без случайного разброса, как и было, `factor` — не разброс,
        а признак забоя (модуль №3)."""
        return LOAD_SETUP_S + BUCKET_CYCLE_S * truck.buckets_needed / factor

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
        factor = self.face_info(ex.id)["factor"]
        cycle_s = BUCKET_CYCLE_S / factor
        t_free = 0.0
        if ex.loading:
            t_free = max(0.0, self._truck_load_time_s(ex.loading, factor) - self._load_elapsed_s(ex.loading, cycle_s))
        for t in ex.queue:
            t_free += self._truck_load_time_s(t, factor)
        pending = []
        for t in self.trucks:
            if t is ex.loading or t in ex.queue:
                continue
            if t.state == "returning" and t.destination == ex.id:
                eta = self._eta_s(t, ex.node)
                if eta is not None:
                    pending.append((eta, self._truck_load_time_s(t, factor)))
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

    def _assigned_trucks(self, ex):
        """Сколько самосвалов уже «идут» к этому экскаватору прямо сейчас — грузится, стоит в
        очереди, едет сюда порожним (включая тех, кто ждёт из-за `travel_pending`). Аналог
        `_committed_tons`, но в штуках самосвалов, а не в тоннах — для предела на НОВОЕ
        назначение в `_best_candidate` (задача «road_closed-2», цель 2: план-долг отрезанного
        экскаватора не копится (`_excavator_cut_off`), но, пока закрыта дорога, у него могут
        стать недоступны конкуренты по группе (руда/вскрыша) — их план уходит в 0, и вся доля
        группы перетекает на этого одного, из-за чего по открытии дороги на него разом едет
        куда больше машин, чем он успевает переварить. Без отдельного предела по штукам
        симметричный предел план-долга (`PLAN_DEFICIT_CAP_T`) это не решает — он ограничивает
        НАКОПЛЕННОЕ отставание, а не то, сколько самосвалов УЖЕ едет сюда прямо сейчас)."""
        n = 1 if ex.loading else 0
        n += len(ex.queue)
        n += sum(1 for t in self.trucks
                 if t.excavator == ex.id and t is not ex.loading and t not in ex.queue
                 and (t.state == "returning" or (t.travel_pending and t.travel_kind == "return")))
        return n

    def _best_candidate(self, truck, ores, near_clay_limit):
        """Экскаватор, который сильнее всего отстаёт от своего план-задания к моменту прибытия
        самосвала, среди ВСЕХ пунктов руды, которые сейчас в принципе доступны (`ores` — набор
        типов, не один тип — самосвал в «авто» сравнивает руду и вскрышу
        напрямую по плану, а не по тому, у какого экскаватора он «домашний»; HOME здесь вообще не
        участвует — он только для «ручного», см. `choose_excavator`). score = время в пути (+
        честное ожидание на дробилке для сульфидных — она общее узкое место для всех сульфидных
        экскаваторов разом) плюс отставание от плана сейчас (эквивалент «на сколько раньше
        относительно прибытия должно было начаться следующее обслуживание»); при разнице < 0,5 мин
        (TRUCK_TIE_BREAK_S) — выбор по честному «путь + ожидание». Так вскрышные экскаваторы (их
        план — вся оставшаяся возможная производительность, см. `_update_plan`) сами забирают
        излишек, когда рудным/глинистым экскаваторам по плану уже достаточно самосвалов — без
        отдельной надбавки «руда важнее вскрыши» (та была нечестной: решала по HOME, не по плану).
        Кандидат, у которого уже «идёт» (`_assigned_trucks`) `trucks_needed(ex) + 1` самосвалов
        или больше, пропускается — предел НА НОВОЕ назначение, отдельный от предела план-долга
        (задача «road_closed-2», цель 2: без него после открытия дороги на один отрезанный ранее
        экскаватор может разом хлынуть вся накопленная доля группы).
        Возвращает id экскаватора или None, если подходящих кандидатов не нашлось вовсе."""
        crusher_wait = self._crusher_wait_s() if "sulphide" in ores else 0.0
        candidates = []
        for ex in self.excavators.values():
            if ex.down:
                continue
            info = self.face_info(ex.id)
            if info["ore"] not in ores:
                continue
            if near_clay_limit and info["ore"] == "sulphide" and info["clay"] > self.clay_limit_pct:
                continue
            if self._assigned_trucks(ex) >= self._trucks_needed(ex) + 1.0:
                continue
            my_eta = self._eta_s(truck, ex.node)
            if my_eta is None:
                continue
            extra = crusher_wait if info["ore"] == "sulphide" else 0.0
            honest_start = max(my_eta, self._excavator_free_at_s(ex)) + extra
            score = my_eta + extra + self._plan_deficit_time_s(ex)
            candidates.append((score, honest_start, ex.id))
        if not candidates:
            return None
        best_score = max(c[0] for c in candidates)
        near = [c for c in candidates if best_score - c[0] < TRUCK_TIE_BREAK_S] or candidates
        return min(near, key=lambda c: c[1])[2]

    def _near_clay_limit(self):
        """Доля глины на дробилке близка к лимиту — не грузить на неё ещё более глинистые забои."""
        return (
            self._clay_crusher_total_t > 0 and self.clay_limit_pct > 0
            and (100.0 * self._clay_crusher_total_clay_t / self._clay_crusher_total_t)
                >= CLAY_SOFT_FACTOR * self.clay_limit_pct
        )

    def _eligible_ores(self):
        """Рудные пункты участвуют в сравнении только если физически принимают сейчас
        (crusher_stop/sag_maintenance) — это обязательное правило, не смягчается; вскрыша
        участвует всегда. Вынесено из choose_excavator — тот же набор нужен для сравнения
        экскаваторов, план-логика при этом не меняется."""
        eligible = {"waste"}
        if self.dumps["crusher-01"].accepting:
            eligible.add("sulphide")
        if self.dumps["stockpile-clay"].accepting:
            eligible.add("clay")
        return eligible

    def choose_excavator(self, truck):
        home = self.excavators[truck.home]
        if self.mode == "manual":
            # закреплённое распределение; если домашний сломан — просто ждём у него
            return home.id
        # «авто»: какую руду возить — решает ПЛАН (кто сильнее отстал),
        # а не HOME/тип груза домашнего забоя самосвала — HOME здесь не участвует вовсе.
        near_clay_limit = self._near_clay_limit()
        eligible = self._eligible_ores()
        best = self._best_candidate(truck, eligible, near_clay_limit)
        if best:
            return best
        # ничего не подошло (все экскаваторы сломаны и т.п.) — домашний, а если и он сломан —
        # любой работающий
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
        truck.state = "hauling"
        dest = self.dumps[truck.destination]
        path = self.roads.path(truck.node, dest.node)
        if path is None:
            # дороги к пункту разгрузки нет (road_closed) — ждём на месте и пробуем снова
            # каждый шаг (проверено координатором), никуда не переадресуем
            truck.travel_pending = True
            truck.travel_kind = "depart"
            truck.path = []
            truck.speed = 0.0
            return
        truck.travel_pending = False
        truck.path = path[1:]
        truck.seg_pos = 0.0

    def _return(self, truck):
        """Самосвал освободился (после разгрузки, заправки или выхода из резерва). «Авто»:
        резерв решается для ВСЕГО ПАРКА разом (часть 2 задачи «долгое восстановление»,
        `_reserve_entry_allowed` — разгон/гистерезис/плавность) — если можно отправить
        следующего освободившегося в резерв, едет туда (`_enter_reserve`), а не к экскаватору.
        «Ручной» — без изменений, как раньше (резерва не существует, самосвал всегда едет к
        своему домашнему экскаватору через choose_excavator)."""
        if self.mode == "auto" and self._reserve_entry_allowed():
            self._enter_reserve(truck)
            self._last_reserve_entry_t = self._sim_t
            return
        truck.entering_reserve = False
        truck.excavator = self.choose_excavator(truck)
        ex = self.excavators[truck.excavator]
        truck.state = "returning"
        truck.destination = ex.id
        path = self.roads.path(truck.node, ex.node)
        if path is None:
            # дороги к экскаватору нет — ждём на месте и пробуем снова каждый шаг; НЕ встаём
            # в очередь экскаватора заранее (иначе самосвал «телепортировался» бы туда на
            # сцене — очередь позиционируется по узлу экскаватора, а самосвал там физически
            # ещё не был) и не перемещаемся мгновенно (проверено координатором)
            truck.travel_pending = True
            truck.travel_kind = "return"
            truck.path = []
            truck.speed = 0.0
            return
        truck.travel_pending = False
        truck.path = path[1:]
        truck.seg_pos = 0.0

    def _enter_reserve(self, truck):
        """Самосвал сейчас никому не нужен — паркуем в
        резерв у fuel-station (контракт, contract/README.md: «стоит на стоянке у узла
        fuel-station»), двигатель заглушен (расход топлива 0 — допущение, см. README). Если
        топлива меньше RESERVE_REFUEL_FUEL_PCT — сначала честная заправка (_start_refuel,
        допущение «заправляются во время простоя»): по её завершении
        step() снова вызывает _return(), и решение «резерв или работа» принимается заново,
        уже с полным баком."""
        if truck.fuel < RESERVE_REFUEL_FUEL_PCT:
            self._start_refuel(truck)
            return
        truck.entering_reserve = True
        truck.destination = "fuel-station"
        truck.state = "returning"
        path = self.roads.path(truck.node, "fuel-station")
        if path is None:
            truck.travel_pending = True
            truck.travel_kind = "reserve"
            truck.path = []
            truck.speed = 0.0
            return
        truck.travel_pending = False
        truck.path = path[1:]
        truck.seg_pos = 0.0

    def _check_reserve_exits(self):
        """Выход из резерва — часть 2 задачи «долгое восстановление»: нехватка важнее экономии
        топлива (по тексту задачи) — если работающих самосвалов (`_working_count`) меньше
        `_target_working`, тут же возвращаем резервные самосвалы в работу обычным путём
        (`_return` — экскаватор для него выберет нынешняя маршрутизация), БЕЗ ограничения на
        скорость и без минимального времени в резерве (в отличие от входа — там своя плавность
        и гистерезис, см. `_reserve_entry_allowed`). Ровно по одному — после каждого возврата
        `_working_count` пересчитывается заново, так что возвращаем не больше, чем нужно. То же
        правило само срабатывает при возврате экскаватора после поломки или открытия дороги —
        `_target_working` в этот момент сразу вырастает (`_excavator_cut_off` внутри него уже
        честно проверяет путь), никакого отдельного кода для этого случая не нужно. Вызывается
        каждый шаг — пересчёт плана (не реже раза в 10 мин) и события (сценарии, поломки, приём
        дробилки/склада) читаются в read_scenarios()/_maybe_update_plan() тем же шагом, так что
        ничего не пропускаем."""
        if self.mode != "auto":
            return
        for truck in self.trucks:
            if truck.state != "reserve":
                continue
            if self._working_count() >= self._target_working_val:
                break
            self._return(truck)

    def _release_all_reserve(self):
        """Переключение «авто» → «ручной»: резерва не существует — все
        резервные самосвалы сразу выезжают к своим домашним экскаваторам. self.mode уже
        «manual» в момент вызова, поэтому _return (через choose_excavator) сам отправляет их
        по закреплённому распределению, не по диспетчеру. Самосвалы, которые ФИЗИЧЕСКИ ЕЩЁ
        ЕДУТ на fuel-station, чтобы встать в резерв (state=="returning", entering_reserve=True,
        ещё не доехали) — тоже перенаправляем сразу, а не ждём, пока они доедут и попробуют
        встать в резерв уже в «ручном» (настоящий баг, найденный при проверке:
        без этой ветки такой самосвал на прибытии получал бы state="reserve" даже в manual)."""
        for truck in self.trucks:
            if truck.state == "reserve" or (truck.state == "returning" and truck.entering_reserve):
                truck.entering_reserve = False
                self._return(truck)

    def _start_refuel(self, truck):
        """Топливо < REFUEL_FUEL_PCT после разгрузки — самосвал едет по дорогам на fuel-station
        (узел из core/geometry.json, по договору), state = "refueling" наступает по прибытии
        (см. _arrived) — не сразу, самосвал сперва честно доезжает."""
        truck.destination = "fuel-station"
        truck.state = "returning"
        path = self.roads.path(truck.node, "fuel-station")
        if path is None:
            truck.travel_pending = True
            truck.travel_kind = "refuel"
            truck.path = []
            truck.speed = 0.0
            return
        truck.travel_pending = False
        truck.path = path[1:]
        truck.seg_pos = 0.0

    def _nearest_reachable_excavator(self, truck, ore=None):
        """Ближайший (по честному времени хода, та же формула, что у диспетчера — `_path_time_s`)
        ДОСТИЖИМЫЙ СЕЙЧАС экскаватор, не сломанный; `ore` — опционально ограничить типом руды
        забоя. Для «ручного»: закреплённый экскаватор отрезан закрытой дорогой — порожний
        самосвал едет к ближайшему достижимому того же типа руды, а если такого нет — к любому
        достижимому; план/«авто» это не трогает — там то же
        самое уже делает `choose_excavator`/`_best_candidate`, см. `_retry_pending_travel`).
        None, если вообще никого не достать (все сломаны или отрезаны одновременно)."""
        best, best_s = None, None
        for ex in self.excavators.values():
            if ex.down:
                continue
            if ore is not None and self.face_info(ex.id)["ore"] != ore:
                continue
            path = self._route_from(truck, ex.node)
            if path is None:
                continue
            dist_s = self._path_time_s(truck, truck.node, path[1:]) if len(path) > 1 else 0.0
            if best_s is None or dist_s < best_s:
                best, best_s = ex.id, dist_s
        return best

    def _route_from(self, truck, goal):
        """Маршрут от текущего узла `truck` к `goal` — с «эвакуацией», если обычного пути (по
        открытым дорогам) нет, потому что самосвал оказался ВНУТРИ закрытого участка
        (`Roads.escape_path` — задача «road_closed»: закрытие по имени дороги закрывает все её
        звенья разом, и самосвал, оказавшийся ровно в середине, не может уехать ни вперёд, ни
        назад обычным путём). Сначала — обычный путь; если его нет — едет по тем же, пока
        формально закрытым, звеньям до ближайшего узла, ОТКУДА `goal` снова достижим, — не по
        новой/придуманной дороге; `truck.evac_until` запоминает, до какого узла эти звенья
        считаются проезжими (иначе `_move()` каждый шаг заново «натыкался» бы на ту же
        закрытую дорогу и пересчитывал тот же путь — настоящий бесконечный цикл, найденный
        при проверке: 100%+ CPU, ни одной строки в журнале). None — недостижимо даже так
        (честно, без выдумывания пути, см. README).

        Эвакуация (`escape_path`) — ТОЛЬКО если самосвал прямо сейчас стоит на закрытом
        участке (`Roads.on_closed_segment`); если обычного пути нет просто потому, что для
        этой ЦЕЛИ сейчас в принципе нет объезда (единственный маршрут шёл через закрытую
        дорогу, а сам самосвал стоит на открытом узле) — закрытые звенья ему, как и всем
        остальным, недоступны, честно возвращаем None (задача «road_closed-2», цель 1:
        раньше `escape_path` звался при ЛЮБОМ провале `path()`, из-за чего самосвал с
        совершенно открытого узла мог получить маршрут через закрытую дорогу — настоящий
        баг, найденный диагностикой на стенде)."""
        start = truck.node
        path = self.roads.path(start, goal)
        if path is not None:
            truck.evac_until = None
            return path
        if not self.roads.on_closed_segment(start):
            return None
        escape = self.roads.escape_path(start, goal)
        if escape is None:
            return None
        rest = self.roads.path(escape[-1], goal)
        if rest is None:
            return None
        truck.evac_until = escape[-1] if len(escape) > 1 else None
        return escape[:-1] + rest

    def _reroute_or_reassign(self, truck):
        """Путь до текущей цели самосвала с эвакуацией (`_route_from`); если даже так пути
        нет — переназначение цели (задача «road_closed», часть 2): порожний («returning»/
        `travel_kind == "return"`) получает другого экскаватора — «авто» через
        `choose_excavator` (план сам исключает недостижимых), «ручной» — ближайшего
        достижимого той же руды, иначе любого достижимого (`_nearest_reachable_excavator`,
        как и раньше в этой функции); гружёный («hauling»/`travel_kind == "depart"`) — едет
        на ту же точку разгрузки, а если и обходного пути туда нет — на ближайшую ДОСТУПНУЮ
        (другую) точку разгрузки. Возвращает путь (список узлов) или None, если выхода
        действительно нет вообще — само ничего не придумывает."""
        returning = truck.state == "returning" or (truck.travel_pending and truck.travel_kind == "return")
        hauling = truck.state == "hauling" or (truck.travel_pending and truck.travel_kind == "depart")
        if returning:
            path = self._route_from(truck, self.excavators[truck.excavator].node)
            if path is not None:
                return path
            if self.mode == "auto":
                truck.excavator = self.choose_excavator(truck)
                truck.destination = truck.excavator
                return self._route_from(truck, self.excavators[truck.excavator].node)
            home_ore = self.face_info(truck.home)["ore"]
            sub = self._nearest_reachable_excavator(truck, ore=home_ore) or self._nearest_reachable_excavator(truck)
            if sub is None:
                return None
            truck.excavator = sub
            truck.destination = sub
            return self._route_from(truck, self.excavators[sub].node)
        if hauling:
            path = self._route_from(truck, self.dumps[truck.destination].node)
            if path is not None:
                return path
            best_path = None
            for did, dump in self.dumps.items():
                if did == truck.destination:
                    continue
                p = self._route_from(truck, dump.node)
                if p is not None and (best_path is None or len(p) < len(best_path)):
                    best_path = p
                    best_did = did
            if best_path is not None:
                truck.destination = best_did
            return best_path
        if truck.travel_pending and truck.travel_kind in ("refuel", "reserve"):
            return self._route_from(truck, "fuel-station")
        return None

    def _retry_pending_travel(self, truck):
        """truck.travel_pending: дороги к цели не было в момент выезда (road_closed) — самосвал
        ждёт на месте и пробует снова КАЖДЫЙ шаг, не застывая навсегда и не телепортируясь в
        чужую очередь, пока реально не доедет (проверено координатором). Путь и, если нужно,
        переназначение цели — `_reroute_or_reassign` (эвакуация из запертого участка,
        порожний — другой экскаватор, гружёный — обходной путь или ближайшая доступная точка
        разгрузки, см. её докстринг и README, «road_closed»)."""
        path = self._reroute_or_reassign(truck)
        if path is None:
            return
        truck.travel_pending = False
        truck.path = path[1:]
        truck.seg_pos = 0.0

    def _replan_all_for_road_change(self):
        """road_closed только что включился или выключился (вызывается из `read_scenarios`,
        один раз на смену) — для каждого самосвала в пути сразу проверяем, не стал ли его
        ТЕКУЩИЙ остаток маршрута (не только следующее звено — весь путь до цели) непроходимым,
        и если да — пересчитываем СРАЗУ (`_reroute_or_reassign`: эвакуация из запертого
        участка, при необходимости — другой экскаватор/другая точка разгрузки), не дожидаясь,
        пока самосвал физически доедет до разрыва. Самосвалов НА СЕРЕДИНЕ ребра
        (`seg_pos > 0`) здесь не трогаем — за разрыв ПОД КОЛЁСАМИ (следующее звено) каждый
        шаг и честный задний ход уже отвечает `_move()` (он же потом сам вызовет
        `_reroute_or_reassign`, когда довезёт самосвал до узла); менять путь поверх
        недопройденного ребра было бы «прыжком» по сцене. Это — для ЗАРАНЕЕ построенного
        остатка пути, который ещё не дошёл до закрытого звена, но пройдёт через него позже
        (задача «road_closed», часть 2)."""
        for truck in self.trucks:
            if not truck.path or truck.seg_pos > 0:
                continue
            nodes = [truck.node] + truck.path
            blocked = False
            for a, b in zip(nodes, nodes[1:]):
                try:
                    if self.roads.edge(a, b)[2] in self.roads.closed:
                        blocked = True
                        break
                except KeyError:
                    pass
            if not blocked:
                continue
            path = self._reroute_or_reassign(truck)
            if path is None:
                truck.travel_pending = True
                truck.travel_kind = "return" if truck.state == "returning" else "depart" if truck.state == "hauling" else truck.travel_kind
                truck.path = []
                truck.speed = 0.0
                continue
            truck.travel_pending = False
            truck.path = path[1:]
            truck.seg_pos = 0.0

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
            if road in self.roads.closed and truck.evac_until is None:
                # дорога закрылась под колёсами — не телепортируемся ни вперёд, ни назад:
                # если самосвал уже проехал часть ребра (seg_pos > 0), сначала честно
                # возвращаем его по той же дороге к truck.node (тому узлу, который он уже
                # реально проезжал), расходуя настоящие dt и топливо, и только оттуда ищем
                # новый маршрут. Без этого (просто сброс seg_pos=0 и путь от truck.node)
                # самосвал визуально прыгает на расстояние, которое уже проехал по закрытому
                # ребру, — вплоть до сотен метров за один шаг (настоящий баг, найден на
                # проверке road_closed, не только в местах из описания)
                if truck.seg_pos > 0:
                    # едем НАЗАД по тому же ребру — уклон обратный (подъём вперёд = спуск назад)
                    back_grade = -grade
                    v = self._speed(truck, back_grade, road)
                    step = v / 3.6 * dt
                    if step < truck.seg_pos:
                        truck.seg_pos -= step
                        self._place(truck, nxt, truck.seg_pos / length)
                        self._consume_fuel(truck, self._edge_fuel_l(truck, back_grade, step))
                        return
                    dt -= truck.seg_pos / (v / 3.6)
                    self._consume_fuel(truck, self._edge_fuel_l(truck, back_grade, truck.seg_pos))
                    truck.seg_pos = 0.0
                    self._place(truck, truck.node, 1.0)
                path = self._reroute_or_reassign(truck)
                if path is None:
                    # ни эвакуация, ни переназначение не помогли — честно ждём на месте и
                    # пробуем снова каждый шаг (как и раньше), не выдумывая дорогу
                    truck.travel_pending = True
                    truck.travel_kind = "return" if truck.state == "returning" else "depart"
                    truck.path = []
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
            if truck.node == truck.evac_until:
                # доехал до конца эвакуации по закрытой дороге — дальше остаток пути уже
                # честно построен по ОТКРЫТЫМ дорогам (см. _route_from), «разрыв под
                # колёсами» снова можно проверять штатно
                truck.evac_until = None
        if not truck.path:
            truck.speed = 0.0
            self._arrived(truck)

    def _place(self, truck, nxt, frac):
        a, b = self.roads.nodes[truck.node], self.roads.nodes[nxt]
        truck.pos = [a[i] + (b[i] - a[i]) * frac for i in range(3)]
        truck.heading = (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360

    def _arrived(self, truck):
        if truck.state == "hauling":
            # пункт разгрузки сейчас не принимает (crusher_stop/sag_maintenance) — гружёный
            # самосвал всё равно встаёт в очередь у СВОЕГО пункта и ждёт, пока приём не
            # возобновится (проверено координатором); на отвал не переадресуем
            truck.state = "queued_dump"
            truck.timer = 0.0
            truck.dump_wait = 0.0
            self.dumps[truck.destination].queue.append(truck)
        elif truck.state == "returning":
            if truck.destination == "fuel-station":
                if truck.entering_reserve and self.mode == "auto":
                    # приехал встать в резерв (не на дозаправку — та идёт тем же путём, но с
                    # entering_reserve=False, см. _enter_reserve/_start_refuel): контракт
                    # (contract/README.md) — payload=0, cargo_type=none, destination=«»
                    truck.entering_reserve = False
                    truck.state = "reserve"
                    truck.reserve_since_s = self._sim_t
                    truck.payload = 0.0
                    truck.cargo_type = "none"
                    truck.destination = ""
                    truck.speed = 0.0
                elif truck.entering_reserve:
                    # защита (основной путь — _release_all_reserve в step()): mode уже сменился
                    # на «ручной», пока самосвал был в пути к резерву — не паркуем в резерв,
                    # отправляем в работу (баг, найденный при проверке)
                    truck.entering_reserve = False
                    self._return(truck)
                else:
                    truck.state = "refueling"
                    truck.refuel_timer = REFUEL_MODEL_MIN * 60.0
                    truck.speed = 0.0
            else:
                truck.state = "queued_load"
                truck.wait = 0.0
                self.excavators[truck.excavator].queue.append(truck)

    # -- шаг модели ----------------------------------------------------------
    def step(self, dt):
        prev_mode = self.mode
        self.read_scenarios()
        if prev_mode == "auto" and self.mode == "manual":
            self._release_all_reserve()
        self._sim_t += dt
        self._trim_windows()
        self._maybe_update_plan()
        self._target_working_val = self._target_working()  # раз за шаг — см. _reserve_surplus
        self._update_reserve_hysteresis()
        self._check_reserve_exits()
        for ex in self.excavators.values():
            if not self._excavator_cut_off(ex):  # план-долг не копится, пока не обслуживается
                ex.plan_target_cum_t += ex.plan_tph / 3600.0 * dt
        fuel_before = self.fuel_used_l_total
        state_counts = {}
        for truck in self.trucks:
            state_counts[truck.state] = state_counts.get(truck.state, 0) + 1
            if truck.state != "reserve":
                self._consume_fuel(truck, truck.idle_lph * dt / 3600.0)  # холостой ход — пока включён; в резерве двигатель заглушен (расход 0)
            if truck.state == "refueling":
                truck.time_in["refuel"] += dt
                truck.refuel_timer = max(0.0, truck.refuel_timer - dt)
                truck.speed = 0.0
                if truck.refuel_timer == 0.0:
                    truck.fuel = 100.0
                    self.refuels_total += 1
                    truck.destination = ""
                    self._return(truck)  # «авто» — по диспетчеру (может снова уйти в резерв), «ручной» — к своему экскаватору
            elif truck.state == "reserve":
                truck.time_in["reserve"] += dt  # не едет, не грузится, топливо не расходуется (см. выше)
            elif truck.travel_pending:
                bucket = "haul_loaded" if truck.travel_kind == "depart" else "haul_empty"
                truck.time_in[bucket] += dt
                self._retry_pending_travel(truck)
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
        self._shift_reserve_s += dt * state_counts.get("reserve", 0)
        self._fleet_state_log.append((self._sim_t, dt, state_counts, self.fuel_used_l_total - fuel_before))
        for ex in self.excavators.values():
            if ex.loading:
                ex.busy_s += dt
            ex.queue_integral += len(ex.queue) * dt
            self._excavator(ex)
        for dump in self.dumps.values():
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
        while self._fleet_state_log and self._fleet_state_log[0][0] < horizon:
            self._fleet_state_log.popleft()

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

    def _fleet_time_shares(self):
        """Доли модельного времени ПАРКА по состояниям за последний модельный час (то же окно,
        что у avg_wait_*/trips_per_hour) — суммируются
        к 100%, т.к. это полный перебор состояния самосвала из договора, и каждый самосвал
        всегда ровно в одном из них. trucks_needed — среднее число самосвалов, реально занятых
        планом за тот же час (всё, кроме NOT_WORKING_STATES, т.е. loading/hauling/returning/
        dumping) — та же логика, что у fleet_utilization, но усреднённая по часу, а не
        мгновенная. fuel_rate_l_per_s — средний расход топлива (холостой ход + ход) одного
        НЕзарезервированного самосвала за тот же час, л/с — используется для fuel_saved_l_shift
        (формула — см. README, раздел «Резерв самосвалов»)."""
        total_dt = sum(dt for _, dt, _, _ in self._fleet_state_log)
        bucket_s = {k: 0.0 for k in TIME_PCT_FEATURES}
        not_working_s = 0.0
        fuel_s = 0.0
        for _, dt, counts, fuel_delta in self._fleet_state_log:
            fuel_s += fuel_delta
            not_working_s += dt * sum(counts.get(s, 0) for s in NOT_WORKING_STATES)
            for state, n in counts.items():
                key = STATE_TIME_PCT_KEY.get(state)
                if key:
                    bucket_s[key] += n * dt
        fleet_truck_s = max(len(self.trucks) * total_dt, 1e-9)
        pct = {k: 100.0 * v / fleet_truck_s for k, v in bucket_s.items()}
        if total_dt > 0:
            trucks_needed = (len(self.trucks) * total_dt - not_working_s) / total_dt
        else:
            trucks_needed = float(len(self.trucks))
        working_truck_s = max(len(self.trucks) * total_dt - bucket_s["reserve"], 1e-9)
        fuel_rate_l_per_s = fuel_s / working_truck_s
        return pct, trucks_needed, fuel_rate_l_per_s

    # -- публикация ----------------------------------------------------------
    def dispatch_features(self):
        hauling = sum(1 for t in self.trucks if t.state in ("hauling", "returning"))
        not_working = sum(1 for t in self.trucks if t.state in NOT_WORKING_STATES)
        assignments = {t.id: t.excavator for t in self.trucks}
        hours = min(1.0, self._sim_t / WAIT_WINDOW_MODEL_S) if self._sim_t > 0 else 0.0
        window_h = max(hours, 1e-6)
        avg_wait_exc = (sum(v for _, v in self._wait_exc) / len(self._wait_exc)) if self._wait_exc else 0.0
        avg_wait_dump = (sum(v for _, v in self._wait_dump) / len(self._wait_dump)) if self._wait_dump else 0.0
        trips_per_hour = len(self._trips_log) / window_h
        tph = {k: sum(v for _, v in dq) / window_h for k, dq in self._tph_log.items()}
        # "в деле" = не стоит в очереди (ни на погрузке, ни на разгрузке), не заправляется и не
        # в резерве (резервные не считаются работающими, NOT_WORKING_STATES
        # выше) — у грузовиков нет отдельного простоя из-за поломки экскаватора, он уже учтён через
        # queued_load, отдельно вычитать не нужно (было задвоение).
        fleet_utilization = 100.0 * max(0, len(self.trucks) - not_working) / len(self.trucks)
        clay_share = (100.0 * self._clay_crusher_total_clay_t / self._clay_crusher_total_t
                      if self._clay_crusher_total_t > 0 else 0.0)
        time_pct, trucks_needed, fuel_rate_l_per_s = self._fleet_time_shares()
        trucks_reserve = sum(1 for t in self.trucks if t.state == "reserve")
        fuel_saved_l_shift = self._shift_reserve_s * fuel_rate_l_per_s
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
            "trucks_needed": feature(round(trucks_needed, 1), "шт"),
            "trucks_reserve": feature(trucks_reserve, "шт"),
            "fuel_saved_l_shift": feature(round(fuel_saved_l_shift, 1), "л"),
            "time_loading_pct": feature(round(time_pct["loading"], 1), "%"),
            "time_hauling_pct": feature(round(time_pct["hauling"], 1), "%"),
            "time_returning_pct": feature(round(time_pct["returning"], 1), "%"),
            "time_queue_pct": feature(round(time_pct["queue"], 1), "%"),
            "time_dumping_pct": feature(round(time_pct["dumping"], 1), "%"),
            "time_refueling_pct": feature(round(time_pct["refueling"], 1), "%"),
            "time_reserve_pct": feature(round(time_pct["reserve"], 1), "%"),
            "time_down_pct": feature(round(time_pct["down"], 1), "%"),
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


def read_prev_state(ditto, thing_ids):
    """Прежние значения своих накопительных счётчиков из Ditto (договор, §4: «свои счётчики и
    запасы при перезапуске сервиса восстанавливать из текущего состояния своего двойника в
    Ditto, а не начинать с нуля»). Один снимок всех двойников (`ditto.search`, не по одному —
    быстрее и даёт единый бюджет повторов), до 10 попыток с паузой 3 с (задача — «долгое
    восстановление», часть 1). Ditto недоступен или ответ не разобрать — пустой словарь: счётчики
    стартуют с нуля (новый стенд), в журнал пишется предупреждение; никогда не бросает исключение
    дальше, чтобы не ронять старт сервиса из-за недоступности Ditto."""
    try:
        snapshot = ditto.retry(ditto.search, attempts=10, delay=3)
    except Exception as exc:  # noqa: BLE001 — недоступен, нет пароля, неверный ответ — всё равно стартуем
        log.warning("прежнее состояние из Ditto не прочитано (%s) — счётчики начинаются с нуля", exc)
        return {}
    prev = {}
    try:
        for name in thing_ids:
            item = snapshot.get(f"{NAMESPACE}:{name}") if isinstance(snapshot, dict) else None
            feats = item.get("features") if isinstance(item, dict) else None
            if not isinstance(feats, dict):
                continue
            vals = {}
            for fname, feat_val in feats.items():
                props = feat_val.get("properties") if isinstance(feat_val, dict) else None
                if isinstance(props, dict) and props.get("value") is not None:
                    vals[fname] = props["value"]
            if vals:
                prev[name] = vals
    except Exception as exc:  # noqa: BLE001 — ответ неожиданной формы — всё равно стартуем
        log.warning("ответ Ditto не разобран (%s) — счётчики начинаются с нуля", exc)
        return {}
    return prev


def restore_counters(model, prev):
    """Применить прежние значения счётчиков (см. `read_prev_state`) к только что созданной модели,
    ДО первого такта. Восстанавливаются ровно те признаки, что только растут и принадлежат нам
    (договор §4 + свои, не упомянутые в таблице явно, но накопительные): у `dispatch` —
    delivered_crusher_t/_cu_t, delivered_clay_t/_cu_t, delivered_dump_t, trips_total,
    fuel_used_l, refuels_total; у каждого excavator-NN — loaded_total, passes_total; у каждого
    truck-NN — trips_total; у dump-waste-1 — received_total. `fuel_used_l`/`refuels_total`
    раньше в списке не было (настоящий недочёт, найденный проверкой restart — после перезапуска
    сбрасывались в 0, хотя растут всю смену так же, как остальные счётчики, задача
    «road_closed-2», цель 3). Остальные признаки (состояния, очереди, координаты) не
    накопительные — пересчитываются с нуля каждый такт, восстанавливать их не нужно и не нужно
    по договору."""
    restored = []
    d = prev.get("dispatch")
    if d:
        pairs = (("delivered_crusher_t", "crusher-01", 0), ("delivered_crusher_cu_t", "crusher-01", 1),
                 ("delivered_clay_t", "stockpile-clay", 0), ("delivered_clay_cu_t", "stockpile-clay", 1),
                 ("delivered_dump_t", "dump-waste-1", 0))
        for fname, dump_id, idx in pairs:
            if fname in d:
                model.delivered[dump_id][idx] = float(d[fname])
                restored.append(f"dispatch.{fname}")
        if "trips_total" in d:
            model.trips = int(d["trips_total"])
            restored.append("dispatch.trips_total")
        if "fuel_used_l" in d:
            model.fuel_used_l_total = float(d["fuel_used_l"])
            restored.append("dispatch.fuel_used_l")
        if "refuels_total" in d:
            model.refuels_total = int(d["refuels_total"])
            restored.append("dispatch.refuels_total")
    dw = prev.get("dump-waste-1")
    if dw and "received_total" in dw:
        model.dumps["dump-waste-1"].received = float(dw["received_total"])
        restored.append("dump-waste-1.received_total")
    for ex in model.excavators.values():
        e = prev.get(ex.id)
        if not e:
            continue
        if "loaded_total" in e:
            ex.loaded_total = float(e["loaded_total"])
            restored.append(f"{ex.id}.loaded_total")
        if "passes_total" in e:
            ex.passes_total = int(e["passes_total"])
            restored.append(f"{ex.id}.passes_total")
    for truck in model.trucks:
        t = prev.get(truck.id)
        if t and "trips_total" in t:
            truck.trips = int(t["trips_total"])
            restored.append(f"{truck.id}.trips_total")
    return restored


def main():
    with open("geometry.json", encoding="utf-8") as f:
        geometry = json.load(f)
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios", "mine", "crusher-01", "stockpile-clay"}
                          | {f"face-0{i}" for i in range(1, 7)}, client_id="bz-haulage-watch").start()
    telemetry = Telemetry(client_id="bz-haulage").connect()
    clock = SimClock()
    model = Haulage(geometry, watcher, clock)
    own_ids = ["dispatch", "dump-waste-1"] + [ex_id for ex_id in model.excavators] + [t.id for t in model.trucks]
    restored = restore_counters(model, read_prev_state(ditto, own_ids))
    if restored:
        log.info("счётчики восстановлены из Ditto (%d признаков): %s", len(restored), ", ".join(restored))
    else:
        log.warning("прежних значений счётчиков в Ditto не найдено — начинаем с нуля (новый стенд или Ditto недоступен)")
    # план-долг (_committed_tons) должен начинать считать с нуля в рамках ТЕКУЩЕГО запуска
    # диспетчера, даже если loaded_total восстановлен из Ditto с большим накопленным значением —
    # см. docstring _committed_tons
    model._committed_baseline = {ex.id: ex.loaded_total for ex in model.excavators.values()}
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
