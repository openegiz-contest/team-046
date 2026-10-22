"""Синтетическая блочная модель карьера Бозшаколь (модуль geology, участник №3).

Блоки 25 × 25 × 15 м внутри контура карьера из core/geometry.json. Поля блока хранятся
в array('f') — по одному массиву на поле, без объектов на блок. Модель детерминирована:
зерно шума — константа SEED, одинаковая при каждом запуске. Numpy не нужен.

Устройство: этап 1 (build_fields) считает стандартизованные поля шума и тренды — он не
зависит от калибруемых параметров; этап 2 (finalize) переводит их в содержание Cu, Au, глины,
крепость, плотность и тип руды по параметрам CAL. Калибровка (tools/calibrate.py) подбирает CAL
так, чтобы средние по модели сошлись с фактом 2025 года; числа вписаны ниже.
"""
import math
from array import array

SEED = 20251
BLOCK_XY = 25.0          # м, сторона блока в плане
CUTOFF_CU = 0.20         # % Cu, бортовое содержание (допущение, ЗАФИКСИРОВАНО)
CLAY_LIMIT = 30.0        # % глины, порог глинистой руды (допущение, согласовано с №2 и №4)

WASTE, CLAY, SULPHIDE = 0, 1, 2
ORE_NAME = {WASTE: "waste", CLAY: "clay", SULPHIDE: "sulphide"}
DENSITY = {WASTE: 2.65, CLAY: 2.2, SULPHIDE: 2.7}            # т/м³
DESTINATION = {WASTE: "dump-waste-1", CLAY: "stockpile-clay", SULPHIDE: "crusher-01"}
HARD_CENTER = {WASTE: 14.0, CLAY: 4.5, SULPHIDE: 11.0}       # ед. Протодьяконова f
HARD_RANGE = {WASTE: (12.0, 16.0), CLAY: (3.0, 6.0), SULPHIDE: (9.0, 13.0)}

# Тренды в «сигмах» логарифма содержания: центр залежи богаче края, с глубиной богаче;
# у забоев из geometry.json — локальные аномалии (руда у рудных забоев, вскрыша у вскрышных).
BUMP_AMP = {"sulphide": 0.0, "clay": -0.3, "waste": -2.4}
BUMP_SIGMA_H = 450.0     # м
BUMP_SIGMA_Z = 45.0      # м
CLAY_ZONE_SIGMA_H = 250.0
CLAY_ZONE_SIGMA_Z = 60.0
CLAY_ZONE_AMP = 50.0     # % глины в центре зоны глинизации (у забоя с ore_type clay)
CLAY_BASE = 5.0          # % глины в глубине залежи
CLAY_NOISE = 2.5
CLAY_WEATHER_DEPTH = 60.0  # м, на какой глубине выветривание затухает в e раз
# Сжатие верхнего хвоста распределения меди: выше CU_SOFT содержание плавно прижимается к CU_MAX
# (богатые «гнёзда» в порфировых рудах редки и ограничены), максимум по модели < CU_MAX.
CU_SOFT = 0.45           # % Cu, с этого значения начинается сжатие
CU_MAX = 1.0             # % Cu, предел
# Выветрелая глинистая часть залежи обеднена: медь частично вынесена. Множитель на содержание Cu
# падает линейно от 1,0 при нулевой глине до 1 − CLAY_CU_LOSS при глине CLAY_CU_FULL % и выше.
CLAY_CU_LOSS = 0.4
CLAY_CU_FULL = 60.0
AU_PER_CU = 0.30         # г/т на 1 % Cu (порфировое Cu-Au: золото следует за медью)
AU_NOISE = 0.03

# Калибровка (tools/calibrate.py). Среднее по рудным блокам Cu 0,39 %, Au 0,19 г/т,
# глинистая руда 17,5 % рудного тоннажа, вскрыша/руда 0,67 т/т.
CAL = {"mu": -0.99487, "sigma": 0.52098, "clay_surf": 51.51512, "c_au": 0.07304}


