"""Общая часть расчётных скриптов (blend_run.py, drilling_balance.py): код сервиса без стенда.

Подключает blockmodel.py, drilling.py и main.py из modules/geology/ как есть. Библиотека платформы bzlib
(MQTT, Ditto) для расчёта не нужна, поэтому на время импорта подставляется пустая заглушка; сервис при этом не запускается.
"""
import json
import os
import random
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.dirname(HERE)
ROOT = os.path.join(GEO, "..", "..")          # bozshakol/
sys.path.insert(0, GEO)

stub = types.ModuleType("bzlib")
stub.feature = lambda v, u=None: {"properties": {"value": v, **({"unit": u} if u else {})}}
stub.value = lambda f, k, d=None: f.get(k, {}).get("properties", {}).get("value", d)
stub.setup_logging = lambda name: __import__("logging").getLogger(name)
for name in ("DittoClient", "SimClock", "Telemetry", "TwinWatcher"):
    setattr(stub, name, type(name, (), {}))
sys.modules.setdefault("bzlib", stub)

import blockmodel as bm  # noqa: E402
import main as G  # noqa: E402
from drilling import Drill  # noqa: E402

DT = 100.0                  # шаг расчёта, модельных секунд
RATE_CLAY, RATE_WASTE = 700.0, 2000.0       # скорость отгрузки глинистого и вскрышных экскаваторов, т/ч


def rate_of(face, rate_sulphide):
    """Скорость отгрузки экскаватора забоя, т/ч: сульфидная руда — rate_sulphide, глинистая 700, вскрыша 2000."""
    return RATE_CLAY if face.role == "clay" else (RATE_WASTE if face.role == "waste" else rate_sulphide)


def build(n_drills, blend):
    """Модель, забои face-01…06 и станки; blend — включить усреднение. Возвращает (model, tracker, faces, drills)."""
    with open(os.path.join(ROOT, "core", "geometry.json"), encoding="utf-8") as f:
        geometry = json.load(f)
    with open(os.path.join(GEO, "twins.json"), encoding="utf-8") as f:
        twins = json.load(f)
    model = bm.BlockModel(geometry)
    model.drop_fields()
    rng = random.Random(3)
    claimed = set()
    tracker = G.FeedTracker() if blend else None
    faces = [G.Face(t, b, geometry, model, claimed, rng, None, tracker) for t, b in twins.items() if ":face-" in t]
    places = {o["id"] for o in geometry["objects"]}
    ids = sorted(k for k in twins if k.split(":")[1].startswith("drill-") and k.split(":")[1][6:].isdigit() and k.split(":")[1] in places)
    drills = [Drill(t, geometry, model, rng, i) for i, t in enumerate(ids[:n_drills])]
    for d in drills:
        d.faces = list(faces)
    return model, tracker, faces, drills
