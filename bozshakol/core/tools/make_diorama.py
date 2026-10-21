"""Схема-макет рудника (core/diorama.json): компактная раскладка ≈ 600 × 400 единиц сцены.

Взаимное расположение — как в geometry.json (стороны света, порядок вдоль конвейера), расстояния сжаты:
карьер — половина ширины макета, техника рисуется в натуральную величину (1 единица ≈ 1 м), поэтому
самосвал на общем виде хорошо виден. Места узлов в карьере считаются переносом «по отступу от борта»
(тот же расчёт делает сцена, web/diorama.js); наземные узлы и объекты расставлены вручную (SURFACE).

Запуск: python3 bozshakol/core/tools/make_diorama.py  (пишет bozshakol/core/diorama.json)
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.dirname(HERE)

# Карьер в схеме: центр, полуоси по борту, 7 уступов по 7 единиц, отступ на уступ 8 (берма 3,5 + стенка 4,5)
PIT = {"center": [40, 55], "semi_axes": [160, 88], "benches": 7, "bench_height": 7, "inset": 8, "berm": 3.5}

# Наземные узлы и объекты: реальное место (м) → место в схеме (единицы); север — вверх (+y)
SURFACE_NODES = {
    "r1-top": [-4, -40], "r2-top": [84, -40], "crusher": [26, -56], "rim-ne": [6, -86],
    "fuel-station": [-12, -76], "rim-w": [-50, -52], "rim-sw": [130, -74], "rim-e": [92, -74],
    "dump-waste-1": [182, -92], "stockpile-clay": [-28, -128],
}
SURFACE_OBJECTS = {   # место и множитель размера модели (здания, склады и отвал в схеме уменьшены)
    "crusher-01": {"position": [26, -68], "scale": 0.6},
    "stockpile-coarse": {"position": [-150, -60], "scale": 0.3},
    "plant-sulphide": {"position": [-228, -80], "scale": 0.27},
    "sag-mill-01": {"position": [-245, -72], "scale": 0.27},
    "flotation-01": {"position": [-210, -90], "scale": 0.27},
    "stockpile-clay": {"position": [-28, -137], "scale": 0.3},
    "plant-clay": {"position": [46, -114], "scale": 0.3},
    "power-grid": {"position": [-150, -102], "scale": 0.4},
    "fuel-station": {"position": [-24, -84], "scale": 0.6},
    "dump-waste-1": {"position": [215, -120], "scale": 0.12},
}
# Конвейер: точки трассы geometry.json → схема (от дробилки на запад к складу у фабрики)
CONVEYOR = {"conveyor-01": [[12, -72], [-80, -66], [-150, -60]]}
# Окружение схемы (в geometry.json его нет): хвостохранилище к западу от фабрики
EXTRA = {"tailings": {"center": [-215, 100], "radii": [62, 42], "real_center": [-4050, 250]}}
# Дальние опорные точки (реальные м → схема): края макета
CORNERS = [
    [-4600, 1600, -300, 200], [0, 1600, 40, 200], [3400, 1600, 300, 200],
    [-4600, -300, -300, 10], [3400, -300, 300, 10],
    [-4600, -2000, -300, -200], [0, -2000, 40, -200], [3400, -2000, 300, -200],
    [-4050, 250, -215, 100],
]


def pit_map(x, y, gp):
    """Реальная точка внутри карьера → схема: по отступу от борта d (эллипсы уступов сужаются на inset)."""
    A, B = gp["semi_axes_top"]
    Dr = gp["bench_count"] * gp["inset_per_bench"]
    cx, cy = PIT["center"]
    a, b = PIT["semi_axes"]
    Ds = PIT["benches"] * PIT["inset"]
    f = lambda d: (x / (A - d)) ** 2 + (y / (B - d)) ** 2 - 1
    if f(Dr) <= 0:   # дно
        return [cx + x * (a - Ds) / (A - Dr), cy + y * (b - Ds) / (B - Dr)]
    lo, hi = 0.0, Dr
    for _ in range(50):
        mid = (lo + hi) / 2
        if f(mid) > 0: hi = mid      # точка вне эллипса отступа mid — корень меньше
        else: lo = mid
    d = (lo + hi) / 2
    t = math.atan2(y / (B - d), x / (A - d))
    ds = d * Ds / Dr
    return [cx + (a - ds) * math.cos(t), cy + (b - ds) * math.sin(t)]


ROAD_NEAR, SIDE_K = 40.0, 0.4   # экскаватор у забоя: место на схематичном ребре и боковой сдвиг ×0,4


def near_road(x, y, g, nodes):
    """Точка до 40 м от ребра дороги → место на схематичном ребре с той же долей пути (+ боковой сдвиг)."""
    best = None
    for e in g["edges"]:
        ra, rb = g["nodes"][e["from"]], g["nodes"][e["to"]]
        dx, dy = rb[0] - ra[0], rb[1] - ra[1]
        L2 = dx * dx + dy * dy or 1
        t = max(0.0, min(1.0, ((x - ra[0]) * dx + (y - ra[1]) * dy) / L2))
        px, py = ra[0] + dx * t, ra[1] + dy * t
        d = math.hypot(x - px, y - py)
        if best is None or d < best[0]:
            best = (d, e, t, x - px, y - py)
    d, e, t, ox, oy = best
    if d >= ROAD_NEAR:
        return None
    sa, sb = nodes[e["from"]], nodes[e["to"]]
    return [sa[0] + (sb[0] - sa[0]) * t + ox * SIDE_K, sa[1] + (sb[1] - sa[1]) * t + oy * SIDE_K]


def inside_pit(x, y, gp):
    A, B = gp["semi_axes_top"]
    return (x / A) ** 2 + (y / B) ** 2 < 1


def main():
    g = json.load(open(os.path.join(CORE, "geometry.json"), encoding="utf-8"))
    gp = g["pit"]
    kz = PIT["benches"] * PIT["bench_height"] / gp["depth"]
    nodes = {}
    for n, (x, y, z) in g["nodes"].items():
        if n in SURFACE_NODES:
            xs, ys = SURFACE_NODES[n]; zs = 0.0
        elif inside_pit(x, y, gp):
            xs, ys = pit_map(x, y, gp); zs = z * kz
        else:
            raise SystemExit(f"узел {n} вне карьера и без места в SURFACE_NODES")
        nodes[n] = [round(xs, 2), round(ys, 2), round(zs, 2)]
    objects = {}
    for o in g["objects"]:
        oid = o["id"]
        if oid in SURFACE_OBJECTS:
            objects[oid] = dict(SURFACE_OBJECTS[oid])
        elif oid in CONVEYOR:
            objects[oid] = {"path": CONVEYOR[oid]}
        elif "position" in o and inside_pit(o["position"][0], o["position"][1], gp):
            x, y = o["position"][0], o["position"][1]
            xs, ys = near_road(x, y, g, nodes) or pit_map(x, y, gp)
            face = o.get("face")
            if face in nodes and math.hypot(xs - nodes[face][0], ys - nodes[face][1]) < 5:
                # экскаватор стоит в самом узле забоя — в схеме отодвигаем его за конец заезда,
                # чтобы самосвал под погрузкой стоял рядом, а не внутри экскаватора
                e = next(e for e in g["edges"] if face in (e["from"], e["to"]))
                other = nodes[e["to"] if e["from"] == face else e["from"]]
                dx, dy = nodes[face][0] - other[0], nodes[face][1] - other[1]
                L = math.hypot(dx, dy) or 1
                xs, ys = nodes[face][0] + dx / L * 9, nodes[face][1] + dy / L * 9
            objects[oid] = {"position": [round(xs, 2), round(ys, 2)], "scale": 1.0}
        else:
            raise SystemExit(f"объект {oid} без места в схеме")
    # опорные точки поверхности: реальное место → схема
    anchors = []
    for n, (xs, ys) in SURFACE_NODES.items():
        x, y, _ = g["nodes"][n]; anchors.append([x, y, xs, ys])
    for o in g["objects"]:
        if o["id"] in SURFACE_OBJECTS and "position" in o:
            anchors.append([o["position"][0], o["position"][1]] + SURFACE_OBJECTS[o["id"]]["position"])
        if o["id"] in CONVEYOR:
            # трасса конвейера: опорные точки через каждые ≈ 150 м — в схеме конвейер идёт прямыми участками
            path, sp = o["path"], CONVEYOR[o["id"]]
            for i in range(len(path) - 1):
                (x0, y0, _), (x1, y1, _) = path[i], path[i + 1]
                n = max(1, round(math.hypot(x1 - x0, y1 - y0) / 150))
                for k in range(n):
                    t = k / n
                    anchors.append([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t,
                                    sp[i][0] + (sp[i + 1][0] - sp[i][0]) * t, sp[i][1] + (sp[i + 1][1] - sp[i][1]) * t])
            anchors.append([path[-1][0], path[-1][1]] + sp[-1])
    anchors += CORNERS
    out = {
        "_comment": "Схема-макет рудника (не в масштабе): места узлов дорог и объектов geometry.json в единицах сцены. "
                    "Генератор — core/tools/make_diorama.py; перенос координат — web/diorama.js.",
        "units": "единицы сцены (≈ 1 м для размеров техники); x — восток, y — север, z — высота",
        "bounds": [-300, -200, 300, 200],
        "pit": dict(PIT, z_scale=round(kz, 5)),
        "nodes": nodes,
        "objects": objects,
        "extra": EXTRA,
        "anchors": anchors,
    }
    path = os.path.join(CORE, "diorama.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("записано", path, len(nodes), "узлов,", len(objects), "объектов")


if __name__ == "__main__":
    main()
