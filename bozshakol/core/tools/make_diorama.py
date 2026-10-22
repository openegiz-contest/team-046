"""Схема рудника (core/diorama.json): карта рудника — расстояния сжаты в 2 раза (K = 2), а здания, склады, отвал,
хвостохранилище — в реальном размере (модели в метрах, единица сцены = 1 м размера). Чтобы крупные объекты не
налезали друг на друга, у каждого комплекса сжимается только место «якоря», а соседи стоят от него на реальном
расстоянии: фабрика со складом, мельницей, флотацией и подстанцией; дробилка с точкой разгрузки, заправка, склад
глины, отвал — от своих узлов дорог. Карьер ≈ 4,4 × 1,1 км → 2 200 × 550 единиц, 13 уступов по 15 м; глубина —
с вертикальным масштабом ×1,5 к сжатой карте: 200 м → 150 единиц.

Перенос реальных координат в схему делает сцена (web/diorama.js): деление на K плюс плавные поправки по опорным
точкам (anchors) — у сдвинутых объектов окрестность сдвигается вместе с ними.

Запуск: python3 bozshakol/core/tools/make_diorama.py  (пишет bozshakol/core/diorama.json)
"""
import json
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
    {"anchor": ("node", "crusher"), "shift": [0, -30], "objects": ["crusher-01"]},
    {"anchor": ("node", "fuel-station"), "shift": [0, 0], "objects": ["fuel-station"]},
    {"anchor": ("node", "stockpile-clay"), "shift": [0, 0], "objects": ["stockpile-clay"]},
    {"anchor": ("node", "dump-waste-1"), "shift": [0, 0], "objects": ["dump-waste-1"]},
]
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
    # конвейер: от дробилки (на реальном расстоянии от неё) до склада у фабрики
    conv = real["conveyor-01"]["path"]
    cr, sp = real["crusher-01"]["position"], real["stockpile-coarse"]["position"]
    p0 = objects["crusher-01"]["position"]; pe = objects["stockpile-coarse"]["position"]
    objects["conveyor-01"]["path"] = [[round(p0[0] + conv[0][0] - cr[0], 2), round(p0[1] + conv[0][1] - cr[1], 2)],
                                      [s(conv[1][0]), s(conv[1][1])],
                                      [round(pe[0] + conv[-1][0] - sp[0], 2), round(pe[1] + conv[-1][1] - sp[1], 2)]]
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
        "extra": {"tailings": {"center": TAILINGS["center_s"], "radii": TAILINGS["radii"]}},
        "anchors": anchors,
    }
    path = os.path.join(CORE, "diorama.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("записано", path, len(nodes), "узлов,", len(objects), "объектов")


if __name__ == "__main__":
    main()
