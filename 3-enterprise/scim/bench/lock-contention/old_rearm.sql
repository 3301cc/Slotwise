\set uid random(1, 200)
BEGIN ISOLATION LEVEL SERIALIZABLE;
UPDATE scim_users SET active = true, version = version + 1, deletion_requested_at = NULL WHERE tenant_id = 'acme' AND id = 'u' || :uid;
UPDATE pipelines SET status = 'active', revoked_at = NULL WHERE tenant_id = 'acme' AND owner_user_id = 'u' || :uid;
INSERT INTO provider_tokens VALUES ('t' || :uid, 'acme', 'u' || :uid, 'microsoft') ON CONFLICT DO NOTHING;
UPDATE webhook_channels SET stop_requested_at = NULL, stopped_at = NULL WHERE tenant_id = 'acme' AND user_id = 'u' || :uid;
COMMIT;
