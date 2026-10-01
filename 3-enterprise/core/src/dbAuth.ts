/**
 * Passwortlose Datenbankanmeldung per AWS IAM-Datenbank-Authentifizierung.
 *
 * Kette:
 *   ECS-Task-Rolle (ecs.tf, Statement "DatabaseIamAuth": rds-db:connect auf
 *     arn:aws:rds-db:<region>:<account>:dbuser:<cluster-resource-id>/calensync_app)
 *   → @aws-sdk/rds-signer erzeugt lokal ein SigV4-signiertes Token (gültig 15 min, kein Netzwerkaufruf)
 *   → node-postgres ruft password() bei JEDEM neuen Verbindungsaufbau auf → immer frisches Token
 *   → Aurora prüft das Token gegen IAM; DB-Rolle calensync_app hat GRANT rds_iam
 *
 * Es gibt kein Anwendungs-Passwort: nicht in Terraform, nicht im State, nicht in Secrets Manager, nicht im
 * Container.
 *
 * Token-Lebensdauer vs. Verbindungs-Lebensdauer: AWS prüft das Token NUR beim Verbindungsaufbau. Eine
 * bestehende Verbindung läuft nach 15 min einfach weiter – sie "verliert" kein Passwort. Trotzdem begrenzen wir
 * die Lebensdauer jeder physischen Verbindung hart auf 10 min (POOL_LIMITS.maxLifetimeSeconds = 600):
 *   * Entzug wirkt schnell: Wird rds-db:connect entzogen oder die Rolle gesperrt, ist nach spätestens 10 min
 *     keine Verbindung mit der alten Berechtigung mehr offen.
 *   * Nach einem Aurora-Failover verteilen sich die Verbindungen innerhalb von 10 min neu.
 *   * Jede neue Verbindung holt über password() ein frisches Token – keine Verbindung wird je mit einem
 *     Token aufgebaut, das älter als Sekunden ist.
 * Kosten: bei 20 Verbindungen je Task und 600 s Lebensdauer ≈ 0,03 Neuanmeldungen/s je Task – weit unter
 * der AWS-Empfehlung für IAM-Auth (< 200 neue Verbindungen/s).
 *
 * Absturzschutz: pg.Pool meldet Fehler auf LEERLAUF-Verbindungen (z. B. Failover, Netzabbruch) als 'error'-
 * Event. Ohne Listener beendet Node.js den Prozess. createIamPgPool() hängt den Listener immer an.
 *
 * TLS ist Pflicht (rds.force_ssl = 1, IAM-Auth funktioniert nur über TLS). Geprüft wird gegen das RDS-CA-
 * Bundle (global-bundle.pem, beim Image-Build aus https://truststore.pds.rds.amazonaws.com/global/global-bundle.pem
 * eingebacken) inkl. Hostname – entspricht sslmode=verify-full.
 *
 * Prisma: über den Driver-Adapter mit diesem Pool verbinden (new PrismaPg(pool) aus @prisma/adapter-pg);
 * eine statische DATABASE_URL mit eingesetztem Token würde bei neuen Verbindungen nach 15 min scheitern.
 */
import { readFileSync } from "node:fs";
import { Signer } from "@aws-sdk/rds-signer";

export interface IamDbSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  region: string;
  /** PEM-Inhalt des RDS-CA-Bundles */
  caPem: string;
  max?: number;
}

/** Signatur-Quelle; in Produktion @aws-sdk/rds-signer, in Tests ein Fake. */
export interface AuthTokenSource {
  getAuthToken(): Promise<string>;
}

/** Konfiguration für new pg.Pool(…) – identische Feldnamen wie pg.PoolConfig. */
export interface IamPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: () => Promise<string>;
  ssl: { ca: string; rejectUnauthorized: true; servername: string };
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  /** Harte Obergrenze je physischer Verbindung (< Token-TTL), danach Neuaufbau mit frischem Token */
  maxLifetimeSeconds: number;
  application_name: string;
}

