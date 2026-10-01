-- Verlängerung der Graph-Abos (core/src/renewalWorker.ts, PgChannelRepo.scheduleDueRenewals)
ALTER TABLE webhook_channels
  ADD COLUMN IF NOT EXISTS last_renewed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS renew_error        text,
  ADD COLUMN IF NOT EXISTS renew_paused_until timestamptz;

-- Scheduler liest nur lebende Microsoft-Abos nach Ablaufzeit: Index-Scan statt Full Scan alle 10 min
CREATE INDEX IF NOT EXISTS webhook_channels_renew_due ON webhook_channels (expires_at)
  WHERE provider = 'microsoft' AND stop_requested_at IS NULL AND stopped_at IS NULL;
