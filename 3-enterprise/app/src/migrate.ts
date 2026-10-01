/**
 * Einmal-Task im Deployment (ECS run-task, siehe Terraform "migrate" / "db-bootstrap"):
 *
 *   node dist/app/src/migrate.js               Migrator: core/migrations (001 = Basisschema; Prisma-Migrationen nur,
 *                                              falls PRISMA_SCHEMA gesetzt UND prisma/migrations vorhanden ist –
 *                                              im Standard-Deployment nicht: prisma/schema.prisma ist nur der Client)
 *                                              Login als calensync_migrator per IAM-Token
 *   node dist/app/src/migrate.js --bootstrap   Einmalig: 000_bootstrap_roles.sql als Master-User
 *
 * Exit-Code 0 = Erfolg; alles andere stoppt die Pipeline VOR dem Rolling Update der App.
 */
import { spawnSync } from "node:child_process";
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

    // 1) Optional: Prisma-Migrationen. Standard ist AUS – die Tabellen scim_users, pipelines, webhook_channels,
    //    provider_tokens, audit_events legt core/migrations/001_base_schema.sql an.
    const schema = process.env.PRISMA_SCHEMA;
    if (schema) {
      const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}` +
        `?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`;
      log(`prisma migrate deploy (${schema})`);
      // distroless: keine Shell, kein /usr/bin/env → Prisma-CLI direkt mit dem laufenden Node starten
      const r = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schema], {
        env: { ...process.env, DATABASE_URL: url, HOME: "/tmp" },
        stdio: "inherit",
      });
      if (r.status !== 0) throw new Error(`prisma migrate deploy: Exit-Code ${r.status}`);
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
