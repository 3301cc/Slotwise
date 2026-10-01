#!/usr/bin/env bash
# Datenbankseite des Webhook-Eingangs: 64 Clients, je Request 20 Notifications, Worker leert die Queue nebenher.
#   old           = 2 Statements je Notification (Lookup + INSERT) → 40 Roundtrips je Request
#   new_unsorted  = 1 Lookup + 1 mehrzeiliger INSERT, Schlüssel unsortiert (zeigt das Deadlock-Risiko)
#   new           = 1 Lookup + 1 mehrzeiliger INSERT, nach (kind, dedupe_key) sortiert (= enqueueMany)
#   PGHOST=localhost PGUSER=qa PGPASSWORD=qa PGDATABASE=webhookbench bash run_pgbench.sh
set -euo pipefail
cd "$(dirname "$0")"
psql -q -v ON_ERROR_STOP=1 -f schema.sql >/dev/null
for v in old new_unsorted new; do
  psql -q -c "TRUNCATE job_queue"
  echo "===== $v"
  pgbench -n -c "${CLIENTS:-64}" -j 8 -T "${SECONDS_PER_RUN:-15}" --max-tries=1 --failures-detailed \
    -f "${v}_request.sql@10" -f worker.sql@1 \
    | grep -E "^SQL script 1|^ - [0-9]+ transactions|deadlock failures: |latency average" | sed -n '1,5p'
done
