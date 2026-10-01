#!/usr/bin/env bash
# Race-Test Pipeline-Anlage vs. SCIM-Deaktivierung/Reaktivierung auf echtem Postgres (≥ 13, pgbench).
#   DATABASE_URL=postgres://user:pw@localhost:5432/race ./run.sh
# Läuft zweimal: mit Advisory-Lock (Soll: 0 Verstöße) und ohne (Negativkontrolle: Verstöße erwartet).
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")"
: "${DATABASE_URL:?DATABASE_URL fehlt}"
MIG=../../../core/migrations/005_pipeline_create.sql
T=${T:-20}; C=${C:-24}

round() { # $1 = Suffix ("" oder "_nolock")
  psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f schema.sql
  psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$MIG"
  psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$MIG"   # idempotent
  pgbench -n -c "$C" -j 4 -T "$T" -f "create$1.sql@6" -f "deactivate$1.sql@1" -f "reactivate$1.sql@1" -f audit.sql@1 "$DATABASE_URL" 2>&1 \
    | grep -E "number of (transactions actually processed|failed)|aborted|tps =" >&2 || true
  psql -At -F ' ' "$DATABASE_URL" -f check.sql
}

echo "== mit Advisory-Lock (Produktionsablauf) =="
read -r a b c d n v < <(round "" 2>/dev/null | tail -1)
echo "inactive_with_pipeline=$a over_limit=$b without_job=$c dup_keys=$d pipelines=$n seen_during_run=$v"
echo "== ohne Lock (Negativkontrolle) =="
read -r a2 b2 c2 d2 n2 v2 < <(round "_nolock" 2>/dev/null | tail -1)
echo "inactive_with_pipeline=$a2 over_limit=$b2 without_job=$c2 dup_keys=$d2 pipelines=$n2 seen_during_run=$v2"

if [ "$a" != 0 ] || [ "$b" != 0 ] || [ "$c" != 0 ] || [ "$d" != 0 ] || [ "$v" != 0 ]; then echo "FEHLER: Invariante verletzt"; exit 1; fi
if [ "$n" -lt 20 ]; then echo "FEHLER: zu wenig Pipelines angelegt ($n) – Test aussagelos"; exit 1; fi
if [ $((a2 + b2 + d2 + v2)) -eq 0 ]; then echo "WARNUNG: Negativkontrolle ohne Verstoß – T/C erhöhen"; fi
echo "OK"
