\set uid random(1, 200)
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
SELECT pg_advisory_xact_lock(hashtext('acme'), hashtext('u' || :uid));
UPDATE scim_users SET active = false, version = version + 1 WHERE tenant_id = 'acme' AND id = 'u' || :uid AND deletion_requested_at IS NULL;
UPDATE pipelines SET status = 'revoked', revoked_at = now() WHERE tenant_id = 'acme' AND owner_user_id = 'u' || :uid AND status <> 'revoked';
DELETE FROM provider_tokens WHERE tenant_id = 'acme' AND user_id = 'u' || :uid;
UPDATE webhook_channels SET stop_requested_at = now() WHERE tenant_id = 'acme' AND user_id = 'u' || :uid AND stop_requested_at IS NULL AND stopped_at IS NULL;
INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload) VALUES ('acme', 'subscription.teardown', 'teardown:u' || :uid, '{}') ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING;
COMMIT;
