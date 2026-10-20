#!/usr/bin/env python3
"""bz-geology — геология, качество руды, буровзрывные работы (участник №3).

Блочная модель карьера (blockmodel.py): блоки 25 × 25 × 15 м, содержание Cu, Au, глины,
крепость, плотность и тип руды по бортовому 0,20 % Cu и порогу глины 30 %. У каждого забоя
face-01…06 своя панель — цепочка соседних блоков уступа. Экскаватор в забое (читается через
платформу, накопительный loaded_total) отрабатывает панель; содержание забоя — смесь текущего
и следующего блока по доле выработки текущего. Когда панель кончается, забой переходит на
уступ ниже.

Буровые станки (drilling.py) бурят блоки панелей по сетке, измеряют крепость по скорости
бурения (MWD) и «взрывают» блок: блоку присваиваются крепость и P80 по модели
Кузнецова–Рамлера (blasting.py). Забой публикует p80 и hardness взорванного блока; если дошёл
до невзорванного — blasted = false и loading_factor падает до минимума.
Сценарии: clay_face (face, clay_pct), bad_blast (face, p80_mm).
"""
import json
import math
import random
import time

import blasting as bl
import blockmodel as bm
from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging, value
from drilling import Drill

log = setup_logging("bz-geology")
PUBLISH_S = 10.0         # реальных секунд между публикациями
PREVIEW_BLOCKS = 30      # блоков вокруг забоя в block_preview
INITIAL_BLASTED = 3      # блоков панели, взорванных до начала моделирования (запас перед экскаватором)
BAD_BLAST_FACTOR = 2.0   # неудачный взрыв: P80 вдвое больше расчётного, если p80_mm не задан или меньше расчётного


def same_face(param, face_id):
    return str(param or "").split(":")[-1] == face_id