class _Noise:
    """Гладкий шум: значения на редкой решётке, трилинейная интерполяция со сглаживанием."""

    def __init__(self, seed, step_xy, step_z):
        self.seed, self.sx, self.sz = seed, step_xy, step_z
        self.cache = {}

    def _lat(self, i, j, k):
        key = (i, j, k)
        v = self.cache.get(key)
        if v is None:
            n = (i * 374761393 + j * 668265263 + k * 2147483629 + self.seed * 1274126177) & 0xFFFFFFFF
            n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
            n ^= n >> 16
            v = (n / 4294967295.0 * 2.0 - 1.0) * 1.7320508
            self.cache[key] = v
        return v

    def __call__(self, x, y, z):
        fx, fy, fz = x / self.sx, y / self.sx, z / self.sz
        i, j, k = math.floor(fx), math.floor(fy), math.floor(fz)
        tx, ty, tz = fx - i, fy - j, fz - k
        tx, ty, tz = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty), tz * tz * (3 - 2 * tz)
        L = self._lat
        c00 = L(i, j, k) * (1 - tx) + L(i + 1, j, k) * tx
        c10 = L(i, j + 1, k) * (1 - tx) + L(i + 1, j + 1, k) * tx
        c01 = L(i, j, k + 1) * (1 - tx) + L(i + 1, j, k + 1) * tx
        c11 = L(i, j + 1, k + 1) * (1 - tx) + L(i + 1, j + 1, k + 1) * tx
        return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz


def _standardize(arr):
    n = len(arr)
    mean = sum(arr) / n
    var = sum((v - mean) ** 2 for v in arr) / n
    sd = math.sqrt(var) or 1.0
    for i in range(n):
        arr[i] = (arr[i] - mean) / sd


