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
  # Поисковый индекс Ditto под нагрузкой может отставать: «застывшие» по поиску двойники перепроверяем
  # напрямую (чтение двойника по thingId) с тем же порогом. Ошибка — только если двойник застыл и там;
  # если Ditto напрямую не ответил — остаётся то, что увидено в поиске
  lag=""; still_direct=""; still_search=""
  for t in $stale; do
    m="$(curl -s --max-time 10 -u "$AUTH" "$DITTO/api/2/things/$t?fields=_modified")"
    age="$(python3 -c '
import json, sys, datetime
try:
    m = json.loads(sys.argv[1])["_modified"]
    t = datetime.datetime.fromisoformat(m.replace("Z", "+00:00"))
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
except Exception:
    print(-1)' "$m")"
    if [ "$age" -lt 0 ]; then still_search="$still_search $t"
    elif [ "$age" -gt "$FRESH_S" ]; then still_direct="$still_direct $t"
    else lag="$lag $t"; fi
  done
  nd="$(printf '%s\n' $still_direct | grep -c .)"; ns="$(printf '%s\n' $still_search | grep -c .)"; nl="$(printf '%s\n' $lag | grep -c .)"
  if [ "$nd" = 0 ] && [ "$ns" = 0 ]; then
    if [ "$nl" = 0 ]; then ok "все двойники обновлялись за последние ${FRESH_S} с"
    else ok "все двойники обновлялись за последние ${FRESH_S} с (Ditto напрямую; поиск отставал у $nl:${lag})"; fi
  else
    msg="не обновлялись больше ${FRESH_S} с"
    [ "$nd" != 0 ] && msg="$msg — Ditto напрямую ($nd):${still_direct}"
    [ "$ns" != 0 ] && msg="$msg — поиск, напрямую Ditto не ответил ($ns):${still_search}"
    bad "$msg"
  fi
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
# Сразу после запуска стенда первые точки появляются через 20–60 с: до трёх попыток
for attempt in 1 2 3; do
  points="$(curl -s --max-time 20 -X POST "$INFLUX/api/v2/query?org=opentwins" \
    -H "Authorization: Token ${INFLUXDB_TOKEN}" -H 'Content-Type: application/vnd.flux' -H 'Accept: application/csv' \
    --data-binary "$flux" | tr -d '\r' | grep -v '^$' | awk -F, 'NR==1{for(i=1;i<=NF;i++) if($i=="_value") c=i} NR==2{print $c}')"
  if [ -n "${points:-}" ] && [ "${points:-0}" -gt 0 ] 2>/dev/null; then break; fi
  [ "$attempt" -lt 3 ] && sleep 20
done
if [ -n "${points:-}" ] && [ "${points:-0}" -gt 0 ] 2>/dev/null; then
  ok "за последние 2 минуты в InfluxDB записано $points точек $NS"
else
  bad "в InfluxDB нет свежих точек $NS (Telegraf → InfluxDB)"
  if docker logs --tail 20 openegiz-telegraf-1 2>&1 | grep -q "401 Unauthorized"; then
    echo "             Telegraf получает 401 от InfluxDB: пароли в deploy/compose/.env не совпадают с томами"
    echo "             (например, .env создан заново при сохранённых томах). Лечится: make clean, затем make bozshakol."
  fi
fi

# 4а. Сценарии в истории: mine.scenario_* (договор, раздел 6) ----------------------------
flux_sc='from(bucket: "default") |> range(start: -2m) |> filter(fn: (r) => r.thingId == "kz.bozshakol:mine" and r._field == "value_scenario_blizzard_properties_value") |> keep(columns: ["_time","_value"]) |> last()'
sc_last="$(curl -s --max-time 20 -X POST "$INFLUX/api/v2/query?org=opentwins" \
    -H "Authorization: Token ${INFLUXDB_TOKEN}" -H 'Content-Type: application/vnd.flux' -H 'Accept: application/csv' \
    --data-binary "$flux_sc" | tr -d '\r' | grep -v '^$' | awk -F, 'NR==1{for(i=1;i<=NF;i++) if($i=="_value") c=i} NR==2{print $c}')"
case "${sc_last:-}" in
  0|1) ok "сценарии пишутся в историю: mine.scenario_blizzard = $sc_last (поле value_scenario_*_properties_value)" ;;
  *) bad "в InfluxDB нет mine.scenario_* (bz-core должен публиковать scenario_<имя> вместе с признаками mine)" ;;
esac

# 5. Grafana отвечает -----------------------------------------------------------------
echo "5. Grafana"
code_gf="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$H:${GRAFANA_PORT:-3000}/api/health")"
if [ "$code_gf" = 200 ]; then ok "Grafana отвечает на http://$H:${GRAFANA_PORT:-3000}"; else bad "Grafana: HTTP $code_gf"; fi