class Face:
    def __init__(self, thing_id, body, geometry, model, claimed, rng):
        self.id = thing_id.split(":")[1]
        f = body["features"]
        self.base = {k: value(f, k) for k in ("remaining",)}
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.x, self.y, z = obj["position"]
        self.model, self.claimed, self.rng = model, claimed, rng
        self.level = model.level_of(z)
        self.target_t = float(self.base["remaining"])      # тоннаж одной панели — как в twins.json
        self.excavator = f"excavator-{self.id[-2:]}"
        self.last_loaded = None
        self.extracted = 0.0
        self.panel_no = 1
        self.last_p80 = bl.P80_REF
        self._new_panel()
        self.preview = json.dumps(bm.preview(model, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        self.cur = {}
        self.update_values(False, {}, False, {})

    # -- панель и взрыв ----------------------------------------------------------------
    def _new_panel(self):
        m = self.model
        self.panel = bm.Panel(m, self.level, self.x, self.y, self.target_t, self.claimed)
        if not self.panel.blocks:      # нижний уступ исчерпан другими панелями — берём блоки повторно
            self.panel = bm.Panel(m, self.level, self.x, self.y, self.target_t, set())
        p = self.panel
        n = len(p.blocks)
        p.level = self.level
        p.reserved = set()                       # блоки, которые сейчас бурит станок
        p.blasted = bytearray(n)
        p.p80 = [0.0] * n
        p.hard_b = [0.0] * n
        for j in range(min(INITIAL_BLASTED, n)):   # взорванный запас на старте: крепость с небольшим разбросом
            self.blast(p, j, m.hard[p.blocks[j]] * (1.0 + self.rng.gauss(0.0, 0.03)))

    def blast(self, panel, j, f):
        """Блок взорван: ему присваиваются крепость (измеренная MWD) и P80 по модели Кузнецова–Рамлера."""
        panel.hard_b[j] = f
        panel.p80[j] = bl.p80_mm(f)
        panel.blasted[j] = 1

    def cur_index(self):
        return bm.bisect_index(self.panel.cum, self.extracted)

    def reserve(self):
        """Сколько взорванных блоков подряд лежит перед экскаватором (с текущего)."""
        p, i = self.panel, self.cur_index()
        k = 0
        while i + k < len(p.blocks) and p.blasted[i + k]:
            k += 1
        return k

    def next_to_blast(self):
        p = self.panel
        for j in range(self.cur_index(), len(p.blocks)):
            if not p.blasted[j] and j not in p.reserved:
                return j
        return None

    # -- отработка ---------------------------------------------------------------------
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
        self._new_panel()
        self.preview = json.dumps(bm.preview(m, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        where = "на уступ %d" % (self.level + 1) if self.level != old else "на следующий ряд нижнего уступа %d" % (self.level + 1)
        log.info("%s: панель отработана, забой переходит %s (панель %d, %.2f млн т, блоков %d)",
                 self.id, where, self.panel_no, self.panel.total / 1e6, len(self.panel.blocks))

    def update_values(self, clay_on, clay_p, blast_on, blast_p):
        p = self.panel
        mix = bm.mixed(self.model, p, self.extracted)
        if mix is None:                # пустая панель — оставляем последние значения
            return
        i = self.cur_index()
        n = len(p.blocks)
        k = mix["k"]
        blasted = bool(p.blasted[i])
        if blasted:
            p80, hard = p.p80[i], p.hard_b[i]
            if i + 1 < n and p.blasted[i + 1]:     # как и содержание: смесь текущего и следующего блока
                p80 = (1 - k) * p80 + k * p.p80[i + 1]
                hard = (1 - k) * hard + k * p.hard_b[i + 1]
            self.last_p80 = p80
            lf = bl.loading_factor(p80)
        else:                          # экскаватор дошёл до невзорванного блока: погрузка на минимуме
            p80, hard, lf = self.last_p80, mix["hard"], bl.LF_MIN
        c = {"cu_grade": mix["cu"], "au_grade": mix["au"], "clay_pct": mix["clay"], "hardness": hard,
             "p80": p80, "loading_factor": lf}
        ore, dest = bm.classify(c["cu_grade"], c["clay_pct"])
        if clay_on and same_face(clay_p.get("face"), self.id):
            c["clay_pct"] = float(clay_p.get("clay_pct", 45))
            ore, dest = "clay", bm.DESTINATION[bm.CLAY]
        if blast_on and same_face(blast_p.get("face"), self.id):
            # неудачный взрыв: крупность выше расчётной, скорость погрузки — по той же формуле
            normal = c["p80"]
            try:
                asked = float(blast_p.get("p80_mm") or 0.0)
            except (TypeError, ValueError):
                asked = 0.0
            # p80_mm, меньший расчётного P80 забоя (стоящее в scenarios значение 450 мм — под прежний масштаб 250 мм),
            # не имеет смысла для «неудачного» взрыва: берём вдвое от расчётного
            c["p80"] = asked if asked > 1.2 * normal else BAD_BLAST_FACTOR * normal
            c["loading_factor"] = min(c["loading_factor"], bl.loading_factor(c["p80"]))
        c["ore_type"], c["recommended_destination"] = ore, dest
        c["remaining"] = max(0.0, p.total - self.extracted)
        c["blasted"] = blasted
        self.cur = c

    def features(self):
        c = self.cur
        return {
            "ore_type": feature(c["ore_type"]), "cu_grade": feature(round(c["cu_grade"], 3), "% Cu"),
            "au_grade": feature(round(c["au_grade"], 3), "г/т"), "clay_pct": feature(round(c["clay_pct"], 1), "%"),
            "p80": feature(int(round(c["p80"])), "мм"), "loading_factor": feature(round(c["loading_factor"], 2), "коэф."),
            "hardness": feature(round(c["hardness"], 1), "ед. Протодьяконова"),
            "remaining": feature(round(c["remaining"], 0), "т"),
            "recommended_destination": feature(c["recommended_destination"]), "blasted": feature(c["blasted"]),
            "block_preview": feature(self.preview, "м, м, % Cu"),
            "bench": feature(self.level + 1, "№"),
            "panel_progress": feature(round(100.0 * self.extracted / max(1.0, self.panel.total), 1), "%"),
            "powder_factor": feature(round(bl.charge()["powder_factor"], 2), "кг/м³"),
            "reserve_blocks": feature(self.reserve(), "шт"),
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
    ch = bl.charge()
    log.info("взрыв: сетка %.0f×%.0f м, скважина %.0f мм, заряд %.0f кг, удельный расход %.2f кг/м³, n=%.2f, P80 опорное %.0f мм",
             bl.BURDEN_M, bl.SPACING_M, bl.HOLE_D_MM, ch["mass"], ch["powder_factor"], bl.uniformity_n(), bl.P80_REF)
    claimed = set()
    faces = [Face(t, b, geometry, model, claimed, rng) for t, b in twins.items() if ":face-" in t]
    drills = [Drill(t, geometry, model, rng, i) for i, t in enumerate(sorted(t for t in twins if ":drill-" in t))]
    for face in faces:      # каждый забой обслуживает ближайший станок
        near = min(drills, key=lambda d: math.dist((face.x, face.y), d.pos[:2]))
        near.faces.append(face)
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios"} | {f.excavator for f in faces}, client_id="bz-geology-watch").start()
    telemetry = Telemetry(client_id="bz-geology").connect()
    clock = SimClock()

    while True:
        dt = clock.tick()
        clay_on, clay_p = watcher.scenario("clay_face")
        blast_on, blast_p = watcher.scenario("bad_blast")
        for drill in drills:
            drill.step(dt)
            telemetry.publish(drill.id, drill.features())
        for face in faces:
            if watcher.get(face.excavator, "face") == face.id:
                face.absorb(watcher.get(face.excavator, "loaded_total"))
            else:
                face.last_loaded = None    # экскаватор в другом забое: счётчик чужой, отсчёт заново
            face.update_values(clay_on, clay_p, blast_on, blast_p)
            telemetry.publish(face.id, face.features())
        log.info("забои: %s", ", ".join(
            f"{f.id} {f.cur['cu_grade']:.2f}%Cu P80 {f.cur['p80']:.0f} мм lf {f.cur['loading_factor']:.2f} "
            f"{'взорван' if f.cur['blasted'] else 'НЕ взорван'} (запас {f.reserve()})" for f in faces[:4]))
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
