WITH due AS (SELECT id FROM job_queue WHERE status = 'queued' ORDER BY run_at LIMIT 50 FOR UPDATE SKIP LOCKED) UPDATE job_queue j SET status = 'done' FROM due WHERE j.id = due.id;
DELETE FROM job_queue WHERE status = 'done' AND updated_at < now() - interval '2 seconds';