class BlockModel:
    def __init__(self, geometry, cal=None):
        pit = geometry["pit"]
        self.a0, self.b0 = pit["semi_axes_top"]
        self.bench_h = float(pit["bench_height"])
        self.levels = int(pit["bench_count"])
        self.inset = float(pit["inset_per_bench"])
        self.block_vol = BLOCK_XY * BLOCK_XY * self.bench_h
        self.cal = dict(CAL if cal is None else cal)
        self.rows = []         # по уступам: список (iy, ix_min, ix_max, offset)
        self.row_index = []    # по уступам: iy_min
        self._layout()
        n = self.count
        self.cu, self.au, self.clay = (array("f", bytes(4 * n)) for _ in range(3))
        self.hard, self.dens = (array("f", bytes(4 * n)) for _ in range(2))
        self.typ = array("b", bytes(n))
        self._build_fields(geometry)
        self.finalize()

    # -- геометрия сетки -----------------------------------------------------
    def level_axes(self, k):
        """Полуоси контура уступа k (0 — верхний): блоки добываются до дна уступа k+1."""
        return self.a0 - (k + 1) * self.inset, self.b0 - (k + 1) * self.inset

    def _layout(self):
        offset = 0
        for k in range(self.levels):
            a, b = self.level_axes(k)
            iy0, iy1 = math.floor(-b / BLOCK_XY), math.ceil(b / BLOCK_XY) - 1
            rows = []
            for iy in range(iy0, iy1 + 1):
                cy = (iy + 0.5) * BLOCK_XY
                if abs(cy) >= b:
                    rows.append((iy, 0, -1, offset))
                    continue
                w = a * math.sqrt(1.0 - (cy / b) ** 2)
                ix0, ix1 = math.ceil(-w / BLOCK_XY - 0.5), math.floor(w / BLOCK_XY - 0.5)
                rows.append((iy, ix0, ix1, offset))
                offset += max(0, ix1 - ix0 + 1)
            self.rows.append(rows)
            self.row_index.append(iy0)
        self.count = offset

    def level_of(self, z):
        """Номер уступа по высоте точки (дно карьера −200 м относится к нижнему уступу)."""
        k = math.ceil(-z / self.bench_h - 1e-9) - 1
        return max(0, min(self.levels - 1, k))

    def locate(self, k, x, y):
        """Индекс ближайшего к (x, y) блока уступа k."""
        rows = self.rows[k]
        iy = math.floor(y / BLOCK_XY)
        r = rows[max(0, min(len(rows) - 1, iy - self.row_index[k]))]
        # ближайшая непустая строка
        if r[2] < r[1]:
            best = None
            for rr in rows:
                if rr[2] >= rr[1] and (best is None or abs(rr[0] - iy) < abs(best[0] - iy)):
                    best = rr
            r = best
        ix = max(r[1], min(r[2], math.floor(x / BLOCK_XY)))
        return r[3] + ix - r[1]

    def center(self, k, idx):
        """Центр блока (x, y, z) по индексу на уступе k."""
        rows = self.rows[k]
        lo, hi = 0, len(rows) - 1
        while lo < hi:                      # последняя строка с offset <= idx и непустая
            mid = (lo + hi + 1) // 2
            if rows[mid][3] <= idx:
                lo = mid
            else:
                hi = mid - 1
        iy, ix0, ix1, off = rows[lo]
        while ix1 < ix0 or off > idx:       # на всякий случай пропускаем пустые строки
            lo -= 1
            iy, ix0, ix1, off = rows[lo]
        ix = ix0 + idx - off
        return (ix + 0.5) * BLOCK_XY, (iy + 0.5) * BLOCK_XY, -(k + 0.5) * self.bench_h

    def level_range(self, k):
        start = self.rows[k][0][3]
        end = self.rows[k + 1][0][3] if k + 1 < self.levels else self.count
        return start, end

    # -- этап 1: поля шума и тренды ---------------------------------------------
    def _build_fields(self, geometry):
        n = self.count
        faces = [(o["position"], o.get("ore_type", "waste")) for o in geometry["objects"] if o.get("kind") == "face"]
        n_cu1, n_cu2 = _Noise(SEED + 1, 100.0, 60.0), _Noise(SEED + 2, 45.0, 30.0)
        n_au = _Noise(SEED + 3, 60.0, 45.0)
        n_cl1, n_cl2 = _Noise(SEED + 4, 100.0, 60.0), _Noise(SEED + 5, 45.0, 30.0)
        n_h = _Noise(SEED + 6, 80.0, 60.0)
        n_cu, n_cl = array("f", bytes(4 * n)), array("f", bytes(4 * n))
        self.z_au, self.z_h = array("f", bytes(4 * n)), array("f", bytes(4 * n))
        self.trend_cu, self.zone = array("f", bytes(4 * n)), array("f", bytes(4 * n))
        self.depth = array("f", bytes(4 * n))
        clay_faces = [p for p, ore in faces if ore == "clay"]
        for k in range(self.levels):
            zc = -(k + 0.5) * self.bench_h
            df = (k + 0.5) / self.levels
            for iy, ix0, ix1, off in self.rows[k]:
                y = (iy + 0.5) * BLOCK_XY
                for ix in range(ix0, ix1 + 1):
                    x = (ix + 0.5) * BLOCK_XY
                    i = off + ix - ix0
                    n_cu[i] = n_cu1(x, y, zc) + 0.45 * n_cu2(x, y, zc)
                    n_cl[i] = n_cl1(x, y, zc) + 0.45 * n_cl2(x, y, zc)
                    self.z_au[i] = n_au(x, y, zc)
                    self.z_h[i] = n_h(x, y, zc)
                    rn = math.sqrt((x / self.a0) ** 2 + (y / self.b0) ** 2)
                    t = 0.9 * (0.55 - rn) + 0.8 * (df - 0.5)
                    for (fx, fy, fz), ore in faces:
                        dz = zc - fz
                        t += BUMP_AMP.get(ore, 0.0) * math.exp(
                            -((x - fx) ** 2 + (y - fy) ** 2) / (2 * BUMP_SIGMA_H ** 2) - dz * dz / (2 * BUMP_SIGMA_Z ** 2))
                    self.trend_cu[i] = t
                    z = 0.0
                    for fx, fy, fz in clay_faces:
                        dz = zc - fz
                        z += math.exp(-((x - fx) ** 2 + (y - fy) ** 2) / (2 * CLAY_ZONE_SIGMA_H ** 2)
                                      - dz * dz / (2 * CLAY_ZONE_SIGMA_Z ** 2))
                    self.zone[i] = z
                    self.depth[i] = -zc
        for arr in (n_cu, n_cl, self.z_au, self.z_h):
            _standardize(arr)
        self.zc = array("f", (n_cu[i] + self.trend_cu[i] for i in range(n)))
        self.zcl = n_cl
        del n_cu, self.trend_cu

    # -- этап 2: параметры калибровки -> поля блоков -------------------------------------
    def finalize(self, cal=None):
        if cal is not None:
            self.cal = dict(cal)
        mu, sigma, surf, c_au = (self.cal[k] for k in ("mu", "sigma", "clay_surf", "c_au"))
        cu, au, clay, hard, dens, typ = self.cu, self.au, self.clay, self.hard, self.dens, self.typ
        for i in range(self.count):
            c = math.exp(mu + sigma * self.zc[i])
            if c > CU_SOFT:
                span = CU_MAX - CU_SOFT
                c = CU_SOFT + span * (1.0 - math.exp(-(c - CU_SOFT) / span))
            cl = CLAY_BASE + CLAY_NOISE * self.zcl[i] + surf * math.exp(-self.depth[i] / CLAY_WEATHER_DEPTH) \
                + CLAY_ZONE_AMP * self.zone[i]
            cl = min(90.0, max(0.5, cl))
            c = max(0.005, c * (1.0 - CLAY_CU_LOSS * min(1.0, cl / CLAY_CU_FULL)))   # глина → беднее
            g = max(0.01, AU_PER_CU * c + c_au + AU_NOISE * self.z_au[i])
            t = WASTE if c < CUTOFF_CU else (CLAY if cl >= CLAY_LIMIT else SULPHIDE)
            lo, hi = HARD_RANGE[t]
            cu[i], au[i], clay[i], typ[i] = c, g, cl, t
            hard[i] = min(hi, max(lo, HARD_CENTER[t] + 1.0 * self.z_h[i]))
            dens[i] = DENSITY[t]

    def drop_fields(self):
        """Освободить поля этапа 1: сервису после калибровки они не нужны (экономия памяти)."""
        for name in ("zc", "zcl", "z_au", "z_h", "zone", "depth"):
            setattr(self, name, None)

    def kind_of(self, i):
        """Тип блока строкой: waste / clay / sulphide."""
        return ORE_NAME[self.typ[i]]

    def tonnes(self, i):
        return self.block_vol * self.dens[i]

    def stats(self):
        """Средние по модели (взвешены тоннажем) — для калибровки и отчёта."""
        t_ore = t_waste = t_clay = cu_t = au_t = 0.0
        for i in range(self.count):
            t = self.block_vol * self.dens[i]
            if self.typ[i] == WASTE:
                t_waste += t
                continue
            t_ore += t
            cu_t += self.cu[i] * t
            au_t += self.au[i] * t
            if self.typ[i] == CLAY:
                t_clay += t
        ore_cu = sorted(self.cu[i] for i in range(self.count) if self.typ[i] != WASTE)
        pct = lambda q: ore_cu[min(len(ore_cu) - 1, int(q / 100.0 * len(ore_cu)))]
        return {
            "cu_p50": pct(50), "cu_p90": pct(90), "cu_p99": pct(99), "cu_max_ore": ore_cu[-1], "cu_max_all": max(self.cu),
            "blocks": self.count, "ore_mt": t_ore / 1e6, "waste_mt": t_waste / 1e6,
            "cu": cu_t / t_ore, "au": au_t / t_ore, "clay_share": t_clay / t_ore, "strip": t_waste / t_ore,
        }


