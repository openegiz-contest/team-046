#!/usr/bin/env python3
"""Расчёт на модели (не замер на стенде): баланс бурения при разном числе станков и разной скорости отгрузки экскаваторов.

Те же блочная модель, панели, станки и правила бурения, что в сервисе bz-geology (общий пул станков; станок бурит, пока взорванный запас
впереди экскаватора меньше 72 часов его работы). Для каждого сочетания «число станков — скорость сульфидного экскаватора» считается
минимальный взорванный запас blasted_ahead_h по забоям, сколько часов запас был на нуле и какую долю времени станки были в работе.
Стенд не нужен.

Запуск из bozshakol/ (около 5–10 минут):  python3 modules/geology/tools/drilling_balance.py
Необязательный аргумент: число модельных суток на сочетание (по умолчанию 20).

Допущения: сульфидные экскаваторы грузят R т/ч каждый (1000, 1100 или 1500), глинистый 700 т/ч, вскрышные 2000 т/ч, без простоев;
скорость отгрузки умножается на loading_factor забоя; шаг 100 модельных секунд; зерно датчика случайных чисел 3; усреднение выключено.
"""
import sys

from modelrun import DT, build, rate_of

CASES = ((3, 1000.0), (5, 1000.0), (3, 1100.0), (5, 1100.0), (5, 1500.0))


def run(n_drills, rate, days):
    model, tracker, faces, drills = build(n_drills, False)
    tot = {f.id: 0.0 for f in faces}
    low = {f.id: 1e9 for f in faces}
    zero = {f.id: 0.0 for f in faces}
    for _ in range(int(days * 86400 / DT)):
        for d in drills:
            d.step(DT)
        for f in faces:
            lf = f.cur["loading_factor"] if f.cur else 1.0
            tot[f.id] += rate_of(f, rate) * DT / 3600.0 * lf
            f.absorb(tot[f.id], DT)
            f.update_values(False, {}, False, {})
            ahead = f.blasted_ahead_h()
            low[f.id] = min(low[f.id], ahead)
            if ahead < 0.05:
                zero[f.id] += DT / 3600.0
    busy = [d.busy_s / d.total_s for d in drills]
    return low, zero, busy


def main():
    days = float(sys.argv[1]) if len(sys.argv) > 1 else 20
    print("Расчёт на модели (не замер на стенде): %g модельных суток на сочетание; сульфидный экскаватор R т/ч, глинистый 700, вскрышные 2000" % days)
    print("\n| Станков | R, т/ч | Минимум запаса `blasted_ahead_h` по забоям, ч | Часов в нуле | Доля времени станков в работе |")
    print("|---|---|---|---|---|")
    for n, rate in CASES:
        low, zero, busy = run(n, rate, days)
        zeros = {k[-2:]: round(v, 1) for k, v in zero.items() if v >= 0.05}
        b_lo, b_hi = round(100 * min(busy)), round(100 * max(busy))
        row = "| %d | %.0f | %.1f–%.1f | %s | %s |" % (
            n, rate, min(low.values()), max(low.values()),
            ("; ".join("face-%s: %s ч" % kv for kv in zeros.items()) if zeros else "нет"), ("%d %%" % b_lo) if b_lo == b_hi else ("%d–%d %%" % (b_lo, b_hi)))
        print(row.replace(".", ","))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
