"""Буровзрывные работы: проекты взрыва, модель Кузнецова–Рамлера, скорость бурения и MWD.

Формулы — как в литературе, без подгонки под результат. Проектные параметры (диаметр скважины, сетка,
забойка, ВВ) — наши решения, их обоснование — в README модуля. Коэффициент породы A считается по
индексу взрываемости Лилли из свойств блока (доля глины, плотность, крепость).
"""
import math

BENCH_H_M = 15.0         # H — высота уступа, м
ANFO_DENSITY = 850.0     # плотность ANFO в скважине, кг/м³
ANFO_E = 100.0           # относительная работоспособность ВВ (ANFO = 100)
DEVIATION_M = 0.3        # W — отклонение скважины при бурении, м (принято)
BLOCK_XY = 25.0          # сторона блока в плане, м

# Два проекта: руда бурится чаще и мельче (mine-to-mill), вскрыша — реже и крупнее (в отвал).
DESIGNS = {
    "ore": {"d_mm": 165.0, "burden": 4.5, "spacing": 5.5, "subdrill": 1.5, "stemming": 3.5},
    "waste": {"d_mm": 251.0, "burden": 8.0, "spacing": 9.0, "subdrill": 2.0, "stemming": 6.0},
}

# --- индекс взрываемости Лилли: A = 0,06 · (RMD + JPS + JPA + RDI + HF) ----------------------
CLAY_LIMIT = 30.0        # % глины, при котором массив «рыхлый и выветрелый» (порог глинистой руды)
RMD_JOINTED, RMD_LOOSE = 20.0, 10.0
JPS = 20.0               # расстояние между трещинами 0,1–1 м (среднее) — допущение
JPA = 30.0               # простирание трещин под углом к забою — допущение
UCS_PER_F = 10.0         # предел прочности на сжатие, МПа ≈ 10·f (по Протодьяконову)

# --- скорость бурения: крепче — медленнее (допущение, степенная зависимость ROP ~ f^-k) ------
ROP_F5, ROP_F16 = 55.0, 25.0                        # м/ч при f = 5 и f = 16
ROP_K = math.log(ROP_F16 / ROP_F5) / math.log(16.0 / 5.0)    # показатель степени (< 0)
F_REF = 11.0             # средняя крепость сульфидной руды (диапазон 9–13), опорная для P80_REF
CLAY_REF, DENS_REF = 5.0, 2.7    # доля глины, плотность обычной рудной породы

LF_MIN, LF_MAX = 0.5, 1.2   # границы коэффициента скорости погрузки


def design(kind):
    """Проект взрыва: 'waste' — вскрыша, любой другой тип (сульфидная, глинистая руда) — руда."""
    return DESIGNS["waste" if kind == "waste" else "ore"]


def hole_depth(kind):
    d = design(kind)
    return BENCH_H_M + d["subdrill"]


def holes_per_block(kind):
    """Скважин на блок: площадь блока в плане / площадь сетки (округление до целого)."""
    d = design(kind)
    return max(1, round(BLOCK_XY * BLOCK_XY / (d["burden"] * d["spacing"])))


def charge(kind):
    """Заряд одной скважины из геометрии: длина заряда, масса ВВ, объём породы, удельный расход."""
    d = design(kind)
    length = hole_depth(kind) - d["stemming"]
    mass = ANFO_DENSITY * math.pi * (d["d_mm"] / 1000.0) ** 2 / 4.0 * length                 # кг
    volume = d["burden"] * d["spacing"] * BENCH_H_M                                           # м³ на скважину
    return {"length": length, "mass": mass, "volume": volume, "powder_factor": mass / volume}


def rock_factor_A(f, clay_pct=CLAY_REF, density=DENS_REF):
    """Коэффициент породы по Лилли: A = 0,06·(RMD + JPS + JPA + RDI + HF).

    RMD — 20 (трещиноватый массив) … 10 (рыхлый и выветрелый, глина ≥ порога) по доле глины; RDI = 25·ρ − 50;
    HF = UCS/5, UCS = 10·f МПа."""
    rmd = RMD_JOINTED - (RMD_JOINTED - RMD_LOOSE) * min(1.0, max(0.0, clay_pct / CLAY_LIMIT))
    rdi = 25.0 * density - 50.0
    hf = UCS_PER_F * f / 5.0
    return 0.06 * (rmd + JPS + JPA + rdi + hf)


def uniformity_n(kind):
    """Индекс однородности Каннингема n = (2,2 − 14·B/d)·√((1+S/B)/2)·(1 − W/B)·(L/H)."""
    d, c = design(kind), charge(kind)
    b, s = d["burden"], d["spacing"]
    return (2.2 - 14.0 * b / d["d_mm"]) * math.sqrt((1.0 + s / b) / 2.0) * (1.0 - DEVIATION_M / b) * (c["length"] / BENCH_H_M)


def fragmentation(f, kind="ore", clay_pct=CLAY_REF, density=DENS_REF):
    """Модель Кузнецова–Рамлера: X50 (см), индекс n, Xc (см) и P80 (мм) для проекта kind и свойств породы."""
    c = charge(kind)
    a = rock_factor_A(f, clay_pct, density)
    x50 = a * (c["volume"] / c["mass"]) ** 0.8 * c["mass"] ** (1.0 / 6.0) * (115.0 / ANFO_E) ** (19.0 / 30.0)
    n = uniformity_n(kind)
    xc = x50 / 0.693 ** (1.0 / n)
    p80 = xc * math.log(5.0) ** (1.0 / n) * 10.0
    return {"A": a, "x50_cm": x50, "n": n, "xc_cm": xc, "p80_mm": p80}


def p80_mm(f, kind="ore", clay_pct=CLAY_REF, density=DENS_REF):
    return fragmentation(f, kind, clay_pct, density)["p80_mm"]


P80_REF = p80_mm(F_REF)   # крупность при обычном взрыве рудного блока средней крепости (f = 11), мм


def loading_factor(p80):
    """Чем крупнее кусок, тем медленнее погрузка: ограничить((P80_ref / P80)^0,5; 0,5 … 1,2) — допущение."""
    return min(LF_MAX, max(LF_MIN, (P80_REF / max(p80, 1.0)) ** 0.5))


# --- бурение и MWD --------------------------------------------------------------------
def rop_from_hardness(f):
    """Механическая скорость бурения, м/ч, по крепости (55 м/ч при f = 5, 25 м/ч при f = 16)."""
    return ROP_F5 * (max(f, 1.0) / 5.0) ** ROP_K


def hardness_from_rop(rop):
    """MWD: крепость по скорости бурения — обратная формула (станок крепость не знает, а измеряет)."""
    return 5.0 * (ROP_F5 / max(rop, 0.5)) ** (1.0 / -ROP_K)
