"""Модельное время продолжается с mine.sim_time (SimClock.resume). Запуск: python3 -m unittest tests.test_clock"""
import os
import sys
import types
import unittest

for name in ("paho", "paho.mqtt", "paho.mqtt.client"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["paho.mqtt.client"].Client = object
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bzlib.platform import SimClock  # noqa: E402


class ClockResumeTest(unittest.TestCase):
    def test_fresh_start(self):
        c = SimClock(10)
        self.assertEqual(c.iso()[:16], "2026-01-15T08:00")
        self.assertEqual(c.shift()[0], 1)

    def test_resume_keeps_time_and_shift(self):
        c = SimClock(10).resume("2026-01-15T21:30:00")
        self.assertEqual(c.iso()[:16], "2026-01-15T21:30")
        self.assertEqual(c.shift(), (2, 1.5))          # смена 2 (с 20:00), 1,5 ч от её начала

    def test_resume_before_start_ignored(self):
        c = SimClock(10).resume("2026-01-15T07:00:00")
        self.assertEqual(c.iso()[:16], "2026-01-15T08:00")


if __name__ == "__main__":
    unittest.main()
