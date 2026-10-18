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
SPEED_VARIANCE = (0.95, 1.05)         # разброс скорости ±5 %

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
DISPATCH_AVG_SPEED_KMH = 25.0 # допущение: средняя скорость для оценки времени пути при выборе экскаватора
                               # (сам ход считается по формуле мощности — это только эвристика диспетчера)


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

    def path_length_m(self, start, goal):
        """Длина кратчайшего пути в метрах (без утяжеления) — для оценки времени в пути диспетчером."""
        path = self.path(start, goal)
        if path is None:
            return None
        total = 0.0
        for a, b in zip(path, path[1:]):
            length, _grade, _road = self.edge(a, b)
            total += length
        return total

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
        self.fuel = random.uniform(60, 100)
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


# ------------------------------------------------------------------ модель
class Haulage:
    def __init__(self, geometry, watcher, clock):
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
        self.rng = random.Random(42)
        self.clay_limit_pct = 15.0
        self.fuel_used_l_total = 0.0
        self.refuels_total = 0
        # скользящие окна за последний модельный час для сверки (деque из (sim_time_s, значение))
        self._wait_exc = deque()     # (t, минуты ожидания у экскаватора)
        self._wait_dump = deque()    # (t, минуты ожидания на разгрузке)
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

    def _expected_wait_s(self, ex, travel_s):
        """Ожидаемое ожидание у экскаватора: сколько он будет занят тем, что уже стоит у него
        или едет к нему, за вычетом времени нашего пути туда (не меньше 0)."""
        total = 0.0
        if ex.loading:
            total += self._truck_load_time_s(ex.loading)
        for t in ex.queue:
            total += self._truck_load_time_s(t)
        for t in self.trucks:
            if t is ex.loading or t in ex.queue:
                continue
            if t.state == "returning" and t.destination == ex.id:
                total += self._truck_load_time_s(t)
        return max(0.0, total - travel_s)

    def choose_excavator(self, truck):
        home = self.excavators[truck.home]
        if self.mode == "manual":
            # закреплённое распределение; если домашний сломан — просто ждём у него (п.1 части 4)
            return home.id
        target_ore = self._candidate_ore(truck)
        # (в) доля глины на дробилке близка к лимиту — не грузить на неё ещё более глинистые забои
        near_clay_limit = (
            target_ore == "sulphide" and self._clay_crusher_total_t > 0 and self.clay_limit_pct > 0
            and (100.0 * self._clay_crusher_total_clay_t / self._clay_crusher_total_t)
                >= CLAY_SOFT_FACTOR * self.clay_limit_pct
        )
        best, best_score = None, math.inf
        for ex in self.excavators.values():
            if ex.down:
                continue
            info = self.face_info(ex.id)
            if info["ore"] != target_ore:
                continue
            if near_clay_limit and info["clay"] > self.clay_limit_pct:
                continue
            length_m = self.roads.path_length_m(truck.node, ex.node)
            if length_m is None:
                continue
            travel_s = length_m / (DISPATCH_AVG_SPEED_KMH / 3.6)
            score = travel_s + self._expected_wait_s(ex, travel_s)
            if score < best_score:
                best, best_score = ex.id, score
        if best:
            return best
        # ничего не подошло (например, все экскаваторы нужной руды сломаны) — домашний как раньше,
        # а если и он сломан — любой работающий, лишь бы самосвал не завис совсем
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
    def _speed(self, truck, grade_pct, road):
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
        v_kmh = min(v_kmh, truck.top_speed_loaded_kmh, self.roads.limits.get(road, 50), self.speed_limit)
        return v_kmh * self.rng.uniform(*SPEED_VARIANCE)

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
            truck.state = "queued_dump"
            truck.timer = 0.0
            truck.dump_wait = 0.0
            self.dumps[truck.destination].queue.append(truck)
        elif truck.state == "returning":
            truck.state = "queued_load"
            truck.wait = 0.0
            self.excavators[truck.excavator].queue.append(truck)

    # -- шаг модели ----------------------------------------------------------
    def step(self, dt):
        self.read_scenarios()
        self._sim_t += dt
        self._trim_windows()
        for truck in self.trucks:
            self._consume_fuel(truck, truck.idle_lph * dt / 3600.0)   # холостой ход — всегда, пока включён
            if truck.refuel_timer > 0:
                truck.refuel_timer = max(0.0, truck.refuel_timer - dt)
                truck.speed = 0.0
                if truck.refuel_timer == 0.0:
                    truck.fuel = 100.0
                    self.refuels_total += 1
                    truck.destination = ""
                    self._return(truck)
            elif truck.state in ("hauling", "returning"):
                self._move(truck, dt)
            elif truck.state == "queued_load":
                truck.wait += dt
            elif truck.state == "queued_dump":
                truck.dump_wait += dt
            elif truck.state == "loading":
                self._loading(truck, dt)
            elif truck.state == "dumping":
                self._dumping(truck, dt)
        for ex in self.excavators.values():
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
        if ex.loading is None and ex.queue:
            truck = ex.queue.pop(0)
            ex.loading = truck
            truck.state = "loading"
            truck.timer = 0.0
            truck.setup_done = False
            truck.buckets_done = 0
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
            if truck.timer < LOAD_SETUP_S:
                return
            truck.timer -= LOAD_SETUP_S
            truck.setup_done = True
        cycle = BUCKET_CYCLE_S / info["factor"]
        while truck.timer >= cycle and truck.buckets_done < truck.buckets_needed:
            truck.timer -= cycle
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
            ex.loading = None
            self._depart(truck)

    def _dump_point(self, dump):
        if dump.dumping is None and dump.queue and dump.accepting:
            truck = dump.queue.pop(0)
            dump.dumping = truck
            truck.state = "dumping"
            truck.timer = 0.0
            self._wait_dump.append((self._sim_t, truck.dump_wait / 60.0))

    def _dumping(self, truck, dt):
        dump = self.dumps[truck.destination]
        truck.timer += dt
        if truck.timer >= DUMP_S:
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
        down = sum(1 for t in self.trucks if self.excavators.get(t.excavator) and self.excavators[t.excavator].down
                   and t.state == "queued_load")
        assignments = {t.id: t.excavator for t in self.trucks}
        hours = min(1.0, self._sim_t / WAIT_WINDOW_MODEL_S) if self._sim_t > 0 else 0.0
        window_h = max(hours, 1e-6)
        avg_wait_exc = (sum(v for _, v in self._wait_exc) / len(self._wait_exc)) if self._wait_exc else 0.0
        avg_wait_dump = (sum(v for _, v in self._wait_dump) / len(self._wait_dump)) if self._wait_dump else 0.0
        trips_per_hour = len(self._trips_log) / window_h
        tph = {k: sum(v for _, v in dq) / window_h for k, dq in self._tph_log.items()}
        not_down_or_queued_issue = len(self.trucks) - queued - down
        fleet_utilization = 100.0 * max(0, not_down_or_queued_issue) / len(self.trucks)
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
