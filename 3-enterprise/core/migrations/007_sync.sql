-- Kalenderabgleich (core/src/syncWorker.ts, core/src/pgSyncRepo.ts, Job "pipeline.delta_sync").
-- Idempotent (IF NOT EXISTS, DROP CONSTRAINT IF EXISTS). Expand-only: alte App-Versionen ignorieren die Spalten.
--
-- Datenminimierung (Fact Sheet): gespeichert werden je Termin NUR Quell-ID, Ziel-ID, Beginn, Ende und changeKey,
-- je Pipeline nur Delta-Link, Zeitpunkt und Fehler-CODE. Kein Betreff, kein Text, kein Ort, keine Teilnehmer.

-- Ziel der Pipeline: account | team | booking (NULL = Altbestand vor 007, wird nicht synchronisiert)
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS target_kind             text,
  ADD COLUMN IF NOT EXISTS target_mailbox          text,
  ADD COLUMN IF NOT EXISTS target_entra_tenant_id  text,
  ADD COLUMN IF NOT EXISTS target_ref              text,
  -- Sync-Zustand
  ADD COLUMN IF NOT EXISTS source_delta_link       text,
  ADD COLUMN IF NOT EXISTS source_delta_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error         text,
  -- höchstens ein Sync je Pipeline gleichzeitig (zwei Tasks, ein laufender + ein wartender Job)
  ADD COLUMN IF NOT EXISTS sync_lease_owner        text,
  ADD COLUMN IF NOT EXISTS sync_lease_until        timestamptz,
  -- Bereinigung der Zieltermine nach Widerruf (core/src/cleanupWorker.ts): angefordert im selben Commit wie die
  -- Kappung, erledigt = alle Zieltermine gelöscht, Zielpostfach genullt
  ADD COLUMN IF NOT EXISTS cleanup_requested_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_done_at         timestamptz,
  -- account-Ziele: letzte erfolgreiche Graph-Prüfung "dieselbe Person" + Merkmal (NIE der Wert)
  ADD COLUMN IF NOT EXISTS identity_verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS identity_attribute      text,
  -- zuletzt tatsächlich geschriebener Modus (busy/full); weicht er ab (Team erlaubt full nicht mehr), werden
  -- alle Zieltermine einmal neu (inhaltsfrei) geschrieben
  ADD COLUMN IF NOT EXISTS effective_mode          text;

ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_identity_attribute_valid;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_identity_attribute_valid
  CHECK (identity_attribute IS NULL OR identity_attribute IN
    ('objectId', 'employeeId', 'onPremisesImmutableId', 'onPremisesSecurityIdentifier', 'localPart')) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_identity_attribute_valid;
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_effective_mode_valid;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_effective_mode_valid
  CHECK (effective_mode IS NULL OR effective_mode IN ('busy', 'full')) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_effective_mode_valid;

ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_target_kind_valid;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_target_kind_valid
  CHECK (target_kind IS NULL OR target_kind IN ('account', 'team', 'booking')) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_target_kind_valid;

-- Form je Zielart: booking ohne Postfach, team/account mit Postfach, team mit Referenz auf teamCalendars.
-- Nach erledigter Bereinigung ist das Postfach (personenbezogen) genullt; Art/Referenz bleiben für die Anzeige.
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_target_shape;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_target_shape
  CHECK (target_kind IS NULL
      OR (cleanup_done_at IS NOT NULL AND target_kind IN ('account', 'team', 'booking'))
      OR (target_kind = 'booking' AND target_mailbox IS NULL AND target_entra_tenant_id IS NULL)
      OR (target_kind = 'team'    AND target_mailbox IS NOT NULL AND target_ref IS NOT NULL AND target_entra_tenant_id IS NULL)
      OR (target_kind = 'account' AND target_mailbox IS NOT NULL AND target_ref IS NULL)) NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_target_shape;

-- Ausstehende Bereinigungen je Nutzer (Purge des SCIM-Tombstones wartet darauf, Notbremse 8 Tage)
CREATE INDEX IF NOT EXISTS pipelines_cleanup_pending ON pipelines (tenant_id, owner_user_id)
  WHERE cleanup_requested_at IS NOT NULL AND cleanup_done_at IS NULL;

-- Nur ein Code, nie eine Meldung (Meldungen könnten Inhalte enthalten)
ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_last_sync_error_code;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_last_sync_error_code
  CHECK (last_sync_error IS NULL OR last_sync_error ~ '^[a-z0-9_]{1,64}$') NOT VALID;
ALTER TABLE pipelines VALIDATE CONSTRAINT pipelines_last_sync_error_code;

-- Termin-Zuordnung Quelle → Ziel. target_event_id NULL = Buchungsseite (kein Provider-Ziel) bzw. Anlage begonnen
CREATE TABLE IF NOT EXISTS sync_event_map (
  tenant_id       text        NOT NULL,
  pipeline_id     text        NOT NULL,
  source_event_id text        NOT NULL,
  target_event_id text,
  change_key      text,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- aus dem Sync-Fenster gefallen (Vergangenheit): kein Abgleich, keine Busy-API, aber die Bereinigung löscht den
  -- Zieltermin trotzdem. Nur Metadaten, wie alle Spalten hier.
  archived_at     timestamptz,
  CONSTRAINT sync_event_map_pkey PRIMARY KEY (pipeline_id, source_event_id),
  CONSTRAINT sync_event_map_pipeline_id_fkey FOREIGN KEY (pipeline_id)
    REFERENCES pipelines (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT sync_event_map_interval CHECK (end_at >= start_at)
);
-- Schleifenschutz: "ist diese Quell-ID ein von CalenSync angelegter Zieltermin?" – ein Lookup je Seite
CREATE INDEX IF NOT EXISTS sync_event_map_tenant_id_target_event_id_idx ON sync_event_map (tenant_id, target_event_id);
-- Busy-API der Buchungsseite: Zeitraum je Pipeline
CREATE INDEX IF NOT EXISTS sync_event_map_pipeline_id_start_at_idx ON sync_event_map (pipeline_id, start_at);

-- Rechte: DML für calensync_app kommt über ALTER DEFAULT PRIVILEGES aus 000, wenn calensync_migrator die Tabelle
-- anlegt. Läuft die Migration als anderer Nutzer (lokal, CI), hier ausdrücklich dasselbe Recht – nicht mehr.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calensync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sync_event_map TO calensync_app;
  END IF;
END $$;

-- Laufende Pipelines brauchen nach dem Deployment einen ersten Abgleich, sobald sie ein Ziel haben;
-- den stellt der SyncScheduler ein (last_synced_at IS NULL). Altbestand ohne Ziel bleibt unberührt.
