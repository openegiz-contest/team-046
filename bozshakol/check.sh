#!/usr/bin/env bash
# Проверка работающего стенда рудника Бозшаколь. Запуск из корня репозитория:
#   make bozshakol-check   (или bash bozshakol/check.sh)
# Порты и пароли — из deploy/compose/.env. Пишет, что в порядке и что нет;
# при любой ошибке код выхода ненулевой.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/compose/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ОШИБКА: нет $ENV_FILE — стенд не запускался (make bozshakol)"; exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
H="${OPENEGIZ_PUBLIC_HOST:-localhost}"
DITTO="http://$H:${DITTO_PORT:-8080}"
WEB="http://$H:${BOZSHAKOL_WEB_PORT:-8095}"
INFLUX="http://$H:${INFLUXDB_PORT:-8086}"
AUTH="ditto:${DITTO_PASSWORD}"
NS="kz.bozshakol"
FRESH_S=30
fail=0
ok()   { printf '  \033[32mв порядке\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mОШИБКА\033[0m     %s\n' "$1"; fail=1; }

command -v python3 >/dev/null || { echo "ОШИБКА: нужен python3"; exit 1; }
command -v curl >/dev/null || { echo "ОШИБКА: нужен curl"; exit 1; }

echo "Проверка стенда Бозшаколь ($(date '+%H:%M:%S'))"

# 1. Все двойники из twins.json есть в Ditto и обновлялись за последние 30 с -------
echo "1. Двойники в Ditto"
expected="$(python3 - "$ROOT/bozshakol" <<'PY'
import glob, json, os, sys
root = sys.argv[1]
files = [os.path.join(root, "core", "twins.json")] + sorted(glob.glob(os.path.join(root, "modules", "*", "twins.json")))
ids = []
for f in files:
    ids += list(json.load(open(f, encoding="utf-8")).keys())
print("\n".join(ids))
PY
)"
expected_n="$(printf '%s\n' "$expected" | grep -c .)"
things="$(curl -s --max-time 20 -u "$AUTH" "$DITTO/api/2/search/things?namespaces=$NS&option=size(200)&fields=thingId,_modified")"
case "$things" in
  "{"*) things_ok=1 ;;
  *) things_ok=0 ;;
esac
if [ "$things_ok" = 0 ]; then
  bad "Ditto не отвечает по адресу $DITTO (ответ: $(printf '%s' "$things" | tr -d '
' | cut -c1-60)); после запуска подождите 1–2 минуты и повторите"
else
  result="$(python3 - "$expected" "$FRESH_S" <<'PY' "$things"
import json, sys, datetime
expected = sys.argv[1].split()
fresh_s = int(sys.argv[2])
items = json.loads(sys.argv[3]).get("items", [])
now = datetime.datetime.now(datetime.timezone.utc)
seen = {}
for it in items:
    m = it.get("_modified")
    age = None
    if m:
        t = datetime.datetime.fromisoformat(m.replace("Z", "+00:00"))
        age = (now - t).total_seconds()
    seen[it["thingId"]] = age
missing = [t for t in expected if t not in seen]
stale = [t for t in expected if t in seen and (seen[t] is None or seen[t] > fresh_s)]
# scenarios и pit-central меняются только по событию — свежесть у них не требуется
stale = [t for t in stale if not t.endswith((":scenarios", ":pit-central"))]
print(len(expected), len(missing), len(stale))
print(" ".join(missing))
print(" ".join(stale))
PY
)"
  read -r total missing_n stale_n <<<"$(printf '%s\n' "$result" | sed -n 1p)"
  missing="$(printf '%s\n' "$result" | sed -n 2p)"
  stale="$(printf '%s\n' "$result" | sed -n 3p)"
  # Поисковый индекс Ditto отстаёт первые секунды после создания двойников:
  # то, чего нет в поиске, спрашиваем напрямую.
  if [ "$missing_n" != 0 ]; then
    still=""
    for t in $missing; do
      code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -u "$AUTH" "$DITTO/api/2/things/$t?fields=thingId")"
      [ "$code" = 200 ] || still="$still $t"
    done
    missing="${still# }"
    missing_n=0
    [ -n "$missing" ] && missing_n="$(printf '%s
