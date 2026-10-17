"""Высота рельефа в координатах рудника по terrain.json + heights.bin (без сторонних библиотек).

Используется core/tools/make_geometry.py, чтобы согласовать высоты наземных узлов
geometry.json с рельефом. Внутри контура карьера рельеф не применяется — там модель уступов.
"""
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))


class Terrain:
    def __init__(self, folder=HERE):
        with open(os.path.join(folder, "terrain.json"), encoding="utf-8") as f:
            self.meta = json.load(f)
        h = self.meta["heights"]
        self.n = h["n"]
        self.step = h["step_m"]
        self.half = self.meta["half_m"]
        with open(os.path.join(folder, h["file"]), "rb") as f:
            raw = f.read()
        self.values = struct.unpack(f"<{self.n * self.n}h", raw)
        a, b = self.meta["pit_contour"]["semi_axes"]
        self.pit_a, self.pit_b = a, b

    def inside_pit(self, x, y):
        return (x / self.pit_a) ** 2 + (y / self.pit_b) ** 2 < 1.0

    def height_at(self, x, y):
        """Высота (м) относительно борта карьера; за пределами сетки — край."""
        fx = (x + self.half) / self.step
        fy = (y + self.half) / self.step
        fx = min(max(fx, 0.0), self.n - 1.001)
        fy = min(max(fy, 0.0), self.n - 1.001)
        c0, r0 = int(fx), int(fy)
        tx, ty = fx - c0, fy - r0
        v = self.values
        n = self.n
        top = v[r0 * n + c0] * (1 - tx) + v[r0 * n + c0 + 1] * tx
        bot = v[(r0 + 1) * n + c0] * (1 - tx) + v[(r0 + 1) * n + c0 + 1] * tx
        return (top * (1 - ty) + bot * ty) / 10.0


def load():
    """Terrain или None, если файлов нет."""
    try:
        return Terrain()
    except (OSError, ValueError, KeyError):
        return None
