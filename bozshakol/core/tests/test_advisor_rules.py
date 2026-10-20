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


def history(feed, plan=3360.0, minutes=60, inflow=None):
    t0 = 1_000_000.0
    return [(t0 + m * 60, feed, plan, feed if inflow is None else inflow) for m in range(0, minutes + 1, 5)]


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

    def test_crusher_bunker_full_is_info_only(self):
        s = base_snap()
        s["crusher-01"].update(accepting=False, state="running", stop_reason="", bunker=760.0, capacity=4500.0)
        s["dispatch"]["queue_crusher"] = 2
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "crusher")
        self.assertEqual(a[0]["priority"], "info")
        self.assertIn("бункер полон (760 т)", a[0]["text"])
        self.assertNotIn("Фабрика встанет", a[0]["text"])

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

    def test_clay_face_scenario_marked_as_clay(self):
        # геология при clay_face помечает забой как clay и рекомендует склад глины; глина в питании ещё в норме
        s = base_snap()
        s["mine"]["scenario_clay_face"] = 1
        s["scenarios_params"] = {"clay_face": {"value": True, "face": "face-03", "clay_pct": 45}}
        s["face-03"].update(ore_type="clay", clay_pct=45, recommended_destination="stockpile-clay")
        a = R.advise(s)
        self.assertEqual([x["id"] for x in a], ["clay"])
        self.assertEqual(a[0]["priority"], "info")
        self.assertIn("Забой face-03 даёт глину 45 %", a[0]["text"])
        self.assertIn("Геология уже рекомендует склад глины", a[0]["text"])
        # два гружёных самосвала этого забоя ещё везут руду на дробилку — «важно»
        s["truck-05"] = {"state": "hauling", "excavator": "excavator-03", "destination": "crusher-01", "payload": 135}
        s["truck-07"] = {"state": "queued_dump", "excavator": "excavator-03", "destination": "crusher-01", "payload": 135}
        a = R.advise(s)
        self.assertEqual(a[0]["priority"], "important")
        self.assertIn("Сейчас 2 гружёных самосвалов этого забоя везут руду на дробилку", a[0]["text"])
        # сценарий включён, но геология ещё не обновила забой и глина в питании в норме — совета нет
        s2 = base_snap(); s2["mine"]["scenario_clay_face"] = 1
        s2["scenarios_params"] = {"clay_face": {"value": True, "face": "face-03", "clay_pct": 45}}
        s2["face-03"]["clay_pct"] = 3; s2["plant-sulphide"]["feed_clay"] = 4.0
        self.assertEqual(R.advise(s2), [])
        # сценарий выключен — совета нет
        s["mine"]["scenario_clay_face"] = 0
        s["face-03"].update(ore_type="sulphide", clay_pct=5)
        self.assertEqual(R.advise(s), [])

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
        # ремонт мельницы распознаётся как причина
        s2 = base_snap(); s2["mine"]["scenario_sag_maintenance"] = 1
        a2 = R.advise(s2, history(0.0))
        self.assertIn("мельница на ремонте", a2[0]["text"])
        self.assertEqual(a2[0]["target"], "kz.bozshakol:sag-mill-01")
        # первый модельный час (30 мин данных) — «рудник разгоняется», правила привоза молчат
        a = R.advise(s, history(2900.0, minutes=30))
        self.assertEqual([x["id"] for x in a], ["warmup"])
        self.assertEqual(a[0]["priority"], "info")
        self.assertIn("рудник разгоняется", a[0]["text"])
        # план выполняется — совета нет
        self.assertEqual(R.advise(base_snap(), history(3300.0)), [])

    def test_plan_bottleneck_road_and_crusher(self):
        s = base_snap()
        s["road-ramp-2"]["open"] = False
        a = R.advise(s, history(2000.0))
        self.assertEqual(a[0]["priority"], "critical")      # 60 % < 80 %
        self.assertIn("дорога road-ramp-2 закрыта", a[0]["text"])

    def test_inflow_below_plan_while_plant_on_stockpile(self):
        # экскаватор в аварии: фабрика ещё идёт по плану со склада, но привоз на дробилку упал
        s = base_snap()
        s["excavator-02"]["state"] = "down"
        a = R.advise(s, history(3360.7, inflow=2800.0))
        self.assertEqual([x["id"] for x in a], ["inflow"])
        self.assertIn("83 % плана (2800 из 3360 т/ч)", a[0]["text"])
        self.assertIn("хватит на 4.5 ч", a[0]["text"])
        self.assertIn("excavator-02 в аварии", a[0]["text"])
        self.assertEqual(a[0]["priority"], "info")
        # привоз в норме — совета нет
        self.assertEqual(R.advise(s, history(3360.7, inflow=4200.0)), [])
        # авария устранена, последние 15 мин привоз в норме — совет снят, хотя среднее за час ещё 84 %
        s["excavator-02"]["state"] = "loading"
        h = history(3360.7, inflow=2800.0)
        h = [(t, f, p, 4100.0 if t >= h[-1][0] - 900 else i) for (t, f, p, i) in h]
        self.assertEqual(R.advise(s, h), [])

    def test_inflow_with_reserve(self):
        # недовоз руды, 4 самосвала в резерве, модуль транспорта считает нужными 19 при 16 в работе (без очередей) — вернуть 3
        s = base_snap()
        s["dispatch"].update(trucks_reserve=4, trucks_needed=19.0)
        states = ["hauling"] * 8 + ["returning"] * 4 + ["loading"] * 4 + ["queued_load"] * 4 + ["reserve"] * 4
        for i, st in enumerate(states, 1):
            s[f"truck-{i:02d}"] = {"state": st, "speed": 25.0}
        a = R.advise(s, history(3360.7, inflow=2400.0))
        self.assertEqual(a[0]["id"], "inflow")
        self.assertEqual(a[0]["priority"], "info")                # фабрика идёт со склада на план
        self.assertIn("в резерве 4 самосвалов при нехватке руды — вернуть 3 в работу", a[0]["text"])
        self.assertIn("хватит на 4.5 ч", a[0]["text"])
        self.assertEqual(a[0]["target"], "kz.bozshakol:dispatch")
        # самосвалы долго ждут у экскаваторов — «вернуть из резерва» не советуем (противоречило бы совету о лишних)
        s["dispatch"]["avg_wait_excavator"] = 5.6
        txt = " ".join(x["text"] for x in R.advise(s, history(3360.7, inflow=2400.0)))
        self.assertNotIn("вернуть", txt)
        self.assertIn("узкое место погрузка", txt)

    def test_fleet_wait_too_long(self):
        s = base_snap()
        s["dispatch"].update(avg_wait_excavator=3.2, trucks_hauling=26)
        for i in (1, 2, 3):
            s[f"excavator-{i:02d}"]["queue"] = 3
        a = R.advise(s)
        self.assertEqual(a[0]["id"], "fleet")
        self.assertEqual(a[0]["target"], "kz.bozshakol:excavator-01")   # объект в сцене: экскаватор с очередью
        self.assertIn("3.2 мин", a[0]["text"])
        self.assertIn("≈ 3", a[0]["text"])                  # 9 в очередях − 6 экскаваторов (нет данных модуля №2)
        s["dispatch"]["trucks_needed"] = 20                 # только trucks_needed — прежняя оценка по очередям
        self.assertIn("≈ 3", R.advise(s)[0]["text"])
        s["dispatch"]["trucks_reserve"] = 2                 # модуль №2 публикует оба признака: K = в работе − нужно
        a = R.advise(s)
        self.assertIn("≈ 6", a[0]["text"])                  # нет двойников truck-*: в работе = trucks_hauling = 26; 26 − 20
        self.assertIn("в резерве уже 2", a[0]["reason"])
        # двойники truck-*: 24 в цикле (в пути только 10), 2 в резерве, 2 на заправке — в работе 24, а не 10
        states = ["hauling"] * 6 + ["returning"] * 4 + ["loading"] * 5 + ["queued_load"] * 6 + ["dumping"] * 3 + ["reserve"] * 2 + ["refueling"] * 2
        for i, st in enumerate(states, 1):
            s[f"truck-{i:02d}"] = {"state": st, "speed": 25.0 if st in ("hauling", "returning") else 0.0}
        s["dispatch"]["trucks_hauling"] = 10
        a = R.advise(s)
        self.assertIn("≈ 4", a[0]["text"])                  # 24 − 20
        self.assertIn("в работе (в цикле) 24", a[0]["reason"])
        s["dispatch"].update(trucks_needed=23.8)            # нужно ≈ столько, сколько в работе — совета нет
        self.assertEqual(R.advise(s), [])
        for i in range(1, 29):
            s.pop(f"truck-{i:02d}", None)
        s["dispatch"].update(trucks_hauling=26)
        s["dispatch"].update(trucks_needed=20, mode="manual")
        self.assertEqual(R.advise(s), [])

    def _frames(self, minutes=60):
        """Срезы парка до метели: каждые 5 модельных минут 28 самосвалов, как на стенде."""
        frame = ([("hauling", 30.0)] * 4 + [("hauling", 12.0)] * 3 + [("hauling", 30.0)] * 2 +
                 [("returning", 40.0)] * 5 + [("returning", 25.0)] * 2 +
                 [("loading", 0.0)] * 4 + [("queued_load", 0.0)] * 4 + [("dumping", 0.0)] * 2 + [("queued_dump", 0.0)] * 2)
        return [s for _ in range(0, minutes, 5) for s in frame]

    def test_blizzard_from_fleet_speeds(self):
        s = base_snap()
        s["mine"].update(scenario_blizzard=1, speed_limit=20, visibility=300)
        a = R.advise(s, ctx={"samples_before": self._frames()})
        self.assertEqual(a[0]["id"], "blizzard")
        self.assertEqual(a[0]["target"], "kz.bozshakol:stockpile-coarse")
        self.assertIn("ограничение 20 км/ч", a[0]["text"])
        drop = a[0]["data"]["haul_drop_pct"]
        self.assertTrue(10 <= drop <= 30, drop)               # порядок фактических −7…−24 %, а не прежние −47 %
        self.assertAlmostEqual(a[0]["data"]["travel_share"], 16 / 28, places=2)
        self.assertIn("не меньше 4 ч (сейчас 4.5 ч)", a[0]["text"])
        self.assertEqual(a[0]["priority"], "important")
        s["stockpile-coarse"]["hours_left"] = 3.0
        self.assertEqual(R.advise(s, ctx={"samples_before": self._frames()})[0]["priority"], "critical")

    def test_blizzard_fallback_without_data(self):
        s = base_snap()
        s["mine"].update(scenario_blizzard=1, speed_limit=20)
        a = R.advise(s)
        drop = a[0]["data"]["haul_drop_pct"]
        self.assertTrue(10 <= drop <= 35, drop)
        self.assertIn("паспортным скоростям", a[0]["reason"])

    def test_blizzard_measured_change(self):
        # час до метели: руда 3750 т/ч, вскрыша 4500 т/ч; 40 мин метели: руда 3500 т/ч (−7 %), вскрыша 3420 т/ч (−24 %)
        t0 = 1_000_000.0
        dl = [(t0 + m * 60, 3750 * m / 60, 4500 * m / 60) for m in range(0, 61, 5)]
        ore0, w0 = dl[-1][1], dl[-1][2]
        dl += [(t0 + 3600 + m * 60, ore0 + 3500 * m / 60, w0 + 3420 * m / 60) for m in range(5, 41, 5)]
        s = base_snap()
        s["mine"].update(scenario_blizzard=1, speed_limit=20)
        a = R.advise(s, ctx={"samples_before": self._frames(), "deliveries": dl, "blizzard_since": t0 + 3600})
        self.assertIn("За 40 мин метели: руда -7 %, вскрыша -24 %", a[0]["text"])
        self.assertIn("диспетчер держит руду", a[0]["text"])
        # меньше 30 минут метели — факта ещё нет
        a = R.advise(s, ctx={"samples_before": self._frames(), "deliveries": dl[:16], "blizzard_since": t0 + 3600})
        self.assertNotIn("За ", a[0]["text"])

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
