#!/usr/bin/env python3
"""Готовит рельеф и снимок вокруг карьера Бозшаколь для 3D-сцены.

Запуск: bash make_terrain.sh (контейнер python:3.12-slim с rasterio; интернет нужен
только здесь, стенд ничего не скачивает). Результат — в этой же папке:
  terrain.json  — параметры сетки, привязка к координатам рудника, источники
  heights.bin   — высоты, int16, дециметры относительно уровня борта карьера, строки с юга на север
  texture.jpg   — цветной снимок Sentinel-2 (TCI), тот же квадрат, 10 м/пиксель

Источники (открытые данные, без ключей):
  Copernicus DEM GLO-30  https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/  (плитка N51 E074)
  Sentinel-2 L2A, TCI    STAC Earth Search https://earth-search.aws.element84.com/v1, коллекция sentinel-2-c1-l2a

Система координат рудника (core/geometry.json): начало — центр карьера, X — вдоль длинной оси
карьера (≈ 11° к северу от востока), Y — перпендикулярно (≈ север), Z — высота относительно
борта карьера. Центр и поворот подобраны по снимку (см. README.md).
"""
import json
import math
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform
from rasterio.windows import from_bounds

HERE = os.path.dirname(os.path.abspath(__file__))

# --- привязка (подобрано по снимку Sentinel-2 от 2024-06-29) ---------------------------
CENTER_LON, CENTER_LAT = 74.307, 51.855     # центр карьера
THETA_DEG = 11.0                            # поворот оси X рудника от востока к северу
HALF_M = 3000                               # половина стороны квадрата (6 × 6 км)
DEM_STEP_M = 30                             # шаг сетки высот
TEX_STEP_M = 10                             # шаг текстуры (разрешение Sentinel-2)
PIT_SEMI_AXES = (2200, 550)                 # контур карьера в координатах рудника (как в geometry.json)

DEM_URL = ("https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/"
           "Copernicus_DSM_COG_10_N51_00_E074_00_DEM/Copernicus_DSM_COG_10_N51_00_E074_00_DEM.tif")
# Сцена выбрана запросом к STAC: bbox [74.2,51.78,74.42,51.92], лето 2024–2025, облачность < 5 %,
# взята малооблачная (0,15 %) летняя сцена 2024-06-29.
TCI_URL = ("https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/"
           "sentinel-2-c1-l2a/43/U/DT/2024/6/S2B_T43UDT_20240629T060949_L2A/TCI.tif")
TCI_DATE = "2024-06-29"
TCI_ID = "S2B_T43UDT_20240629T060949_L2A"


def local_grid(step):
    """Узлы сетки в координатах рудника: строки — y с юга на север, столбцы — x с запада на восток."""
    n = int(2 * HALF_M / step) + 1
    xs = -HALF_M + step * np.arange(n)
    ys = -HALF_M + step * np.arange(n)
    gx, gy = np.meshgrid(xs, ys)
    return gx, gy


def to_utm(gx, gy, e0, n0):
    th = math.radians(THETA_DEG)
    e = e0 + gx * math.cos(th) - gy * math.sin(th)
    n = n0 + gx * math.sin(th) + gy * math.cos(th)
    return e, n


def bilinear(arr, rows, cols):
    """Билинейная выборка массива по дробным индексам."""
    r0 = np.clip(np.floor(rows).astype(int), 0, arr.shape[0] - 2)
    c0 = np.clip(np.floor(cols).astype(int), 0, arr.shape[1] - 2)
    fr = np.clip(rows - r0, 0, 1)
    fc = np.clip(cols - c0, 0, 1)
    top = arr[r0, c0] * (1 - fc) + arr[r0, c0 + 1] * fc
    bot = arr[r0 + 1, c0] * (1 - fc) + arr[r0 + 1, c0 + 1] * fc
    return top * (1 - fr) + bot * fr