ROLE_TYPES = {"sulphide": SULPHIDE, "clay": CLAY, "waste": WASTE}
MATCH_OK = 0.8           # доля тоннажа нужного типа в панели, при которой панель считается подходящей роли забоя
MATCH_MIN = 0.5          # ниже — роль не выполнена (role_mismatch)
ALONG_W = 4.0            # вдоль уступа блоки «дешевле» поперёк в 4 раза: панель вытянута по простиранию
POOL_ALONG_M = 3000.0    # как далеко вдоль уступа ищем блоки панели, м
POOL_ACROSS_M = 250.0    # как далеко поперёк (вглубь и наружу) ищем блоки панели, м


class Panel:
    """Панель забоя: упорядоченная цепочка блоков одного уступа вдоль фронта (простирания) уступа."""

    def __init__(self, model, level, blocks, share=1.0):
        self.model, self.level = model, level
        self.blocks = array("i", blocks)
        self.cum = array("d")      # тоннаж до блока i (накопительно, без него)
        total = 0.0
        for idx in self.blocks:
            self.cum.append(total)
            total += model.tonnes(idx)
        self.total = total
        self.match = share         # доля тоннажа панели, тип которого совпадает с ролью забоя
        self.mismatch = share < MATCH_MIN


def _select(model, level, want, x, y, target_t, claimed):
    """Подбирает блоки панели на уступе level вокруг якоря (x, y): вытянуто вдоль контура уступа.

    Предпочтение — блокам нужного типа (want), ближайшим к якорю; расстояние вдоль контура в ALONG_W раз «дешевле»,
    чем поперёк, поэтому панель идёт по простиранию. Если блоков нужного типа не хватает, добираются ближайшие любые."""
    a, b = model.level_axes(level)
    u0, v0 = x / a, y / b
    r0 = max(0.05, math.hypot(u0, v0))
    th0 = math.atan2(v0, u0)
    grad = math.sqrt((math.cos(th0) / a) ** 2 + (math.sin(th0) / b) ** 2)      # |∇r|: изменение r на метр поперёк контура
    arc = r0 * math.sqrt((a * math.sin(th0)) ** 2 + (b * math.cos(th0)) ** 2)  # метров вдоль контура на радиан
    pool = []
    for iy, ix0, ix1, off in model.rows[level]:
        cy = (iy + 0.5) * BLOCK_XY
        for ix in range(ix0, ix1 + 1):
            idx = off + ix - ix0
            if (level, idx) in claimed:
                continue
            u, v = ((ix + 0.5) * BLOCK_XY) / a, cy / b
            dth = (math.atan2(v, u) - th0 + math.pi) % (2.0 * math.pi) - math.pi
            ds = dth * arc
            dn = (math.hypot(u, v) - r0) / grad
            if abs(ds) > POOL_ALONG_M or abs(dn) > POOL_ACROSS_M:
                continue
            pool.append((math.hypot(ds / ALONG_W, dn), idx, ds, dn))
    pool.sort()
    chosen, total, good = [], 0.0, 0.0
    for take_match in (True, False):          # сначала блоки нужного типа, потом — ближайшие любые
        for _, idx, ds, dn in pool:
            if total >= target_t:
                break
            is_match = want is None or model.typ[idx] == want
            if is_match != take_match:
                continue
            chosen.append((idx, ds, dn))
            total += model.tonnes(idx)
            good += model.tonnes(idx) if is_match else 0.0
        if total >= target_t:
            break
    if not chosen:
        return [], 0.0
    # порядок отработки: дорожки (ряды вдоль уступа) по возрастанию |смещения|, змейкой вдоль контура
    tracks = {}
    for idx, ds, dn in chosen:
        tracks.setdefault(round(dn / BLOCK_XY), []).append((ds, idx))
    ordered = []
    for i, key in enumerate(sorted(tracks, key=lambda k: (abs(k), -k))):
        ordered.extend(idx for _, idx in sorted(tracks[key], reverse=(i % 2 == 1)))
    return ordered, (good / total if total else 0.0)


