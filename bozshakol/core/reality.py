"""Сверка с реальностью: величины модели (по двойникам, среднее за последний модельный час) против
фактов Бозшаколя из data/SOURCES.md. Чистые функции — их вызывает bz-advisor и проверяют тесты.

rows = reality_rows(samples)  # samples — [(модельные секунды, снимок {двойник: {признак: значение}})]
Каждая строка: id, name, unit, model (или None — «нет данных»), real (число) или real_range [от, до],
dev_pct (отклонение, %; для диапазона — от ближайшей границы, внутри — 0), status ok / off / warmup / no_data,
source (откуда реальная цифра), model_from (из каких признаков двойников).
"""

WINDOW_S = 3600          # последний модельный час
WARMUP_S = 3300          # меньше 55 мин данных — «модель разгоняется»
TOL_PCT = 10.0           # «в пределах» — отклонение не больше ±10 %

KAZ = ("KAZ Minerals, Q4 2025 Production report — "
       "https://www.kazminerals.com/app/uploads/2026/02/Q4-2025-Production-report_FINAL_ENG.pdf")
HEXAGON = "im-mining.com, 28.03.2025 — https://im-mining.com/2025/03/28/hexagons-fleet-and-fatigue-management-in-tandem-at-bozshakol/"
NDT = "Справочник НДТ РК 2023 (zakon.uchet.kz, документ P2300001101) — по данным модуля переработки"

# id, название, единица, реальное значение или диапазон, источник, из чего модель
ROWS = [
    ("feed_sulphide", "Руда на сульфидную фабрику", "т/ч", 3360, None,
     KAZ + "; расчёт: (35,7 − 6,26) млн т / 8 760 ч", "plant-sulphide.feed_rate"),
    ("feed_clay", "Руда на фабрику глинистой руды", "т/ч", 715, None,
     KAZ + "; расчёт: 6,26 млн т / 8 760 ч", "plant-clay.feed_rate"),
    ("cu_grade", "Содержание меди в питании", "% Cu", 0.39, None, KAZ,
     "feed_cu обеих фабрик, взвешено по feed_rate"),
    ("recovery", "Извлечение меди", "%", 73.4, None, KAZ,
     "медь в концентрат / медь в питании по обеим фабрикам (feed_rate × feed_cu × recovery)"),
    ("cu_kt_year", "Медь в концентрате, темп года", "тыс. т/год", 102, None,
     KAZ + "; расчёт: 35,7 млн т × 0,39 % × 73,4 % ≈ 102 тыс. т", "cu_year_pace обеих фабрик"),
    ("wait_excavator", "Ожидание самосвала у экскаватора (режим «авто»)", "мин", None, (1.0, 1.5),
     HEXAGON + " (было 3–5 мин до диспетчеризации)", "dispatch.avg_wait_excavator"),
    ("energy_kwh_t", "Удельная электроэнергия фабрики", "кВт·ч/т", None, (26.9, 36.3), NDT,
     "plant-sulphide.specific_energy (публикует модуль переработки)"),
]


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


def sample_values(snap):
    """Мгновенные величины модели из снимка двойников; None — признак не публикуется."""
    ps, pc = snap.get("plant-sulphide") or {}, snap.get("plant-clay") or {}
    d = snap.get("dispatch") or {}
    fs, fc = _num(ps.get("feed_rate")), _num(pc.get("feed_rate"))
    gs, gc = _num(ps.get("feed_cu")), _num(pc.get("feed_cu"))
    rs, rc = _num(ps.get("recovery")), _num(pc.get("recovery"))
    out = {"feed_sulphide": fs, "feed_clay": fc}
    if None not in (fs, fc, gs, gc) and fs + fc > 0:
        out["cu_grade"] = (fs * gs + fc * gc) / (fs + fc)
    if None not in (fs, fc, gs, gc, rs, rc) and fs * gs + fc * gc > 0:
        out["recovery"] = (fs * gs * rs + fc * gc * rc) / (fs * gs + fc * gc)
    ys, yc = _num(ps.get("cu_year_pace")), _num(pc.get("cu_year_pace"))
    if ys is not None or yc is not None:
        out["cu_kt_year"] = (ys or 0.0) + (yc or 0.0)
    if str(d.get("mode") or "") == "auto":
        out["wait_excavator"] = _num(d.get("avg_wait_excavator"))
    out["energy_kwh_t"] = _num(ps.get("specific_energy"))
    return out


def _dev(model, real, rng):
    if rng:
        lo, hi = rng
        if lo <= model <= hi:
            return 0.0
        b = lo if model < lo else hi
        return (model - b) / b * 100.0
    return (model - real) / real * 100.0


def reality_rows(samples, t0=None):
    """samples: [(t, {id: значение})] — значения sample_values по времени. Среднее за последний час.
    t0 — модельное время первого среза после старта (для «модель разгоняется»), по умолчанию — первый срез."""
    t_last = samples[-1][0] if samples else None
    span = (t_last - (samples[0][0] if t0 is None else t0)) if samples else 0.0
    window = [v for t, v in samples if t_last is not None and t_last - t <= WINDOW_S]
    rows = []
    for rid, name, unit, real, rng, source, model_from in ROWS:
        vals = [v[rid] for v in window if v.get(rid) is not None]
        model = sum(vals) / len(vals) if vals else None
        row = {"id": rid, "name": name, "unit": unit, "real": real, "real_range": list(rng) if rng else None,
               "model": None if model is None else round(model, 3), "dev_pct": None, "source": source,
               "model_from": model_from}
        if model is None:
            row["status"] = "no_data"
        else:
            row["dev_pct"] = round(_dev(model, real, rng), 1)
            if span < WARMUP_S:
                row["status"] = "warmup"
            else:
                row["status"] = "ok" if abs(row["dev_pct"]) <= TOL_PCT else "off"
        rows.append(row)
    return rows, {"window_min": round(min(span, WINDOW_S) / 60.0, 1), "warmup": span < WARMUP_S}
