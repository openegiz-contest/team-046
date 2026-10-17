# Рельеф и снимок вокруг карьера Бозшаколь

Файлы в этой папке лежат в репозитории готовыми: при запуске стенда ничего не скачивается.

| Файл | Что | Размер |
|---|---|---|
| `terrain.json` | параметры сетки, привязка к координатам рудника, источники | 2 КБ |
| `heights.bin` | высоты рельефа: 201 × 201 значений int16 (little-endian), дециметры относительно уровня борта карьера, шаг 30 м, строки с юга на север | 79 КБ |
| `texture.jpg` | цветной снимок Sentinel-2 (TCI), тот же квадрат 6 × 6 км, 10 м/пиксель, строка 0 — север | 77 КБ |
| `make_terrain.py`, `make_terrain.sh` | скрипт, который воспроизводит три файла выше из открытых данных (контейнер `python:3.12-slim` + rasterio; нужен интернет) | |
| `heights.py` | чтение высот без сторонних библиотек; используется `core/tools/make_geometry.py` | |

## Привязка

Квадрат 6 × 6 км с центром в центре карьера: 51,855° с. ш., 74,307° в. д. (UTM 43N, E 452 272, N 5 745 138),
подобран по снимку Sentinel-2. Ось X рудника идёт вдоль длинной оси карьера — ≈ 11° к северу от востока,
ось Y — перпендикулярно (≈ север), Z — высота относительно уровня борта карьера (медиана высот рельефа
по контуру карьера, 233,2 м над уровнем моря). Контур карьера по снимку ≈ 4,3 × 1,2 км принят как эллипс
модели (полуоси 2 200 × 550 м, как в `core/geometry.json`).

Рельеф Copernicus DEM снят в 2011–2015 гг.: современной ямы в нём нет (есть начало выработки).
Поэтому в сцене вокруг — реальный рельеф с текстурой, а сам карьер — наша модель уступов, вписанная
в контур карьера со снимка. Положение дробилки, конвейера, фабрик, складов и отвала в `geometry.json`
остаётся схемой (не положением реальных объектов), высоты их наземных узлов взяты из рельефа.

## Как воспроизвести

```bash
bash bozshakol/data/terrain/make_terrain.sh
```

Скрипт читает плитку Copernicus DEM GLO-30 `N51_00_E074_00` и сцену Sentinel-2 L2A
`S2B_T43UDT_20240629T060949_L2A` (TCI, 29 июня 2024 г., облачность 0,15 %) прямо с открытых
хранилищ AWS, вырезает квадрат, поворачивает его в координаты рудника и сохраняет файлы.
Сцена выбрана запросом к STAC Earth Search (`https://earth-search.aws.element84.com/v1`,
коллекция `sentinel-2-c1-l2a`, bbox 74,2–74,42° в. д., 51,78–51,92° с. ш., лето 2024–2025, облачность < 5 %).

## Источники, лицензии и атрибуция

Лицензия MIT репозитория покрывает код, но не эти данные. Данные — открытые данные программы Copernicus
со своими условиями использования; при любом использовании сохраняйте атрибуцию ниже.

- **Рельеф:** Copernicus DEM GLO-30, https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/ (AWS Open Data).
  «produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
  provided under COPERNICUS by the European Union and ESA; all rights reserved».
  «The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability
  for any use of the Copernicus WorldDEM-30».
  Условия: https://spacedata.copernicus.eu/documents/20123/121239/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf
- **Снимок:** Sentinel-2 L2A (Earth Search by Element 84, AWS Open Data). «Contains modified Copernicus Sentinel data 2024».
  Условия: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice
