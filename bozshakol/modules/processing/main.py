#!/usr/bin/env python3
"""bz-processing — переработка и энергия (участник №4).

Цепочка сульфидной руды: самосвалы (разница счётчиков dispatch.delivered_crusher_t и _cu_t)
→ приёмный бункер → гирационная дробилка (производительность зависит от крупности p80 и
крепости руды забоев) → магистральный конвейер (длина — из core/geometry.json, руда едет по
ленте с задержкой) → склад крупнодроблёной руды (буфер, запас в часах, прогноз остановки)
→ мельница ПСИ и флотация (питание = min(план, запас), извлечение зависит от содержания
меди и доли глины) → медь в концентрате.
Глинистая руда: dispatch.delivered_clay_t → склад глинистой руды → фабрика глинистой руды.
Сценарии: crusher_stop (дробилка стоит), sag_maintenance (мельница на ремонте).
Все параметры, источники и допущения — в README.md модуля.
"""
import json
import math
import time

from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging, value

log = setup_logging("bz-processing")
PUBLISH_S = 5.0
HOURS_YEAR = 8760.0

# -- план фабрик: факт 2025 г. (KAZ Minerals, Q4 2025) ------------------------------------
# переработано всего 35,7 млн т, из них глинистой руды 6,26 млн т (добыто). Раздельной
# переработки по фабрикам в отчёте нет: сульфидная = 35,7 − 6,26 = 29,44 млн т — допущение.
PLAN_SULPH_TPH = 29.44e6 / HOURS_YEAR   # ≈ 3 360 т/ч
PLAN_CLAY_TPH = 6.26e6 / HOURS_YEAR     # ≈ 715 т/ч

# -- дробилка и бункер (допущения, обоснование в README) ----------------------------------
CRUSHER_TPH = 4500.0    # номинал при p80 = P80_REF и крепости HARD_REF: план 3 360 т/ч ÷ 0,75 (работает ~75 % времени)
P80_REF = 450.0         # мм — крупность при нормальном взрыве по модулю №3 (450–500 мм; неудачный — 800–900 мм)
HARD_REF = 11.0         # ед. Протодьяконова — средняя крепость сульфидной руды по модулю №3 (F_REF в geology/blasting.py)
CRUSHER_AVAIL = 0.75    # доля времени, когда дробилка дробит (ждёт самосвалы, ТО, простои) — для расчёта % плана в README
CRUSHER_K_MIN, CRUSHER_K_MAX = 0.5, 1.15   # мелкая руда ускоряет не больше чем на 15 %, крупная замедляет не больше чем вдвое
BUNKER_T = 900.0        # приёмный бункер: 5 кузовов по 180 т (≈ 6–7 по 135 т)
TRUCK_MAX_T = 180.0     # бункер «принимает», пока в нём есть место для полного кузова
FLEET_T = 22 * 135.0 + 6 * 180.0   # 4 050 т — весь парк самосвалов (dispatch.fleet): больше за один шаг не привезти

# -- конвейер -------------------------------------------------------------------------------
BELT_SPEED = 2.5        # м/с — как в библиотеке моделей web/models.js (допущение)

# -- склады ----------------------------------------------------------------------------------
COARSE_CAP = 40000.0    # ≈ 12 ч питания сульфидной фабрики (допущение)
CLAY_CAP = 120000.0     # склад глинистой руды — долговременный (допущение)
BULK_DENSITY = 1.6      # т/м³ насыпная плотность дроблёной руды (допущение) — для объёма штабеля
STOP_WARN_H = 24.0      # stop_expected = true, если фабрика встанет раньше чем через сутки
ALARM_DECLINE_S = 15 * 60.0  # тревога по складу: убывает дольше 15 модельных минут подряд (или дробилка не принимает)

# -- извлечение меди (простые формулы, калибровка — в README) --------------------------------
# сульфидная: 75,5 % при 0,41 % Cu и 5 % глины; +2 п.п. на каждые 0,1 % Cu; −0,4 п.п. на 1 % глины сверх 5 %
REC_S0, REC_S_CU0, REC_S_CLAY0 = 75.5, 0.41, 5.0
REC_S_PER_CU, REC_S_PER_CLAY = 20.0, 0.4
# глинистая: 60 % при 0,31 % Cu и 55 % глины; +2 п.п. на 0,1 % Cu; −0,2 п.п. на 1 % глины сверх 55 %
REC_C0, REC_C_CU0, REC_C_CLAY0 = 60.0, 0.31, 55.0
REC_C_PER_CU, REC_C_PER_CLAY = 20.0, 0.2
CONC_CU = 24.0          # % Cu в концентрате (допущение заглушки)

