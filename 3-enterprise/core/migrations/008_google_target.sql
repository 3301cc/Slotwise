-- Google Workspace als Sync-ZIEL (Ziel account, provider google): core/src/googleCalendar.ts, core/src/googleAuth.ts.
-- Idempotent (IF NOT EXISTS, DROP CONSTRAINT IF EXISTS). Expand-only: alte App-Versionen schreiben die Spalten nicht,
-- der Default 'microsoft' hält sie gültig (ADD COLUMN mit konstantem Default schreibt die Tabelle nicht um, PG ≥ 11).
-- 007 ist ausgerollt und bleibt unverändert (Prüfsumme in calensync_schema_migrations).
--
-- Datenminimierung wie 007: gespeichert werden nur Provider und Workspace-ID aus der Admin-Allowlist
-- (linkedGoogleWorkspaces[].id) – keine Google-Nutzer-IDs, keine Mitarbeiter-ID, keine Termininhalte.

ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS target_provider     text NOT NULL DEFAULT 'microsoft',
  ADD COLUMN IF NOT EXISTS target_workspace_id text;

ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_target_provider_valid;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_target_provider_valid
  CHECK (target_provider IN ('microsoft', 'google')) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_target_provider_valid;

-- Form je Provider: microsoft ohne Workspace; google nur als account, mit Workspace-ID aus der Allowlist und ohne
-- Entra-Mandant (die beiden Allowlists werden nie gemischt). Gilt auch nach der Bereinigung (Postfach genullt,
-- Provider/Workspace bleiben für die Anzeige).
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_target_provider_shape;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_target_provider_shape
  CHECK ((target_provider = 'microsoft' AND target_workspace_id IS NULL)
      -- IS NOT NULL ausdrücklich: ein Vergleich mit NULL ergibt NULL, und CHECK ließe NULL durch
      OR (target_provider = 'google' AND target_kind IS NOT NULL AND target_kind = 'account' AND target_entra_tenant_id IS NULL
          AND target_workspace_id IS NOT NULL AND target_workspace_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$')) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_target_provider_shape;
