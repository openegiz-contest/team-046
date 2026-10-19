"""Проверка правил советника подменой данных двойников (без платформы).
Запуск из папки bozshakol/: python3 -m unittest core/tests/test_advisor_rules.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import advisor_rules as R  # noqa: E402


def base_snap():
    snap = {
        "mine": {"sim_time": "2026-01-15T10:00:00", "speed_limit": 50, "visibility": 5000,
                 "scenario_blizzard": 0, "scenario_dispatch_off": 0},
        "dispatch": {"mode": "auto", "avg_wait_excavator": 0.8, "trucks_hauling": 24, "queue_crusher": 0},
        "crusher-01": {"state": "running", "accepting": True, "stop_reason": "", "trucks_queued": 0},
        "stockpile-coarse": {"stock": 15000.0, "hours_left": 4.5, "stop_forecast": "не ожидается", "stop_expected": False},
        "plant-sulphide": {"feed_rate": 3360.7, "plan_rate": 3360.0, "feed_clay": 5.0, "plan_fulfilment": 100.0},
    }
    for i in range(1, 7):
        snap[f"excavator-{i:02d}"] = {"state": "loading", "queue": 0}
        snap[f"face-{i:02d}"] = {"ore_type": "sulphide" if i <= 3 else ("clay" if i == 4 else "waste"),
                                 "clay_pct": 5 if i <= 3 else (55 if i == 4 else 10), "recommended_destination": "crusher-01"}
    for r in ("road-ramp-1", "road-ramp-2", "road-crusher"):
        snap[r] = {"open": True}
    return snap


def history(feed, plan=3360.0, minutes=60):
    t0 = 1_000_000.0
    return [(t0 + m * 60, feed, plan) for m in range(0, minutes + 1, 5)]


class Rules(unittest.TestCase):
    def test_no_advice_in_normal_state(self):
        self.assertEqual(R.advise(base_snap(), history(3360.7)), [])

    def test_crusher_not_accepting(self):
        s = base_snap()
        s["crusher-01"].update(accepting=False, state="stopped", stop_reason="сценарий «Остановка дробилки»")
        s["stockpile-coarse"].update(hours_left=4.1, stop_forecast="12:27", stop_expected=True, stock=13800.0)
        s["dispatch"]["queue_crusher"] = 5
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "crusher")
        self.assertEqual(a[0]["priority"], "important")
        self.assertIn("Фабрика встанет в 12:27 (запас склада 4.1 ч)", a[0]["text"])
        self.assertIn("5 гружёных самосвалов", a[0]["text"])
        self.assertEqual(a[0]["target"], "kz.bozshakol:crusher-01")
        s["stockpile-coarse"]["hours_left"] = 1.5
        self.assertEqual(R.advise(s)[0]["priority"], "critical")

    def test_clay_face_substitution(self):
        # сценарий clay_face: забой face-03 стал глинистым (45 %), глина в питании выросла до 14 %
        s = base_snap()
        s["plant-sulphide"]["feed_clay"] = 14.0
        s["face-03"].update(clay_pct=45, recommended_destination="stockpile-clay")
        a = R.advise(s)
        self.assertEqual([x["id"] for x in a], ["clay"])
        self.assertIn("Забой face-03 даёт глину 45 %", a[0]["text"])
        self.assertIn("склад глинистой руды", a[0]["text"])
        self.assertEqual(a[0]["target"], "kz.bozshakol:face-03")
        self.assertIn("14.0 %", a[0]["reason"])
        self.assertIn("3.6 %", a[0]["effect"])     # 0,4 × (14 − 5)

    def test_clay_without_face(self):
        s = base_snap()
        s["plant-sulphide"]["feed_clay"] = 12.0
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "clay")
        self.assertEqual(a[0]["target"], "kz.bozshakol:plant-sulphide")
        self.assertIn("не определён", a[0]["text"])

    def test_plan_below_95_with_excavator_down(self):
        s = base_snap()
        s["excavator-02"]["state"] = "down"
        a = R.advise(s, history(2900.0))
        self.assertEqual(a[0]["id"], "plan")
        self.assertIn("86 % плана (2900 из 3360 т/ч)", a[0]["text"])
        self.assertIn("excavator-02 в аварии", a[0]["text"])
        self.assertEqual(a[0]["target"], "kz.bozshakol:excavator-02")
        # мало данных (30 мин) — совета нет
        self.assertEqual(R.advise(s, history(2900.0, minutes=30)), [])
        # план выполняется — совета нет
        self.assertEqual(R.advise(base_snap(), history(3300.0)), [])

    def test_plan_bottleneck_road_and_crusher(self):
        s = base_snap()
        s["road-ramp-2"]["open"] = False
        a = R.advise(s, history(2000.0))
        self.assertEqual(a[0]["priority"], "critical")      # 60 % < 80 %
        self.assertIn("дорога road-ramp-2 закрыта", a[0]["text"])

    def test_fleet_wait_too_long(self):
        s = base_snap()
        s["dispatch"].update(avg_wait_excavator=3.2, trucks_hauling=26)
        for i in (1, 2, 3):
            s[f"excavator-{i:02d}"]["queue"] = 3
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "fleet")
        self.assertIn("3.2 мин", a[0]["text"])
        self.assertIn("≈ 3", a[0]["text"])                  # 9 в очередях − 6 экскаваторов
        s["dispatch"]["trucks_needed"] = 20
        self.assertIn("≈ 6", R.advise(s)[0]["text"])         # 26 − 20
        s["dispatch"]["mode"] = "manual"
        self.assertEqual(R.advise(s), [])

    def test_blizzard(self):
        s = base_snap()
        s["mine"].update(scenario_blizzard=1, speed_limit=20, visibility=300)
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "blizzard")
        self.assertIn("до 20 км/ч", a[0]["text"])
        self.assertIn("на 47 %", a[0]["text"])               # 1 − 1/(0,4 + 0,6·50/20)
        self.assertIn("не меньше 4 ч (сейчас 4.5 ч)", a[0]["text"])
        self.assertEqual(a[0]["priority"], "important")
        s["stockpile-coarse"]["hours_left"] = 3.0
        self.assertEqual(R.advise(s)[0]["priority"], "critical")

    def test_order_by_level(self):
        s = base_snap()
        s["mine"].update(scenario_blizzard=1, speed_limit=20)
        s["crusher-01"].update(accepting=False, state="stopped")
        s["stockpile-coarse"]["hours_left"] = 1.0
        ids = [x["id"] for x in R.advise(s)]
        self.assertEqual(ids[0], "crusher")                  # критично (запас 1 ч) — первым
        self.assertIn("blizzard", ids)


if __name__ == "__main__":
    unittest.main()
