/**
 * Migrationen gegen echtes PostgreSQL. Ohne DATABASE_URL übersprungen.
 *   DATABASE_URL=postgres://postgres@localhost:5432/migtest node --test dist/app/test/migrations.pg.test.js
 * Die Datenbank muss leer sein und eine Rolle rds_iam besitzen (lokal: CREATE ROLE rds_iam;).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrations.js";

const url = process.env.DATABASE_URL;

test("Migrationen: Bootstrap + Vorwärts, idempotent, Prüfsumme schützt, Fehler rollt zurück", { skip: !url }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const src = join(process.cwd(), "core/migrations");
    for (const f of ["000_bootstrap_roles.sql", "002_job_queue.sql"]) copyFileSync(join(src, f), join(dir, f));
    const log = () => {};

    const boot = await runMigrations(db, dir, { bootstrap: true, log });
    assert.deepEqual(boot.applied, ["000_bootstrap_roles.sql"]);
    const r1 = await runMigrations(db, dir, { bootstrap: false, log });
    assert.deepEqual(r1.applied, ["002_job_queue.sql"]);
    const r2 = await runMigrations(db, dir, { bootstrap: false, log });
    assert.deepEqual([r2.applied, r2.skipped], [[], ["002_job_queue.sql"]]);

    // kaputte Migration: nichts davon bleibt, nicht als angewandt markiert
    writeFileSync(join(dir, "009_kaputt.sql"), "CREATE TABLE halb_fertig (id int); SELECT gibt_es_nicht();");
    await assert.rejects(runMigrations(db, dir, { bootstrap: false, log }), /009_kaputt.sql fehlgeschlagen/);
    const t = await db.query("SELECT to_regclass('halb_fertig') AS t");
    assert.equal(t.rows[0].t, null);

    // nachträglich geänderte Migration stoppt das Deployment
    writeFileSync(join(dir, "009_kaputt.sql"), "SELECT 1;");
    appendFileSync(join(dir, "002_job_queue.sql"), "\n-- geändert\n");
    await assert.rejects(runMigrations(db, dir, { bootstrap: false, log }), /Prüfsumme/);
  } finally {
    await db.end();
  }
});
