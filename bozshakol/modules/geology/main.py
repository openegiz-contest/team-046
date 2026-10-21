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
INITIAL_BLASTED = 1      # блоков панели, взорванных до начала моделирования (запас перед экскаватором): станки начинают работать сразу
RATE_MAX_TPH = 3000.0     # верхняя граница оценки скорости отгрузки экскаватора, т/ч
BAD_BLAST_FACTOR = 2.0   # неудачный взрыв: P80 вдвое больше расчётного, если p80_mm не задан или меньше расчётного


def read_prev_state(twins):
    """Прежние значения своих двойников из Ditto (HTTP GET; адрес и пароль — из переменных окружения).

    Возвращает {thingId: {признак: значение}}. Если Ditto недоступен, двойников или значений нет — пустой словарь:
    сервис начинает с начальных значений и пишет об этом в журнал; ни при каких ответах не падает."""
    try:
        ditto = DittoClient()
        snapshot = ditto.retry(ditto.search, attempts=5, delay=3)      # Ditto мог ещё не подняться: несколько повторов
    except Exception as exc:          # недоступен, нет пароля, неверный ответ — всё равно стартуем
        log.warning("прежнее состояние из Ditto не прочитано (%s) — начинаем с начальных значений", exc)
        return {}
    prev = {}
    try:
        for thing_id in twins:
            item = snapshot.get(thing_id) if isinstance(snapshot, dict) else None
            feats = item.get("features") if isinstance(item, dict) else None
            if not isinstance(feats, dict):
                continue
            vals = {}
            for name, feat in feats.items():
                props = feat.get("properties") if isinstance(feat, dict) else None
                if isinstance(props, dict) and props.get("value") is not None:
                    vals[name] = props["value"]
            if vals:
                prev[thing_id] = vals
    except Exception as exc:
        log.warning("ответ Ditto не разобран (%s) — начинаем с начальных значений", exc)
        return {}
    if not prev:
        log.info("в Ditto нет прежних значений своих двойников — начинаем с начальных значений")
    return prev


def num(v, default=None):
    """Число из значения признака; всё остальное (None, строка, пусто) — default."""
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else default


FEED_CU_TARGET = 0.39    # % Cu — целевое содержание в питании дробилки (среднее по руднику 2025 г.)
FEED_CU_LOW, FEED_CU_HIGH = 0.35, 0.43   # допустимый коридор, % Cu
BLEND_OFFSET = 0.0       # % Cu — поправка к «желаемому» содержанию новых блоков (доступные сульфидные блоки в среднем богаче цели)
BLEND_GAIN = 0.3         # во сколько раз сильнее цели отодвигаем «желаемое» содержание новых блоков при отклонении питания
BLEND_WINDOW_S = 86400.0  # окно оценки питания — модельные сутки
BLEND_LOOKAHEAD = 8      # из скольких ближайших невзорванных блоков панели выбирается следующий блок для бурения


class FeedTracker:
    """Содержание Cu в питании дробилки за последние модельные сутки: тоннаж-взвешенное среднее по сульфидным забоям, везущим руду на crusher-01."""

    def __init__(self, target=FEED_CU_TARGET, window_s=BLEND_WINDOW_S):
        self.target, self.window_s = target, window_s
        self.q = []              # (время, тонны, тонны·Cu)
        self.now = 0.0
        self.sum_t = self.sum_cu = 0.0

    def tick(self, dt):
        self.now += dt
        while self.q and self.q[0][0] < self.now - self.window_s:
            _, t, c = self.q.pop(0)
            self.sum_t -= t
            self.sum_cu -= c

    def add(self, tonnes, cu):
        if tonnes > 0:
            self.q.append((self.now, tonnes, tonnes * cu))
            self.sum_t += tonnes
            self.sum_cu += tonnes * cu

    def actual(self):
        return self.sum_cu / self.sum_t if self.sum_t > 2000.0 else None

    def desired(self):
        """Какое содержание нужно у новых блоков: цель, смещённая против отклонения питания (богато — берём победнее, и наоборот)."""
        a = self.actual()
        if a is None:
            return self.target
        return min(0.65, max(0.25, self.target + BLEND_OFFSET - BLEND_GAIN * (a - self.target)))


def same_face(param, face_id):
    return str(param or "").split(":")[-1] == face_id


