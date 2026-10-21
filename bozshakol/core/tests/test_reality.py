"""Сверка с реальностью (core/reality.py). Запуск: cd bozshakol/core && python3 -m unittest tests.test_reality"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import reality as R  # noqa: E402


def snap(**over):
    s = {"plant-sulphide": {"feed_rate": 3360.0, "feed_cu": 0.40, "recovery": 75.0, "cu_year_pace": 88.0},
         "plant-clay": {"feed_rate": 715.0, "feed_cu": 0.31, "recovery": 60.0, "cu_year_pace": 11.6},
         "dispatch": {"mode": "auto", "avg_wait_excavator": 1.2}}
    for k, v in over.items():
        s[k].update(v)
    return s


def series(minutes, **over):
    v = R.sample_values(snap(**over))
    return [(i * 60.0, v) for i in range(minutes + 1)]


class RealityTest(unittest.TestCase):
    def rows(self, samples):
        rows, meta = R.reality_rows(samples)
        return {r["id"]: r for r in rows}, meta

    def test_full_hour_within_tolerance(self):
        r, meta = self.rows(series(70))
        self.assertFalse(meta["warmup"])
        self.assertEqual(r["feed_sulphide"]["status"], "ok")
        self.assertAlmostEqual(r["feed_sulphide"]["dev_pct"], 0.0, places=1)
        self.assertAlmostEqual(r["cu_grade"]["model"], (3360 * 0.40 + 715 * 0.31) / 4075, places=3)
        self.assertEqual(r["wait_excavator"]["dev_pct"], 0.0)          # 1,2 мин внутри 1–1,5
        self.assertAlmostEqual(r["cu_kt_year"]["model"], 99.6, places=1)

    def test_no_energy_published_is_no_data(self):
        r, _ = self.rows(series(70))
        self.assertEqual(r["energy_kwh_t"]["status"], "no_data")
        self.assertIsNone(r["energy_kwh_t"]["model"])
        r, _ = self.rows(series(70, **{"plant-sulphide": {"specific_energy": 24.0}}))
        self.assertEqual(r["energy_kwh_t"]["status"], "off")             # 24 против 26,9: −10,8 %
        self.assertAlmostEqual(r["energy_kwh_t"]["dev_pct"], -10.8, places=1)

    def test_warmup_first_hour(self):
        r, meta = self.rows(series(30))
        self.assertTrue(meta["warmup"])
        self.assertEqual(r["feed_sulphide"]["status"], "warmup")

    def test_wait_outside_range_and_manual_mode(self):
        r, _ = self.rows(series(70, dispatch={"avg_wait_excavator": 3.0}))
        self.assertEqual(r["wait_excavator"]["status"], "off")
        self.assertAlmostEqual(r["wait_excavator"]["dev_pct"], 100.0, places=1)   # 3,0 против верхней границы 1,5
        r, _ = self.rows(series(70, dispatch={"mode": "manual"}))
        self.assertEqual(r["wait_excavator"]["status"], "no_data")             # в «ручном» не сравниваем

    def test_every_row_has_source(self):
        for row in R.ROWS:
            self.assertTrue(row[5])


if __name__ == "__main__":
    unittest.main()
