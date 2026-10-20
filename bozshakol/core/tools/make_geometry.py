#!/usr/bin/env python3
"""Генерирует bozshakol/core/geometry.json — общую геометрию рудника.

Координаты в метрах: начало — центр карьера, X — восток, Y — север, Z — высота
(поверхность степи у борта ≈ 0). Запуск: python3 core/tools/make_geometry.py
из папки bozshakol/. Дорожная сеть — узлы и рёбра; длина и уклон рёбер
считаются здесь из координат узлов.
"""
import json
import math
import os
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "geometry.json")

# ---------------------------------------------------------------- карьер
PIT = {
    "center": [0, 0, 0],
    "semi_axes_top": [2200, 550],      # ≈ 4,4 × 1,1 км по верху (источник: inform.kz)
    "depth": 200,                       # ≈ 200 м (2023)
    "bench_height": 15,                 # уступ 10–15 м (cyberleninka)
    "bench_face_angle_deg": 58,         # угол откоса уступа 55–60°
    "berm_width": 12,                   # допущение
    "bench_count": 13,                  # 13 × 15 м = 195 м + дно на −200 м
    "inset_per_bench": 21.4,            # 15/tan(58°) + 12 ≈ 21,4 м — отступ каждого уступа внутрь
}

# ---------------------------------------------------------------- узлы дорог
# id: [x, y, z]. Наземные узлы (z ≥ 0) стоят на реальных местах по снимку Sentinel-2
# (data/terrain, координаты рудника): промплощадка — к югу и юго-западу от карьера,
# дробилка — на южном борту, фабрика — ≈ 2,5 км к западу-юго-западу, отвалы — к юго-востоку.
# Съезды выходят на южный борт (к дробилке и фабрике). Имена узлов и рёбра неизменны —
# их читает модуль транспорта.
NODES = {
    # дно карьера (−200 м); высоты внутри карьера — по модели уступов (13 × 15 м, дно −200)
    "floor-w": [-1500, 0, -200],
    "floor-c": [0, 0, -200],
    "floor-e": [900, 0, -200],
    "floor-e2": [1450, -40, -200],
    # забои (подъезд к экскаватору)
    "face-01": [-1300, 80, -200],
    "face-02": [-300, -120, -200],
    "face-03": [700, 100, -200],
    "face-04": [1400, -60, -200],
    "face-05": [-1500, -330, -45],   # верхний уступ южного борта (3-я берма)
    "face-06": [1500, -330, -45],
    # съезд 1 (юго-западный борт, три плеча)
    "r1-bottom": [-1600, -180, -200],
    "r1-mid1": [-400, -330, -120],
    "r1-mid2": [-1400, -400, -45],
    "r1-top": [-600, -560, 0],
    # съезд 2 (юго-восточный борт, три плеча)
    "r2-bottom": [1600, -180, -200],
    "r2-mid1": [400, -330, -120],
    "r2-mid2": [1400, -400, -45],
    "r2-top": [600, -560, 0],
    # борт и поверхность (промплощадка к югу от карьера)
    "crusher": [-250, -600, 0],          # первичная дробилка у южного борта (тёмное здание на снимке), вне контура модели
    "rim-w": [-1200, -700, 0],           # дорога по южному борту к западу
    "rim-sw": [1200, -900, 0],           # дорога от съезда 2 к отвалам
    "rim-e": [700, -900, 0],             # дорога от съезда 2 к складу глинистой руды
    "rim-ne": [-300, -800, 0],           # развилка у дробилки к складу глинистой руды
    "fuel-station": [-480, -720, 0],     # топливозаправочный пункт у дороги к дробилке (допущение: на снимке не различим)
    "dump-waste-1": [1900, -1000, 0],    # отвалы к юго-востоку от карьера
    "stockpile-clay": [-700, -1250, 0],  # склад глинистой руды у фабрики глинистой руды
}

# ---------------------------------------------------------------- рёбра
# (от, до, дорога-владелец). Все рёбра двусторонние.
EDGES = [
    ("floor-w", "floor-c", "floor"),
    ("floor-c", "floor-e", "floor"),
    ("floor-e", "floor-e2", "floor"),
    ("face-01", "floor-w", "floor"),
    ("face-02", "floor-c", "floor"),
    ("face-03", "floor-e", "floor"),
    ("face-04", "floor-e2", "floor"),
    ("floor-w", "r1-bottom", "floor"),
    ("floor-e2", "r2-bottom", "floor"),
    ("r1-bottom", "r1-mid1", "road-ramp-1"),
    ("r1-mid1", "r1-mid2", "road-ramp-1"),
    ("r1-mid2", "r1-top", "road-ramp-1"),
    ("face-05", "r1-mid2", "floor"),
    ("r2-bottom", "r2-mid1", "road-ramp-2"),
    ("r2-mid1", "r2-mid2", "road-ramp-2"),
    ("r2-mid2", "r2-top", "road-ramp-2"),
    ("face-06", "r2-mid2", "floor"),
    ("r1-top", "crusher", "road-crusher"),
    ("r1-top", "rim-w", "rim"),
    ("rim-w", "dump-waste-1", "rim"),
    ("r2-top", "rim-sw", "rim"),
    ("rim-sw", "dump-waste-1", "rim"),
    ("r2-top", "rim-e", "rim"),
    ("rim-e", "rim-ne", "rim"),
    ("rim-ne", "stockpile-clay", "rim"),
    ("crusher", "rim-ne", "rim"),
    ("rim-ne", "fuel-station", "rim"),
]

