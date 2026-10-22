#!/usr/bin/env python3
"""Расчёт на модели (не замер на стенде): усреднение содержания Cu в питании дробилки, с усреднением и без.

Считает отработку забоев на той же блочной модели и тех же панелях, что в сервисе bz-geology: станки бурят и взрывают блоки,
забои отрабатываются с заданной скоростью отгрузки, и за каждые модельные сутки считается среднее Cu в питании дробилки
(тоннаж-взвешенное по забоям с recommended_destination = crusher-01). Стенд не нужен.

Запуск из bozshakol/ (около 3–6 минут):  python3 modules/geology/tools/blend_run.py
Необязательные аргументы: число суток (по умолчанию 10) и скорость сульфидного экскаватора, т/ч (по умолчанию 1000).

Допущения: сульфидные экскаваторы грузят R т/ч каждый (R = 1000), глинистый 700 т/ч, вскрышные 2000 т/ч, без простоев;
скорость отгрузки умножается на loading_factor забоя; пять станков; шаг 100 модельных секунд; зерно датчика случайных чисел 3.
Цель 0,39 % Cu, коридор 0,35–0,43 %.
"""
import sys

from modelrun import DT, G, build, rate_of


def run(days, rate, blend):
    """Содержание Cu в питании дробилки по суткам, %."""
    model, tracker, faces, drills = build(5, blend)
    steps_day = int(86400 / DT)
    tot = {f.id: 0.0 for f in faces}
    cu_t = cu_w = 0.0
    out = []
    for step in range(int(days * steps_day) + 1):
        if tracker:
            tracker.tick(DT)
        for d in drills:
            d.step(DT)
        for f in faces:
            lf = f.cur["loading_factor"] if f.cur else 1.0
            moved = rate_of(f, rate) * DT / 3600.0 * lf
            tot[f.id] += moved
            f.absorb(tot[f.id], DT)
            f.update_values(False, {}, False, {})
            c = f.cur
            if c["recommended_destination"] == "crusher-01":
                cu_t += moved * c["cu_grade"]
                cu_w += moved
                if tracker and f.role == "sulphide":
                    tracker.add(f.last_delta, c["cu_grade"])
        if step > 0 and step % steps_day == 0:
            out.append(cu_t / cu_w if cu_w else float("nan"))
            cu_t = cu_w = 0.0
    return out


def fmt(v):
    return ("%.3f" % v).replace(".", ",")


def main():
    days = int(float(sys.argv[1])) if len(sys.argv) > 1 else 10
    rate = float(sys.argv[2]) if len(sys.argv) > 2 else 1000.0
    low, high = G.FEED_CU_LOW, G.FEED_CU_HIGH
    print("Расчёт на модели (не замер на стенде): Cu в питании дробилки за сутки, %%; сульфидные экскаваторы %.0f т/ч, пять станков, BLEND_GAIN = %s"
          % (rate, G.BLEND_GAIN))
    off = run(days, rate, False)
    on = run(days, rate, True)
    print("\n| Сутки | Без усреднения | С усреднением | Коридор %s–%s |" % (fmt(low)[:4], fmt(high)[:4]))
    print("|---|---|---|---|")
    for i, (a, b) in enumerate(zip(off, on), 1):
        print("| %d | %s | %s | %s |" % (i, fmt(a), fmt(b), "в коридоре" if low <= b <= high else ("ниже %s" % fmt(low)[:4] if b < low else "выше %s" % fmt(high)[:4])))
    for name, v in (("без усреднения", off), ("с усреднением", on)):
        inside = sum(1 for x in v if low <= x <= high)
        print("%s: %s–%s %%, среднее %s %%, в коридоре %d суток из %d" % (name, fmt(min(v)), fmt(max(v)), fmt(sum(v) / len(v)), inside, len(v)))


if __name__ == "__main__":
    main()
