#!/usr/bin/env python3
"""Калибровка блочной модели по среднему 2025 года (не входит в образ сервиса).

Запуск из bozshakol/:  python3 modules/geology/tools/calibrate.py
Подбирает CAL (mu, sigma, clay_surf, c_au) в blockmodel.py так, чтобы по рудным блокам
Cu ≈ 0,39 %, Au ≈ 0,19 г/т, глинистая руда ≈ 17,5 % рудного тоннажа, вскрыша/руда ≈ 0,67 т/т.
Бортовое 0,20 % Cu и порог глины 30 % зафиксированы в blockmodel.py и здесь не трогаются.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import blockmodel as bm  # noqa: E402

TARGET = {"cu": 0.39, "au": 0.19, "clay_share": 0.175, "strip": 0.67}


def run(model, cal):
    model.finalize(cal)
    return model.stats()


def main():
    geo = os.path.join(HERE, "..", "..", "..", "core", "geometry.json")
    with open(geo, encoding="utf-8") as f:
        geometry = json.load(f)
    t0 = time.time()
    model = bm.BlockModel(geometry)
    print("построение этапа 1: %.1f с, блоков %d" % (time.time() - t0, model.count))
    cal = dict(bm.CAL)
    for it in range(10):
        # 1) mu, sigma: Ньютон по (cu, strip) с численным якобианом
        for _ in range(4):
            s0 = run(model, cal)
            d = 0.03
            sm = run(model, dict(cal, mu=cal["mu"] + d))
            ss = run(model, dict(cal, sigma=cal["sigma"] * (1 + d)))
            j = [[(sm["cu"] - s0["cu"]) / d, (ss["cu"] - s0["cu"]) / (cal["sigma"] * d)],
                 [(sm["strip"] - s0["strip"]) / d, (ss["strip"] - s0["strip"]) / (cal["sigma"] * d)]]
            e = [TARGET["cu"] - s0["cu"], TARGET["strip"] - s0["strip"]]
            det = j[0][0] * j[1][1] - j[0][1] * j[1][0]
            if abs(det) < 1e-12:
                break
            dmu = (e[0] * j[1][1] - j[0][1] * e[1]) / det
            dsg = (j[0][0] * e[1] - e[0] * j[1][0]) / det
            cal["mu"] += max(-0.5, min(0.5, dmu))
            cal["sigma"] = max(0.2, cal["sigma"] + max(-0.3, min(0.3, dsg)))
        # 2) clay_surf: деление пополам по доле глины
        lo, hi = 0.0, 120.0
        for _ in range(18):
            mid = (lo + hi) / 2
            if run(model, dict(cal, clay_surf=mid))["clay_share"] < TARGET["clay_share"]:
                lo = mid
            else:
                hi = mid
        cal["clay_surf"] = (lo + hi) / 2
        # 3) c_au: линейно (золото слабо влияет на тип)
        s = run(model, cal)
        cal["c_au"] += TARGET["au"] - s["au"]
        s = run(model, cal)
        print("итерация %d: cu %.4f au %.4f глина %.4f вскрыша/руда %.4f" % (it, s["cu"], s["au"], s["clay_share"], s["strip"]))
        if all(abs(s[k] / TARGET[k] - 1) < 0.005 for k in TARGET):
            break
    print("CAL =", {k: round(v, 5) for k, v in cal.items()})
    print("итог:", {k: round(v, 4) for k, v in s.items()})
    print("перцентили Cu по рудным блокам: p50 %.3f p90 %.3f p99 %.3f max %.3f; максимум по модели %.3f" % (
        s["cu_p50"], s["cu_p90"], s["cu_p99"], s["cu_max_ore"], s["cu_max_all"]))


if __name__ == "__main__":
    main()
