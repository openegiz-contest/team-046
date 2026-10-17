# Контекст сборки — bozshakol/ (см. compose.yml): общая библиотека берётся из core/bzlib.
FROM python:3.12-slim
WORKDIR /app
COPY modules/processing/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core/bzlib ./bzlib
COPY core/geometry.json ./geometry.json
COPY modules/processing/main.py modules/processing/twins.json ./
USER nobody
CMD ["python", "main.py"]
