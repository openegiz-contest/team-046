"""Схема рудника (core/diorama.json): карта рудника — расстояния сжаты в 2 раза (K = 2), а здания, склады, отвал,
хвостохранилище — в реальном размере (модели в метрах, единица сцены = 1 м размера). Чтобы крупные объекты не
налезали друг на друга, у каждого комплекса сжимается только место «якоря», а соседи стоят от него на реальном
расстоянии: фабрика со складом, мельницей, флотацией и подстанцией; дробилка с точкой разгрузки, заправка, склад
глины, отвал — от своих узлов дорог. Карьер ≈ 4,4 × 1,1 км → 2 200 × 550 единиц, 13 уступов по 15 м; глубина —
с вертикальным масштабом ×1,5 к сжатой карте: 200 м → 150 единиц.

Перенос реальных координат в схему делает сцена (web/diorama.js): деление на K плюс плавные поправки по опорным
точкам (anchors) — у сдвинутых объектов окрестность сдвигается вместе с ними.

Съезды в схеме — не зигзаг реального карьера, а одна непрерывная спираль вдоль борта: от верхнего узла на борту
вниз с постоянным уклоном GRADE, с ровной площадкой ±LAND у развилки к забою на уступе (узлы *-mid2 и face-05/06);
отступ от борта растёт вместе с глубиной (полотно идёт по среднему профилю уступов). Узлы съезда стоят на спирали на
своей глубине; точки трассы каждого ребра — в "paths" (ключ «откуда>куда», как в geometry.edges), сцена ведёт по ним
полотно и технику. Модель (geometry.json) и схема — одна сеть дорог: те же узлы и рёбра, а длины рёбер в схеме
пропорциональны длинам модели — уклон GRADE подобран так, что спираль кончается у западного (восточного) края дна,
рядом с узлом дна floor-w (floor-e2), и самосвал на съезде и на подходе к нему идёт с одним и тем же масштабом
скорости (проверка — core/tools/motion_check: без телепортов на стыке съезда с дном).

Запуск: python3 bozshakol/core/tools/make_diorama.py  (пишет bozshakol/core/diorama.json)
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.dirname(HERE)

K = 2.0                 # во сколько раз сжаты расстояния
VZ = 1.5                # вертикальный масштаб к сжатой карте
# Хвостохранилище (в geometry.json его нет): реальный размер, место в схеме — к западу от фабрики, где свободно
TAILINGS = {"center_s": [-2750, 330], "radii": [1000, 700]}
# Комплексы: якорь (объект или узел) → соседи на реальном расстоянии от него (+ сдвиг якоря в схеме, единицы)
CLUSTERS = [
    {"anchor": ("obj", "plant-sulphide"), "shift": [-120, 0],   # комплекс — западнее: склад не тянется к карьеру
     "objects": ["sag-mill-01", "flotation-01", "power-grid"], "extra": {"stockpile-coarse": [20, 0]}},
    {"anchor": ("node", "fuel-station"), "shift": [0, 0], "objects": ["fuel-station"]},
    {"anchor": ("node", "stockpile-clay"), "shift": [0, 0], "objects": ["stockpile-clay"]},
    {"anchor": ("node", "dump-waste-1"), "shift": [0, 0], "objects": ["dump-waste-1"]},
]
# Съезды: узлы сверху вниз, направление обхода борта (−1 — по часовой стрелке, на запад), забой на уступе у *-mid2
# Дробилка врезана в землю: площадка разгрузки вровень с землёй, бункер в центре; самосвал встаёт с запада задом
# к бункеру (узел crusher — точка разгрузки), лента выходит из портала подземной галереи к юго-западу
CRUSHER_S = [-108.0, -305.0]
DUMP_FROM_CRUSHER = [-19.0, 0.0]
PORTAL_FROM_CRUSHER = [-65.0, -35.0]
DUMP_TOE_GAP = 15.0     # единицы: точка разгрузки на отвале — за подошвой отвала (отвал в реальном размере)
RAMPS = {"road-ramp-1": (["r1-top", "r1-mid2", "r1-mid1", "r1-bottom"], -1, ("face-05", "excavator-05")),
         "road-ramp-2": (["r2-top", "r2-mid2", "r2-mid1", "r2-bottom"], +1, ("face-06", "excavator-06"))}
GRADE = 0.16            # уклон съезда в схеме (длины звеньев съезда — ≈ 0,35 от модели, подход ко дну — ≈ 0,45)
LAND = 30.0             # единицы: полудлина ровной площадки на съезде у развилки к забою на уступе
VCURVE = 15.0           # единицы: полудлина сглаживания перелома уклона съезда
LAND_BOTTOM = 40.0      # единицы: внизу съезд выходит на уровень дна раньше узла (стык с дорогой дна — ровный)
LAND_TOP = 60.0         # единицы: наверху съезд сначала идёт ровно на уровне борта, уходя от кромки внутрь
FACE_OFF = -30.0        # единицы: центр площадки забоя на уступе — от оси съезда к борту (врезана в стенку, экскаватор работает в забой)
EXC_TO_ROAD = 0.4       # доля пути от забоя к оси съезда, где стоит экскаватор забоя на уступе
LAND_BUMP, LAND_BUMP_LEN = 22.0, 160.0   # у развилки съезд уходит на 22 единицы глубже в карьер (место для площадки забоя)
PATH_STEP = 4.0         # единицы: шаг точек трассы
ENTRY_INS, ENTRY_LEN = 28.0, 140.0   # у борта: ось съезда на отступе ≥ 28 (полуширина 16 + 12 на откос), плавно за 140 единиц


def smooth01(v):
    v = max(0.0, min(1.0, v)); return v * v * (3 - 2 * v)
SHIFT_OBJ = {"plant-clay": [0, -35]}      # глинистая фабрика — чуть южнее, от дороги к складу глины
SHIFT_NODE = {"rim-ne": [0, -30]}         # узел у дробилки — вслед за ней


def s(v):
    return round(v / K, 2)


def main():
    g = json.load(open(os.path.join(CORE, "geometry.json"), encoding="utf-8"))
    gp = g["pit"]
    A, B = gp["semi_axes_top"]
    kz = VZ / K
    inside = lambda x, y: (x / A) ** 2 + (y / B) ** 2 < 1
    pit = {"center": [s(gp["center"][0]), s(gp["center"][1])], "semi_axes": [s(A), s(B)],
           "benches": gp["bench_count"], "bench_height": round(gp["depth"] * kz / gp["bench_count"], 4),
           "inset": round(gp["inset_per_bench"] / K, 4), "berm": round(gp["berm_width"] / K, 4)}
    nodes = {n: [s(x), s(y), round(z * kz, 2) if inside(x, y) else 0.0] for n, (x, y, z) in g["nodes"].items()}
    for n, (dx, dy) in SHIFT_NODE.items():
        nodes[n][0] += dx; nodes[n][1] += dy
    real = {o["id"]: o for o in g["objects"]}
    objects = {}
    for o in g["objects"]:
        if "path" in o:
            objects[o["id"]] = {"path": [[s(p[0]), s(p[1])] for p in o["path"]]}
        else:
            objects[o["id"]] = {"position": [s(o["position"][0]), s(o["position"][1])], "scale": 1.0}
    for oid, (dx, dy) in SHIFT_OBJ.items():
        objects[oid]["position"][0] += dx; objects[oid]["position"][1] += dy
    # комплексы: якорь сжат, соседи — на реальном расстоянии
    for c in CLUSTERS:
        kind, aid = c["anchor"]
        ra = real[aid]["position"][:2] if kind == "obj" else g["nodes"][aid][:2]
        sa = [s(ra[0]) + c["shift"][0], s(ra[1]) + c["shift"][1]]
        if kind == "obj":
            objects[aid]["position"] = [round(sa[0], 2), round(sa[1], 2)]
        else:
            nodes[aid][0], nodes[aid][1] = round(sa[0], 2), round(sa[1], 2)
        members = {oid: [0, 0] for oid in c.get("objects", [])}
        members.update(c.get("extra", {}))
        for oid, (ex, ey) in members.items():
            rp = real[oid]["position"]
            objects[oid]["position"] = [round(sa[0] + rp[0] - ra[0] + ex, 2), round(sa[1] + rp[1] - ra[1] + ey, 2)]
    # дробилка и точка разгрузки (см. CRUSHER_S); конвейер — от портала галереи до склада у фабрики
    objects["crusher-01"]["position"] = CRUSHER_S[:]
    nodes["crusher"][0], nodes["crusher"][1] = CRUSHER_S[0] + DUMP_FROM_CRUSHER[0], CRUSHER_S[1] + DUMP_FROM_CRUSHER[1]
    conv = real["conveyor-01"]["path"]
    sp = real["stockpile-coarse"]["position"]
    pe = objects["stockpile-coarse"]["position"]
    objects["conveyor-01"]["path"] = [[CRUSHER_S[0] + PORTAL_FROM_CRUSHER[0], CRUSHER_S[1] + PORTAL_FROM_CRUSHER[1]],
                                      [s(conv[1][0]), s(conv[1][1])],
                                      [round(pe[0] + conv[-1][0] - sp[0], 2), round(pe[1] + conv[-1][1] - sp[1], 2)]]
    # отвал: точка разгрузки — у подошвы (в том же направлении от неё, что и в жизни), а не под телом отвала
    dn, do_, rr = nodes["dump-waste-1"], objects["dump-waste-1"]["position"], real["dump-waste-1"].get("radius", 200)
    vx, vy = do_[0] - dn[0], do_[1] - dn[1]; vl = math.hypot(vx, vy) or 1.0
    objects["dump-waste-1"]["position"] = [round(dn[0] + vx / vl * (rr + DUMP_TOE_GAP), 2), round(dn[1] + vy / vl * (rr + DUMP_TOE_GAP), 2)]
    # съезды — спирали вдоль борта (точки трасс рёбер — в paths), забои на уступах — у площадки на съезде
    paths = ramps_on_wall(g, pit, nodes, objects)
    # опорные точки переноса: углы области (сжатие ×1/K) и места объектов (их сдвиг тянет окрестность)
    anchors = [[x, y, s(x), s(y)] for x in (-9000, -4000, 0, 4000, 8000) for y in (-6000, -2500, 2000, 5000)]
    for o in g["objects"]:
        if "position" in o and not o["id"].startswith(("face-", "excavator-", "drill-")):
            p = objects[o["id"]]["position"]
            anchors.append([o["position"][0], o["position"][1], p[0], p[1]])
    for n in ("crusher", "fuel-station", "stockpile-clay", "dump-waste-1", "rim-ne"):
        anchors.append([g["nodes"][n][0], g["nodes"][n][1], nodes[n][0], nodes[n][1]])
    out = {
        "_comment": "Схема рудника: расстояния сжаты в 2 раза, здания, склады, отвал, хвостохранилище — в реальном "
                    "размере (комплексы стоят на реальном расстоянии от своего якоря), вертикальный масштаб ×1,5. "
                    "Генератор — core/tools/make_diorama.py; перенос координат — web/diorama.js.",
        "units": "единица сцены: по карте — 2 м местности, для размеров моделей — 1 м; x — восток, y — север, z — высота",
        "scale": K,
        "bounds": [-4100, -1350, 2100, 1350],
        "pit": dict(pit, z_scale=round(kz, 5)),
        "nodes": nodes,
        "objects": objects,
        "paths": paths,
        "extra": {"tailings": {"center": TAILINGS["center_s"], "radii": TAILINGS["radii"]}},
        "anchors": anchors,
    }
    path = os.path.join(CORE, "diorama.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("записано", path, len(nodes), "узлов,", len(objects), "объектов")


def ramps_on_wall(g, pit, nodes, objects):
    """Спираль съезда: от угла верхнего узла по борту вниз, отступ от борта = глубина × Ds / глубину карьера."""
    cx, cy = pit["center"]; a, b = pit["semi_axes"]
    Ds = pit["benches"] * pit["inset"]; depth = pit["benches"] * pit["bench_height"]
    ring = lambda ins, t: (cx + (a - ins) * math.cos(t), cy + (b - ins) * math.sin(t))
    paths = {}
    for road, (names, sgn, (face, exc)) in RAMPS.items():
        top, mid2, mid1, bot = names
        z2, z1 = nodes[mid2][2], nodes[mid1][2]
        s_l0 = LAND_TOP - z2 / GRADE; s2 = s_l0 + LAND; s_l1 = s_l0 + 2 * LAND
        s1 = s_l1 + (z2 - z1) / GRADE; s_end = s1 + (z1 + depth) / GRADE + LAND_BOTTOM   # внизу — ровный выход на дно

        def z_lin(sv):
            if sv <= s_l0: return -GRADE * max(0.0, sv - LAND_TOP)
            if sv <= s_l1: return z2
            return max(-depth, z2 - GRADE * (sv - s_l1))

        def z_at(sv):   # переломы уклона сглажены (вертикальные кривые ±VCURVE): корпус самосвала не повисает на изломе
            return sum(z_lin(sv + VCURVE * (k / 5.0)) for k in range(-5, 6)) / 11.0
        # у борта полотно сразу уходит внутрь на ENTRY_INS (внешний край не ближе 12 к кромке), дальше — по профилю
        def ins_at(sv):   # гладкий максимум (без изломов трассы в плане); у развилки к забою — глубже в карьер
            avg, ent = -z_at(sv) * Ds / depth, ENTRY_INS * smooth01(sv / ENTRY_LEN)
            bump = LAND_BUMP * (1 - smooth01(abs(sv - s2) / LAND_BUMP_LEN))
            return min(Ds, (avg + ent + math.hypot(avg - ent, 8.0)) / 2 + bump)
        tx, ty = nodes[top][0], nodes[top][1]
        t = math.atan2((ty - cy) / b, (tx - cx) / a)
        pts, sv, h, nxt = [], 0.0, 0.25, 0.0
        marks = {s2: mid2, s1: mid1, s_end: bot}
        while True:
            ins = ins_at(sv)
            if sv >= nxt - 1e-9 or any(abs(sv - m) < h / 2 for m in marks):
                x, y = ring(ins, t)
                if pts and abs(sv - pts[-1][3]) < 1.0:
                    pts.pop()   # точка узла рядом с обычной — оставляем одну (без отрезков нулевой длины)
                pts.append([round(x, 2), round(y, 2), round(z_at(sv), 2), round(sv, 2)])
                nxt = sv + PATH_STEP
            if sv >= s_end - 1e-9: break
            speed = math.hypot((a - ins) * math.sin(t), (b - ins) * math.cos(t)) or 1.0
            t += sgn * h / speed; sv = min(s_end, sv + h)
        # узлы съезда — на спирали; узел верха остаётся на борту (к нему — прямой подход от спирали)
        def at(sm):
            q = min(pts, key=lambda p: abs(p[3] - sm)); return [q[0], q[1], q[2]]
        for sm, n in marks.items():
            nodes[n] = at(sm)
        # забой на уступе — у площадки, к центру карьера; экскаватор — на том же месте относительно забоя
        q = min(pts, key=lambda p: abs(p[3] - s2))
        ins = ins_at(s2); t2 = math.atan2((q[1] - cy) / (b - ins), (q[0] - cx) / (a - ins))
        p0, p1 = ring(ins, t2), ring(ins + 1.0, t2)
        nx, ny = p1[0] - p0[0], p1[1] - p0[1]; ln = math.hypot(nx, ny) or 1.0
        fx, fy = round(q[0] + nx / ln * FACE_OFF, 2), round(q[1] + ny / ln * FACE_OFF, 2)
        ex, ey = objects[exc]["position"][0] - objects[face]["position"][0], objects[exc]["position"][1] - objects[face]["position"][1]
        nodes[face] = [fx, fy, z2]
        objects[face]["position"] = [fx, fy]
        # экскаватор — между развалом у стенки и полотном съезда (корпус на площадке, не в стенке)
        objects[exc]["position"] = [round(fx + ex - nx / ln * FACE_OFF * EXC_TO_ROAD, 2), round(fy + ey - ny / ln * FACE_OFF * EXC_TO_ROAD, 2)]
        # трассы рёбер (в направлении geometry.edges)
        seg = lambda s_a, s_b: [p[:3] for p in pts if min(s_a, s_b) - 0.01 <= p[3] <= max(s_a, s_b) + 0.01]
        for e in g["edges"]:
            if e.get("road") != road: continue
            sa_ = {top: 0.0, mid2: s2, mid1: s1, bot: s_end}[e["from"]]
            sb_ = {top: 0.0, mid2: s2, mid1: s1, bot: s_end}[e["to"]]
            pl = seg(sa_, sb_)
            if sa_ > sb_: pl = pl[::-1]
            if e["from"] == top: pl = [nodes[top][:3]] + pl
            if e["to"] == top: pl = pl + [nodes[top][:3]]
            paths[e["from"] + ">" + e["to"]] = pl
    return paths


if __name__ == "__main__":
    main()