# -- энергия (как в заглушке; подробная энергетика — следующее задание) ------------------------
P_SAG, P_CRUSHER, P_OTHER = 28.0, 1.0, 6.0  # МВт: мельница ПСИ 12,2 м — 28 МВт (ABB)
P_BALL = 2 * 22.0       # МВт: две шаровые мельницы 8,5 м по 22 МВт (ABB)

FACES = [f"face-0{i}" for i in range(1, 7)]
EXCAVATORS = [f"excavator-0{i}" for i in range(1, 7)]


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


class Pile:
    """Склад (бункер) с массой и средними показателями руды, взвешенными по массе."""

    def __init__(self, stock, cu, clay=0.0, p80=P80_REF, hardness=HARD_REF):
        self.stock = stock
        self.q = {"cu": cu, "clay": clay, "p80": p80, "hardness": hardness}
        self.received = self.reclaimed = 0.0

    def add(self, tonnes, q):
        if tonnes <= 0:
            return
        total = self.stock + tonnes
        for k, v in q.items():
            if v is not None:
                self.q[k] = (self.q[k] * self.stock + v * tonnes) / total
        self.stock = total
        self.received += tonnes

    def take(self, tonnes):
        t = min(self.stock, max(0.0, tonnes))
        self.stock -= t
        self.reclaimed += t
        return t


def conveyor_length(twins):
    """Длина трассы conveyor-01 — сумма отрезков из core/geometry.json (в плане, м)."""
    try:
        with open("geometry.json", encoding="utf-8") as f:
            geo = json.load(f)
        path = next(o["path"] for o in geo["objects"] if o["id"] == "conveyor-01")
        return sum(math.dist(a[:2], b[:2]) for a, b in zip(path, path[1:]))
    except (OSError, KeyError, StopIteration, ValueError) as exc:
        log.warning("geometry.json: нет трассы конвейера (%s), беру length_m из twins.json", exc)
        return float(twins["kz.bozshakol:conveyor-01"]["attributes"]["length_m"])


def face_quality(watcher, destination, defaults):
    """Среднее по работающим забоям, откуда руда идёт в destination.

    По договору нельзя понять, из какого забоя пришёл конкретный самосвал, поэтому берётся
    среднее по забоям, у которых работает экскаватор (не down) и recommended_destination = destination."""
    vals = {k: [] for k in defaults}
    for exc in EXCAVATORS:
        if watcher.get(exc, "state") == "down":
            continue
        face = watcher.get(exc, "face")
        if not face or watcher.get(face, "recommended_destination") != destination:
            continue
        for k in defaults:
            v = watcher.get(face, k)
            if isinstance(v, (int, float)):
                vals[k].append(float(v))
    return {k: (sum(v) / len(v) if v else defaults[k]) for k, v in vals.items()}


def crusher_capacity(p80, hardness):
    """Производительность дробилки, т/ч: номинал × √(P80_REF/p80) × √(HARD_REF/крепость), коэффициент в пределах 0,5–1,15."""
    k = math.sqrt(P80_REF / max(p80, 1.0)) * math.sqrt(HARD_REF / max(hardness, 1.0))
    return CRUSHER_TPH * clamp(k, CRUSHER_K_MIN, CRUSHER_K_MAX)


def recovery_sulphide(cu, clay):
    return clamp(REC_S0 + REC_S_PER_CU * (cu - REC_S_CU0) - REC_S_PER_CLAY * max(0.0, clay - REC_S_CLAY0), 40.0, 92.0)


def recovery_clay(cu, clay):
    return clamp(REC_C0 + REC_C_PER_CU * (cu - REC_C_CU0) - REC_C_PER_CLAY * max(0.0, clay - REC_C_CLAY0), 30.0, 80.0)


def sim_hhmm(epoch, now_epoch):
    """ЧЧ:ММ модельного времени; если не сегодня — с числом суток вперёд."""
    t, n = time.localtime(epoch), time.localtime(now_epoch)
    days = (time.mktime(t[:3] + (0, 0, 0, 0, 0, -1)) - time.mktime(n[:3] + (0, 0, 0, 0, 0, -1))) / 86400.0
    s = time.strftime("%H:%M", t)
    return s if round(days) == 0 else f"{s} (+{round(days)} сут)"


