#!/usr/bin/env bash
# Воспроизводит terrain.json, heights.bin и texture.jpg из открытых данных (нужен интернет).
# Стенду этот шаг не нужен: готовые файлы лежат в репозитории.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker run --rm -v "$HERE:/work" -w /work docker.io/library/python:3.12-slim bash -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq libexpat1 >/dev/null
  pip install -q rasterio==1.4.3 numpy==2.2.6 pillow==11.2.1
  python make_terrain.py'
