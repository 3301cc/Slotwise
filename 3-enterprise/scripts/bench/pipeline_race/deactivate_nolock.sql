\set uid random(1, 20)
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
UPDATE scim_users SET active = false WHERE tenant_id = 'acme' AND id = 'u' || :uid;
UPDATE pipelines SET status = 'revoked', revoked_at = now() WHERE tenant_id = 'acme' AND owner_user_id = 'u' || :uid AND status <> 'revoked';
COMMIT;
