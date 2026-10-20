#!/usr/bin/env python3
"""bz-geology — геология, качество руды, буровзрывные работы (участник №3).

Блочная модель карьера (blockmodel.py): блоки 25 × 25 × 15 м, содержание Cu, Au, глины,
крепость, плотность и тип руды по бортовому 0,20 % Cu и порогу глины 30 %. У каждого забоя
face-01…06 своя панель — цепочка соседних блоков уступа. Экскаватор в забое (читается через
платформу, накопительный loaded_total) отрабатывает панель; содержание забоя — смесь текущего
и следующего блока по доле выработки текущего. Когда панель кончается, забой переходит на
уступ ниже. Буровые станки drill-01…03 переходят по блокам и наращивают метры и скважины.
Сценарии: clay_face (face, clay_pct), bad_blast (face, p80_mm).
"""
import json
import random
import time

import blockmodel as bm
from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging, value

log = setup_logging("bz-geology")
PUBLISH_S = 10.0         # реальных секунд между публикациями
DRILL_RATE_M_PER_H = 25.0  # допущение: метров скважины в час
HOLE_DEPTH_M = 16.0        # уступ 15 м + перебур
PREVIEW_BLOCKS = 30        # блоков вокруг забоя в block_preview


def same_face(param, face_id):
    return str(param or "").split(":")[-1] == face_id


class Face:
    def __init__(self, thing_id, body, geometry, model, claimed):
        self.id = thing_id.split(":")[1]
        f = body["features"]
        self.base = {k: value(f, k) for k in ("p80", "loading_factor", "remaining")}
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.x, self.y, z = obj["position"]
        self.model, self.claimed = model, claimed
        self.level = model.level_of(z)
        self.target_t = float(self.base["remaining"])      # тоннаж одной панели — как в twins.json
        self.excavator = f"excavator-{self.id[-2:]}"
        self.last_loaded = None
        self.extracted = 0.0
        self.panel_no = 1
        self.panel = bm.Panel(model, self.level, self.x, self.y, self.target_t, claimed)
        self.preview = json.dumps(bm.preview(model, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        self.cur = {}
        self.update_values(False, {}, False, {})

    def absorb(self, loaded):
        """Отработка панели по приросту накопительного loaded_total экскаватора."""
        if loaded is None:
            return
        if self.last_loaded is not None and loaded >= self.last_loaded:
            self.extracted += loaded - self.last_loaded
        self.last_loaded = loaded
        while self.panel.total > 0 and self.extracted >= self.panel.total:
            self.extracted -= self.panel.total
            self.next_panel()

    def next_panel(self):
        m = self.model
        old = self.level
        self.level = min(self.level + 1, m.levels - 1)
        self.panel_no += 1
        self.panel = bm.Panel(m, self.level, self.x, self.y, self.target_t, self.claimed)
        if not self.panel.blocks:      # нижний уступ исчерпан другими панелями — берём блоки повторно
            self.panel = bm.Panel(m, self.level, self.x, self.y, self.target_t, set())
        self.preview = json.dumps(bm.preview(m, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        where = "на уступ %d" % (self.level + 1) if self.level != old else "на следующий ряд нижнего уступа %d" % (self.level + 1)
        log.info("%s: панель отработана, забой переходит %s (панель %d, %.2f млн т, блоков %d)",
                 self.id, where, self.panel_no, self.panel.total / 1e6, len(self.panel.blocks))

    def update_values(self, clay_on, clay_p, blast_on, blast_p):
        mix = bm.mixed(self.model, self.panel, self.extracted)
        if mix is None:                # пустая панель — оставляем последние значения
            return
        c = {"cu_grade": mix["cu"], "au_grade": mix["au"], "clay_pct": mix["clay"], "hardness": mix["hard"],
             "p80": self.base["p80"], "loading_factor": self.base["loading_factor"]}
        ore, dest = bm.classify(c["cu_grade"], c["clay_pct"])
        if clay_on and same_face(clay_p.get("face"), self.id):
            c["clay_pct"] = float(clay_p.get("clay_pct", 45))
            ore, dest = "clay", bm.DESTINATION[bm.CLAY]
        if blast_on and same_face(blast_p.get("face"), self.id):
            c["p80"] = float(blast_p.get("p80_mm", 450))
            c["loading_factor"] = 0.6
        c["ore_type"], c["recommended_destination"] = ore, dest
        c["remaining"] = max(0.0, self.panel.total - self.extracted)
        self.cur = c

    def features(self):
        c = self.cur
        return {
            "ore_type": feature(c["ore_type"]), "cu_grade": feature(round(c["cu_grade"], 3), "% Cu"),
            "au_grade": feature(round(c["au_grade"], 3), "г/т"), "clay_pct": feature(round(c["clay_pct"], 1), "%"),
            "p80": feature(int(c["p80"]), "мм"), "loading_factor": feature(round(c["loading_factor"], 2), "коэф."),
            "hardness": feature(round(c["hardness"], 1), "ед. Протодьяконова"),
            "remaining": feature(round(c["remaining"], 0), "т"),
            "recommended_destination": feature(c["recommended_destination"]), "blasted": feature(True),
            "block_preview": feature(self.preview, "м, м, % Cu"),
            "bench": feature(self.level + 1, "№"),
            "panel_progress": feature(round(100.0 * self.extracted / max(1.0, self.panel.total), 1), "%"),
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
    t0 = time.time()
    model = bm.BlockModel(geometry)
    st = model.stats()
    model.drop_fields()
    log.info("блочная модель: %d блоков за %.1f с; рудные блоки: Cu %.3f %%, Au %.3f г/т, глинистая руда %.1f %%, вскрыша/руда %.2f т/т",
             st["blocks"], time.time() - t0, st["cu"], st["au"], 100 * st["clay_share"], st["strip"])
    claimed = set()
    faces = [Face(t, b, geometry, model, claimed) for t, b in twins.items() if ":face-" in t]
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
            if watcher.get(face.excavator, "face") == face.id:
                face.absorb(watcher.get(face.excavator, "loaded_total"))
            else:
                face.last_loaded = None    # экскаватор в другом забое: счётчик чужой, отсчёт заново
            face.update_values(clay_on, clay_p, blast_on, blast_p)
            telemetry.publish(face.id, face.features())
        for drill in drills:
            drill.step(dt)
            telemetry.publish(drill.id, drill.features())
        log.info("забои: %s", ", ".join(
            f"{f.id} {f.cur['cu_grade']:.2f}%Cu глина {f.cur['clay_pct']:.0f}% → {f.cur['recommended_destination']} "
            f"(ост. {f.cur['remaining'] / 1e6:.2f} млн т)" for f in faces[:4]))
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
