#!/usr/bin/env python3
"""Генерирует начальные twins.json всех частей рудника Бозшаколь.

Запуск из папки bozshakol/: python3 core/tools/make_twins.py
Пишет core/twins.json, modules/haulage/twins.json, modules/geology/twins.json,
modules/processing/twins.json. Дальше участники правят свои twins.json руками;
этот скрипт — только стартовая точка.
"""
import json
import os

NS = "kz.bozshakol"
POLICY = "default:basic_policy"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def tid(name):
    return f"{NS}:{name}"


def feat(value, unit=None, **extra):
    props = {"value": value}
    if unit is not None:
        props["unit"] = unit
    props.update(extra)
    return {"properties": props}


def twin(name, kind, parent=None, attrs=None, features=None):
    attributes = {"name": name, "kind": kind, "_isType": False}
    if parent:
        attributes["_parents"] = tid(parent)
    attributes.update(attrs or {})
    return {"policyId": POLICY, "attributes": attributes, "features": features or {}}


# ------------------------------------------------------------------ core
core = {}
core[tid("mine")] = twin("Карьер Бозшаколь", "mine", attrs={
    "operator": "KAZ Minerals Bozshakol", "region": "Павлодарская область",
    "plant_sulphide_mtpa": 25, "plant_clay_mtpa": 5, "shift_hours": 12,
}, features={
    "sim_time": feat("2026-01-15T08:00:00", "ISO"),
    "shift": feat(1, "№"),
    "shift_hour": feat(0.0, "ч"),
    "temperature": feat(-12.0, "°C"),
    "wind": feat(4.0, "м/с"),
    "visibility": feat(5000, "м"),
    "speed_limit": feat(50, "км/ч"),
    "ore_to_plants": feat(0.0, "т/ч"),
    "plan_fulfilment": feat(0.0, "%"),
    "feed_cu": feat(0.0, "% Cu"),
    "feed_clay": feat(0.0, "%"),
    "cu_concentrate_shift": feat(0.0, "т"),
    "trucks_hauling": feat(0, "шт"),
})
core[tid("scenarios")] = twin("Сценарии «что если»", "scenarios", "mine", features={
    "blizzard": feat(False, visibility_m=300, speed_limit_kmh=20, owner="core"),
    "dispatch_off": feat(False, owner="haulage"),
    "road_closed": feat(False, road="road-ramp-2", owner="haulage"),
    "excavator_down": feat(False, excavator="excavator-02", owner="haulage"),
    "clay_face": feat(False, face="face-03", clay_pct=45, owner="geology"),
    "bad_blast": feat(False, face="face-01", p80_mm=450, owner="geology"),
    "crusher_stop": feat(False, owner="processing"),
    "sag_maintenance": feat(False, owner="processing"),
})
core[tid("pit-central")] = twin("Центральный карьер", "pit", "mine", attrs={
    "length_m": 4400, "width_m": 1100, "depth_m": 200, "bench_height_m": 15, "bench_face_angle_deg": 58,
}, features={
    "depth": feat(200, "м"),
    "bench_height": feat(15, "м"),
    "active_faces": feat(6, "шт"),
})

# --------------------------------------------------------------- haulage
haul = {}
haul[tid("dispatch")] = twin("Диспетчеризация", "dispatch", "mine", attrs={
    "downstream": [tid("crusher-01"), tid("stockpile-clay"), tid("dump-waste-1")],
    "fleet": "22 × 135 т + 6 × 180 т",
}, features={
    "mode": feat("auto"),
    "avg_wait_excavator": feat(0.0, "мин"),
    "trucks_hauling": feat(0, "шт"),
    "trucks_down": feat(0, "шт"),
    "assignments": feat("{}", "json"),
    "delivered_crusher_t": feat(0.0, "т"),
    "delivered_crusher_cu_t": feat(0.0, "т Cu"),
    "delivered_clay_t": feat(0.0, "т"),
    "delivered_clay_cu_t": feat(0.0, "т Cu"),
    "delivered_dump_t": feat(0.0, "т"),
    "trips_total": feat(0, "рейсов"),
    "queue_crusher": feat(0, "шт"),
    "queue_clay": feat(0, "шт"),
    "queue_dump": feat(0, "шт"),
})
for i in range(1, 29):
    cap = 135 if i <= 22 else 180
    haul[tid(f"truck-{i:02d}")] = twin(f"Самосвал {i:02d} ({cap} т)", "truck", "dispatch", attrs={
        "capacity_t": cap, "make": "Caterpillar", "model": "793 (135 т)" if cap == 135 else "795 (180 т)",
    }, features={
        "state": feat("queued_load"),
        "x": feat(0.0, "м"), "y": feat(0.0, "м"), "z": feat(0.0, "м"),
        "heading": feat(0.0, "°"), "speed": feat(0.0, "км/ч"),
        "payload": feat(0.0, "т"), "cargo_type": feat("none"),
        "cargo_cu": feat(0.0, "% Cu"), "cargo_clay": feat(0.0, "%"),
        "destination": feat(""), "excavator": feat(""),
        "fuel": feat(100.0, "%"), "trips_total": feat(0, "рейсов"),
    })
