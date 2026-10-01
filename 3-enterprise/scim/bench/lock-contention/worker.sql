\set uid random(1, 200)
WITH due AS (SELECT id FROM job_queue WHERE status = 'queued' ORDER BY run_at LIMIT 5 FOR UPDATE SKIP LOCKED) UPDATE job_queue j SET status = 'done' FROM due WHERE j.id = due.id;
UPDATE webhook_channels SET stopped_at = now() WHERE tenant_id = 'acme' AND user_id = 'u' || :uid AND stop_requested_at IS NOT NULL AND stopped_at IS NULL;