class Counter:
    """Приращение накопительного счётчика чужого двойника (договор, раздел 4).

    - пока значения нет (Ditto ещё не ответил) — приращение 0;
    - первое прочитанное после старта значение — опорная точка, приращение 0;
    - дальше приращение = текущее − предыдущее;
    - счётчик уменьшился — сброс у владельца: новое значение — новая опорная точка, приращение 0.
      Если затем счётчик вернулся к прежнему уровню (владелец на миг опубликовал 0 и восстановил свой итог),
      старые тонны второй раз не засчитываются: считается только рост выше прежнего уровня."""

    RESTORE_WINDOW = 24        # шагов (≈ 2 мин реального времени): столько ждём «восстановления» итога владельцем

    def __init__(self, name, max_step):
        self.name = name
        self.max_step = max_step   # больше за один шаг прийти не может — значит, это не руда, а смена опорной точки
        self.last = None
        self.before_reset = None   # уровень счётчика до сброса
        self.since_reset = 0

    def delta(self, v):
        if not isinstance(v, (int, float)):
            return 0.0
        if self.last is None:
            log.info("счётчик %s: опорная точка %.1f (приращение 0)", self.name, v)
            self.last = v
            return 0.0
        if v < self.last:
            log.warning("счётчик %s уменьшился %.1f → %.1f: сброс у владельца, новая опорная точка", self.name, self.last, v)
            self.before_reset = max(self.last, self.before_reset or 0.0)
            self.since_reset = 0
            self.last = v
            return 0.0
        d = v - self.last
        if self.before_reset is not None:
            self.since_reset += 1
            if v >= self.before_reset:   # итог восстановлен владельцем — засчитываем только рост сверх старого уровня
                d = v - self.before_reset
                log.warning("счётчик %s вернулся к уровню до сброса (%.1f → %.1f): засчитано %.1f, а не %.1f",
                            self.name, self.before_reset, v, d, v - self.last)
                self.before_reset = None
            elif self.since_reset > self.RESTORE_WINDOW:
                self.before_reset = None   # настоящий сброс: счётчик растёт с нуля как обычно
        if d > self.max_step:
            # например, bz-setup обнулил двойник в Ditto, а владелец продолжает со своим итогом
            log.warning("счётчик %s прыгнул %.1f → %.1f (+%.1f, больше %.0f за шаг): новая опорная точка, приращение 0",
                        self.name, self.last, v, d, self.max_step)
            d = 0.0
        self.last = v
        return d


OWN = ("crusher-01", "conveyor-01", "stockpile-coarse", "stockpile-clay", "flotation-01",
       "plant-sulphide", "plant-clay", "power-grid")


def load_own_state(ditto, twins):
    """Своё состояние при старте: из Ditto (двойники уже живут — перезапуск сервиса); если Ditto не ответил
    или признака нет — начальное значение из twins.json (новый стенд). Возвращает функцию get(двойник, признак, по умолчанию)."""
    live = {}
    for name in OWN:
        try:
            live[name] = (ditto.retry(lambda n=name: ditto.get_thing(n, "features"), attempts=5) or {}).get("features") or {}
        except Exception as exc:  # noqa: BLE001 — любая ошибка Ditto: берём twins.json
            log.warning("состояние %s: Ditto не ответил (%s), беру twins.json", name, exc)
    sources = {"Ditto": 0, "twins.json": 0}

    def get(name, feat, default=None):
        v = value(live.get(name, {}), feat)
        if isinstance(v, (int, float, str)) and not isinstance(v, bool):
            sources["Ditto"] += 1
            return v
        sources["twins.json"] += 1
        return value(twins.get(f"kz.bozshakol:{name}", {}).get("features", {}), feat, default)

    return get, sources


def sim_epoch(iso):
    """Модельное время двойника mine (ISO) → секунды, как SimClock.now()."""
    try:
        return time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


def clamp_pile(pile, cap, name):
    """Страховка: запас не меньше 0 и не больше ёмкости; превышение — признак ошибки, пишем в лог."""
    if pile.stock > cap:
        log.warning("%s: %.0f т больше ёмкости %.0f т — лишние %.0f т не приняты", name, pile.stock, cap, pile.stock - cap)
        pile.stock = cap
    pile.stock = max(0.0, pile.stock)