faces = {1: "face-01", 2: "face-02", 3: "face-03", 4: "face-04", 5: "face-05", 6: "face-06"}
for i in range(1, 7):
    haul[tid(f"excavator-{i:02d}")] = twin(f"Экскаватор {i:02d}", "excavator", "pit-central", attrs={
        "model": "Hitachi EX3600 (допущение)", "bucket_m3": 22, "bucket_t": 40, "downstream": tid("dispatch"),
    }, features={
        "state": feat("idle"),
        "face": feat(faces[i]),
        "x": feat(0.0, "м"), "y": feat(0.0, "м"), "z": feat(0.0, "м"),
        "queue": feat(0, "шт"),
        "loaded_total": feat(0.0, "т"),
        "passes_total": feat(0, "ковшей"),
    })
for rid, name in [("road-ramp-1", "Съезд 1 (северный борт)"), ("road-ramp-2", "Съезд 2 (южный борт)"),
                  ("road-crusher", "Дорога к дробилке")]:
    haul[tid(rid)] = twin(name, "road", "pit-central", features={
        "open": feat(True), "speed_limit": feat(30 if "ramp" in rid else 40, "км/ч"),
        "trucks_on_road": feat(0, "шт"),
    })
haul[tid("dump-waste-1")] = twin("Отвал вскрыши 1", "dump", "pit-central", features={
    "received_total": feat(0.0, "т"), "accepting": feat(True), "trucks_queued": feat(0, "шт"),
})

# --------------------------------------------------------------- geology
geo = {}
face_params = {
    "face-01": ("sulphide", 0.42, 4, 1.8e6, "crusher-01"),
    "face-02": ("sulphide", 0.38, 6, 1.5e6, "crusher-01"),
    "face-03": ("sulphide", 0.45, 5, 2.0e6, "crusher-01"),
    "face-04": ("clay", 0.31, 55, 1.2e6, "stockpile-clay"),
    "face-05": ("waste", 0.05, 10, 3.0e6, "dump-waste-1"),
    "face-06": ("waste", 0.07, 8, 2.5e6, "dump-waste-1"),
}
for fid, (ore, cu, clay, tonnes, dest) in face_params.items():
    n = int(fid[-1])
    geo[tid(fid)] = twin(f"Забой {n:02d}", "face", "pit-central", attrs={
        "downstream": tid(f"excavator-{n:02d}"), "bench_level_m": -200 if n <= 3 else (-185 if n == 4 else -50),
    }, features={
        "ore_type": feat(ore),
        "cu_grade": feat(cu, "% Cu"),
        "au_grade": feat(0.19 if ore != "waste" else 0.02, "г/т"),
        "clay_pct": feat(clay, "%"),
        "p80": feat(250, "мм"),
        "loading_factor": feat(1.0, "коэф."),
        "hardness": feat(12, "ед. Протодьяконова"),
        "remaining": feat(tonnes, "т"),
        "recommended_destination": feat(dest),
        "blasted": feat(True),
    })
for i in range(1, 4):
    geo[tid(f"drill-{i:02d}")] = twin(f"Буровой станок {i:02d}", "drill", "pit-central", attrs={
        "model": "буровой станок класса DM45 (допущение)", "hole_diameter_mm": 251,
    }, features={
        "state": feat("drilling"), "x": feat(0.0, "м"), "y": feat(0.0, "м"), "z": feat(0.0, "м"),
        "block": feat(""), "meters_total": feat(0.0, "м"), "holes_total": feat(0, "шт"),
    })

