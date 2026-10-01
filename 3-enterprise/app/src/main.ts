/**
 * Einstiegspunkt des Mandanten-Backends (ECS-Service "app"):  node dist/app/src/main.js
 *
 * Ein Prozess, mehrere Rollen: HTTP (Webhooks, SCIM, Dashboard-API, Busy-API), Teardown-, Handshake-, Renewal- und
 * Sync-Worker (pipeline.delta_sync).
 * Alle teilen sich EINEN pg-Pool (IAM-Auth, max. DB_POOL_MAX Verbindungen) – das Verbindungsbudget je Task
 * ist damit fest und in Terraform (check "db_connection_budget") gegen die Autoscaling-Obergrenze geprüft.
 */
import { hostname } from "node:os";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  createIamPgPool,
  createLogger,
  HandshakeWorker,
  installGracefulShutdown,
  KmsSignedGraphTokenProvider,
  PgChannelRepo,
  PgDelayedJobQueue,
  PgPipelineRepo,
  PgSyncRepo,
  RenewalScheduler,
  RenewalWorker,
  SubscriptionTeardown,
  SyncScheduler,
  SyncWorker,
  TargetCleanupWorker,
  TeardownJobWorker,
  createGraphCaller,
  verifyIdentity,
  type AppTokenProvider,
  type FetchLike,
} from "../../core/src/index.js";
import { HashedTokenAuthenticator } from "../../scim/src/auth.js";
import { PrismaScimStore } from "../../scim/src/prismaStore.js";
import { loadConfig, syncAllowlistFrom } from "./config.js";
import { createCorsPolicy } from "./cors.js";
import { EntraTokenVerifier } from "./entraAuth.js";
import { createAppServer } from "./server.js";
import { PgStatusRepo } from "./statusApi.js";
import { PrismaPipelineStore } from "./pipelineStore.js";

const cfg0Tenant = process.env.TENANT_ID ?? "unknown";
const logger = createLogger({ service: "calensync-app", tenantId: cfg0Tenant, minLevel: process.env.LOG_LEVEL === "debug" ? "debug" : "info" });
/** Brücke für Module mit Eintrags-Signatur ({ level, msg, … }) → strukturierter Logger */
const log = (entry: Record<string, unknown>): void => {
  const { level, msg, ...rest } = entry;
  const m = typeof msg === "string" ? msg : "event";
  if (level === "error") logger.error(m, rest);
  else if (level === "warn") logger.warn(m, rest);
  else if (level === "alert") logger.alert(m, rest);
  else logger.info(m, rest);
};

const cfg = loadConfig();
const syncAllowlist = syncAllowlistFrom(cfg.secrets);
const fetchFn: FetchLike = (url, init) => fetch(url, init);

