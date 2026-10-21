"""Буровые станки: цикл «скважина → переезд → следующая скважина», MWD и подготовка блоков к взрыву.

Любой станок может бурить любой забой (общий пул): берёт блок панели забоя, у которого взорванного запаса
перед экскаватором меньше целевого (в часах работы экскаватора), бурит по сетке проекта (руда — мелкая
сетка, вскрыша — крупная), и когда блок добурен — он «взрывается»: блоку присваиваются крепость
(по измерениям MWD) и P80 (модель Кузнецова–Рамлера).
"""
import math

import blasting as bl

BLOCK_XY = bl.BLOCK_XY
UTIL_TAU_S = 6 * 3600.0     # постоянная времени сглаживания загрузки станка, модельных секунд
AHEAD_TARGET_H = 72.0       # взорванный запас, который держит станок, часов работы экскаватора
HOLE_MOVE_S = 120.0         # переезд между скважинами одного блока, модельных секунд
TRAM_KMH = 3.0              # скорость переезда станка между блоками (допущение), км/ч
ROP_NOISE = 0.04            # разброс скорости бурения от скважины к скважине
MWD_NOISE = 0.05            # шум измерения крепости по MWD (относительный)
SPEED_FACTORS = (0.92, 1.00, 1.12, 0.96, 1.06)       # у каждого станка своя скорость (износ, оператор)
START_PHASES = (("drilling", 0.30), ("moving", 0.60), ("drilling", 0.80), ("moving", 0.25), ("drilling", 0.55))   # сдвиг фазы на старте


def hole_offsets(kind):
    """Положения скважин в блоке (смещение от центра, м): сетка по B × S, всего holes_per_block скважин."""
    d = bl.design(kind)
    per_block = bl.holes_per_block(kind)
    nx = max(1, round(BLOCK_XY / d["spacing"]))
    ny = max(1, math.ceil(per_block / nx))
    pts = [((i + 0.5) / nx - 0.5, (j + 0.5) / ny - 0.5) for j in range(ny) for i in range(nx)]
    return [(px * BLOCK_XY, py * BLOCK_XY) for px, py in pts][:per_block]