' "$missing" | wc -w)"
  fi
  if [ "$missing_n" = 0 ]; then ok "все $total двойников $NS есть в Ditto"; else bad "нет двойников ($missing_n): $missing"; fi
  if [ "$stale_n" = 0 ]; then ok "все двойники обновлялись за последние ${FRESH_S} с"; else bad "не обновлялись больше ${FRESH_S} с ($stale_n): $stale"; fi
fi

# 2. Сценарий включается и выключается записью одного признака ---------------------
echo "2. Сценарии"
scen_url="$DITTO/api/2/things/$NS:scenarios/features/blizzard/properties/value"
before="$(curl -s --max-time 10 -u "$AUTH" "$scen_url")"
code_on="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -u "$AUTH" -X PUT -H 'Content-Type: application/json' -d true "$scen_url")"
sleep 1
now_on="$(curl -s --max-time 10 -u "$AUTH" "$scen_url")"
code_off="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -u "$AUTH" -X PUT -H 'Content-Type: application/json' -d false "$scen_url")"
sleep 1
now_off="$(curl -s --max-time 10 -u "$AUTH" "$scen_url")"
if [ "$now_on" = "true" ] && [ "$now_off" = "false" ]; then
  ok "сценарий blizzard включился ($code_on) и выключился ($code_off); было: ${before:-?}"
else
  bad "сценарий blizzard: после включения '$now_on' ($code_on), после выключения '$now_off' ($code_off)"
fi
if [ "$before" = "true" ]; then  # вернуть как было
  curl -s --max-time 10 -o /dev/null -u "$AUTH" -X PUT -H 'Content-Type: application/json' -d true "$scen_url"
fi

# 3. 3D-страница отвечает и её прокси к Ditto работает -------------------------------
echo "3. 3D-сцена"
code_web="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$WEB/")"
if [ "$code_web" = 200 ]; then ok "страница $WEB отвечает (HTTP $code_web)"; else bad "страница $WEB: HTTP ${code_web:-нет ответа}"; fi
code_proxy="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$WEB/ditto/api/2/things/$NS:mine?fields=thingId")"
if [ "$code_proxy" = 200 ]; then ok "прокси к Ditto на странице работает"; else bad "прокси /ditto/ на странице: HTTP $code_proxy"; fi
code_three="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$WEB/vendor/three/three.module.js")"
if [ "$code_three" = 200 ]; then ok "three.js отдаётся локально"; else bad "vendor/three/three.module.js: HTTP $code_three"; fi

# 4. В InfluxDB есть свежие точки kz.bozshakol --------------------------------------
echo "4. История в InfluxDB"
flux='from(bucket: "default") |> range(start: -2m) |> filter(fn: (r) => r.thingId =~ /^kz\.bozshakol:/) |> keep(columns: ["_time","thingId"]) |> group() |> count(column: "thingId") |> rename(columns: {thingId: "_value"})'
points="$(curl -s --max-time 20 -X POST "$INFLUX/api/v2/query?org=opentwins" \
  -H "Authorization: Token ${INFLUXDB_TOKEN}" -H 'Content-Type: application/vnd.flux' -H 'Accept: application/csv' \
  --data-binary "$flux" | tr -d '
' | grep -v '^$' | awk -F, 'NR==1{for(i=1;i<=NF;i++) if($i=="_value") c=i} NR==2{print $c}')"
if [ -n "${points:-}" ] && [ "${points:-0}" -gt 0 ] 2>/dev/null; then
  ok "за последние 2 минуты в InfluxDB записано $points точек $NS"
else
  bad "в InfluxDB нет свежих точек $NS (Telegraf → InfluxDB)"
fi

# 5. Grafana отвечает -----------------------------------------------------------------
echo "5. Grafana"
code_gf="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$H:${GRAFANA_PORT:-3000}/api/health")"
if [ "$code_gf" = 200 ]; then ok "Grafana отвечает на http://$H:${GRAFANA_PORT:-3000}"; else bad "Grafana: HTTP $code_gf"; fi

echo
if [ "$fail" = 0 ]; then
  echo "Итог: всё в порядке."
else
  echo "Итог: есть ошибки (см. выше)."
fi
exit "$fail"
