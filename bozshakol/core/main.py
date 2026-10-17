#!/usr/bin/env python3
"""bz-core — координатор рудника Бозшаколь.

Публикует двойник mine: модельное время, смену, погоду (с учётом сценария
blizzard), ограничение скорости и итоговые показатели, которые считает по чужим
двойникам через платформу (plant-sulphide, plant-clay, dispatch, flotation-01).
Сценарии создаёт bz-setup (все выключены); здесь они только читаются.
"""
import math
import random
import time

from bzlib import DittoClient, SimClock, Telemetry, TwinWatcher, feature, setup_logging

log = setup_logging("bz-core")
PERIOD_S = 5.0  # реальных секунд между публикациями mine

# допущения о зимней погоде в Павлодарской области (см. data/SOURCES.md)
BASE_TEMP_C = -12.0
BASE_WIND_MS = 4.0
BASE_VISIBILITY_M = 5000
BASE_SPEED_LIMIT = 50


def main():
    ditto = DittoClient()
    watcher = TwinWatcher(ditto, names={"scenarios", "plant-sulphide", "plant-clay", "dispatch", "flotation-01"},
                          client_id="bz-core-watch").start()
    telemetry = Telemetry(client_id="bz-core").connect()
    clock = SimClock()
    rng = random.Random(7)
    weather_t = 0.0

    while True:
        dt = clock.tick()
        weather_t += dt
        blizzard, params = watcher.scenario("blizzard")
        hour = (clock.now() / 3600.0) % 24
        temp = BASE_TEMP_C + 4.0 * math.sin((hour - 14) / 24 * 2 * math.pi) + rng.gauss(0, 0.2)
        wind = max(0.0, BASE_WIND_MS + 1.5 * math.sin(weather_t / 1800.0) + rng.gauss(0, 0.3))
        visibility = BASE_VISIBILITY_M
        speed_limit = BASE_SPEED_LIMIT
        if blizzard:
            wind += 10.0
            temp -= 6.0
            visibility = int(params.get("visibility_m", 300))
            speed_limit = int(params.get("speed_limit_kmh", 20))

        shift, shift_hour = clock.shift()
        sulph_feed = float(watcher.get("plant-sulphide", "feed_rate", 0.0) or 0.0)
        clay_feed = float(watcher.get("plant-clay", "feed_rate", 0.0) or 0.0)
        sulph_plan = float(watcher.get("plant-sulphide", "plan_fulfilment", 0.0) or 0.0)
        clay_plan = float(watcher.get("plant-clay", "plan_fulfilment", 0.0) or 0.0)
        plan = (sulph_plan * 25 + clay_plan * 5) / 30.0  # взвешено по мощности фабрик
        feed_cu = float(watcher.get("plant-sulphide", "feed_cu", 0.0) or 0.0)
        feed_clay = float(watcher.get("plant-sulphide", "feed_clay", 0.0) or 0.0)
        cu_conc = (float(watcher.get("plant-sulphide", "cu_concentrate_shift", 0.0) or 0.0)
                   + float(watcher.get("plant-clay", "cu_concentrate_shift", 0.0) or 0.0))
        trucks = int(watcher.get("dispatch", "trucks_hauling", 0) or 0)

        telemetry.publish("mine", {
            "sim_time": feature(clock.iso(), "ISO"),
            "shift": feature(shift, "№"),
            "shift_hour": feature(shift_hour, "ч"),
            "temperature": feature(round(temp, 1), "°C"),
            "wind": feature(round(wind, 1), "м/с"),
            "visibility": feature(visibility, "м"),
            "speed_limit": feature(speed_limit, "км/ч"),
            "blizzard": feature(blizzard),
            "ore_to_plants": feature(round(sulph_feed + clay_feed, 1), "т/ч"),
            "plan_fulfilment": feature(round(plan, 1), "%"),
            "feed_cu": feature(round(feed_cu, 3), "% Cu"),
            "feed_clay": feature(round(feed_clay, 1), "%"),
            "cu_concentrate_shift": feature(round(cu_conc, 1), "т"),
            "trucks_hauling": feature(trucks, "шт"),
        })
        if telemetry.sent % 12 == 1:
            log.info("смена %d, %s, %.0f т/ч на фабрики, план %.0f %%, метель=%s",
                     shift, clock.iso(), sulph_feed + clay_feed, plan, blizzard)
        time.sleep(PERIOD_S)


if __name__ == "__main__":
    main()
