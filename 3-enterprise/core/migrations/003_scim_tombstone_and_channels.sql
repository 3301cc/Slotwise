-- SCIM DELETE → PII-freier Tombstone bis zum erfolgreichen Provider-Teardown (scim/src/prismaStore.ts)
ALTER TABLE scim_users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS scim_users_tombstones ON scim_users (tenant_id, deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;

-- Teardown-Zustand je Webhook-Abo (core/src/pgChannelRepo.ts)
ALTER TABLE webhook_channels
  ADD COLUMN IF NOT EXISTS expires_at           timestamptz,
  ADD COLUMN IF NOT EXISTS stop_requested_at    timestamptz,
  ADD COLUMN IF NOT EXISTS stopped_at           timestamptz,
  ADD COLUMN IF NOT EXISTS stop_note            text,
  ADD COLUMN IF NOT EXISTS stop_attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_stop_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_stop_error      text;
-- webhook_channels.user_id hat bewusst KEINEN Fremdschlüssel mit ON DELETE CASCADE auf scim_users
CREATE INDEX IF NOT EXISTS webhook_channels_due_stop ON webhook_channels (next_stop_attempt_at)
  WHERE stop_requested_at IS NOT NULL AND stopped_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_channels_sub ON webhook_channels (provider, provider_subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_channels_one_live ON webhook_channels (pipeline_id)
  WHERE stop_requested_at IS NULL AND stopped_at IS NULL;

-- Audit bleibt append-only
REVOKE UPDATE, DELETE ON audit_events FROM calensync_app;
