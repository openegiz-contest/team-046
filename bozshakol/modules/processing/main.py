#!/usr/bin/env python3
"""bz-processing — переработка и энергия (заглушка, участник №4 заменит логику).

Дробилка принимает руду по разнице счётчиков dispatch.delivered_crusher_t
(и _cu_t) → бункер → конвейер ≈ 3 км → склад крупнодроблёной руды → мельница ПСИ
около проектной производительности → флотация с извлечением ≈ 73,4 % → медь в
концентрате. Склад глинистой руды принимает по dispatch.delivered_clay_t, фабрика
глинистой руды забирает ≈ 570 т/ч. accepting у дробилки и склада глины.
Электроснабжение — по работающему оборудованию. Сценарии: crusher_stop, sag_maintenance.
"""
import json
import random
import time

from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging, value

log = setup_logging("bz-processing")
PUBLISH_S = 5.0

CRUSHER_TPH = 4000.0
BUNKER_T = 1500.0
SAG_TPH = 2850.0        # 25 млн т/год
CLAY_TPH = 570.0        # 5 млн т/год
RECOVERY = 73.4         # % (2025)
CONC_CU = 24.0          # % Cu в концентрате (допущение)
COARSE_CAP = 200000.0
CLAY_CAP = 120000.0
P_SAG, P_BALL, P_CRUSHER, P_OTHER = 28.0, 16.0, 1.0, 6.0  # МВт


class Pile:
    """Склад с массой и средним содержанием (взвешенным по массе)."""

    def __init__(self, stock, cu, clay=0.0):
        self.stock, self.cu, self.clay = stock, cu, clay
        self.received = self.reclaimed = 0.0

    def add(self, tonnes, cu, clay=0.0):
        if tonnes <= 0:
            return
        total = self.stock + tonnes
        self.cu = (self.cu * self.stock + cu * tonnes) / total
        self.clay = (self.clay * self.stock + clay * tonnes) / total
        self.stock = total
        self.received += tonnes

    def take(self, tonnes):
        t = min(self.stock, max(0.0, tonnes))
        self.stock -= t
        self.reclaimed += t
        return t