def main():
    with rasterio.open(TCI_URL) as tci:
        crs = tci.crs
        (e0,), (n0,) = transform("EPSG:4326", crs, [CENTER_LON], [CENTER_LAT])
        print(f"центр карьера: {CENTER_LON}, {CENTER_LAT} → {crs} E={e0:.0f} N={n0:.0f}")

        # --- текстура -----------------------------------------------------------------
        gx, gy = local_grid(TEX_STEP_M)
        e, n = to_utm(gx, gy, e0, n0)
        margin = 50
        win = from_bounds(e.min() - margin, n.min() - margin, e.max() + margin, n.max() + margin, tci.transform)
        rgb = tci.read(window=win)
        wt = tci.window_transform(win)
        inv = ~wt
        cols, rows = inv * (e, n)
        out = np.stack([bilinear(rgb[b].astype(np.float32), rows, cols) for b in range(3)], axis=-1)
        out = np.clip(out, 0, 255).astype(np.uint8)[::-1]   # строка 0 — север (как у картинки)
        Image.fromarray(out).save(os.path.join(HERE, "texture.jpg"), quality=78, optimize=True)
        print("texture.jpg", out.shape, os.path.getsize(os.path.join(HERE, "texture.jpg")) // 1024, "КБ")

    # --- рельеф ---------------------------------------------------------------------------
    with rasterio.open(DEM_URL) as dem:
        gx, gy = local_grid(DEM_STEP_M)
        e, n = to_utm(gx, gy, e0, n0)
        lon, lat = transform(crs, "EPSG:4326", e.ravel().tolist(), n.ravel().tolist())
        lon, lat = np.array(lon).reshape(gx.shape), np.array(lat).reshape(gx.shape)
        pad = 0.01
        win = from_bounds(lon.min() - pad, lat.min() - pad, lon.max() + pad, lat.max() + pad, dem.transform)
        tile = dem.read(1, window=win).astype(np.float32)
        wt = dem.window_transform(win)
        cols, rows = (~wt) * (lon, lat)
        h = bilinear(tile, rows, cols)
    # уровень борта карьера: медиана высот на контуре эллипса (отступ 150 м наружу)
    a, b = PIT_SEMI_AXES[0] + 150, PIT_SEMI_AXES[1] + 150
    rim = np.abs((gx / a) ** 2 + (gy / b) ** 2 - 1.0) < 0.12
    h_ref = float(np.median(h[rim]))
    rel = h - h_ref
    print(f"высоты: {h.min():.0f}–{h.max():.0f} м, уровень борта {h_ref:.1f} м, "
          f"относительно: {rel.min():.0f}…{rel.max():.0f} м")
    data = np.round(rel * 10).astype(np.int16)  # дециметры
    data.tofile(os.path.join(HERE, "heights.bin"))

    meta = {
        "_comment": "Сетка высот и снимок вокруг карьера Бозшаколь в координатах рудника (core/geometry.json). Сгенерировано make_terrain.py.",
        "center": {"lon": CENTER_LON, "lat": CENTER_LAT, "utm_epsg": int(str(crs).split(":")[1]), "e": round(e0, 1), "n": round(n0, 1)},
        "theta_deg": THETA_DEG,
        "half_m": HALF_M,
        "heights": {"file": "heights.bin", "dtype": "int16 little-endian", "unit": "дм относительно h_ref",
                    "step_m": DEM_STEP_M, "n": int(gx.shape[0]), "order": "строки с юга на север, столбцы с запада на восток",
                    "h_ref_m": round(h_ref, 1), "min_m": round(float(rel.min()), 1), "max_m": round(float(rel.max()), 1)},
        "texture": {"file": "texture.jpg", "step_m": TEX_STEP_M, "n": int(2 * HALF_M / TEX_STEP_M) + 1,
                    "order": "строка 0 — север", "scene": TCI_ID, "date": TCI_DATE},
        "pit_contour": {"type": "ellipse", "center": [0, 0], "semi_axes": list(PIT_SEMI_AXES), "note": "контур карьера по снимку ≈ 4,3 × 1,2 км, принят как эллипс модели"},
        "sources": {
            "dem": {"name": "Copernicus DEM GLO-30", "tile": "N51_00_E074_00", "url": DEM_URL,
                    "attribution": "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"},
            "image": {"name": "Sentinel-2 L2A TCI", "scene": TCI_ID, "url": TCI_URL,
                      "attribution": "Contains modified Copernicus Sentinel data 2024"},
        },
    }
    with open(os.path.join(HERE, "terrain.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print("terrain.json, heights.bin", os.path.getsize(os.path.join(HERE, "heights.bin")) // 1024, "КБ")


if __name__ == "__main__":
    main()
