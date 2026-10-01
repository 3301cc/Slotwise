-- Minimalschema für den Race-Test (Spalten wie in Prisma-Schema + Migration 005)
DROP TABLE IF EXISTS job_queue, pipelines, scim_users, violations;
CREATE TABLE scim_users (id text PRIMARY KEY, tenant_id text NOT NULL, external_id text, active boolean NOT NULL DEFAULT true,
  deletion_requested_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pipelines (id text PRIMARY KEY, tenant_id text NOT NULL, owner_user_id text NOT NULL, status text NOT NULL,
  revoked_at timestamptz);
CREATE TABLE job_queue (id bigserial PRIMARY KEY, tenant_id text NOT NULL, kind text NOT NULL, dedupe_key text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', run_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX job_queue_dedupe ON job_queue (kind, dedupe_key) WHERE status = 'queued';
INSERT INTO scim_users (id, tenant_id, external_id) SELECT 'u' || g, 'acme', 'oid-' || g FROM generate_series(1, 20) g;
-- audit.sql schreibt hier jeden beobachteten Verstoß hinein (Zwischenzustände zählen, nicht nur das Ende)
CREATE TABLE violations (seen_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, owner_user_id text NOT NULL);