# ---------------------------------------------------------------- объекты
OBJECTS = [
    {"id": "crusher-01", "kind": "crusher", "position": [-250, -575, 0], "yaw_deg": 0},
    # конвейер от дробилки вдоль южного борта к складу крупнодроблёной руды у фабрики (≈ 2,2 км по трассе)
    {"id": "conveyor-01", "kind": "conveyor", "path": [[-300, -620, 0], [-1500, -640, 0], [-2440, -700, 0]]},
    {"id": "stockpile-coarse", "kind": "stockpile", "position": [-2490, -720, 0], "radius": 60},
    {"id": "plant-sulphide", "kind": "plant", "position": [-2700, -760, 0], "size": [320, 170, 30]},   # главный корпус ≈ 320 × 170 м по снимку
    {"id": "sag-mill-01", "kind": "mill", "position": [-2780, -720, 0]},
    {"id": "flotation-01", "kind": "flotation", "position": [-2620, -800, 0]},
    {"id": "stockpile-clay", "kind": "stockpile", "position": [-700, -1290, 0], "radius": 50},
    {"id": "plant-clay", "kind": "plant", "position": [-300, -1060, 0], "size": [160, 100, 22]},   # ≈ 160 × 100 м по снимку (допущение)
    {"id": "power-grid", "kind": "substation", "position": [-2450, -950, 0], "size": [60, 40, 10]},
    {"id": "fuel-station", "kind": "fuel", "position": [-500, -745, 0], "size": [40, 28, 8]},
    {"id": "dump-waste-1", "kind": "dump", "position": [2200, -1100, 0], "radius": 400},
    {"id": "face-01", "kind": "face", "position": [-1300, 130, -200], "ore_type": "sulphide"},
    {"id": "face-02", "kind": "face", "position": [-300, -170, -200], "ore_type": "sulphide"},
    {"id": "face-03", "kind": "face", "position": [700, 150, -200], "ore_type": "sulphide"},
    {"id": "face-04", "kind": "face", "position": [1400, -110, -200], "ore_type": "clay"},
    {"id": "face-05", "kind": "face", "position": [-1500, -330, -45], "ore_type": "waste"},
    {"id": "face-06", "kind": "face", "position": [1500, -330, -45], "ore_type": "waste"},
    {"id": "excavator-01", "kind": "excavator", "position": [-1300, 105, -200], "face": "face-01"},
    {"id": "excavator-02", "kind": "excavator", "position": [-300, -145, -200], "face": "face-02"},
    {"id": "excavator-03", "kind": "excavator", "position": [700, 125, -200], "face": "face-03"},
    {"id": "excavator-04", "kind": "excavator", "position": [1400, -85, -200], "face": "face-04"},
    {"id": "excavator-05", "kind": "excavator", "position": [-1500, -330, -45], "face": "face-05"},
    {"id": "excavator-06", "kind": "excavator", "position": [1500, -330, -45], "face": "face-06"},
    {"id": "drill-01", "kind": "drill", "position": [-1000, 330, -105]},
    {"id": "drill-02", "kind": "drill", "position": [400, -380, -105]},
    {"id": "drill-03", "kind": "drill", "position": [1200, 300, -120]},
    # места для буровых станков участника №3: рабочий уступ −45 м рядом со вскрышными забоями face-05 и face-06
    {"id": "drill-04", "kind": "drill", "position": [-1620, -300, -45]},
    {"id": "drill-05", "kind": "drill", "position": [1620, -300, -45]},
]

# Пункты разгрузки: двойник → узел дороги, где самосвал разгружается
DUMP_POINTS = {
    "crusher-01": "crusher",
    "stockpile-clay": "stockpile-clay",
    "dump-waste-1": "dump-waste-1",
}
# Узел дороги у каждого экскаватора (место погрузки)
LOAD_POINTS = {f"excavator-0{i}": f"face-0{i}" for i in range(1, 7)}