EARLY_BLOCKS = 12         # сколько первых блоков панели (около 600 кт) учитываем отдельно при выборе панели для усреднения
EARLY_W = 0.6            # вес среднего Cu первых блоков в оценке панели (остальное — вся панель)
SHIFTS_M = (0.0, 400.0, -400.0, 800.0, -800.0, 1200.0, -1200.0)   # сдвиги якоря вдоль уступа при поиске панелей для усреднения


def mean_cu(model, blocks):
    """Среднее содержание Cu блоков, взвешенное тоннажем."""
    t = sum(model.tonnes(i) for i in blocks)
    return sum(model.cu[i] * model.tonnes(i) for i in blocks) / t if t > 0 else 0.0


def _shifted(model, level, x, y, shift_m):
    """Якорь, сдвинутый вдоль контура уступа на shift_m метров (по простиранию)."""
    if not shift_m:
        return x, y
    a, b = model.level_axes(level)
    u0, v0 = x / a, y / b
    r0 = max(0.05, math.hypot(u0, v0))
    th0 = math.atan2(v0, u0)
    arc = r0 * math.sqrt((a * math.sin(th0)) ** 2 + (b * math.cos(th0)) ** 2)
    th = th0 + shift_m / arc
    return r0 * a * math.cos(th), r0 * b * math.sin(th)


