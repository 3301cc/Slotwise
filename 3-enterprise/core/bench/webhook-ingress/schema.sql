DROP TABLE IF EXISTS job_queue, webhook_channels, pipelines CASCADE;
CREATE TABLE pipelines (id text PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL DEFAULT 'active');
CREATE TABLE webhook_channels (
  id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, pipeline_id text NOT NULL,
  provider text NOT NULL, provider_subscription_id text NOT NULL, provider_resource_id text, client_state text,
  expires_at timestamptz, stop_requested_at timestamptz, stopped_at timestamptz, stop_note text,
  stop_attempts int NOT NULL DEFAULT 0, next_stop_attempt_at timestamptz, last_stop_error text);
CREATE UNIQUE INDEX webhook_channels_sub ON webhook_channels (provider, provider_subscription_id);
\i ../../migrations/002_job_queue.sql
INSERT INTO pipelines SELECT 'p' || g, 'acme', CASE WHEN g % 50 = 0 THEN 'revoked' ELSE 'active' END FROM generate_series(1, 3000) g;
INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state, expires_at)
  SELECT 'c' || g, 'acme', 'u' || ((g - 1) / 2 + 1), 'p' || g, 'microsoft', 'sub-' || g, 'cs-' || g, now() + interval '6 days'
  FROM generate_series(1, 3000) g;
ANALYZE;
