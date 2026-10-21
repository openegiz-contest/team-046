"""Схема рудника (core/diorama.json): карта рудника в масштабе 1 : 3 — расстояния и размеры объектов
сжаты одинаково (K = 3), взаимное расположение — как в geometry.json. Карьер ≈ 4,4 × 1,1 км → ≈ 1 467 × 367 единиц,
13 уступов по 15 м; глубина — с вертикальным масштабом ×1,5 (как в «Карте местности»): 200 м → 100 единиц.
Здания, склады, отвал, дробилка — в масштабе 1 : 3 (множитель scale для моделей в метрах); подвижная техника
крупнее зданий не больше чем в 2,5 раза — это задаёт сцена (web/app.js, MACHINE_SCALE).

Перенос реальных координат в схему делает сцена (web/diorama.js); при одинаковом сжатии он сводится к делению
на K, но тот же код продолжает работать и с неравномерной раскладкой (опорные точки anchors).

Запуск: python3 bozshakol/core/tools/make_diorama.py  (пишет bozshakol/core/diorama.json)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.dirname(HERE)

K = 3.0                 # во сколько раз сжаты расстояния и размеры
VZ = 1.5                # вертикальный масштаб (как в «Карте местности»)
# Окружение схемы (в geometry.json его нет): хвостохранилище к западу от фабрики (реальные м)
TAILINGS = {"center": [-4050, 250], "radii": [1000, 700]}
# Объекты в метрах (модели слоёв): в схеме — масштаб 1 : K
SCALED = {"crusher-01", "stockpile-coarse", "plant-sulphide", "sag-mill-01", "flotation-01", "stockpile-clay",
          "plant-clay", "power-grid", "fuel-station", "dump-waste-1"}


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
    objects = {}
    for o in g["objects"]:
        if "path" in o:
            objects[o["id"]] = {"path": [[s(p[0]), s(p[1])] for p in o["path"]]}
        else:
            objects[o["id"]] = {"position": [s(o["position"][0]), s(o["position"][1])],
                                "scale": round(1 / K, 4) if o["id"] in SCALED else 1.0}
    # опорные точки поверхности (реальные м → схема): при одинаковом сжатии — углы области
    anchors = [[x, y, s(x), s(y)] for x in (-7200, -2000, 3000, 6000) for y in (-4800, -1000, 1500, 3900)]
    out = {
        "_comment": "Схема рудника в масштабе 1 : 3 (расстояния и размеры объектов), вертикальный масштаб ×1,5: "
                    "места узлов дорог и объектов geometry.json в единицах сцены. Генератор — core/tools/make_diorama.py; "
                    "перенос координат — web/diorama.js.",
        "units": "единицы сцены = 3 м местности; x — восток, y — север, z — высота",
        "scale": K,
        "bounds": [-2400, -1600, 2000, 1300],
        "pit": dict(pit, z_scale=round(kz, 5)),
        "nodes": nodes,
        "objects": objects,
        "extra": {"tailings": {"center": [s(TAILINGS["center"][0]), s(TAILINGS["center"][1])],
                               "radii": [s(TAILINGS["radii"][0]), s(TAILINGS["radii"][1])],
                               "real_center": TAILINGS["center"]}},
        "anchors": anchors,
    }
    path = os.path.join(CORE, "diorama.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("записано", path, len(nodes), "узлов,", len(objects), "объектов")


if __name__ == "__main__":
    main()