// --- Datenbank: ein IAM-Pool für alles -----------------------------------------------------------------
const pool = createIamPgPool(
  pg.Pool,
  { host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, user: cfg.db.user, region: cfg.db.region,
    caPem: (await import("node:fs")).readFileSync(process.env.DB_CA_BUNDLE ?? "/app/certs/rds-global-bundle.pem", "utf8"),
    max: cfg.db.poolMax },
  (msg, err) => log({ level: "warn", msg, err: err?.message }),
);
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// --- Provider-Tokens: Graph per KMS-signierter Client-Assertion (kein Client-Secret) -------------------
const kms = new KMSClient({ region: cfg.db.region });
const signingKeyArn = process.env.SIGNING_KMS_KEY_ARN;
if (!signingKeyArn) throw new Error("SIGNING_KMS_KEY_ARN fehlt");
const graphTokens = new KmsSignedGraphTokenProvider(
  async () => ({ entraTenantId: cfg.secrets.entraTenantId, clientId: cfg.secrets.graphClientId, certSha256Hex: cfg.secrets.graphCertSha256Hex }),
  async (digest) => {
    const out = await kms.send(new SignCommand({ KeyId: signingKeyArn, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" }));
    if (!out.Signature) throw new Error("KMS lieferte keine Signatur");
    return Buffer.from(out.Signature);
  },
  fetchFn,
);
const tokens: AppTokenProvider = {
  getToken: async (tenantId, provider) => {
    if (provider !== "microsoft") throw new Error("Google-Provider ist in diesem Stack nicht konfiguriert");
    return graphTokens.getToken(tenantId, provider);
  },
  invalidate: (tenantId) => graphTokens.invalidate(tenantId),
};

// --- Bausteine -------------------------------------------------------------------------------------
const queue = new PgDelayedJobQueue(pool);
const channels = new PgChannelRepo(pool);
const pipelines = new PgPipelineRepo(pool);
const syncRepo = new PgSyncRepo(pool);
const statusRepo = new PgStatusRepo(pool, syncAllowlist);
const scimStore = new PrismaScimStore(prisma);
const teardown = new SubscriptionTeardown({ channels, tokens, fetchFn });
const workerId = `${hostname()}-${process.pid}`;

const alert = async (e: object): Promise<void> => logger.alert("worker_alert", { ...e }); // Metric-Filter → Alarm
const teardownWorker = new TeardownJobWorker({
  queue, teardown, channels, users: scimStore, workerId, alert,
  // Tombstone erst löschen, wenn die Zielkalender bereinigt sind (Notbremse 8 Tage)
  cleanups: syncRepo,
  audit: (e) => scimStore.appendAudit({ tenantId: e.tenantId, requestId: e.jobId, actor: "worker:subscription-teardown",
    action: e.action, targetUserId: e.userId, outcome: e.outcome, detail: e.detail, at: new Date().toISOString() }),
});
const handshakeWorker = new HandshakeWorker({
  queue, pipelines, tokens, fetchFn, workerId,
  notificationUrl: `${cfg.publicBaseUrl}/webhooks/graph`,
  lifecycleNotificationUrl: `${cfg.publicBaseUrl}/webhooks/graph`,
  sinks: { setPipelineStatus: (t, p, s) => pipelines.setPipelineStatus(t, p, s), alert },
});

// Graph-Abos laufen nach 6 Tagen ab: Scheduler stellt fällige Verlängerungen ein, Worker führt sie aus
const renewalWorker = new RenewalWorker({ queue, repo: channels, tokens, fetchFn, workerId, alert });
const renewalScheduler = new RenewalScheduler(channels);

// Kalenderabgleich: Quelle = Postfach des Inhabers (Heim-Mandant), Ziel laut Allowlist; Token je Entra-Mandant
// (verknüpfte Mandanten: gleiche App, dort per Admin-Consent freigegeben, Cache-Schlüssel = Entra-Mandant)
const syncWorker = new SyncWorker({
  queue, repo: syncRepo, tokens: graphTokens, fetchFn, allowlist: syncAllowlist, workerId,
  alert: (a) => alert({ kind: "sync_failed", ...a }),
  log,
  options: { includeTentative: cfg.secrets.syncTentative },
});
const syncScheduler = new SyncScheduler(syncRepo);
// Nach Widerruf (SCIM, Nutzer): alle von CalenSync angelegten Zieltermine löschen, dann Zielpostfach nullen
const cleanupWorker = new TargetCleanupWorker({
  queue, repo: syncRepo, tokens: graphTokens, fetchFn, allowlist: syncAllowlist, workerId, log,
  alert: (a) => alert({ ...a }),
});

const app = createAppServer({
  tenantId: cfg.tenantId,
  webhook: { repo: channels, queue, securityEvent: (e) => logger.security("client_state_mismatch", { ...e }) },
  webhookOptions: { onResult: (status, ms) => { if (status >= 500 || ms > 2000) log({ level: "warn", path: "/webhooks/graph", status, ms: Math.round(ms) }); } },
  googleWebhook: { repo: channels, queue, securityEvent: (e) => logger.security("webhook_rejected", { ...e }) },
  googleWebhookOptions: { onResult: (r, ms) => { if (r.status >= 500 || ms > 2000) log({ level: "warn", path: "/webhooks/google", status: r.status, ms: Math.round(ms) }); } },
  scim: {
    store: scimStore,
    auth: new HashedTokenAuthenticator(cfg.secrets.scimTokenPepper, async () => cfg.secrets.scimTokens, undefined, {
      // Alarm statt stiller 401-Schleife: ohne gültiges Token läuft kein Offboarding mehr
      expiredTokenUsed: (tenant) => logger.alert("scim_token_expired", { tenant }),
    }),
    baseUrl: `${cfg.publicBaseUrl}/scim/v2`,
    newId: () => crypto.randomUUID(),
    actor: "scim:idp",
  },
  cors: createCorsPolicy(cfg.corsAllowedOrigins),
  auth: new EntraTokenVerifier({ tenantId: cfg.secrets.entraTenantId, audiences: cfg.api.audiences, requiredScope: cfg.api.requiredScope, fetchFn }),
  status: statusRepo,
  pipelines: new PrismaPipelineStore(prisma, Number(process.env.MAX_PIPELINES_PER_USER ?? "5"), undefined, syncAllowlist,
    // "dieselbe Person" per Graph bei der Anlage (account-Ziele); Token je Entra-Mandant
    (tenantId, subj) => verifyIdentity(createGraphCaller(graphTokens, fetchFn, tenantId, 10_000, async () => {}), subj)),
  syncTargets: { allowlist: syncAllowlist, owners: statusRepo },
  booking: { token: cfg.secrets.bookingApiToken, repo: syncRepo },
  writeScope: cfg.api.writeScope,
  log,
  security: logger,
});

// --- Worker-Schleifen (fester Takt, Jobs je Tick begrenzt → feste Pool-Last) ----------------------------
let stopped = false;
const loop = (name: string, fn: () => Promise<unknown>, everyMs: number) => {
  const run = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (err) {
      log({ level: "error", worker: name, msg: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) setTimeout(run, everyMs).unref();
  };
  setTimeout(run, everyMs).unref();
};
loop("teardown", () => teardownWorker.tick(10), 2_000);
loop("handshake", () => handshakeWorker.tick(10), 2_000);
loop("renewal", () => renewalWorker.tick(10), 5_000);
// Sync-Jobs dauern länger (mehrere Graph-Aufrufe je Termin): wenige je Tick, lange Lease (= Sync-Lease je Pipeline)
loop("sync", () => syncWorker.tick(5), 2_000);
loop("target-cleanup", () => cleanupWorker.tick(5), 5_000);
loop("sync-scheduler", async () => {
  const n = await syncScheduler.tick();
  if (n > 0) log({ level: "info", msg: "syncs_scheduled", count: n });
}, 15 * 60_000);
// Ein INSERT … SELECT je Lauf; mehrere Tasks gleichzeitig sind harmlos (dedupe_key renew:<channel>)
loop("renewal-scheduler", async () => {
  const n = await renewalScheduler.tick();
  if (n > 0) log({ level: "info", msg: "renewals_scheduled", count: n });
}, 10 * 60_000);

app.server.listen(cfg.port, () => log({ level: "info", msg: "listening", port: cfg.port, tenant: cfg.tenantId }));

installGracefulShutdown({
  server: {
    close: (cb?: (err?: Error) => void) => {
      app.startDraining(); // Healthcheck → 503; ALB hat den Task beim ECS-Stopp ohnehin schon abgemeldet
      stopped = true;
      return app.server.close(cb);
    },
    closeIdleConnections: () => app.server.closeIdleConnections(),
  },
  workers: [teardownWorker, handshakeWorker, renewalWorker, syncWorker, cleanupWorker],
  closePool: async () => {
    await prisma.$disconnect();
    await pool.end();
  },
  log: (msg) => {
    logger.info(msg);
    logger.flush();
  },
});
