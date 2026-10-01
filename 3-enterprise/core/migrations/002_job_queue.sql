-- Delay-Queue (core/src/retryQueue.ts). Teardown-, Handshake- und Sync-Jobs.
CREATE TABLE IF NOT EXISTS job_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text        NOT NULL,
  kind         text        NOT NULL,
  dedupe_key   text,
  payload      jsonb       NOT NULL,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int         NOT NULL DEFAULT 0,
  status       text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_queued_dedupe ON job_queue (kind, dedupe_key) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS job_queue_due   ON job_queue (run_at)       WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS job_queue_lease ON job_queue (locked_until) WHERE status = 'running';
