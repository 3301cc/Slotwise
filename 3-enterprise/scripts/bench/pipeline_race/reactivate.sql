\set uid random(1, 20)
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
SELECT pg_advisory_xact_lock(hashtext('acme'), hashtext('u' || :uid));
UPDATE scim_users SET active = true WHERE tenant_id = 'acme' AND id = 'u' || :uid AND deletion_requested_at IS NULL;
COMMIT;