class Drill:
    def __init__(self, thing_id, geometry, model, rng, index):
        self.id = thing_id.split(":")[1]
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.pos = list(obj["position"])
        self.model, self.rng = model, rng
        self.speed_factor = SPEED_FACTORS[index % len(SPEED_FACTORS)]
        self.faces = []
        self.kind = "ore"               # проект текущего блока
        self.per_block = bl.holes_per_block("ore")
        self.offsets = hole_offsets("ore")
        self.meters = 0.0
        self.holes = 0
        self.state = "idle"
        self.depth = 0.0                # глубина текущей скважины, м
        self.holes_in_block = 0
        self.block_ready = False
        self.block_name = ""
        self.rop = 0.0                  # текущая механическая скорость бурения, м/ч
        self.f_mwd = 0.0                # последнее измеренное значение крепости
        self.f_samples = []             # измерения по скважинам текущего блока
        self.target = None              # (face, индекс блока в панели, панель)
        self.move_from = self.move_to = None
        self.move_left = self.move_total = 0.0
        self.phase = START_PHASES[index % len(START_PHASES)]
        self.first = True
        self.busy_s = 0.0               # модельных секунд в работе (бурение и переезды) — для баланса
        self.total_s = 0.0
        self.util = 0.0                 # загрузка станка: скользящее среднее доли времени в работе (постоянная времени UTIL_TAU_S)
        self.block_busy_s = 0.0         # время в работе на текущем блоке
        # производительность станка, т/ч взорванной породы: начальная — расчёт для рудного блока, затем по факту блоков
        self.rates = {"ore": self._initial_rate("ore", bl.F_REF), "waste": self._initial_rate("waste", 14.0)}   # т/ч по типам работ

    def _initial_rate(self, kind, f):
        """Производительность по расчёту для блока типа kind и крепости f, т/ч (с переездом на блок ~12 мин)."""
        per = bl.holes_per_block(kind)
        rop = bl.rop_from_hardness(f) * self.speed_factor
        hours = per * (bl.hole_depth(kind) / rop + HOLE_MOVE_S / 3600.0) + 0.2
        return self.model.block_vol * (bl.DENS_REF if kind == "ore" else 2.65) / hours

    # -- выбор работы ----------------------------------------------------------------
    def _pick(self):
        """Выбирает работу: забои по возрастанию запаса впереди; берём первый, где ещё есть что бурить."""
        needy = []
        for face in self.faces:
            ahead = face.ahead_with_pending_h()
            if ahead < AHEAD_TARGET_H:
                needy.append((ahead, face.id, face))
        needy.sort(key=lambda x: (x[0], x[1]))
        for _, _, face in needy:
            j = face.next_to_blast()
            if j is None:
                continue
            panel = face.panel
            panel.reserved.add(j)
            self.target = (face, j, panel)
            self.holes_in_block, self.f_samples, self.block_ready = 0, [], False
            self.block_busy_s = 0.0
            kind = self.model.kind_of(panel.blocks[j])
            self.kind = "waste" if kind == "waste" else "ore"
            self.per_block = bl.holes_per_block(self.kind)
            self.offsets = hole_offsets(self.kind)
            self.block_name = "Б%d-%s-%d" % (panel.level + 1, face.id[-2:], j + 1)
            self._start_move(self._hole_pos(0), travel=True)
            return True
        return False

    def _hole_pos(self, k):
        face, j, panel = self.target
        cx, cy, cz = self.model.center(panel.level, panel.blocks[j])
        dx, dy = self.offsets[k % len(self.offsets)]
        return [cx + dx, cy + dy, cz + self.model.bench_h / 2.0]      # на поверхности уступа

    def _start_move(self, dest, travel):
        self.move_from, self.move_to = list(self.pos), dest
        dist = math.dist(self.pos[:2], dest[:2])
        self.move_total = max(HOLE_MOVE_S, dist / (TRAM_KMH * 1000.0 / 3600.0)) if travel else HOLE_MOVE_S
        self.move_left = self.move_total
        self.state = "moving"
        self.rop = 0.0

    def _begin_hole(self):
        face, j, panel = self.target
        f_true = self.model.hard[panel.blocks[j]]
        base = bl.rop_from_hardness(f_true) * self.speed_factor
        self.rop = base * (1.0 + self.rng.gauss(0.0, ROP_NOISE))
        # MWD: станок крепость не знает — выводит её из скорости бурения (с поправкой на свой коэффициент) и шумит
        self.f_mwd = bl.hardness_from_rop(self.rop / self.speed_factor) * (1.0 + self.rng.gauss(0.0, MWD_NOISE))
        self.depth = 0.0
        self.state = "drilling"

    def _finish_block(self):
        face, j, panel = self.target
        f_block = sum(self.f_samples) / len(self.f_samples)
        face.blast(panel, j, f_block)                # блок взорван: крепость (MWD) и P80
        if self.block_busy_s > 60.0:                 # фактическая производительность по этому блоку, отдельно для руды и вскрыши
            inst = self.model.tonnes(panel.blocks[j]) / (self.block_busy_s / 3600.0)
            self.rates[self.kind] = 0.8 * self.rates[self.kind] + 0.2 * inst
        panel.reserved.discard(j)
        self.block_ready = True
        self.target = None
        self.state = "idle"
        self.rop = 0.0

    def _abandon(self):
        """Забой перешёл на новую панель, пока станок бурил блок старой: бросаем его и берём новую работу."""
        face, j, panel = self.target
        panel.reserved.discard(j)
        self.target = None
        self.state = "idle"
        self.rop = 0.0
        self.holes_in_block, self.f_samples = 0, []

    # -- шаг модели ----------------------------------------------------------------------
    def step(self, dt):
        busy0 = self.busy_s
        self._step(dt)
        used = self.busy_s - busy0
        self.block_busy_s += used
        alpha = 1.0 - math.exp(-dt / UTIL_TAU_S)
        self.util += alpha * (min(1.0, used / dt if dt > 0 else 0.0) - self.util)

    def _step(self, dt):
        if self.first:
            self.first = False
            if self._pick():
                kind, frac = self.phase
                if kind == "moving":
                    self.move_left = self.move_total * (1.0 - frac)
                else:                                  # сразу «в скважине» с долей глубины
                    self.pos = self.move_to
                    self._begin_hole()
                    self.depth = frac * bl.hole_depth(self.kind)
        self.total_s += dt
        guard = 0
        while dt > 1e-6 and guard < 2000:
            guard += 1
            if self.target is not None and self.target[0].panel is not self.target[2]:
                self._abandon()
            if self.state == "idle":
                if not self._pick():
                    return
            elif self.state == "moving":
                use = min(dt, self.move_left)
                self.move_left -= use
                self.busy_s += use
                dt -= use
                k = 1.0 - self.move_left / self.move_total if self.move_total else 1.0
                self.pos = [a + (b - a) * k for a, b in zip(self.move_from, self.move_to)]
                if self.move_left <= 1e-6:
                    self.pos = list(self.move_to)
                    self._begin_hole()
            elif self.state == "drilling":
                depth_full = bl.hole_depth(self.kind)
                left = depth_full - self.depth
                need = left / self.rop * 3600.0
                use = min(dt, need)
                drilled = self.rop * use / 3600.0
                self.depth += drilled
                self.meters += drilled
                self.busy_s += use
                dt -= use
                if self.depth >= depth_full - 1e-6:
                    self.depth = depth_full
                    self.holes += 1
                    self.holes_in_block += 1
                    self.f_samples.append(self.f_mwd)
                    if self.holes_in_block >= self.per_block:
                        self._finish_block()
                    else:
                        self._start_move(self._hole_pos(self.holes_in_block), travel=False)

    def features(self):
        from bzlib import feature
        return {
            "state": feature(self.state), "x": feature(round(self.pos[0], 1), "м"),
            "y": feature(round(self.pos[1], 1), "м"), "z": feature(round(self.pos[2], 1), "м"),
            "block": feature(self.block_name), "meters_total": feature(round(self.meters, 1), "м"),
            "holes_total": feature(self.holes, "шт"),
            "penetration_rate": feature(round(self.rop if self.state == "drilling" else 0.0, 1), "м/ч"),
            "rock_hardness_mwd": feature(round(self.f_mwd, 1), "ед. Протодьяконова"),
            "hole_depth_m": feature(round(self.depth, 1), "м"),
            "holes_in_block": feature(self.holes_in_block, "шт"),
            "block_ready": feature(self.block_ready),
        }