def build_panel(model, role, x, y, z, target_t, claimed, levels=None, desired_cu=None):
    """Рудоконтроль: панель для забоя с ролью role (sulphide / clay / waste) на уступе точки (x, y, z) или на уступе ниже.

    Берётся первая панель, где нужного типа не меньше MATCH_OK тоннажа; иначе наиболее подходящая из найденных
    (role_mismatch, если нужного типа меньше MATCH_MIN)."""
    want = ROLE_TYPES.get(role)
    target_t = max(float(target_t), 1.0)
    k0 = model.level_of(z)
    cand = levels or [k0, min(k0 + 1, model.levels - 1)]
    best = None
    if desired_cu is not None:
        # усреднение (шихтовка): из подходящих по типу панелей (на том же уступе и ниже, со сдвигами вдоль уступа)
        # берём ту, средняя Cu которой ближе всего к нужной — победнее, если питание богаче цели, и побогаче, если беднее
        pick = None
        for lv in dict.fromkeys(cand):
            for sh in SHIFTS_M:
                ax, ay = _shifted(model, lv, x, y, sh)
                blocks, share = _select(model, lv, want, ax, ay, target_t, claimed)
                if not blocks or share < MATCH_OK:
                    continue
                # первые блоки панели отрабатываются первыми, поэтому в оценке они весят больше, чем вся панель
                err = abs(EARLY_W * mean_cu(model, blocks[:EARLY_BLOCKS]) + (1.0 - EARLY_W) * mean_cu(model, blocks) - desired_cu)
                if pick is None or err < pick[0]:
                    pick = (err, lv, blocks, share)
        if pick is not None:
            best = (pick[1], pick[2], pick[3])
    if best is None:
      for lv in dict.fromkeys(cand):
        blocks, share = _select(model, lv, want, x, y, target_t, claimed)
        if not blocks:
            continue
        if best is None or share > best[2] + 0.02:
            best = (lv, blocks, share)
        if share >= MATCH_OK:
            break
    if best is None:
        return None
    lv, blocks, share = best
    for idx in blocks:
        claimed.add((lv, idx))
    return Panel(model, lv, blocks, share)


def mixed(model, panel, extracted):
    """Смесь текущего и следующего блока по доле выработки текущего: (1-k)·текущий + k·следующий."""
    n = len(panel.blocks)
    if n == 0:
        return None
    i = bisect_index(panel.cum, extracted)
    cur = panel.blocks[i]
    nxt = panel.blocks[i + 1] if i + 1 < n else cur
    t_cur = model.tonnes(cur)
    k = min(1.0, max(0.0, (extracted - panel.cum[i]) / t_cur))
    return {
        "k": k, "block": cur, "cu": (1 - k) * model.cu[cur] + k * model.cu[nxt],
        "au": (1 - k) * model.au[cur] + k * model.au[nxt],
        "clay": (1 - k) * model.clay[cur] + k * model.clay[nxt],
        "hard": (1 - k) * model.hard[cur] + k * model.hard[nxt],
    }


def bisect_index(cum, x):
    lo, hi = 0, len(cum) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if cum[mid] <= x:
            lo = mid
        else:
            hi = mid - 1
    return lo


def classify(cu, clay):
    """Тип руды и пункт разгрузки по смешанным значениям: теми же порогами, что у блоков."""
    t = WASTE if cu < CUTOFF_CU else (CLAY if clay >= CLAY_LIMIT else SULPHIDE)
    return ORE_NAME[t], DESTINATION[t]


def preview(model, level, x, y, count=30):
    """Около count ближайших к (x, y) блоков уступа: [dx, dy, cu] — смещение в метрах и % Cu."""
    near = []
    c = model.locate(level, x, y)
    cx, cy, _ = model.center(level, c)
    iy0 = math.floor(cy / BLOCK_XY)
    for iy, ix0, ix1, off in model.rows[level]:
        if abs(iy - iy0) > 6 or ix1 < ix0:
            continue
        for ix in range(max(ix0, math.floor(cx / BLOCK_XY) - 6), min(ix1, math.floor(cx / BLOCK_XY) + 6) + 1):
            bx, by = (ix + 0.5) * BLOCK_XY, (iy + 0.5) * BLOCK_XY
            near.append(((bx - x) ** 2 + (by - y) ** 2, round(bx - x), round(by - y), round(model.cu[off + ix - ix0], 2)))
    near.sort()
    return [[dx, dy, cu] for _, dx, dy, cu in near[:count]]
