#!/usr/bin/env python3
"""bz-geology — геология, качество руды, буровзрывные работы (заглушка, участник №3).

Забои face-01…06: содержание меди и золота, доля глины около средних 2025 года
с медленным дрейфом; крупность после взрыва P80, коэффициент скорости погрузки,
крепость; остаток тонн уменьшается по разнице накопительного loaded_total
экскаватора, стоящего в забое (читается через платформу). Буровые станки
drill-01…03 переходят по блокам и наращивают метры и скважины.
Сценарии: clay_face (face, clay_pct), bad_blast (face, p80_mm).
"""
import json
import random
import time

from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging, value

log = setup_logging("bz-geology")
PUBLISH_S = 10.0         # реальных секунд между публикациями
CLAY_THRESHOLD = 30.0    # % глины, выше — руда «глинистая» (допущение)
DRILL_RATE_M_PER_H = 25.0  # допущение: метров скважины в час
HOLE_DEPTH_M = 16.0        # уступ 15 м + перебур


class Face:
    def __init__(self, thing_id, body, geometry):
        self.id = thing_id.split(":")[1]
        f = body["features"]
        self.base = {k: value(f, k) for k in ("ore_type", "cu_grade", "au_grade", "clay_pct", "p80",
                                                "loading_factor", "hardness", "remaining", "recommended_destination")}
        self.cur = dict(self.base)
        self.blasted = True
        self.excavator = f"excavator-{self.id[-2:]}"
        self.last_loaded = None

    def features(self):
        c = self.cur
        return {
            "ore_type": feature(c["ore_type"]), "cu_grade": feature(round(c["cu_grade"], 3), "% Cu"),
            "au_grade": feature(round(c["au_grade"], 3), "г/т"), "clay_pct": feature(round(c["clay_pct"], 1), "%"),
            "p80": feature(int(c["p80"]), "мм"), "loading_factor": feature(round(c["loading_factor"], 2), "коэф."),
            "hardness": feature(c["hardness"], "ед. Протодьяконова"),
            "remaining": feature(round(max(0.0, c["remaining"]), 0), "т"),
            "recommended_destination": feature(c["recommended_destination"]), "blasted": feature(self.blasted),
        }


class Drill:
    def __init__(self, thing_id, geometry, rng):
        self.id = thing_id.split(":")[1]
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.pos = list(obj["position"])
        self.rng = rng
        self.block = f"Б-{self.id[-1]}{rng.randint(10, 40)}"
        self.meters = 0.0
        self.holes = 0
        self.hole_progress = 0.0
        self.state = "drilling"
        self.timer = 0.0

    def step(self, dt):
        self.timer += dt
        if self.state == "drilling":
            m = DRILL_RATE_M_PER_H * dt / 3600.0
            self.meters += m
            self.hole_progress += m
            if self.hole_progress >= HOLE_DEPTH_M:
                self.hole_progress = 0.0
                self.holes += 1
                self.state = "moving"
                self.timer = 0.0
                self.pos[0] += self.rng.uniform(-8, 8)
                self.pos[1] += self.rng.uniform(-8, 8)
        elif self.state == "moving" and self.timer >= 120:
            self.state = "drilling"
            if self.holes % 40 == 0:
                self.block = f"Б-{self.id[-1]}{self.rng.randint(10, 40)}"

    def features(self):
        return {
            "state": feature(self.state), "x": feature(round(self.pos[0], 1), "м"),
            "y": feature(round(self.pos[1], 1), "м"), "z": feature(round(self.pos[2], 1), "м"),
            "block": feature(self.block), "meters_total": feature(round(self.meters, 1), "м"),
            "holes_total": feature(self.holes, "шт"),
        }


def main():
    with open("geometry.json", encoding="utf-8") as f:
        geometry = json.load(f)
    with open("twins.json", encoding="utf-8") as f:
        twins = json.load(f)
    rng = random.Random(3)
    faces = [Face(t, b, geometry) for t, b in twins.items() if ":face-" in t]
    drills = [Drill(t, geometry, rng) for t in twins if ":drill-" in t]
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios"} | {f.excavator for f in faces}, client_id="bz-geology-watch").start()
    telemetry = Telemetry(client_id="bz-geology").connect()
    clock = SimClock()

    while True:
        dt = clock.tick()
        clay_on, clay_p = watcher.scenario("clay_face")
        blast_on, blast_p = watcher.scenario("bad_blast")
        for face in faces:
            c, b = face.cur, face.base
            # медленный дрейф содержания вокруг исходного (допущение)
            c["cu_grade"] = min(b["cu_grade"] * 1.3, max(b["cu_grade"] * 0.7, c["cu_grade"] + rng.gauss(0, 0.002)))
            c["au_grade"] = min(b["au_grade"] * 1.3, max(b["au_grade"] * 0.7, c["au_grade"] + rng.gauss(0, 0.001)))
            c["clay_pct"] = min(90.0, max(0.0, c["clay_pct"] + rng.gauss(0, 0.1)))
            c["p80"], c["loading_factor"] = b["p80"], b["loading_factor"]
            if clay_on and clay_p.get("face") == face.id:
                c["clay_pct"] = float(clay_p.get("clay_pct", 45))
            elif clay_on is False and b["ore_type"] != "clay":
                c["clay_pct"] = min(c["clay_pct"], b["clay_pct"] + 3)
            if blast_on and blast_p.get("face") == face.id:
                c["p80"] = float(blast_p.get("p80_mm", 450))
                c["loading_factor"] = 0.6
            # рекомендуемый пункт разгрузки: по типу руды и доле глины
            if b["ore_type"] == "waste":
                c["recommended_destination"] = "dump-waste-1"
            elif c["clay_pct"] >= CLAY_THRESHOLD:
                c["recommended_destination"] = "stockpile-clay"
            else:
                c["recommended_destination"] = "crusher-01"
            # остаток по разнице счётчика экскаватора, который стоит в этом забое
            if watcher.get(face.excavator, "face") == face.id:
                loaded = watcher.get(face.excavator, "loaded_total")
                if loaded is not None:
                    if face.last_loaded is not None and loaded >= face.last_loaded:
                        c["remaining"] -= loaded - face.last_loaded
                    face.last_loaded = loaded
            if c["remaining"] <= 0:  # забой отработан — «взорван» новый блок (допущение)
                c["remaining"] = b["remaining"]
            telemetry.publish(face.id, face.features())
        for drill in drills:
            drill.step(dt)
            telemetry.publish(drill.id, drill.features())
        log.info("забои: %s", ", ".join(f"{f.id} {f.cur['cu_grade']:.2f}%Cu глина {f.cur['clay_pct']:.0f}% → {f.cur['recommended_destination']}" for f in faces[:4]))
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
