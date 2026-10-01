-- Dashboard: Pipeline anlegen (app/src/pipelineStore.ts)
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS mode            text,
  ADD COLUMN IF NOT EXISTS busy_label      text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();

-- Gleicher Idempotency-Key desselben Nutzers = dieselbe Pipeline (auch bei parallelen Retries)
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_owner_idempotency
  ON pipelines (tenant_id, owner_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_mode_valid;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_mode_valid
  CHECK (mode IS NULL OR mode IN ('busy', 'full')) NOT VALID;
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_busy_label_len;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_busy_label_len
  CHECK (busy_label IS NULL OR char_length(busy_label) BETWEEN 1 AND 64) NOT VALID;
