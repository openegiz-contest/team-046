#!/usr/bin/env python3
"""Прогон модели bz-haulage без платформы (без Ditto/MQTT/Docker) — для сверки диспетчера.

Запуск: python3 sim_check.py  (несколько секунд; только стандартная библиотека).
Берёт тот же код цикла самосвала и диспетчера, что и main.py (импортирует его классы
напрямую), с постоянными, не меняющимися данными забоев — чтобы сравнить «авто» и
«ручной» режимы диспетчеризации при одинаковых условиях.
"""
import json
import logging
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
GEOMETRY_PATH = os.path.join(HERE, "..", "..", "core", "geometry.json")
MODEL_HOURS = 12
STEP_S = 5.0  # как в основном цикле main.py — не больше 5 модельных секунд за шаг


def _stub_bzlib():
    """main.py на верхнем уровне делает `from bzlib import ...`; реальный bzlib тянет
    paho-mqtt и реальное подключение к Ditto/MQTT, которых здесь нет и не нужно — сам
    цикл и диспетчер ничего из DittoClient/SimClock/Telemetry не используют напрямую,
    только из TwinWatcher (а его мы подменяем своим FakeWatcher ниже, с тем же интерфейсом
    .get()/.scenario()). Поэтому достаточно подставить модуль с нужными именами."""
    stub = types.ModuleType("bzlib")

    def feature(val, unit=None, **extra):
        props = {"value": val}
        if unit is not None:
            props["unit"] = unit
        props.update(extra)
        return {"properties": props}

    stub.feature = feature
    stub.setup_logging = lambda name: logging.getLogger(name)
    stub.DittoClient = object
    stub.SimClock = object
    stub.Telemetry = object
    stub.TwinWatcher = object
    sys.modules["bzlib"] = stub


def _load_main():
    _stub_bzlib()
    sys.path.insert(0, HERE)
    import importlib
    import main as haulage_main  # noqa: E402  (bozshakol/modules/haulage/main.py)
    importlib.reload(haulage_main)
    return haulage_main


class FakeWatcher:
    """Постоянные данные платформы: забои, приёмка пунктов разгрузки, mine, dispatch."""

    def __init__(self, faces, accepting, speed_limit=50.0, clay_limit=15.0,
                 dispatch_off=False, road_closed=None, excavator_down=None):
        self.faces = faces
        self.accepting = accepting
        self.speed_limit = speed_limit
        self.clay_limit = clay_limit
        self.dispatch_off = dispatch_off
        self.road_closed = road_closed
        self.excavator_down = excavator_down

    def get(self, name, feature_name, default=None):
        if name in self.faces:
            return self.faces[name].get(feature_name, default)
        if name in self.accepting and feature_name == "accepting":
            return self.accepting[name]
        if name == "mine" and feature_name == "speed_limit":
            return self.speed_limit
        if name == "dispatch" and feature_name == "clay_limit":
            return self.clay_limit
        return default

    def scenario(self, name):
        if name == "dispatch_off":
            return self.dispatch_off, {}
        if name == "road_closed":
            return (self.road_closed is not None), (self.road_closed or {})
        if name == "excavator_down":
            return (self.excavator_down is not None), (self.excavator_down or {})
        return False, {}


CONST_FACES = {
    "face-01": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-02": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-03": dict(ore_type="sulphide", cu_grade=0.39, clay_pct=5.0, loading_factor=1.0, recommended_destination="crusher-01"),
    "face-04": dict(ore_type="clay", cu_grade=0.31, clay_pct=60.0, loading_factor=1.0, recommended_destination="stockpile-clay"),
    "face-05": dict(ore_type="waste", cu_grade=0.0, clay_pct=0.0, loading_factor=1.0, recommended_destination="dump-waste-1"),
    "face-06": dict(ore_type="waste", cu_grade=0.0, clay_pct=0.0, loading_factor=1.0, recommended_destination="dump-waste-1"),
}
CONST_ACCEPTING = {"crusher-01": True, "stockpile-clay": True}


def run(hm, dispatch_off):
    with open(GEOMETRY_PATH, encoding="utf-8") as f:
        geometry = json.load(f)
    watcher = FakeWatcher(CONST_FACES, CONST_ACCEPTING, dispatch_off=dispatch_off)
    model = hm.Haulage(geometry, watcher, clock=None)
    model.speed_limit = 50.0
    steps = int(MODEL_HOURS * 3600 / STEP_S)
    for _ in range(steps):
        model.step(STEP_S)
    return model.dispatch_features()


def fv(features, name):
    return features[name]["properties"]["value"]


def report(label, features):
    print(f"\n== {label} ==")
    print(f"  ожидание у экскаватора:  {fv(features, 'avg_wait_excavator'):.2f} мин")
    print(f"  ожидание на разгрузке:   {fv(features, 'avg_wait_dump'):.2f} мин")
    print(f"  рейсов в час:            {fv(features, 'trips_per_hour'):.1f}")
    print(f"  т/ч на дробилку:         {fv(features, 'tph_crusher'):.1f}")
    print(f"  т/ч на склад глины:      {fv(features, 'tph_clay'):.1f}")
    print(f"  т/ч на отвал:            {fv(features, 'tph_dump'):.1f}")
    print(f"  доля самосвалов в деле:  {fv(features, 'fleet_utilization'):.1f} %")
    print(f"  доля глины на дробилке:  {fv(features, 'clay_share_crusher'):.2f} % (лимит {fv(features, 'clay_limit')} %)")
    print(f"  топлива израсходовано:   {fv(features, 'fuel_used_l'):.0f} л")
    print(f"  заправок:                {fv(features, 'refuels_total')}")


def main():
    hm = _load_main()
    print(f"Прогон {MODEL_HOURS} модельных часов, постоянные данные забоев (без платформы).")
    print("Показатели — за последний модельный час (скользящее окно, как публикует dispatch).")
    auto = run(hm, dispatch_off=False)
    manual = run(hm, dispatch_off=True)
    report("авто", auto)
    report("ручной (dispatch_off)", manual)
    print("\nЦель по задаче: авто — 1-1.5 мин ожидания у экскаватора, ручной — 3-5 мин.")
    print(f"Получено: авто {fv(auto, 'avg_wait_excavator'):.2f} мин, ручной {fv(manual, 'avg_wait_excavator'):.2f} мин.")


if __name__ == "__main__":
    main()
