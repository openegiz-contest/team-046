# Контекст сборки — bozshakol/ (см. compose.yml): общая библиотека берётся из core/bzlib.
FROM python:3.12-slim
WORKDIR /app
COPY modules/geology/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core/bzlib ./bzlib
COPY core/geometry.json ./geometry.json
COPY modules/geology/main.py modules/geology/twins.json ./
USER nobody
CMD ["python", "main.py"]
