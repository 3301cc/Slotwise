#!/usr/bin/env bash
# Sperr-Lasttest: altes Transaktionsmuster (SERIALIZABLE, ohne User-Sperre) gegen neues
# (READ COMMITTED, pg_advisory_xact_lock je User zuerst, feste Sperrreihenfolge).
# 64 Clients, 200 User, Offboarding/Deaktivierung/Re-Onboarding im Wechsel + Teardown-Worker.
#   PGHOST=localhost PGUSER=qa PGPASSWORD=qa PGDATABASE=lockbench bash run.sh
set -euo pipefail
cd "$(dirname "$0")"
INV="SELECT count(*) FILTER (WHERE x='tok') AS inaktiv_mit_token, count(*) FILTER (WHERE x='pipe') AS inaktiv_mit_aktiver_pipeline
     FROM (SELECT 'tok' x FROM scim_users u JOIN provider_tokens t ON t.user_id=u.id WHERE NOT u.active
           UNION ALL SELECT 'pipe' FROM scim_users u JOIN pipelines p ON p.owner_user_id=u.id WHERE NOT u.active AND p.status='active') s"
for v in old new; do
  psql -q -v ON_ERROR_STOP=1 -f schema.sql >/dev/null
  echo "===== $v"
  pgbench -n -c "${CLIENTS:-64}" -j 8 -T "${SECONDS_PER_RUN:-15}" --max-tries=1 --failures-detailed \
    -f "${v}_delete.sql@3" -f "${v}_revoke.sql@3" -f "${v}_rearm.sql@3" -f worker.sql@1 \
    | grep -E "actually processed|serialization failures: |deadlock failures: " | sed -n '1,3p'
  psql -tA -c "$INV" | sed 's/^/Invarianten (inaktiv+Token | inaktiv+aktive Pipeline): /'
done
