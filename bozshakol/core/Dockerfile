FROM python:3.12-slim
WORKDIR /app
COPY core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core/bzlib ./bzlib
COPY core/setup.py core/main.py core/advisor.py core/advisor_rules.py core/reality.py core/geometry.json ./
USER nobody
CMD ["python", "main.py"]
