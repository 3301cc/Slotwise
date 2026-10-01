-- Einmalig als Master-User (Task "<name>-db-bootstrap", siehe ecs.tf). Idempotent.
-- Zwei Rollen, beide OHNE Passwort – Login nur per IAM-Token:
--   calensync_migrator  besitzt das Schema, führt DDL aus (Deployment-Task)
--   calensync_app       nur DML auf Tabellen, die der Migrator anlegt (laufende App)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calensync_migrator') THEN
    CREATE ROLE calensync_migrator WITH LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calensync_app') THEN
    CREATE ROLE calensync_app WITH LOGIN;
  END IF;
END $$;

GRANT rds_iam TO calensync_migrator;
GRANT rds_iam TO calensync_app;

GRANT CONNECT ON DATABASE calensync TO calensync_migrator, calensync_app;
GRANT USAGE, CREATE ON SCHEMA public TO calensync_migrator;
GRANT USAGE ON SCHEMA public TO calensync_app;

ALTER ROLE calensync_app SET statement_timeout = '30s';
ALTER ROLE calensync_app SET lock_timeout = '5s';
ALTER ROLE calensync_migrator SET lock_timeout = '10s';   -- Migration wartet nicht ewig hinter App-Sperren

-- Alles, was der Migrator künftig anlegt, darf die App lesen/schreiben (nicht ändern/löschen)
ALTER DEFAULT PRIVILEGES FOR ROLE calensync_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO calensync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE calensync_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO calensync_app;
