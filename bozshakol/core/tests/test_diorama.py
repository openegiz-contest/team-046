"""Схема рудника (core/diorama.json) согласована с geometry.json: те же узлы и объекты, всё внутри макета,
узлы карьера — внутри схематичного карьера, наземные — снаружи. Запуск: python3 -m unittest tests.test_diorama"""
import json
import os
import unittest

CORE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    with open(os.path.join(CORE, name), encoding="utf-8") as fh:
        return json.load(fh)


class DioramaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = load("geometry.json")
        cls.d = load("diorama.json")

    def inside(self, x, y):
        x0, y0, x1, y1 = self.d["bounds"]
        return x0 <= x <= x1 and y0 <= y <= y1

    def test_same_nodes(self):
        self.assertEqual(set(self.g["nodes"]), set(self.d["nodes"]))

    def test_same_objects(self):
        self.assertEqual({o["id"] for o in self.g["objects"]}, set(self.d["objects"]))

    def test_inside_bounds(self):
        for n, (x, y, _) in self.d["nodes"].items():
            self.assertTrue(self.inside(x, y), n)
        for oid, o in self.d["objects"].items():
            for p in ([o["position"]] if "position" in o else o.get("path", [])):
                self.assertTrue(self.inside(*p), oid)

    def test_pit_nodes_in_schematic_pit(self):
        A, B = self.g["pit"]["semi_axes_top"]
        cx, cy = self.d["pit"]["center"]
        a, b = self.d["pit"]["semi_axes"]
        for n, (x, y, z) in self.g["nodes"].items():
            xs, ys, zs = self.d["nodes"][n]
            in_real = (x / A) ** 2 + (y / B) ** 2 < 1
            in_schema = ((xs - cx) / a) ** 2 + ((ys - cy) / b) ** 2 < 1
            self.assertEqual(in_real, in_schema, n)
            if in_real:
                self.assertAlmostEqual(zs, z * self.d["pit"]["z_scale"], places=1)

    def test_order_along_conveyor_and_sides(self):
        o = self.d["objects"]
        # с востока на запад: дробилка → склад крупнодроблёной руды → сульфидная фабрика
        self.assertGreater(o["crusher-01"]["position"][0], o["stockpile-coarse"]["position"][0])
        self.assertGreater(o["stockpile-coarse"]["position"][0], o["plant-sulphide"]["position"][0])
        # отвал — к востоку от карьера, фабрика глинистой руды — к югу
        self.assertGreater(o["dump-waste-1"]["position"][0], self.d["pit"]["center"][0] + self.d["pit"]["semi_axes"][0] * 0.5)
        self.assertLess(o["plant-clay"]["position"][1], self.d["pit"]["center"][1] - self.d["pit"]["semi_axes"][1])

    def test_compression_about_2(self):
        # расстояния между узлами и объектами сжаты примерно в 2 раза: не больше 2,1 (крупные объекты в реальном
        # размере стоят от соседей своего комплекса на реальном расстоянии — это чуть меняет сжатие до других)
        # съезды в схеме — спирали вдоль борта (не зигзаг реального карьера): их узлы, забои на уступах у площадок
        # съездов и экскаваторы этих забоев стоят по трассе, а не по сжатию — их проверяет test_ramp_paths
        spiral = {n for e in self.g["edges"] if e.get("road", "").startswith("road-ramp") for n in (e["from"], e["to"])}
        spiral |= {"face-05", "face-06", "excavator-05", "excavator-06"}
        pts = {n: (x, y, self.d["nodes"][n][0], self.d["nodes"][n][1]) for n, (x, y, _) in self.g["nodes"].items() if n not in spiral}
        for o in self.g["objects"]:
            if "position" in o and o["id"] not in spiral:
                pts[o["id"]] = (o["position"][0], o["position"][1]) + tuple(self.d["objects"][o["id"]]["position"])
        keys = sorted(pts)
        for i, k1 in enumerate(keys):
            for k2 in keys[i + 1:]:
                x1, y1, s1, t1 = pts[k1]; x2, y2, s2, t2 = pts[k2]
                real = ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5
                if real < 50:
                    continue
                sch = ((s1 - s2) ** 2 + (t1 - t2) ** 2) ** 0.5
                self.assertLessEqual(real / sch, 2.1, (k1, k2))

    def test_buildings_real_size_apart(self):
        # фабрика, склад и подстанция — на реальном расстоянии друг от друга (здания в реальном размере не налезают)
        o, r = self.d["objects"], {x["id"]: x["position"] for x in self.g["objects"] if "position" in x}
        for a, b in (("plant-sulphide", "power-grid"), ("plant-sulphide", "sag-mill-01"), ("crusher-01", "plant-sulphide")):
            real = ((r[a][0] - r[b][0]) ** 2 + (r[a][1] - r[b][1]) ** 2) ** 0.5
            sch = ((o[a]["position"][0] - o[b]["position"][0]) ** 2 + (o[a]["position"][1] - o[b]["position"][1]) ** 2) ** 0.5
            if a == "crusher-01":
                self.assertAlmostEqual(real / sch, 2.0, delta=0.25)
            else:
                self.assertAlmostEqual(sch, real, delta=1)
        self.assertEqual(self.d["scale"], 2.0)
        for oid in ("plant-sulphide", "stockpile-coarse", "dump-waste-1", "crusher-01"):
            self.assertEqual(o[oid]["scale"], 1.0, oid)

    def test_ramp_paths(self):
        # трасса каждого ребра съезда: от узла до узла, без отрезков нулевой длины, уклон не круче 11 %,
        # точки трассы внутри карьера (кроме подхода к верхнему узлу за бортом)
        P = self.d["pit"]; a, b = P["semi_axes"]; cx, cy = P["center"]
        for e in self.g["edges"]:
            if not e.get("road", "").startswith("road-ramp"):
                continue
            pl = self.d["paths"][e["from"] + ">" + e["to"]]
            self.assertEqual(pl[0][:2], self.d["nodes"][e["from"]][:2], e)
            self.assertEqual(pl[-1][:2], self.d["nodes"][e["to"]][:2], e)
            for p, q in zip(pl, pl[1:]):
                L = ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2) ** 0.5
                self.assertGreater(L, 0.5, e)
                self.assertLessEqual(abs(q[2] - p[2]) / L, 0.11, (e, p, q))
            inside = [((p[0] - cx) / a) ** 2 + ((p[1] - cy) / b) ** 2 < 1.0 for p in pl]
            self.assertGreaterEqual(sum(inside), len(pl) - 2, e)


if __name__ == "__main__":
    unittest.main()