class Face:
    def __init__(self, thing_id, body, geometry, model, claimed, rng, prev=None, blend=None):
        self.id = thing_id.split(":")[1]
        f = body["features"]
        self.base = {k: value(f, k) for k in ("remaining",)}
        obj = next(o for o in geometry["objects"] if o["id"] == self.id)
        self.x, self.y, self.z0 = obj["position"]
        self.model, self.claimed, self.rng = model, claimed, rng
        self.blend = blend                              # FeedTracker: усреднение питания дробилки (только для сульфидных забоев)
        self.last_delta = 0.0
        self.role = obj.get("ore_type", "waste")        # роль забоя: sulphide / clay / waste (из core/geometry.json)
        self.role_mismatch = False
        self.level = model.level_of(self.z0)
        self.target_t = float(self.base["remaining"])      # тоннаж одной панели — как в twins.json
        self.excavator = f"excavator-{self.id[-2:]}"
        self.last_loaded = None
        self.extracted = 0.0
        self.panel_no = 1
        self.last_p80 = bl.P80_REF
        self.win_x = self.win_t = 0.0
        self.rate_tph = 700.0          # скорость отгрузки экскаватора, т/ч (скользящая оценка по loaded_total)
        self._new_panel()
        self._restore(prev or {})
        self.preview = json.dumps(bm.preview(model, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        self.cur = {}
        self.update_values(False, {}, False, {})

    # -- панель и взрыв ----------------------------------------------------------------
    def _restore(self, prev):
        """Продолжение с прежних значений из Ditto: номер панели и остаток (положение в панели)."""
        no = num(prev.get("panel_no"), 1.0)
        for _ in range(max(0, min(int(no), 200) - 1)):        # перестраиваем уже отработанные панели
            self.panel_no += 1
            self._new_panel()
        done = num(prev.get("panel_extracted"), 0.0)          # точный тоннаж, отработанный в панели (публикуется каждые 10 с)
        if done > 0.0 and done <= self.panel.total * 1.02:
            self.extracted = done
        elif num(prev.get("panel_progress"), 0.0) > 0.0:        # запасной путь: по остатку (признак панели старого сервиса)
            rem = num(prev.get("remaining"))
            if rem is not None and 0.0 <= rem <= self.panel.total * 1.02:
                self.extracted = max(0.0, self.panel.total - rem)
        if self.extracted > 0 or self.panel_no > 1:
            log.info("%s: продолжаем с панели %d, отработано %.0f т, остаток %.0f т (из Ditto)", self.id, self.panel_no, self.extracted,
                     max(0.0, self.panel.total - self.extracted))

    def _new_panel(self):
        m = self.model
        # рудоконтроль: панель вдоль уступа, преобладающий тип которой совпадает с ролью забоя; ищем на текущем уступе и ниже
        levels = [self.level, min(self.level + 1, m.levels - 1)]
        desired = self.blend.desired() if (self.blend is not None and self.role == "sulphide") else None
        self.panel = bm.build_panel(m, self.role, self.x, self.y, self.z0, self.target_t, self.claimed, levels, desired)
        if self.panel is None:         # свободных блоков рядом нет — берём блоки повторно
            self.panel = bm.build_panel(m, self.role, self.x, self.y, self.z0, self.target_t, set(), levels)
        if self.panel is None:         # совсем нечего взять (пустой пул): панель из одного ближайшего блока, роль не выполнена
            self.panel = bm.Panel(m, self.level, [m.locate(self.level, self.x, self.y)], 0.0)
        p = self.panel
        self.level = p.level
        self.role_mismatch = bool(p.mismatch)
        if p.mismatch:
            log.warning("%s: роль «%s» не выполнена — подходящих блоков рядом нет (нужного типа %.0f %% тоннажа); берём ближайшую панель",
                        self.id, self.role, 100.0 * p.match)
        n = len(p.blocks)
        p.reserved = set()                       # блоки, которые сейчас бурит станок
        p.blasted = bytearray(n)
        p.p80 = [0.0] * n
        p.hard_b = [0.0] * n
        if n:
            self._blend_frontier(0)                  # усреднение: первый блок панели — из ближайших по содержанию Cu к нужному
        for j in range(min(INITIAL_BLASTED, n)):   # взорванный запас на старте: крепость с небольшим разбросом
            self.blast(p, j, m.hard[p.blocks[j]] * (1.0 + self.rng.gauss(0.0, 0.03)))

    def blast(self, panel, j, f):
        """Блок взорван: ему присваиваются крепость (измеренная MWD) и P80 по модели Кузнецова–Рамлера."""
        idx = panel.blocks[j]
        m = self.model
        panel.hard_b[j] = f
        panel.p80[j] = bl.p80_mm(f, m.kind_of(idx), m.clay[idx], m.dens[idx])   # проект по типу блока, A — по Лилли
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

    def blasted_ahead_t(self):
        """Тоннаж взорванного запаса впереди экскаватора (остаток текущего блока и взорванные блоки подряд за ним)."""
        p, i = self.panel, self.cur_index()
        n = len(p.blocks)
        if i >= n or not p.blasted[i]:
            return 0.0
        t = self.model.tonnes(p.blocks[i]) - (self.extracted - p.cum[i])
        k = i + 1
        while k < n and p.blasted[k]:
            t += self.model.tonnes(p.blocks[k])
            k += 1
        return max(0.0, t)

    def blasted_ahead_h(self):
        """Сколько часов работы экскаватора хватит взорванного запаса; 0 — забой упирается в невзорванный блок."""
        return self.blasted_ahead_t() / max(self.rate_tph, 300.0)

    def ahead_status(self):
        """Предупреждение о нехватке бурения: ok (> 12 ч), low (4–12 ч), critical (< 4 ч взорванного запаса)."""
        h = self.blasted_ahead_h()
        return "ok" if h > 12.0 else ("low" if h >= 4.0 else "critical")

    def ahead_with_pending_h(self):
        """Запас с учётом блоков, которые станки бурят прямо сейчас (чтобы два станка не поехали в один и тот же забой)."""
        p = self.panel
        pending = sum(self.model.tonnes(p.blocks[j]) for j in p.reserved if j < len(p.blocks))
        return (self.blasted_ahead_t() + pending) / max(self.rate_tph, 300.0)

    def next_to_blast(self):
        p = self.panel
        for j in range(self.cur_index(), len(p.blocks)):
            if not p.blasted[j] and j not in p.reserved:
                self._blend_frontier(j)
                return j
        return None

    def _blend_frontier(self, j):
        """Усреднение внутри панели: из ближайших невзорванных блоков в очередь на бурение ставим тот, чьё Cu ближе к нужному
        (питание богаче цели — победнее, беднее — побогаче). Переставляются только ещё не тронутые блоки."""
        if self.blend is None or self.role != "sulphide":
            return
        p, m = self.panel, self.model
        end = j
        while end < len(p.blocks) and end < j + BLEND_LOOKAHEAD and not p.blasted[end] and end not in p.reserved:
            end += 1
        if end - j < 2:
            return
        want = self.blend.desired()
        q = min(range(j, end), key=lambda i: abs(m.cu[p.blocks[i]] - want) + 0.004 * (i - j))
        if q != j:
            p.blocks[j], p.blocks[q] = p.blocks[q], p.blocks[j]
            total = p.cum[j]
            for i in range(j, len(p.blocks)):
                p.cum[i] = total
                total += m.tonnes(p.blocks[i])
            p.total = total

    # -- отработка ---------------------------------------------------------------------
    def absorb(self, loaded, dt=0.0):
        """Отработка панели по приросту накопительного loaded_total экскаватора.

        Нулевое или отсутствующее значение — это начальное значение двойника, а не показание счётчика: ждём первого
        настоящего (положительного) значения и только от него считаем прирост. Скачок больше возможного за тик
        (счётчик перезапущен, пропуск сообщений) пропускается."""
        self.last_delta = 0.0
        if loaded is None or loaded <= 0:
            return
        if self.last_loaded is None or loaded < self.last_loaded:
            self.last_loaded = loaded          # первое показание или счётчик сброшен: новая точка отсчёта
            return
        delta = loaded - self.last_loaded
        self.last_loaded = loaded
        if delta > max(2000.0, 5.0 * RATE_MAX_TPH * max(dt, 1.0) / 3600.0):
            log.warning("%s: скачок loaded_total на %.0f т за тик — пропущен", self.id, delta)
            return
        self.extracted += delta
        self.last_delta = delta
        self.win_x += delta               # скорость отгрузки считаем по окну в 10 модельных минут, а не по тику
        self.win_t += dt
        if self.win_t >= 600.0:
            inst = self.win_x / self.win_t * 3600.0
            self.rate_tph = 0.8 * self.rate_tph + 0.2 * min(RATE_MAX_TPH, inst)
            self.win_x = self.win_t = 0.0
        while self.panel.total > 0 and self.extracted >= self.panel.total:
            self.extracted -= self.panel.total
            self.next_panel()

    def next_panel(self):
        m = self.model
        old = self.level
        self.panel_no += 1
        self._new_panel()
        self.preview = json.dumps(bm.preview(m, self.level, self.x, self.y, PREVIEW_BLOCKS), separators=(",", ":"))
        where = "на уступ %d" % (self.level + 1) if self.level != old else "на соседнюю панель уступа %d" % (self.level + 1)
        log.info("%s: панель отработана, забой переходит %s (панель %d, %.2f млн т, блоков %d, нужного типа %.0f %%)",
                 self.id, where, self.panel_no, self.panel.total / 1e6, len(self.panel.blocks), 100.0 * self.panel.match)

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
        c["powder_factor"] = bl.charge(self.model.kind_of(p.blocks[i]))["powder_factor"]
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
            "powder_factor": feature(round(c["powder_factor"], 2), "кг/м³"),
            "reserve_blocks": feature(self.reserve(), "шт"),
            "blasted_ahead_h": feature(round(self.blasted_ahead_h(), 1), "ч"),
            "drilling_ahead_status": feature(self.ahead_status()),
            "panel_no": feature(self.panel_no, "№"),
            "panel_extracted": feature(round(self.extracted, 0), "т"),
            "face_role": feature(self.role),
            "role_mismatch": feature(self.role_mismatch),
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
    for kind in ("ore", "waste"):
        ch, d = bl.charge(kind), bl.design(kind)
        log.info("взрыв (%s): скважина %.0f мм, сетка %.1f×%.1f м, заряд %.0f кг, удельный расход %.2f кг/м³, n=%.2f",
                 kind, d["d_mm"], d["burden"], d["spacing"], ch["mass"], ch["powder_factor"], bl.uniformity_n(kind))
    log.info("P80 опорное (руда, f=11): %.0f мм", bl.P80_REF)
    prev = read_prev_state(twins)
    claimed = set()
    tracker = FeedTracker()
    faces = [Face(t, b, geometry, model, claimed, rng, prev.get(t), tracker) for t, b in twins.items() if ":face-" in t]
    drills = []
    geo_ids = {o["id"] for o in geometry["objects"]}
    drill_ids = sorted(k for k in twins if k.split(":")[1].startswith("drill-") and k.split(":")[1][6:].isdigit())
    for thing in drill_ids:
        if thing.split(":")[1] not in geo_ids:      # места для станка в core/geometry.json нет — пропускаем, не падаем
            log.warning("буровой %s: нет места в core/geometry.json — станок пропущен", thing)
            continue
        drill = Drill(thing, geometry, model, rng, len(drills))     # индекс — по созданным станкам (пропущенные не считаются)
        old = prev.get(thing, {})
        drill.meters = max(0.0, num(old.get("meters_total"), 0.0))      # накопительные метры и скважины продолжаются
        drill.holes = max(0, int(num(old.get("holes_total"), 0.0)))
        drills.append(drill)
    for drill in drills:    # общий пул: любой станок может бурить любой забой, выбирая самый нуждающийся
        drill.faces = list(faces)
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
        n = max(1, len(drills))
        rate = {k: (sum(d.rates[k] for d in drills) / n) or 1.0 for k in ("ore", "waste")}    # т/ч одного станка по типам работ
        demand = need = 0.0
        for f in faces:
            r = min(f.rate_tph, RATE_MAX_TPH)
            demand += r
            need += r / rate["waste" if f.cur.get("ore_type") == "waste" else "ore"]   # станков, нужных этому забою
        # производительность бурения при текущем составе работ (руда и вскрыша): спрос / нужное число станков × число станков
        capacity = demand * n / need if need > 0 else n * rate["ore"]
        telemetry.publish("drill-summary", {
            "drill_utilisation_pct": feature(round(100.0 * sum(d.util for d in drills) / n, 1), "%"),
            "drilling_capacity_tph": feature(round(capacity, 0), "т/ч"),
            "blasting_demand_tph": feature(round(demand, 0), "т/ч"),
            "drills_needed": feature(round(need, 2), "шт"),
            "drills_working": feature(sum(1 for d in drills if d.state != "idle"), "шт"),
            "feed_cu_target": feature(FEED_CU_TARGET, "% Cu"),
            "feed_cu_actual": feature(round(tracker.actual() if tracker.actual() is not None else FEED_CU_TARGET, 3), "% Cu"),
        })
        tracker.tick(dt)
        for face in faces:
            if watcher.get(face.excavator, "face") == face.id:
                face.absorb(watcher.get(face.excavator, "loaded_total"), dt)
            else:
                face.last_loaded = None    # экскаватор в другом забое: счётчик чужой, отсчёт заново
                face.last_delta = 0.0      # и прироста в этот тик нет (иначе старый прирост снова попал бы в оценку питания)
            face.update_values(clay_on, clay_p, blast_on, blast_p)
            if face.last_delta > 0 and face.role == "sulphide" and face.cur.get("recommended_destination") == "crusher-01":
                tracker.add(face.last_delta, face.cur["cu_grade"])
            telemetry.publish(face.id, face.features())
        log.info("забои: %s", ", ".join(
            f"{f.id} {f.cur['cu_grade']:.2f}%Cu P80 {f.cur['p80']:.0f} мм lf {f.cur['loading_factor']:.2f} "
            f"{'взорван' if f.cur['blasted'] else 'НЕ взорван'} (запас {f.blasted_ahead_h():.0f} ч)" for f in faces[:4]))
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
