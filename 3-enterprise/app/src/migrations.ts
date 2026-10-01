/**
 * SQL-Migrationen aus core/migrations – vorwärts, idempotent, protokolliert.
 *
 *   * genau ein Migrator gleichzeitig (pg_advisory_lock) – zwei parallele Deployments warten aufeinander
 *   * jede Datei in eigener Transaktion; Fehler → ROLLBACK, Deployment bricht ab, App bleibt auf alter Version
 *   * Prüfsumme je Datei: eine nachträglich geänderte, bereits angewandte Migration stoppt das Deployment
 *     (Änderungen gehören in eine NEUE Datei)
 *   * Zero-Downtime-Regel (expand/contract): Migrationen müssen mit der laufenden UND der neuen App-Version
 *     funktionieren – Spalten erst hinzufügen, Code umstellen, erst im nächsten Release entfernen
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Eine dedizierte Verbindung (nicht der Pool): BEGIN/COMMIT müssen auf derselben Session laufen */
export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export function listMigrations(dir: string, opts: { bootstrap: boolean }): string[] {
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .filter((f) => (opts.bootstrap ? f.startsWith("000_") : !f.startsWith("000_")))
    .sort();
}

export async function runMigrations(db: SqlSession, dir: string, opts: { bootstrap: boolean; log: (m: string) => void }): Promise<MigrationResult> {
  const files = listMigrations(dir, opts);
  const result: MigrationResult = { applied: [], skipped: [] };
  await db.query("SELECT pg_advisory_lock(hashtext('calensync-migrations'))");
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS calensync_schema_migrations (
      filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>();
    for (const r of (await db.query("SELECT filename, sha256 FROM calensync_schema_migrations")).rows) {
      done.set(String(r.filename), String(r.sha256));
    }
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(f);
      if (prev !== undefined) {
        if (prev !== sha) throw new Error(`Migration ${f} wurde nach dem Anwenden geändert (Prüfsumme). Neue Datei anlegen statt ändern.`);
        result.skipped.push(f);
        continue;
      }
      opts.log(`wende ${f} an`);
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query("INSERT INTO calensync_schema_migrations (filename, sha256) VALUES ($1, $2)", [f, sha]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${f} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
      result.applied.push(f);
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext('calensync-migrations'))").catch(() => undefined);
  }
  return result;
}
