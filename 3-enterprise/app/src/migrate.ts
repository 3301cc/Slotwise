/**
 * Einmal-Task im Deployment (ECS run-task, siehe Terraform "migrate" / "db-bootstrap"):
 *
 *   node dist/app/src/migrate.js               Migrator: core/migrations (001 = Basisschema). prisma/schema.prisma
 *                                              dient nur dem Prisma-Client; PRISMA_SCHEMA wird abgelehnt
 *                                              Login als calensync_migrator per IAM-Token
 *   node dist/app/src/migrate.js --bootstrap   Einmalig: 000_bootstrap_roles.sql als Master-User
 *
 * Exit-Code 0 = Erfolg; alles andere stoppt die Pipeline VOR dem Rolling Update der App.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { rdsTokenSource } from "../../core/src/dbAuth.js";
import { runMigrations } from "./migrations.js";

const log = (msg: string) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), msg }) + "\n");
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} fehlt`);
  return v;
};

const bootstrap = process.argv.includes("--bootstrap");
const host = env("DB_HOST");
const port = Number(process.env.DB_PORT ?? "5432");
const database = env("DB_NAME");
const caPath = process.env.DB_CA_BUNDLE ?? "/app/certs/rds-global-bundle.pem";
const ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true, servername: host };
const migrationsDir = process.env.MIGRATIONS_DIR ?? "core/migrations";

async function main(): Promise<void> {
  let user: string;
  let password: string;
  if (bootstrap) {
    user = env("DB_MASTER_USER");
    password = env("DB_MASTER_PASSWORD");
  } else {
    user = env("DB_USER");
    password = await rdsTokenSource({ host, port, user, region: env("AWS_REGION") }).getAuthToken();

    // Das Schema legen allein die SQL-Migrationen an (core/migrations/001 ff.). Die Prisma-CLI ist nur noch
    // Build-Werkzeug (devDependency) und fehlt im Laufzeit-Image; ein altes PRISMA_SCHEMA wäre ein Konfigurationsfehler.
    if (process.env.PRISMA_SCHEMA) {
      throw new Error("PRISMA_SCHEMA wird nicht mehr unterstützt: Schema kommt aus core/migrations. Variable aus der Task-Definition entfernen.");
    }
  }

  // 2) SQL-Migrationen aus core/migrations (Job-Queue, Tombstones, Channel-Teardown, Rechte)
  const client = new pg.Client({ host, port, database, user, password, ssl, application_name: "calensync-migrate" });
  await client.connect();
  try {
    const r = await runMigrations(client, migrationsDir, { bootstrap, log });
    log(`fertig: ${r.applied.length} angewandt, ${r.skipped.length} bereits vorhanden`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  log(`FEHLER: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
