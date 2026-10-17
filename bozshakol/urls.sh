#!/usr/bin/env bash
# Печатает адреса рудника Бозшаколь после `make bozshakol`. Порты — из deploy/compose/.env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
set -a; . "$ROOT/deploy/compose/.env"; set +a
H="${OPENEGIZ_PUBLIC_HOST:-localhost}"
cat <<TXT

Рудник Бозшаколь запущен.

  3D-сцена            http://$H:${BOZSHAKOL_WEB_PORT:-8095}
  Grafana             http://$H:${GRAFANA_PORT:-3000}   (admin / пароль GRAFANA_ADMIN_PASSWORD из deploy/compose/.env)
                      Dashboards -> Бозшаколь; приложение OpenEgiz -> Twins — иерархия kz.bozshakol
  Ditto API           http://$H:${DITTO_PORT:-8080}/api/2/search/things?namespaces=kz.bozshakol

Проверка стенда: make bozshakol-check. Логи: make bozshakol-logs S=bz-haulage
TXT
