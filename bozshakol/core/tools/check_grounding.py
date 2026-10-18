#!/usr/bin/env python3
"""Проверка «ничего не висит и не утоплено»: высота каждого объекта и наземного узла
core/geometry.json сравнивается с высотой земли, как её считает сцена (web/terrain.js):
рельеф Copernicus (data/terrain) + выровненные площадки у зданий, складов и отвалов
(уровень площадки = рельеф в её центре) + профиль наземных дорог; внутри карьера — бермы
модели уступов. Допустимое отклонение — 1 м.

Запуск из папки bozshakol/: python3 core/tools/check_grounding.py  (код выхода 1 при нарушениях)
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.join(ROOT, "data", "terrain"))
from heights import load  # noqa: E402

TOL = 1.0
PAD_BLEND, ROAD_SHOULDER, ROAD_BLEND = 60, 40, 160


def main():
    terrain = load()
    if terrain is None:
        print("нет data/terrain — проверка невозможна")
        return 1
    g = json.load(open(os.path.join(ROOT, "core", "geometry.json"), encoding="utf-8"))
    nodes, objects = g["nodes"], g["objects"]
    pit = g["pit"]
    a, b, inset, h, count, depth = pit["semi_axes_top"][0], pit["semi_axes_top"][1], pit["inset_per_bench"], pit["bench_height"], pit["bench_count"], pit["depth"]

    def bench(x, y):
        level = 0
        for k in range(1, count + 1):
            ak, bk = a - k * inset, b - k * inset
            if ak <= 0 or bk <= 0:
                break
            if (x / ak) ** 2 + (y / bk) ** 2 < 1:
                level = k
            else:
                break
        return -depth if level >= count else -level * h

    pads = []
    for o in objects:
        if "position" not in o:
            continue
        x, y = o["position"][:2]
        if o["kind"] in ("plant", "substation", "crusher", "fuel"):
            l, w = (o.get("size") or [60, 60])[:2]
            hx, hy = l / 2 + 60, w / 2 + 60   # как в web/terrain.js (padsFrom)
            pads.append((o["id"], terrain.height_at(x, y), lambda px, py, x=x, y=y, hx=hx, hy=hy: max(abs(px - x) - hx, abs(py - y) - hy)))
        elif o["kind"] in ("stockpile", "dump"):
            r = (o.get("radius") or 50) + 40
            pads.append((o["id"], terrain.height_at(x, y), lambda px, py, x=x, y=y, r=r: math.hypot(px - x, py - y) - r))
    roads = []
    for e in g["edges"]:
        if e["road"] in ("rim", "road-crusher"):
            roads.append((nodes[e["from"]], nodes[e["to"]]))

    def ground(x, y):
        if terrain.inside_pit(x, y):
            return bench(x, y)
        z = terrain.height_at(x, y)
        bestr = None
        for A, B in roads:
            dx, dy = B[0] - A[0], B[1] - A[1]
            l2 = dx * dx + dy * dy or 1
            s = max(0.0, min(1.0, ((x - A[0]) * dx + (y - A[1]) * dy) / l2))
            d = math.hypot(x - (A[0] + dx * s), y - (A[1] + dy * s))
            if d < ROAD_BLEND and (bestr is None or d < bestr[0]):
                bestr = (d, A[2] + (B[2] - A[2]) * s)
        if bestr:
            w = 1.0 if bestr[0] <= ROAD_SHOULDER else 1 - (bestr[0] - ROAD_SHOULDER) / (ROAD_BLEND - ROAD_SHOULDER)
            z = z * (1 - w) + bestr[1] * w
        best = None
        for _, level, dist in pads:
            d = dist(x, y)
            if d < PAD_BLEND and (best is None or d < best[0]):
                best = (d, level)
        if best:
            w = 1.0 if best[0] <= 0 else 1 - best[0] / PAD_BLEND
            z = z * (1 - w) + best[1] * w
        return z

    bad = 0
    print(f"{'объект / узел':<22}{'z объекта':>10}{'земля':>9}{'откл.':>8}")
    for o in objects:
        if "position" in o:
            x, y, z = o["position"]
            # у наземных объектов make_geometry ставит z = рельеф (+1 м у зданий); у отвала — рельеф
            zg = ground(x, y)
            offset = 1.0 if (z >= -50 and o["kind"] not in ("dump", "face", "excavator", "drill")) and not terrain.inside_pit(x, y) else 0.0
            dev = abs((z - offset) - zg)
            flag = "" if dev <= TOL else "  <-- ВИСИТ/УТОПЛЕН"
            if dev > TOL:
                bad += 1
            print(f"{o['id']:<22}{z:>10.1f}{zg:>9.1f}{dev:>8.1f}{flag}")
        elif "path" in o:
            for i, p in enumerate(o["path"]):
                zg = ground(p[0], p[1])
                dev = abs((p[2] - 3.0) - zg)     # конвейер на опорах +3 м
                flag = "" if dev <= TOL else "  <-- ВИСИТ/УТОПЛЕН"
                if dev > TOL:
                    bad += 1
                print(f"{o['id'] + '[' + str(i) + ']':<22}{p[2]:>10.1f}{zg:>9.1f}{dev:>8.1f}{flag}")
    for name, (x, y, z) in nodes.items():
        if terrain.inside_pit(x, y):
            continue
        zg = ground(x, y)
        dev = abs(z - zg)
        flag = "" if dev <= TOL else "  <-- ВИСИТ/УТОПЛЕН"
        if dev > TOL:
            bad += 1
        print(f"{'узел ' + name:<22}{z:>10.1f}{zg:>9.1f}{dev:>8.1f}{flag}")
    print("\nИтог:", "все объекты и наземные узлы стоят на земле (отклонение ≤ 1 м)" if bad == 0 else f"нарушений: {bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
