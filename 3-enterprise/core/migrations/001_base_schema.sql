-- Basisschema der Tabellen, die 003–006 erweitern und scim/src/prismaStore.ts, app/src/pipelineStore.ts,
-- app/src/statusApi.ts, core/src/pgChannelRepo.ts und core/src/pgPipelineRepo.ts benutzen.
-- Früher kam es aus dem Prisma-Schema der externen QA-Suite; ohne diese Datei scheitert 003 auf einer leeren DB.
--
-- Idempotent (IF NOT EXISTS) und mit den Namen, die Prisma für dieselben Constraints/Indizes vergibt: auf einer
-- schon per Prisma angelegten Datenbank ist die Datei ein No-op, auch wenn sie dort erst nach 003–006 läuft.
-- Bewusst NICHT hier, sondern in den Folge-Migrationen (dort ADD COLUMN IF NOT EXISTS):
--   scim_users.deletion_requested_at (003) · webhook_channels.expires_at, stop_* (003), last_message_number (004),
--   last_renewed_at/renew_* (006) · pipelines.mode/busy_label/idempotency_key/created_at (005)
--   sowie alle Indizes auf diesen Spalten (webhook_channels_sub, _one_live, _due_stop, _renew_due, …).
--
-- Typen: alle IDs text (Prisma String, SQL vergleicht mit text[] bzw. gen_random_uuid()::text),
-- Zeitpunkte timestamptz (Prisma @db.Timestamptz(6)), JSON jsonb. Abbild für den Client: prisma/schema.prisma.

-- SCIM-provisionierte Nutzer (Entra ID / Okta). external_id = Entra-Objekt-ID.
CREATE TABLE IF NOT EXISTS scim_users (
  id                   text        NOT NULL,
  tenant_id            text        NOT NULL,
  user_name            text        NOT NULL,
  user_name_normalized text        NOT NULL,
  external_id          text,
  active               boolean     NOT NULL DEFAULT true,
  display_name         text,
  given_name           text,
  family_name          text,
  formatted_name       text,
  emails               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  department           text,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deprovisioned_at     timestamptz,
  CONSTRAINT scim_users_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS scim_users_tenant_id_user_name_normalized_key ON scim_users (tenant_id, user_name_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS scim_users_tenant_id_external_id_key          ON scim_users (tenant_id, external_id);
CREATE INDEX        IF NOT EXISTS scim_users_tenant_id_active_idx               ON scim_users (tenant_id, active);

-- Sync-Pipelines je Nutzer. Löschen des Users (purgeDeletedUser) löscht seine Pipelines mit.
-- status: pending | pending_scope | active | paused | revoked | blocked_scope | config_error | error
CREATE TABLE IF NOT EXISTS pipelines (
  id             text        NOT NULL,
  tenant_id      text        NOT NULL,
  owner_user_id  text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active',
  revoked_reason text,
  revoked_at     timestamptz,
  CONSTRAINT pipelines_pkey PRIMARY KEY (id),
  CONSTRAINT pipelines_owner_user_id_fkey FOREIGN KEY (owner_user_id)
    REFERENCES scim_users (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS pipelines_tenant_id_owner_user_id_status_idx ON pipelines (tenant_id, owner_user_id, status);

-- Verschlüsselte Provider-Refresh-Tokens (nur delegiertes OAuth). Gehen mit dem User.
CREATE TABLE IF NOT EXISTS provider_tokens (
  id                 text        NOT NULL,
  tenant_id          text        NOT NULL,
  user_id            text        NOT NULL,
  provider           text        NOT NULL,
  ciphertext         bytea       NOT NULL,
  encrypted_data_key bytea       NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT provider_tokens_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES scim_users (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_tokens_tenant_id_user_id_provider_key ON provider_tokens (tenant_id, user_id, provider);

-- Webhook-Abos bei Microsoft Graph / Google. BEWUSST ohne Fremdschlüssel:
--   user_id     → die Zeile muss die Löschung des Users überleben, bis das Abo beim Provider beendet ist
--                 (core/src/subscriptionTeardown.ts); kein ON DELETE CASCADE auf scim_users
--   pipeline_id → Pipelines gehen per Cascade mit dem User; der Channel bleibt (Lookups: COALESCE(p.status, 'missing'))
CREATE TABLE IF NOT EXISTS webhook_channels (
  id                       text NOT NULL,
  tenant_id                text NOT NULL,
  user_id                  text NOT NULL,
  pipeline_id              text NOT NULL,
  provider                 text NOT NULL,
  provider_subscription_id text NOT NULL,
  provider_resource_id     text,
  client_state             text,
  CONSTRAINT webhook_channels_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_channels_provider_valid CHECK (provider IN ('microsoft', 'google'))
);
-- Kill-Switch (revokeInTx) und listOpenForUser filtern nach (tenant_id, user_id)
CREATE INDEX IF NOT EXISTS webhook_channels_tenant_id_user_id_idx ON webhook_channels (tenant_id, user_id);

-- Manipulationsevidentes Audit-Log (Hash-Kette je Mandant), append-only.
-- target_user_id ohne Fremdschlüssel: Einträge überleben die Löschung des Users.
CREATE TABLE IF NOT EXISTS audit_events (
  seq            bigserial   NOT NULL,
  tenant_id      text        NOT NULL,
  request_id     text        NOT NULL,
  actor          text        NOT NULL,
  action         text        NOT NULL,
  target_user_id text,
  outcome        text        NOT NULL,
  detail         jsonb       NOT NULL,
  at             timestamptz NOT NULL,
  prev_hash      text        NOT NULL,
  hash           text        NOT NULL,
  CONSTRAINT audit_events_pkey PRIMARY KEY (seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_hash_key          ON audit_events (hash);
CREATE INDEX        IF NOT EXISTS audit_events_tenant_id_seq_idx ON audit_events (tenant_id, seq);

-- Rechte: DML für calensync_app kommt über ALTER DEFAULT PRIVILEGES aus 000 (Tabellen und Sequenzen, die
-- calensync_migrator anlegt). Audit bleibt append-only (wie 003; hier schon ab dem Anlegen).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calensync_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM calensync_app;
  END IF;
END $$;