# ------------------------------------------------------------ processing
proc = {}
proc[tid("plant-sulphide")] = twin("Сульфидная фабрика", "plant", "mine", attrs={
    "capacity_mtpa": 25, "design_tph": 2850, "recovery_cu_design_pct": 73.4,
}, features={
    "feed_rate": feat(0.0, "т/ч"), "feed_cu": feat(0.0, "% Cu"), "feed_clay": feat(0.0, "%"),
    "plan_fulfilment": feat(0.0, "%"), "ore_shift_t": feat(0.0, "т"),
    "cu_concentrate_shift": feat(0.0, "т"), "recovery": feat(73.4, "%"), "state": feat("running"),
})
proc[tid("plant-clay")] = twin("Фабрика глинистой руды", "plant", "mine", attrs={
    "capacity_mtpa": 5, "design_tph": 570,
}, features={
    "feed_rate": feat(0.0, "т/ч"), "feed_cu": feat(0.0, "% Cu"), "plan_fulfilment": feat(0.0, "%"),
    "ore_shift_t": feat(0.0, "т"), "cu_concentrate_shift": feat(0.0, "т"), "state": feat("running"),
})
proc[tid("power-grid")] = twin("Электроснабжение", "power", "mine", attrs={"supply_mw": 120}, features={
    "load": feat(0.0, "МВт"), "sag_mill": feat(0.0, "МВт"), "ball_mills": feat(0.0, "МВт"),
    "crusher": feat(0.0, "МВт"), "other": feat(6.0, "МВт"), "energy_shift": feat(0.0, "МВт·ч"),
})
proc[tid("crusher-01")] = twin("Гирационная дробилка", "crusher", "plant-sulphide", attrs={
    "type": "гирационная", "rated_tph": 4000, "bunker_t": 1500, "downstream": tid("conveyor-01"),
}, features={
    "state": feat("running"), "accepting": feat(True), "throughput": feat(0.0, "т/ч"),
    "bunker": feat(0.0, "т"), "received_total": feat(0.0, "т"), "trucks_queued": feat(0, "шт"),
    "feed_cu": feat(0.0, "% Cu"), "power": feat(0.0, "МВт"),
})
proc[tid("conveyor-01")] = twin("Магистральный конвейер", "conveyor", "plant-sulphide", attrs={
    "length_m": 3000, "rated_tph": 4000, "downstream": tid("stockpile-coarse"),
}, features={
    "state": feat("running"), "throughput": feat(0.0, "т/ч"), "speed": feat(0.0, "м/с"), "load": feat(0.0, "т"),
})
proc[tid("stockpile-coarse")] = twin("Склад крупнодроблёной руды", "stockpile", "plant-sulphide", attrs={
    "capacity_t": 200000, "downstream": tid("sag-mill-01"),
}, features={
    "stock": feat(60000.0, "т"), "cu_grade": feat(0.39, "% Cu"), "clay_pct": feat(5.0, "%"),
    "received_total": feat(0.0, "т"), "reclaimed_total": feat(0.0, "т"),
})
proc[tid("sag-mill-01")] = twin("Мельница полусамоизмельчения", "mill", "plant-sulphide", attrs={
    "diameter_m": 12.2, "power_mw": 28, "rated_tph": 2850, "downstream": tid("flotation-01"),
}, features={
    "state": feat("running"), "throughput": feat(0.0, "т/ч"), "power": feat(0.0, "МВт"), "p80_product": feat(150, "мкм"),
})
proc[tid("flotation-01")] = twin("Флотация", "flotation", "plant-sulphide", attrs={"cells": 14}, features={
    "state": feat("running"), "feed_rate": feat(0.0, "т/ч"), "feed_cu": feat(0.0, "% Cu"),
    "recovery": feat(73.4, "%"), "concentrate_tph": feat(0.0, "т/ч"), "concentrate_cu": feat(24.0, "% Cu"),
    "cu_in_concentrate_total": feat(0.0, "т Cu"),
})
proc[tid("stockpile-clay")] = twin("Склад глинистой руды", "stockpile", "plant-clay", attrs={
    "capacity_t": 120000, "downstream": tid("plant-clay"),
}, features={
    "stock": feat(30000.0, "т"), "cu_grade": feat(0.31, "% Cu"), "accepting": feat(True),
    "received_total": feat(0.0, "т"), "reclaimed_total": feat(0.0, "т"), "trucks_queued": feat(0, "шт"),
})

for path, data in [("core/twins.json", core), ("modules/haulage/twins.json", haul),
                   ("modules/geology/twins.json", geo), ("modules/processing/twins.json", proc)]:
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(data):3d} двойников -> {path}")
