DROP TABLE IF EXISTS job_queue, webhook_channels, provider_tokens, pipelines, scim_users CASCADE;
CREATE TABLE scim_users (id text PRIMARY KEY, tenant_id text NOT NULL, user_name text, active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1, deletion_requested_at timestamptz, deprovisioned_at timestamptz);
CREATE TABLE pipelines (id text PRIMARY KEY, tenant_id text NOT NULL, owner_user_id text NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active', revoked_at timestamptz);
CREATE INDEX ON pipelines (tenant_id, owner_user_id, status);
CREATE TABLE provider_tokens (id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE, provider text NOT NULL,
  UNIQUE (tenant_id, user_id, provider));
CREATE TABLE webhook_channels (id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, pipeline_id text NOT NULL,
  stop_requested_at timestamptz, stopped_at timestamptz);
CREATE INDEX ON webhook_channels (tenant_id, user_id);
\i ../../../core/migrations/002_job_queue.sql
INSERT INTO scim_users (id, tenant_id, user_name) SELECT 'u'||g, 'acme', 'user'||g FROM generate_series(1,200) g;
INSERT INTO pipelines SELECT 'p'||g||'-'||k, 'acme', 'u'||g, 'active' FROM generate_series(1,200) g, generate_series(1,2) k;
INSERT INTO provider_tokens SELECT 't'||g, 'acme', 'u'||g, 'microsoft' FROM generate_series(1,200) g;
INSERT INTO webhook_channels SELECT 'c'||g||'-'||k, 'acme', 'u'||g, 'p'||g||'-'||k FROM generate_series(1,200) g, generate_series(1,2) k;