def main():
    with open("twins.json", encoding="utf-8") as f:
        twins = json.load(f)

    belt_len = conveyor_length(twins)
    transit_s = belt_len / BELT_SPEED
    log.info("конвейер: %.0f м по geometry.json, руда едет %.1f мин", belt_len, transit_s / 60)

    ditto = DittoClient()
    # -- своё состояние: восстановить из Ditto (договор, раздел 4), иначе — twins.json --------------
    st, sources = load_own_state(ditto, twins)
    coarse = Pile(float(st("stockpile-coarse", "stock", 15000.0)), float(st("stockpile-coarse", "cu_grade", 0.41)),
                  float(st("stockpile-coarse", "clay_pct", 5.0)))
    coarse.received = float(st("stockpile-coarse", "received_total", 0.0))
    coarse.reclaimed = float(st("stockpile-coarse", "reclaimed_total", 0.0))
    clay = Pile(float(st("stockpile-clay", "stock", 30000.0)), float(st("stockpile-clay", "cu_grade", 0.31)),
                float(st("stockpile-clay", "clay_pct", 55.0)))
    clay.received = float(st("stockpile-clay", "received_total", 0.0))
    clay.reclaimed = float(st("stockpile-clay", "reclaimed_total", 0.0))
    bunker = Pile(float(st("crusher-01", "bunker", 0.0)), float(st("crusher-01", "feed_cu", coarse.q["cu"])),
                  coarse.q["clay"], float(st("crusher-01", "feed_p80", P80_REF)), float(st("crusher-01", "feed_hardness", HARD_REF)))
    clamp_pile(bunker, BUNKER_T, "бункер дробилки при старте")
    clamp_pile(coarse, COARSE_CAP, "склад крупнодроблёной руды при старте")
    clamp_pile(clay, CLAY_CAP, "склад глинистой руды при старте")
    received_crusher = float(st("crusher-01", "received_total", 0.0))
    # руда на ленте хранится только тоннами: раскладываем её по ленте равномерно
    belt_load = max(0.0, float(st("conveyor-01", "load", 0.0)))
    belt = [[transit_s * (i + 0.5) / 10, belt_load / 10, {"cu": bunker.q["cu"], "clay": bunker.q["clay"]}]
            for i in range(10)] if belt_load > 0 else []   # [осталось ехать, с; тонны; показатели]
    cu_total = {"s": float(st("flotation-01", "cu_in_concentrate_total", 0.0)),
                "c": float(st("plant-clay", "cu_in_concentrate_total", 0.0))}
    saved_shift = {"shift": st("plant-sulphide", "shift", None),
                   "s_ore": float(st("plant-sulphide", "ore_shift_t", 0.0)), "s_cu": float(st("plant-sulphide", "cu_concentrate_shift", 0.0)),
                   "c_ore": float(st("plant-clay", "ore_shift_t", 0.0)), "c_cu": float(st("plant-clay", "cu_concentrate_shift", 0.0)),
                   "energy": float(st("power-grid", "energy_shift", 0.0))}
    log.info("состояние при старте: %d признаков из Ditto, %d из twins.json; бункер %.0f т, склад %.0f т, "
             "склад глины %.0f т, на ленте %.0f т, принято дробилкой %.0f т, медь в концентрате %.1f т",
             sources["Ditto"], sources["twins.json"], bunker.stock, coarse.stock, clay.stock, belt_load,
             received_crusher, cu_total["s"])

    names = {"scenarios", "dispatch", "mine", *FACES, *EXCAVATORS}
    watcher = TwinWatcher(ditto, names=names, client_id="bz-processing-watch").start()
    telemetry = Telemetry(client_id="bz-processing").connect()
    clock = SimClock()

    step_t = FLEET_T * max(1.0, PUBLISH_S * clock.speedup / 50.0)   # за шаг ≈ 50 модельных с больше парка не привезти
    c_crusher, c_crusher_cu = Counter("dispatch.delivered_crusher_t", step_t), Counter("dispatch.delivered_crusher_cu_t", step_t / 100.0)
    c_clay, c_clay_cu = Counter("dispatch.delivered_clay_t", step_t), Counter("dispatch.delivered_clay_cu_t", step_t / 100.0)
    cu_pending = {"crusher": 0.0, "clay": 0.0}
    blocked = coarse.stock >= COARSE_CAP   # склад полон — конвейер и дробилка стоят
    inflow_ema = PLAN_SULPH_TPH  # сглаженный приход на склад, т/ч (старт = план, без ложного прогноза остановки)
    declining_s = 0.0            # сколько модельных секунд подряд склад убывает
    energy_shift = 0.0
    shift_acc = None
    shift_prev = None

    while True:
        dt = clock.tick()
        if dt <= 0:
            time.sleep(PUBLISH_S)
            continue
        # смена и модельное время — из двойника mine (общие для всех); пока его нет — своим SimClock
        m_shift, m_hour = watcher.get("mine", "shift"), watcher.get("mine", "shift_hour")
        if isinstance(m_shift, (int, float)) and isinstance(m_hour, (int, float)):
            shift, shift_hour = int(m_shift), float(m_hour)
        else:
            shift, shift_hour = clock.shift()
        if shift != shift_prev:
            if shift_prev is None and saved_shift["shift"] is not None and int(saved_shift["shift"]) == shift:
                # перезапуск внутри той же смены — продолжаем её счётчики
                shift_acc = {k: saved_shift[k] for k in ("s_ore", "s_cu", "c_ore", "c_cu")}
                energy_shift = saved_shift["energy"]
                log.info("смена %d продолжается: руда за смену %.0f т, медь %.1f т", shift, shift_acc["s_ore"], shift_acc["s_cu"])
            else:   # новая смена (или смена прошла, пока сервис стоял) — счётчики смены с нуля
                shift_acc = {"s_ore": 0.0, "s_cu": 0.0, "c_ore": 0.0, "c_cu": 0.0}
                energy_shift = 0.0
                log.info("смена %d: счётчики смены с нуля", shift)
            shift_prev = shift
        hours = max(shift_hour, 0.05)
        now = sim_epoch(watcher.get("mine", "sim_time")) or clock.now()

        crusher_stop, _ = watcher.scenario("crusher_stop")
        sag_maint, _ = watcher.scenario("sag_maintenance")

        # -- качество руды забоев (модуль №3): среднее по работающим забоям --------------------
        q_s = face_quality(watcher, "crusher-01", {"p80": P80_REF, "hardness": HARD_REF, "clay_pct": 5.0})
        q_c = face_quality(watcher, "stockpile-clay", {"clay_pct": 55.0})

        # -- приём с самосвалов по накопительным счётчикам dispatch -----------------------------
        # тонны и медь приходят разными признаками: медь копится, пока не придут её тонны
        overflow = False   # пришло больше, чем помещается: признак ошибки, руду не принимаем
        t_in = c_crusher.delta(watcher.get("dispatch", "delivered_crusher_t"))
        cu_pending["crusher"] += c_crusher_cu.delta(watcher.get("dispatch", "delivered_crusher_cu_t"))
        if t_in > 0:
            cu_in, cu_pending["crusher"] = cu_pending["crusher"], 0.0
            room = max(0.0, BUNKER_T - bunker.stock)
            if t_in > room:
                log.warning("бункер дробилки: пришло %.0f т, места %.0f т (в бункере %.0f из %.0f т) — лишние %.0f т не приняты",
                            t_in, room, bunker.stock, BUNKER_T, t_in - room)
                overflow = True
            taken = min(t_in, room)
            bunker.add(taken, {"cu": 100.0 * cu_in / t_in, "clay": q_s["clay_pct"],
                               "p80": q_s["p80"], "hardness": q_s["hardness"]})
            received_crusher += taken
        clay_overflow = False
        t_cl = c_clay.delta(watcher.get("dispatch", "delivered_clay_t"))
        cu_pending["clay"] += c_clay_cu.delta(watcher.get("dispatch", "delivered_clay_cu_t"))
        if t_cl > 0:
            cu_cl, cu_pending["clay"] = cu_pending["clay"], 0.0
            room = max(0.0, CLAY_CAP - clay.stock)
            if t_cl > room:
                log.warning("склад глинистой руды: пришло %.0f т, места %.0f т — лишние %.0f т не приняты", t_cl, room, t_cl - room)
                clay_overflow = True
            clay.add(min(t_cl, room), {"cu": 100.0 * cu_cl / t_cl, "clay": q_c["clay_pct"]})

        # -- склад полон? (гистерезис 3 %) ------------------------------------------------------
        if coarse.stock >= COARSE_CAP:
            blocked = True
        elif coarse.stock < COARSE_CAP * 0.97:
            blocked = False

        # -- конвейер: руда едет transit_s секунд ----------------------------------------------
        discharged = 0.0
        if not blocked:
            for item in belt:
                item[0] -= dt
            arrived = [i for i in belt if i[0] <= 0]
            belt = [i for i in belt if i[0] > 0]
            for item in arrived:
                put = min(item[1], max(0.0, COARSE_CAP - coarse.stock))
                coarse.add(put, item[2])
                discharged += put
                if item[1] > put:      # склад полон: остаток ждёт на конце ленты, руда не теряется
                    belt.insert(0, [0.0, item[1] - put, item[2]])

        # -- дробилка ----------------------------------------------------------------------------
        cap_tph = crusher_capacity(bunker.q["p80"], bunker.q["hardness"])
        if crusher_stop:
            crushed, crusher_state, reason = 0.0, "stopped", "сценарий «Остановка дробилки»"
        elif blocked:
            crushed, crusher_state, reason = 0.0, "stopped", "склад крупнодроблёной руды полон"
        else:
            crushed = bunker.take(cap_tph * dt / 3600.0)
            crusher_state, reason = ("running", "") if crushed > 0 else ("idle", "нет руды в бункере")
        if crushed > 0:
            belt.append([transit_s, crushed, {k: bunker.q[k] for k in ("cu", "clay")}])
        crusher_tph = crushed / dt * 3600.0
        accepting = crusher_state != "stopped" and not overflow and bunker.stock <= BUNKER_T - TRUCK_MAX_T
        belt_t = sum(i[1] for i in belt)
        if blocked:
            conveyor_state = "stopped"
        elif belt_t > 0:
            conveyor_state = "running"
        else:
            conveyor_state = "stopped" if crusher_state == "stopped" else "idle"

        # -- сульфидная фабрика: питание = min(план, что может дать склад) ----------------------
        if sag_maint:
            milled, sag_state = 0.0, "maintenance"
        else:
            milled = coarse.take(PLAN_SULPH_TPH * dt / 3600.0)
            sag_state = "running" if milled > 0 else "idle"
        feed_tph = milled / dt * 3600.0
        feed_cu, feed_clay = coarse.q["cu"], coarse.q["clay"]
        rec_s = recovery_sulphide(feed_cu, feed_clay)
        cu_s = milled * feed_cu / 100.0 * rec_s / 100.0
        conc_tph = cu_s / (CONC_CU / 100.0) / dt * 3600.0
        cu_total["s"] += cu_s
        shift_acc["s_ore"] += milled
        shift_acc["s_cu"] += cu_s
        plan_s = 100.0 * shift_acc["s_ore"] / (PLAN_SULPH_TPH * hours)

        # -- запас склада и прогноз остановки фабрики -------------------------------------------
        inflow_tph = discharged / dt * 3600.0
        a = 1.0 - math.exp(-dt / 1800.0)          # сглаживание прихода за ~30 мин модельного времени
        inflow_ema += a * (inflow_tph - inflow_ema)
        use_tph = feed_tph if feed_tph > 0 else PLAN_SULPH_TPH
        hours_left = coarse.stock / use_tph
        # склад «реально убывает»: сглаженный приход меньше расхода; считаем, сколько это длится подряд
        declining_s = declining_s + dt if feed_tph - inflow_ema > 50.0 else 0.0
        # режим тревоги — только если дробилка не принимает руду или склад убывает дольше 15 модельных минут
        alarm = (not accepting) or declining_s >= ALARM_DECLINE_S
        supply_stopped = crusher_state == "stopped" or (belt_t <= 0 and crusher_tph <= 0)
        if sag_maint:
            forecast, h_stop = "мельница на ремонте", None
        elif supply_stopped:
            h_stop = coarse.stock / PLAN_SULPH_TPH
            forecast = sim_hhmm(now + h_stop * 3600.0, now)
        elif PLAN_SULPH_TPH - inflow_ema > 50.0:   # приход меньше питания — запас тает
            h_stop = coarse.stock / (PLAN_SULPH_TPH - inflow_ema)
            forecast = sim_hhmm(now + h_stop * 3600.0, now)
        else:
            forecast, h_stop = "не ожидается", None
        if not alarm and not sag_maint:
            forecast, h_stop = "запас в норме", None

        # -- фабрика глинистой руды: своя линия от склада глинистой руды ------------------------
        clay_fed = clay.take(PLAN_CLAY_TPH * dt / 3600.0)
        clay_tph = clay_fed / dt * 3600.0
        rec_c = recovery_clay(clay.q["cu"], clay.q["clay"])
        cu_c = clay_fed * clay.q["cu"] / 100.0 * rec_c / 100.0
        cu_total["c"] += cu_c
        shift_acc["c_ore"] += clay_fed
        shift_acc["c_cu"] += cu_c
        plan_c = 100.0 * shift_acc["c_ore"] / (PLAN_CLAY_TPH * hours)
        clay_accepting = not clay_overflow and clay.stock <= CLAY_CAP - TRUCK_MAX_T

        # -- энергия (упрощённо) -----------------------------------------------------------------
        p_sag = P_SAG * feed_tph / PLAN_SULPH_TPH if sag_state == "running" else 0.0
        p_ball = P_BALL * feed_tph / PLAN_SULPH_TPH if sag_state == "running" else 0.0
        p_cr = P_CRUSHER * crusher_tph / CRUSHER_TPH if crusher_state == "running" else 0.0
        load = p_sag + p_ball + p_cr + P_OTHER + (1.5 if clay_tph > 0 else 0.0)
        energy_shift += load * dt / 3600.0

        # -- публикация --------------------------------------------------------------------------
        r = round
        telemetry.publish("crusher-01", {
            "state": feature(crusher_state), "accepting": feature(accepting), "stop_reason": feature(reason),
            "throughput": feature(r(crusher_tph, 1), "т/ч"), "capacity": feature(r(cap_tph, 0), "т/ч"),
            "bunker": feature(r(bunker.stock, 1), "т"),
            "bunker_fill": feature(r(100.0 * bunker.stock / BUNKER_T, 1), "%"),
            "received_total": feature(r(received_crusher, 1), "т"),
            "trucks_queued": feature(int(watcher.get("dispatch", "queue_crusher", 0) or 0), "шт"),
            "feed_cu": feature(r(bunker.q["cu"], 3), "% Cu"),
            "feed_p80": feature(r(bunker.q["p80"], 0), "мм"), "feed_hardness": feature(r(bunker.q["hardness"], 1), "ед. Протодьяконова"),
            "power": feature(r(p_cr, 2), "МВт"),
        })
        telemetry.publish("conveyor-01", {
            "state": feature(conveyor_state),
            "throughput": feature(r(inflow_tph if not blocked else 0.0, 1), "т/ч"),
            "intake": feature(r(crusher_tph, 1), "т/ч"),
            "speed": feature(0.0 if conveyor_state != "running" else BELT_SPEED, "м/с"),
            "load": feature(r(belt_t, 1), "т"),
            "length": feature(r(belt_len, 0), "м"), "transit_time": feature(r(transit_s / 60.0, 1), "мин"),
        })
        telemetry.publish("stockpile-coarse", {
            "stock": feature(r(coarse.stock, 1), "т"), "cu_grade": feature(r(feed_cu, 3), "% Cu"),
            "clay_pct": feature(r(feed_clay, 1), "%"),
            "fill_pct": feature(r(100.0 * coarse.stock / COARSE_CAP, 1), "%"),
            "volume": feature(r(coarse.stock / BULK_DENSITY, 0), "м³"),
            "hours_left": feature(r(hours_left, 2), "ч"),
            "stop_forecast": feature(forecast),
            "stop_expected": feature(alarm and h_stop is not None and h_stop < STOP_WARN_H),
            "alarm": feature(alarm), "declining_min": feature(r(declining_s / 60.0, 0), "мин"),
            "inflow": feature(r(inflow_ema, 1), "т/ч"), "outflow": feature(r(feed_tph, 1), "т/ч"),
            "full": feature(blocked),
            "received_total": feature(r(coarse.received, 1), "т"),
            "reclaimed_total": feature(r(coarse.reclaimed, 1), "т"),
        })
        telemetry.publish("sag-mill-01", {
            "state": feature(sag_state), "throughput": feature(r(feed_tph, 1), "т/ч"),
            "power": feature(r(p_sag, 2), "МВт"), "p80_product": feature(150, "мкм"),
        })
        telemetry.publish("flotation-01", {
            "state": feature("running" if feed_tph > 0 else ("maintenance" if sag_maint else "idle")),
            "feed_rate": feature(r(feed_tph, 1), "т/ч"), "feed_cu": feature(r(feed_cu, 3), "% Cu"),
            "feed_clay": feature(r(feed_clay, 1), "%"),
            "recovery": feature(r(rec_s, 2), "%"), "concentrate_tph": feature(r(conc_tph, 2), "т/ч"),
            "concentrate_cu": feature(CONC_CU, "% Cu"), "cu_in_concentrate_total": feature(r(cu_total["s"], 2), "т Cu"),
        })
        telemetry.publish("plant-sulphide", {
            "feed_rate": feature(r(feed_tph, 1), "т/ч"), "plan_rate": feature(r(PLAN_SULPH_TPH, 0), "т/ч"),
            "feed_cu": feature(r(feed_cu, 3), "% Cu"), "feed_clay": feature(r(feed_clay, 1), "%"),
            "plan_fulfilment": feature(r(plan_s, 1), "%"), "shift": feature(shift),
            "ore_shift_t": feature(r(shift_acc["s_ore"], 1), "т"),
            "cu_concentrate_shift": feature(r(shift_acc["s_cu"], 2), "т"),
            "cu_year_pace": feature(r(cu_s / dt * 3600.0 * HOURS_YEAR / 1000.0, 1), "тыс. т/год"),
            "recovery": feature(r(rec_s, 2), "%"),
            "state": feature("running" if feed_tph > 0 else ("maintenance" if sag_maint else "idle")),
        })
        telemetry.publish("stockpile-clay", {
            "stock": feature(r(clay.stock, 1), "т"), "cu_grade": feature(r(clay.q["cu"], 3), "% Cu"),
            "clay_pct": feature(r(clay.q["clay"], 1), "%"),
            "fill_pct": feature(r(100.0 * clay.stock / CLAY_CAP, 1), "%"),
            "volume": feature(r(clay.stock / BULK_DENSITY, 0), "м³"),
            "hours_left": feature(r(clay.stock / PLAN_CLAY_TPH, 1), "ч"),
            "accepting": feature(clay_accepting), "received_total": feature(r(clay.received, 1), "т"),
            "reclaimed_total": feature(r(clay.reclaimed, 1), "т"),
            "trucks_queued": feature(int(watcher.get("dispatch", "queue_clay", 0) or 0), "шт"),
        })
        telemetry.publish("plant-clay", {
            "feed_rate": feature(r(clay_tph, 1), "т/ч"), "plan_rate": feature(r(PLAN_CLAY_TPH, 0), "т/ч"),
            "feed_cu": feature(r(clay.q["cu"], 3), "% Cu"), "feed_clay": feature(r(clay.q["clay"], 1), "%"),
            "plan_fulfilment": feature(r(plan_c, 1), "%"), "ore_shift_t": feature(r(shift_acc["c_ore"], 1), "т"),
            "cu_concentrate_shift": feature(r(shift_acc["c_cu"], 2), "т"),
            "cu_in_concentrate_total": feature(r(cu_total["c"], 2), "т Cu"),
            "cu_year_pace": feature(r(cu_c / dt * 3600.0 * HOURS_YEAR / 1000.0, 1), "тыс. т/год"),
            "recovery": feature(r(rec_c, 2), "%"),
            "state": feature("running" if clay_tph > 0 else "idle"),
        })
        telemetry.publish("power-grid", {
            "load": feature(r(load, 2), "МВт"), "sag_mill": feature(r(p_sag, 2), "МВт"),
            "ball_mills": feature(r(p_ball, 2), "МВт"), "crusher": feature(r(p_cr, 2), "МВт"),
            "other": feature(P_OTHER, "МВт"), "energy_shift": feature(r(energy_shift, 1), "МВт·ч"),
        })
        if telemetry.sent % 90 < 9:
            log.info("дробилка %s %.0f/%.0f т/ч (бункер %.0f т, accepting=%s); лента %.0f т; склад %.0f т (%.1f ч, %s); "
                     "мельница %s %.0f т/ч, извл. %.1f %%; глина %.0f т/ч; план %.0f %%",
                     crusher_state, crusher_tph, cap_tph, bunker.stock, accepting, belt_t, coarse.stock, hours_left,
                     forecast, sag_state, feed_tph, rec_s, clay_tph, plan_s)
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