# 6. Перезапуск сервисов переработки и транспорта: счётчики и запасы восстанавливаются ------
echo "6. Перезапуск сервисов (bz-processing, bz-haulage) и повторный make bozshakol"
read_state() {
  python3 - "$DITTO" "$AUTH" <<'PY'
import base64, json, sys, urllib.request
base, auth = sys.argv[1], sys.argv[2]
hdr = {"Authorization": "Basic " + base64.b64encode(auth.encode()).decode()}
def get(n):
    r = urllib.request.Request(f"{base}/api/2/things/kz.bozshakol:{n}", headers=hdr)
    return json.load(urllib.request.urlopen(r, timeout=15))
v = lambda t, f: ((t.get("features") or {}).get(f) or {}).get("properties", {}).get("value")
cr, sc, sl, d = get("crusher-01"), get("stockpile-coarse"), get("stockpile-clay"), get("dispatch")
out = {"bunker": v(cr, "bunker"), "bunker_t": cr["attributes"].get("bunker_t"),
       "coarse": v(sc, "stock"), "coarse_cap": sc["attributes"].get("capacity_t"),
       "clay": v(sl, "stock"), "clay_cap": sl["attributes"].get("capacity_t")}
for k in ("delivered_crusher_t", "delivered_clay_t", "delivered_dump_t", "trips_total"):
    out[k] = v(d, k)
print(json.dumps(out))
PY
}
# сравнение состояния до и после: бункер и склады в пределах ёмкости и без скачка, счётчики dispatch не уменьшились
compare_state() {   # $1 — до, $2 — после, $3 — сколько реальных секунд прошло (по умолчанию ~40 с перезапуска)
  python3 - "$1" "$2" "${3:-40}" "${SIM_SPEEDUP:-10}" <<'PY2'
import json, sys
b, a = json.loads(sys.argv[1]), json.loads(sys.argv[2] or "{}")
problems = []
# т: больше, чем склад может измениться за это время (≈ 4 000 т/ч модельного времени + запас 300 т)
JUMP_T = max(600, float(sys.argv[3]) * float(sys.argv[4]) / 3600 * 4000 + 300)
num = lambda x: float(x) if isinstance(x, (int, float)) else None
if num(a.get("bunker")) is None or num(a.get("bunker_t")) is None or not (0 <= a["bunker"] <= a["bunker_t"]):
    problems.append(f"бункер дробилки {a.get('bunker')} т при ёмкости {a.get('bunker_t')} т")
names = {"coarse": "крупнодроблёной руды", "clay": "глинистой руды"}
for k, cap in (("coarse", "coarse_cap"), ("clay", "clay_cap")):
    if num(a.get(k)) is None or num(a.get(cap)) is None or not (0 <= a[k] <= a[cap]):
        problems.append(f"склад {names[k]}: {a.get(k)} т при ёмкости {a.get(cap)} т")
    elif num(b.get(k)) is not None and abs(a[k] - b[k]) > JUMP_T:
        # за время проверки запас меняется на сотни тонн, а не возвращается к начальному
        problems.append(f"склад {names[k]} скачком {b[k]:.0f} → {a[k]:.0f} т (запас не восстановлен из Ditto)")
for k in ("delivered_crusher_t", "delivered_clay_t", "delivered_dump_t", "trips_total"):
    if num(b.get(k)) is not None and (num(a.get(k)) is None or a[k] < b[k]):
        problems.append(f"dispatch.{k} уменьшился: {b.get(k)} → {a.get(k)}")
print("OK" if not problems else "; ".join(problems))
PY2
}
before="$(read_state 2>/dev/null)"
if [ -z "$before" ]; then
  bad "перезапуск: не удалось прочитать двойники до перезапуска"
else
  compose=(docker compose -f "$ROOT/deploy/compose/docker-compose.yml" -f "$ROOT/bozshakol/compose.yml")
  if "${compose[@]}" restart bz-processing bz-haulage >/dev/null 2>&1; then
    sleep 30
    verdict="$(compare_state "$before" "$(read_state 2>/dev/null)")"
    if [ "$verdict" = "OK" ]; then
      ok "после перезапуска бункер, склады и счётчики dispatch в порядке"
    else
      bad "после перезапуска: $verdict"
    fi
  else
    bad "перезапуск: docker compose restart не выполнился"
  fi
fi
# 6б. Повторный make bozshakol на работающем стенде: bz-setup не сбрасывает признаки существующих двойников.
# Модули за секунды заново публикуют свои счётчики, поэтому кроме сравнения до/после ставим временную метку —
# признак check_probe у двойника координатора pit-central (его никто не публикует заново): bz-setup, переписавший
# двойник целиком, стёр бы её. После проверки метка удаляется.
PROBE="$DITTO/api/2/things/$NS:pit-central/features/check_probe"
before="$(read_state 2>/dev/null)"
probe_put="$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X PUT -H 'Content-Type: application/json'   -d '{"properties":{"value":"повторный make bozshakol"}}' "$PROBE")"
if [ -z "$before" ] || { [ "$probe_put" != 201 ] && [ "$probe_put" != 204 ]; }; then
  bad "повторный make bozshakol: не удалось прочитать двойники или поставить метку (HTTP $probe_put)"
elif t0=$(date +%s) && timeout 600 make -C "$ROOT" bozshakol >/dev/null 2>&1; then
  probe_get="$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "$PROBE")"
  sleep 30
  verdict="$(compare_state "$before" "$(read_state 2>/dev/null)" "$(( $(date +%s) - t0 ))")"
  if [ "$probe_get" != 200 ]; then
    lost="bz-setup переписал признаки существующего двойника (метка pit-central.check_probe пропала)"
    if [ "$verdict" = "OK" ]; then verdict="$lost"; else verdict="$lost; $verdict"; fi
  fi
  if [ "$verdict" = "OK" ]; then
    ok "повторный make bozshakol: признаки существующих двойников сохранены, счётчики dispatch, бункер и склады не сброшены"
  else
    bad "повторный make bozshakol: $verdict"
  fi
else
  bad "повторный make bozshakol не выполнился"
fi
curl -s -o /dev/null -u "$AUTH" -X DELETE "$PROBE" || true

echo
if [ "$fail" = 0 ]; then
  echo "Итог: всё в порядке."
else
  echo "Итог: есть ошибки (см. выше)."
fi
exit "$fail"
