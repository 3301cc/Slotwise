\set uid random(1, 20)
\set k random(1, 200)
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
SELECT pg_advisory_xact_lock(hashtext('acme'), hashtext('u' || :uid));
SELECT count(*) AS ok FROM scim_users WHERE tenant_id = 'acme' AND id = 'u' || :uid AND active AND deletion_requested_at IS NULL \gset
\if :ok
  SELECT count(*) AS dup FROM pipelines WHERE tenant_id = 'acme' AND owner_user_id = 'u' || :uid AND idempotency_key = 'key-' || :k \gset
  \if :dup = 0
    SELECT count(*) AS n FROM pipelines WHERE tenant_id = 'acme' AND owner_user_id = 'u' || :uid AND status <> 'revoked' \gset
    \if :n < 3
      SELECT pg_sleep(0.001);
      WITH p AS (INSERT INTO pipelines (id, tenant_id, owner_user_id, status, mode, idempotency_key)
                 VALUES (gen_random_uuid()::text, 'acme', 'u' || :uid, 'pending', 'busy', 'key-' || :k) ON CONFLICT (tenant_id, owner_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
                 RETURNING id)
      INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload)
        SELECT 'acme', 'pipeline.handshake', 'handshake:' || p.id, '{}' FROM p
        ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING;
    \endif
  \endif
\endif
COMMIT;
