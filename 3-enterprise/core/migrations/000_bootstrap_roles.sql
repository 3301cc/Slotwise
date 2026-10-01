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

-- IAM-Login: rds_iam gibt es nur auf Amazon RDS/Aurora (dort identisch zu früher). Auf einfachem PostgreSQL
-- (lokal, CI) fehlt die Rolle; dann ohne IAM weiter, Anmeldung dort per Passwort/pg_hba.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO calensync_migrator;
    GRANT rds_iam TO calensync_app;
  ELSE
    RAISE NOTICE 'Rolle rds_iam fehlt (kein Amazon RDS) – IAM-Login für calensync_migrator/calensync_app nicht eingerichtet';
  END IF;
END $$;

-- Datenbank, mit der der Bootstrap-Task verbunden ist (DB_NAME; in Terraform "calensync")
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO calensync_migrator, calensync_app', current_database());
END $$;

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

-- Protokolltabelle des Runners (app/src/migrations.ts): dieser Bootstrap-Lauf legt sie als Master-User an,
-- danach muss der Migrator sie lesen und fortschreiben (sonst: permission denied beim ersten Migrator-Lauf)
DO $$
BEGIN
  IF to_regclass('calensync_schema_migrations') IS NOT NULL THEN
    GRANT SELECT, INSERT ON calensync_schema_migrations TO calensync_migrator;
  END IF;
END $$;
