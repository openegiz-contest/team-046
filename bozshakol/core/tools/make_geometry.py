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
# id: [x, y, z]
NODES = {
    # дно карьера (−200 м) и восточная площадка (−185 м)
    "floor-w": [-1500, 0, -200],
    "floor-c": [0, 0, -200],
    "floor-e": [900, 0, -200],
    "floor-e2": [1450, -40, -185],
    # забои (подъезд к экскаватору)
    "face-01": [-1300, 80, -200],
    "face-02": [-300, -120, -200],
    "face-03": [700, 100, -200],
    "face-04": [1400, -60, -185],
    "face-05": [-1500, 400, -50],
    "face-06": [1500, -450, -50],
    # съезд 1 (северный борт, три плеча)
    "r1-bottom": [-1600, 180, -200],
    "r1-mid1": [-400, 330, -120],
    "r1-mid2": [-1400, 450, -50],
    "r1-top": [-600, 560, 0],
    # съезд 2 (южный борт, три плеча)
    "r2-bottom": [1600, -180, -185],
    "r2-mid1": [400, -330, -120],
    "r2-mid2": [1400, -450, -50],
    "r2-top": [600, -560, 0],
    # борт и поверхность
    "crusher": [-100, 680, 5],
    "rim-w": [-2400, 0, 2],
    "rim-sw": [-1200, -620, 2],
    "rim-e": [2400, 0, 3],
    "rim-ne": [1800, 800, 5],
    "dump-waste-1": [-2200, -1100, 20],
    "stockpile-clay": [1100, 2400, 10],
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
]

# ---------------------------------------------------------------- объекты
OBJECTS = [
    {"id": "crusher-01", "kind": "crusher", "position": [-100, 720, 6], "yaw_deg": 0},
    {"id": "conveyor-01", "kind": "conveyor", "path": [[-100, 740, 8], [-100, 3250, 16]]},
    {"id": "stockpile-coarse", "kind": "stockpile", "position": [-100, 3300, 18], "radius": 60},
    {"id": "plant-sulphide", "kind": "plant", "position": [-100, 3600, 20], "size": [260, 140, 28]},
    {"id": "sag-mill-01", "kind": "mill", "position": [-180, 3560, 20]},
    {"id": "flotation-01", "kind": "flotation", "position": [-20, 3640, 20]},
    {"id": "stockpile-clay", "kind": "stockpile", "position": [1100, 2450, 10], "radius": 50},
    {"id": "plant-clay", "kind": "plant", "position": [1100, 2750, 14], "size": [140, 90, 20]},
    {"id": "power-grid", "kind": "substation", "position": [-700, 3500, 20], "size": [60, 40, 10]},
    {"id": "dump-waste-1", "kind": "dump", "position": [-2300, -1250, 25], "radius": 260},
    {"id": "face-01", "kind": "face", "position": [-1300, 130, -200], "ore_type": "sulphide"},
    {"id": "face-02", "kind": "face", "position": [-300, -170, -200], "ore_type": "sulphide"},
    {"id": "face-03", "kind": "face", "position": [700, 150, -200], "ore_type": "sulphide"},
    {"id": "face-04", "kind": "face", "position": [1400, -110, -185], "ore_type": "clay"},
    {"id": "face-05", "kind": "face", "position": [-1500, 450, -50], "ore_type": "waste"},
    {"id": "face-06", "kind": "face", "position": [1500, -500, -50], "ore_type": "waste"},
    {"id": "excavator-01", "kind": "excavator", "position": [-1300, 105, -200], "face": "face-01"},
    {"id": "excavator-02", "kind": "excavator", "position": [-300, -145, -200], "face": "face-02"},
    {"id": "excavator-03", "kind": "excavator", "position": [700, 125, -200], "face": "face-03"},
    {"id": "excavator-04", "kind": "excavator", "position": [1400, -85, -185], "face": "face-04"},
    {"id": "excavator-05", "kind": "excavator", "position": [-1500, 425, -50], "face": "face-05"},
    {"id": "excavator-06", "kind": "excavator", "position": [1500, -475, -50], "face": "face-06"},
    {"id": "drill-01", "kind": "drill", "position": [-1000, 330, -155]},
    {"id": "drill-02", "kind": "drill", "position": [400, -380, -140]},
    {"id": "drill-03", "kind": "drill", "position": [1200, 300, -125]},
]

# Пункты разгрузки: двойник → узел дороги, где самосвал разгружается
DUMP_POINTS = {
    "crusher-01": "crusher",
    "stockpile-clay": "stockpile-clay",
    "dump-waste-1": "dump-waste-1",
}
# Узел дороги у каждого экскаватора (место погрузки)
LOAD_POINTS = {f"excavator-0{i}": f"face-0{i}" for i in range(1, 7)}


def main():
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
        "pit": PIT,
        "nodes": NODES,
        "edges": edges,
        "roads": {
            "road-ramp-1": {"name": "Съезд 1 (северный борт)", "speed_limit_kmh": 30},
            "road-ramp-2": {"name": "Съезд 2 (южный борт)", "speed_limit_kmh": 30},
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
    print(f"{len(NODES)} узлов, {len(edges)} рёбер -> {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