def main():
    with open("twins.json", encoding="utf-8") as f:
        twins = json.load(f)
    sc = twins["kz.bozshakol:stockpile-coarse"]["features"]
    coarse = Pile(value(sc, "stock", 60000.0), value(sc, "cu_grade", 0.39), value(sc, "clay_pct", 5.0))
    scl = twins["kz.bozshakol:stockpile-clay"]["features"]
    clay = Pile(value(scl, "stock", 30000.0), value(scl, "cu_grade", 0.31), 55.0)

    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios", "dispatch", "mine"}, client_id="bz-processing-watch").start()
    telemetry = Telemetry(client_id="bz-processing").connect()
    clock = SimClock()
    rng = random.Random(11)

    bunker = Pile(0.0, 0.39)
    last_crusher = last_crusher_cu = last_clay = last_clay_cu = None
    received_crusher = 0.0
    conveyor_load = 0.0
    energy_shift = 0.0
    sulph = {"ore": 0.0, "cu_t": 0.0}   # за смену
    clayp = {"ore": 0.0, "cu_t": 0.0}
    cu_total = 0.0
    shift_prev = None

    while True:
        dt = clock.tick()
        shift, shift_hour = clock.shift()
        if shift != shift_prev:  # новая смена — счётчики смены обнуляются
            sulph = {"ore": 0.0, "cu_t": 0.0}
            clayp = {"ore": 0.0, "cu_t": 0.0}
            energy_shift = 0.0
            shift_prev = shift
        hours = max(shift_hour, 0.01)

        crusher_stop, _ = watcher.scenario("crusher_stop")
        sag_maint, _ = watcher.scenario("sag_maintenance")

        # -- приём с самосвалов по накопительным счётчикам диспетчера ------------
        d_t = watcher.get("dispatch", "delivered_crusher_t")
        d_cu = watcher.get("dispatch", "delivered_crusher_cu_t")
        if d_t is not None and last_crusher is not None and d_t > last_crusher:
            tonnes = d_t - last_crusher
            cu_t = (d_cu or 0.0) - (last_crusher_cu or 0.0)
            bunker.add(tonnes, 100.0 * cu_t / tonnes if tonnes else 0.39, 5.0)
            received_crusher += tonnes
        if d_t is not None:
            last_crusher, last_crusher_cu = d_t, d_cu
        c_t = watcher.get("dispatch", "delivered_clay_t")
        c_cu = watcher.get("dispatch", "delivered_clay_cu_t")
        if c_t is not None and last_clay is not None and c_t > last_clay:
            tonnes = c_t - last_clay
            cu_t = (c_cu or 0.0) - (last_clay_cu or 0.0)
            clay.add(tonnes, 100.0 * cu_t / tonnes if tonnes else 0.31, 55.0)
        if c_t is not None:
            last_clay, last_clay_cu = c_t, c_cu

        # -- дробилка и конвейер -------------------------------------------------
        if crusher_stop:
            crushed = 0.0
            crusher_state = "stopped"
        else:
            crushed = bunker.take(CRUSHER_TPH * dt / 3600.0)
            crusher_state = "running" if crushed > 0 else "idle"
        crusher_tph = crushed / dt * 3600.0 if dt > 0 else 0.0
        accepting = (not crusher_stop) and bunker.stock < BUNKER_T * 0.9
        conveyor_load = crusher_tph * 3000.0 / (2.5 * 3600.0)  # т на ленте при 2,5 м/с (допущение)
        coarse.add(crushed, bunker.cu, bunker.clay)

        # -- мельница и флотация -------------------------------------------------
        if sag_maint or coarse.stock <= 0:
            milled = 0.0
            sag_state = "maintenance" if sag_maint else "starved"
        else:
            milled = coarse.take(SAG_TPH * rng.uniform(0.97, 1.03) * dt / 3600.0)
            sag_state = "running"
        feed_tph = milled / dt * 3600.0 if dt > 0 else 0.0
        recovery = RECOVERY + rng.gauss(0, 0.3)
        cu_t = milled * coarse.cu / 100.0 * recovery / 100.0
        conc_tph = (cu_t / (CONC_CU / 100.0)) / dt * 3600.0 if dt > 0 else 0.0
        sulph["ore"] += milled
        sulph["cu_t"] += cu_t
        cu_total += cu_t
        plan_sulph = 100.0 * sulph["ore"] / (SAG_TPH * hours)

        # -- фабрика глинистой руды ---------------------------------------------
        clay_fed = clay.take(CLAY_TPH * rng.uniform(0.95, 1.05) * dt / 3600.0)
        clay_tph = clay_fed / dt * 3600.0 if dt > 0 else 0.0
        clayp["ore"] += clay_fed
        clayp["cu_t"] += clay_fed * clay.cu / 100.0 * 0.60  # извлечение из глинистой руды ниже (допущение)
        plan_clay = 100.0 * clayp["ore"] / (CLAY_TPH * hours)
        clay_accepting = clay.stock < CLAY_CAP * 0.95

        # -- энергия ---------------------------------------------------------------
        p_sag = P_SAG * (feed_tph / SAG_TPH) if sag_state == "running" else 0.0
        p_ball = P_BALL * (feed_tph / SAG_TPH) if sag_state == "running" else 0.0
        p_cr = P_CRUSHER * (crusher_tph / CRUSHER_TPH) if crusher_state == "running" else 0.0
        load = p_sag + p_ball + p_cr + P_OTHER + (1.5 if clay_tph > 0 else 0.0)
        energy_shift += load * dt / 3600.0

        # -- публикация -----------------------------------------------------------
        telemetry.publish("crusher-01", {
            "state": feature(crusher_state), "accepting": feature(accepting),
            "throughput": feature(round(crusher_tph, 1), "т/ч"), "bunker": feature(round(bunker.stock, 1), "т"),
            "received_total": feature(round(received_crusher, 1), "т"),
            "trucks_queued": feature(int(watcher.get("dispatch", "queue_crusher", 0) or 0), "шт"),
            "feed_cu": feature(round(bunker.cu, 3), "% Cu"),
            "power": feature(round(p_cr, 2), "МВт"),
        })
        telemetry.publish("conveyor-01", {
            "state": feature("running" if crusher_tph > 0 else "idle"),
            "throughput": feature(round(crusher_tph, 1), "т/ч"),
            "speed": feature(2.5 if crusher_tph > 0 else 0.0, "м/с"), "load": feature(round(conveyor_load, 1), "т"),
        })
        telemetry.publish("stockpile-coarse", {
            "stock": feature(round(coarse.stock, 1), "т"), "cu_grade": feature(round(coarse.cu, 3), "% Cu"),
            "clay_pct": feature(round(coarse.clay, 1), "%"),
            "received_total": feature(round(coarse.received, 1), "т"),
            "reclaimed_total": feature(round(coarse.reclaimed, 1), "т"),
        })
        telemetry.publish("sag-mill-01", {
            "state": feature(sag_state), "throughput": feature(round(feed_tph, 1), "т/ч"),
            "power": feature(round(p_sag, 2), "МВт"), "p80_product": feature(150, "мкм"),
        })
        telemetry.publish("flotation-01", {
            "state": feature("running" if feed_tph > 0 else "idle"),
            "feed_rate": feature(round(feed_tph, 1), "т/ч"), "feed_cu": feature(round(coarse.cu, 3), "% Cu"),
            "recovery": feature(round(recovery, 2), "%"), "concentrate_tph": feature(round(conc_tph, 2), "т/ч"),
            "concentrate_cu": feature(CONC_CU, "% Cu"), "cu_in_concentrate_total": feature(round(cu_total, 2), "т Cu"),
        })
        telemetry.publish("plant-sulphide", {
            "feed_rate": feature(round(feed_tph, 1), "т/ч"), "feed_cu": feature(round(coarse.cu, 3), "% Cu"),
            "feed_clay": feature(round(coarse.clay, 1), "%"), "plan_fulfilment": feature(round(plan_sulph, 1), "%"),
            "ore_shift_t": feature(round(sulph["ore"], 1), "т"),
            "cu_concentrate_shift": feature(round(sulph["cu_t"], 2), "т"),
            "recovery": feature(round(recovery, 2), "%"), "state": feature("running" if feed_tph > 0 else "stopped"),
        })
        telemetry.publish("stockpile-clay", {
            "stock": feature(round(clay.stock, 1), "т"), "cu_grade": feature(round(clay.cu, 3), "% Cu"),
            "accepting": feature(clay_accepting), "received_total": feature(round(clay.received, 1), "т"),
            "reclaimed_total": feature(round(clay.reclaimed, 1), "т"),
            "trucks_queued": feature(int(watcher.get("dispatch", "queue_clay", 0) or 0), "шт"),
        })
        telemetry.publish("plant-clay", {
            "feed_rate": feature(round(clay_tph, 1), "т/ч"), "feed_cu": feature(round(clay.cu, 3), "% Cu"),
            "plan_fulfilment": feature(round(plan_clay, 1), "%"), "ore_shift_t": feature(round(clayp["ore"], 1), "т"),
            "cu_concentrate_shift": feature(round(clayp["cu_t"], 2), "т"),
            "state": feature("running" if clay_tph > 0 else "stopped"),
        })
        telemetry.publish("power-grid", {
            "load": feature(round(load, 2), "МВт"), "sag_mill": feature(round(p_sag, 2), "МВт"),
            "ball_mills": feature(round(p_ball, 2), "МВт"), "crusher": feature(round(p_cr, 2), "МВт"),
            "other": feature(P_OTHER, "МВт"), "energy_shift": feature(round(energy_shift, 1), "МВт·ч"),
        })
        if telemetry.sent % 90 < 9:
            log.info("дробилка %s %.0f т/ч (бункер %.0f т, accepting=%s); мельница %s %.0f т/ч; склад %.0f т; план %.0f %%",
                     crusher_state, crusher_tph, bunker.stock, accepting, sag_state, feed_tph, coarse.stock, plan_sulph)
        time.sleep(PUBLISH_S)


if __name__ == "__main__":
    main()
