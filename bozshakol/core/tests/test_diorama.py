"""Схема-макет (core/diorama.json) согласована с geometry.json: те же узлы и объекты, всё внутри макета,
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

    def test_compression_at_most_3(self):
        # расстояния между узлами и объектами сжаты не больше чем в 3 раза от реальных
        pts = {n: (x, y, self.d["nodes"][n][0], self.d["nodes"][n][1]) for n, (x, y, _) in self.g["nodes"].items()}
        for o in self.g["objects"]:
            if "position" in o:
                pts[o["id"]] = (o["position"][0], o["position"][1]) + tuple(self.d["objects"][o["id"]]["position"])
        keys = sorted(pts)
        for i, k1 in enumerate(keys):
            for k2 in keys[i + 1:]:
                x1, y1, s1, t1 = pts[k1]; x2, y2, s2, t2 = pts[k2]
                real = ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5
                if real < 50:
                    continue
                sch = ((s1 - s2) ** 2 + (t1 - t2) ** 2) ** 0.5
                self.assertLessEqual(real / sch, 3.0 + 1e-3, (k1, k2))


if __name__ == "__main__":
    unittest.main()