def apply_terrain():
    """Высоты наземных узлов и объектов (z >= 0 в таблицах выше) берутся из рельефа
    data/terrain (Copernicus DEM), если он есть. Узлы внутри карьера остаются как в модели."""
    terrain_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "terrain")
    sys.path.insert(0, terrain_dir)
    try:
        from heights import load
    except ImportError:
        return None
    terrain = load()
    if terrain is None:
        return None
    # выровненные площадки у объектов (как в web/terrain.js): узел внутри площадки — на её уровне
    pads = []
    for obj in OBJECTS:
        if "position" not in obj:
            continue
        ox, oy = obj["position"][:2]
        if obj["kind"] in ("plant", "substation", "crusher", "fuel"):
            l, w = (obj.get("size") or [60, 60])[:2]
            pads.append((ox, oy, lambda x, y, ox=ox, oy=oy, hx=l / 2 + 60, hy=w / 2 + 60: max(abs(x - ox) - hx, abs(y - oy) - hy)))
        elif obj["kind"] in ("stockpile", "dump"):
            pads.append((ox, oy, lambda x, y, ox=ox, oy=oy, r=(obj.get("radius") or 50) + 40: math.hypot(x - ox, y - oy) - r))
    for name, p in NODES.items():
        if p[2] >= 0 and not terrain.inside_pit(p[0], p[1]):
            p[2] = round(terrain.height_at(p[0], p[1]), 1)
            for ox, oy, dist in pads:
                if dist(p[0], p[1]) <= 0:
                    p[2] = round(terrain.height_at(ox, oy), 1)
                    break
    for obj in OBJECTS:
        if "position" in obj and obj["position"][2] >= 0 and not terrain.inside_pit(*obj["position"][:2]):
            obj["position"][2] = round(terrain.height_at(obj["position"][0], obj["position"][1]) + (1 if obj["kind"] != "dump" else 0), 1)
        if "path" in obj:
            for p in obj["path"]:
                p[2] = round(terrain.height_at(p[0], p[1]) + 3, 1)
            # конец конвейера — на площадке склада (уровень площадки = рельеф в её центре)
            end = obj["path"][-1]
            for o2 in OBJECTS:
                if o2["kind"] == "stockpile" and "position" in o2 and math.hypot(o2["position"][0] - end[0], o2["position"][1] - end[1]) < 150:
                    end[2] = round(terrain.height_at(o2["position"][0], o2["position"][1]) + 3, 1)
    return terrain


def bench_height(x, y):
    """Высота бермы модели уступов в точке (как web/terrain.js): последний уровень — дно."""
    a, b = PIT["semi_axes_top"]
    level = 0
    for k in range(1, PIT["bench_count"] + 1):
        ak, bk = a - k * PIT["inset_per_bench"], b - k * PIT["inset_per_bench"]
        if ak <= 0 or bk <= 0:
            break
        if (x / ak) ** 2 + (y / bk) ** 2 < 1:
            level = k
        else:
            break
    return -PIT["depth"] if level >= PIT["bench_count"] else -level * PIT["bench_height"]


def apply_pit_levels():
    """Забои, экскаваторы, буровые и узлы забоев внутри карьера стоят на бермах модели уступов."""
    a, b = PIT["semi_axes_top"]
    inside = lambda x, y: (x / a) ** 2 + (y / b) ** 2 < 1
    for obj in OBJECTS:
        if obj["kind"] in ("face", "excavator", "drill") and inside(*obj["position"][:2]):
            obj["position"][2] = bench_height(*obj["position"][:2])
    for name, p in NODES.items():
        if name.startswith("face-") and inside(p[0], p[1]):
            p[2] = bench_height(p[0], p[1])


def main():
    apply_pit_levels()
    terrain = apply_terrain()
    edges = []
    for a, b, road in EDGES:
        pa, pb = NODES[a], NODES[b]
        dx, dy, dz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        horizontal = math.hypot(dx, dy)
        length = math.sqrt(horizontal ** 2 + dz ** 2)
        grade = round(100.0 * dz / horizontal, 1) if horizontal else 0.0
        edges.append({"from": a, "to": b, "road": road, "length_m": round(length, 1), "grade_pct": grade})
    geometry = {
        "_comment": "Геометрия рудника Бозшаколь в метрах; начало координат — центр карьера, X — восток, Y — север, Z — высота. Сгенерировано core/tools/make_geometry.py.",
        "units": "m",
        "terrain": ("data/terrain (Copernicus DEM GLO-30): высоты наземных узлов из рельефа, уровень 0 — борт карьера"
                    if terrain else "рельеф не подключён: поверхность плоская, Z = 0"),
        "pit": PIT,
        "nodes": NODES,
        "edges": edges,
        "roads": {
            "road-ramp-1": {"name": "Съезд 1 (юго-западный борт)", "speed_limit_kmh": 30},
            "road-ramp-2": {"name": "Съезд 2 (юго-восточный борт)", "speed_limit_kmh": 30},
            "road-crusher": {"name": "Дорога к дробилке", "speed_limit_kmh": 40},
            "floor": {"name": "Дороги на дне карьера", "speed_limit_kmh": 40},
            "rim": {"name": "Дороги по борту и поверхности", "speed_limit_kmh": 50},
        },
        "load_points": LOAD_POINTS,
        "dump_points": DUMP_POINTS,
        "objects": OBJECTS,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(geometry, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(NODES)} узлов, {len(edges)} рёбер -> {os.path.normpath(OUT)}; рельеф: {'да' if terrain else 'нет'}")


if __name__ == "__main__":
    main()
