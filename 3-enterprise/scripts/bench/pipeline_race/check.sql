-- 1) deaktivierter User mit nicht-revoked Pipeline   2) mehr als 3 aktive Pipelines   3) Pipeline ohne Handshake-Job
-- 4) doppelter Idempotency-Key je User   5) Verstöße, die audit.sql während des Laufs gesehen hat
SELECT
  (SELECT count(*) FROM pipelines p JOIN scim_users u ON u.id = p.owner_user_id WHERE NOT u.active AND p.status <> 'revoked') AS inactive_with_pipeline,
  (SELECT count(*) FROM (SELECT owner_user_id FROM pipelines WHERE status <> 'revoked' GROUP BY 1 HAVING count(*) > 3) x) AS over_limit,
  (SELECT count(*) FROM pipelines p WHERE NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.dedupe_key = 'handshake:' || p.id)) AS without_job,
  (SELECT count(*) FROM (SELECT owner_user_id, idempotency_key FROM pipelines GROUP BY 1, 2 HAVING count(*) > 1) x) AS dup_keys,
  (SELECT count(*) FROM pipelines) AS pipelines_total,
  (SELECT count(*) FROM violations) AS seen_during_run;