/** Harte Pool-Grenzen. maxLifetimeSeconds MUSS unter der Token-Gültigkeit (900 s) liegen. */
export const POOL_LIMITS = Object.freeze({
  max: 20,
  maxLifetimeSeconds: 600,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const IAM_TOKEN_TTL_SECONDS = 900;

export function iamPoolConfig(s: IamDbSettings, tokens: AuthTokenSource): IamPoolConfig {
  if (!s.caPem.includes("BEGIN CERTIFICATE")) throw new Error("RDS-CA-Bundle fehlt oder ist kein PEM");
  if (POOL_LIMITS.maxLifetimeSeconds >= IAM_TOKEN_TTL_SECONDS) throw new Error("maxLifetimeSeconds muss < 900 s sein");
  return {
    host: s.host,
    port: s.port,
    database: s.database,
    user: s.user,
    password: () => tokens.getAuthToken(),
    ssl: { ca: s.caPem, rejectUnauthorized: true, servername: s.host },
    max: Math.min(s.max ?? POOL_LIMITS.max, POOL_LIMITS.max),
    idleTimeoutMillis: POOL_LIMITS.idleTimeoutMillis,
    connectionTimeoutMillis: POOL_LIMITS.connectionTimeoutMillis,
    maxLifetimeSeconds: POOL_LIMITS.maxLifetimeSeconds,
    application_name: "calensync-app",
  };
}

/** Liest die Umgebung, die ecs.tf in die Task-Definition schreibt. Fehlt etwas, startet der Task nicht. */
export function iamDbSettingsFromEnv(env: NodeJS.ProcessEnv = process.env, caPath = "/app/certs/rds-global-bundle.pem"): IamDbSettings {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Umgebungsvariable ${k} fehlt`);
    return v;
  };
  if (env.DB_IAM_AUTH !== "true") throw new Error("DB_IAM_AUTH muss 'true' sein – Passwort-Login ist nicht vorgesehen");
  if (env.DB_PASSWORD || env.PGPASSWORD || /:\/\/[^:@/]+:[^@/]+@/.test(env.DATABASE_URL ?? "")) {
    throw new Error("Statisches DB-Passwort in der Umgebung gefunden – IAM-Auth erwartet keins");
  }
  return {
    host: need("DB_HOST"),
    port: Number(env.DB_PORT ?? "5432"),
    database: need("DB_NAME"),
    user: need("DB_USER"),
    region: need("AWS_REGION"),
    caPem: readFileSync(env.DB_CA_BUNDLE ?? caPath, "utf8"),
  };
}

/** Produktions-Signer: Credentials kommen automatisch aus der ECS-Task-Rolle (Container-Credentials-Endpunkt). */
export function rdsTokenSource(s: Pick<IamDbSettings, "host" | "port" | "user" | "region">): AuthTokenSource {
  const signer = new Signer({ hostname: s.host, port: s.port, username: s.user, region: s.region });
  return { getAuthToken: () => signer.getAuthToken() };
}

/** Minimaler Ausschnitt von pg.Pool, den createIamPgPool braucht */
export interface PoolLike {
  on(event: "error", listener: (err: Error) => void): unknown;
  end(): Promise<void>;
}

/**
 * Baut den Produktions-Pool:  createIamPgPool(pg.Pool, iamDbSettingsFromEnv(), log)
 * PoolCtor wird injiziert, damit das Modul ohne laufende Datenbank testbar bleibt.
 */
export function createIamPgPool<P extends PoolLike>(
  PoolCtor: new (config: IamPoolConfig) => P,
  settings: IamDbSettings,
  log: (msg: string, err?: Error) => void,
  tokens: AuthTokenSource = rdsTokenSource(settings),
): P {
  const pool = new PoolCtor(iamPoolConfig(settings, tokens));
  // Fehler auf Leerlauf-Verbindungen: Verbindung ist verloren, der Pool baut beim nächsten Checkout neu auf.
  // Ohne diesen Listener würde Node.js den gesamten Task beenden.
  pool.on("error", (err) => log("pg-Pool: Leerlauf-Verbindung verloren, wird ersetzt", err));
  return pool;
}
