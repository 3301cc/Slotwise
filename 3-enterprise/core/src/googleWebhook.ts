/**
 * Eingang für Google-Calendar-Push-Notifications:  POST /webhooks/google
 *
 * Google schickt KEINEN Body, nur Header:
 *   X-Goog-Channel-ID        unsere Channel-ID (≤ 64 Zeichen), = webhook_channels.provider_subscription_id
 *   X-Goog-Channel-Token     unser Geheimnis je Channel (≤ 256 Zeichen), = webhook_channels.client_state
 *   X-Goog-Resource-ID       Googles stabile ID des beobachteten Kalenders, = webhook_channels.provider_resource_id
 *   X-Goog-Resource-State    sync (Channel angelegt) | exists (Änderung) | not_exists (Ressource weg)
 *   X-Goog-Message-Number    1 bei sync, danach streng steigend (nicht lückenlos)
 *   X-Goog-Channel-Expiration (optional) Ablauf des Channels
 *
 * Prüfkette (jede Stufe verwirft, nichts wird gelesen oder gespeichert, was nicht alle Stufen passiert):
 *   1. Methode POST, kein Origin-Header (Browser haben hier nichts verloren), Body ≤ 1 KiB
 *   2. Header-Syntax: feste Zeichensätze und Längen – kein Freitext gelangt in SQL, Logs oder Job-Keys
 *   3. EIN Lookup: Channel muss existieren und provider = 'google' sein
 *   4. Token timing-sicher (SHA-256 beider Seiten + crypto.timingSafeEqual), Resource-ID muss passen
 *   5. Channel weder abgelaufen noch gestoppt, Pipeline aktiv – sonst verwerfen (+ Teardown sicherstellen)
 *   6. EIN Schreibzugriff: Message-Number nur vorwärts (Replay-Schutz) UND Job einstellen, atomar
 *
 * Antwortcodes (Google wiederholt nur bei 500/502/503/504):
 *   200  angenommen ODER verworfen – bewusst gleich, damit niemand Channel-IDs oder Tokens ausprobieren kann
 *   400  Header fehlen/ungültig · 403 Origin-Header · 405 falsche Methode · 413 Body zu groß
 *   503  Datenbank langsamer als das Budget (2,5 s) oder Fehler → Google stellt erneut zu
 *
 * Last: 2 DB-Roundtrips je Notification (Lookup + atomarer Accept), keine Pufferung, keine Allokation je
 * Header über die geprüften Strings hinaus.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DelayedJobQueue } from "./retryQueue.js";
import { TEARDOWN_JOB_KIND } from "./teardownJob.js";
import type { GuardChannel } from "./webhookGuard.js";

// ---------------------------------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------------------------------
export type GoogleResourceState = "sync" | "exists" | "not_exists";

export interface GoogleNotificationHeaders {
  channelId: string;
  token: string;
  resourceId: string;
  resourceState: GoogleResourceState;
  messageNumber: number;
  /** ms seit Epoch oder null, wenn Google keinen Ablauf mitschickt */
  channelExpiresAtMs: number | null;
}

export interface GoogleChannel extends GuardChannel {
  lastMessageNumber: number | null;
}

/** Job, der nach erfolgreicher Prüfung eingestellt wird (null = nur Message-Number fortschreiben, z. B. sync) */
export interface GoogleJob {
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface GoogleGuardRepo {
  findGoogleChannel(channelId: string): Promise<GoogleChannel | null>;
  /**
   * Atomar in EINER Anweisung: last_message_number nur erhöhen (nie senken, nie bei gestopptem Channel) und –
   * nur wenn das gelungen ist – den Job einstellen. fresh = false heißt Replay oder veraltete Zustellung.
   */
  acceptGoogleNotification(channelId: string, messageNumber: number, tenantId: string, job: GoogleJob | null): Promise<{ fresh: boolean; queued: boolean }>;
}

export type GoogleDropReason =
  | "unknown_channel"
  | "token_mismatch"
  | "resource_mismatch"
  | "channel_expired"
  | "channel_stopped_or_revoked"
  | "replay_or_stale";

export interface GoogleSecurityEvent {
  kind: "webhook_rejected";
  provider: "google";
  reason: GoogleDropReason | "malformed_headers" | "origin_header" | "body_too_large" | "method_not_allowed";
  requestId: string;
  /** SHA-256-Präfix der Channel-ID – korrelierbar, aber kein Klartext im Log */
  channelRef: string | null;
  tenantId: string | null;
  sourceIp: string | null;
  messageNumber: number | null;
}

export interface GoogleGuardDeps {
  repo: GoogleGuardRepo;
  queue: Pick<DelayedJobQueue, "enqueueMany">;
  /** strukturierter Sicherheits-Log (JSON); bekommt nie Token oder Klartext-IDs */
  securityEvent: (e: GoogleSecurityEvent) => void;
  now?: () => number;
  budgetMs?: number;
}

export interface GoogleResult {
  status: 200 | 400 | 403 | 405 | 413 | 503;
  outcome: "accepted" | "dropped" | "rejected" | "unavailable";
  reason: GoogleDropReason | null;
  jobQueued: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Header-Prüfung
// ---------------------------------------------------------------------------------------------------
const CHANNEL_ID = /^[A-Za-z0-9_+/=-]{1,64}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const TOKEN = /^[\x21-\x7e]{16,256}$/; // druckbares ASCII ohne Leerzeichen; wir vergeben 43 Zeichen base64url
const MESSAGE_NUMBER = /^[1-9][0-9]{0,15}$/; // positiv, < 2^53
const STATES: ReadonlySet<string> = new Set(["sync", "exists", "not_exists"]);

function single(v: string | string[] | undefined): string | null {
  if (typeof v !== "string") return null; // fehlt oder mehrfach gesendet → ungültig
  return v;
}

/** Liefert die geprüften Header oder null. Keine Exceptions, keine Regex mit Backtracking-Risiko. */
export function parseGoogleHeaders(h: IncomingMessage["headers"]): GoogleNotificationHeaders | null {
  const channelId = single(h["x-goog-channel-id"]);
  const token = single(h["x-goog-channel-token"]);
  const resourceId = single(h["x-goog-resource-id"]);
  const state = single(h["x-goog-resource-state"]);
  const msg = single(h["x-goog-message-number"]);
  if (!channelId || !CHANNEL_ID.test(channelId)) return null;
  if (!token || !TOKEN.test(token)) return null;
  if (!resourceId || !RESOURCE_ID.test(resourceId)) return null;
  if (!state || !STATES.has(state)) return null;
  if (!msg || !MESSAGE_NUMBER.test(msg)) return null;
  const messageNumber = Number(msg);
  if (!Number.isSafeInteger(messageNumber)) return null;

  let channelExpiresAtMs: number | null = null;
  const exp = h["x-goog-channel-expiration"];
  if (exp !== undefined) {
    if (typeof exp !== "string" || exp.length > 64) return null;
    const t = Date.parse(exp);
    if (Number.isNaN(t)) return null;
    channelExpiresAtMs = t;
  }
  return { channelId, token, resourceId, resourceState: state as GoogleResourceState, messageNumber, channelExpiresAtMs };
}

function safeEqual(a: string, b: string): boolean {
  // Hash auf feste Länge: timingSafeEqual wirft sonst bei ungleicher Länge und verrät die Länge
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function channelRef(channelId: string): string {
  return createHash("sha256").update(channelId).digest("hex").slice(0, 16);
}

class BudgetExceeded extends Error {}

// ---------------------------------------------------------------------------------------------------
// Fachlogik (ohne HTTP) – direkt testbar
// ---------------------------------------------------------------------------------------------------
export async function handleGoogleNotification(
  hdr: GoogleNotificationHeaders,
  ctx: { requestId: string; sourceIp: string | null },
  d: GoogleGuardDeps,
): Promise<GoogleResult> {
  const work = evaluate(hdr, ctx, d);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BudgetExceeded()), d.budgetMs ?? 2_500);
      }),
    ]);
  } catch {
    work.catch(() => undefined); // läuft ggf. im Hintergrund zu Ende; Google wiederholt, Replay-Schutz fängt Doppel
    return { status: 503, outcome: "unavailable", reason: null, jobQueued: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluate(hdr: GoogleNotificationHeaders, ctx: { requestId: string; sourceIp: string | null }, d: GoogleGuardDeps): Promise<GoogleResult> {
  const now = d.now?.() ?? Date.now();
  const ref = channelRef(hdr.channelId);
  const drop = (reason: GoogleDropReason, tenantId: string | null, log: boolean): GoogleResult => {
    if (log) {
      d.securityEvent({ kind: "webhook_rejected", provider: "google", reason, requestId: ctx.requestId, channelRef: ref,
        tenantId, sourceIp: ctx.sourceIp, messageNumber: hdr.messageNumber });
    }
    return { status: 200, outcome: "dropped", reason, jobQueued: false };
  };

  const ch = await d.repo.findGoogleChannel(hdr.channelId);
  if (!ch) return drop("unknown_channel", null, true);
  // Token und Resource-ID IMMER beide prüfen (gleicher Aufwand, egal welche Prüfung scheitert)
  const tokenOk = ch.clientState !== null && safeEqual(hdr.token, ch.clientState);
  const resourceOk = ch.providerResourceId !== null && safeEqual(hdr.resourceId, ch.providerResourceId);
  if (!tokenOk) return drop("token_mismatch", ch.tenantId, true);
  if (!resourceOk) return drop("resource_mismatch", ch.tenantId, true);

  const expired =
    (ch.expiresAt !== null && Date.parse(ch.expiresAt) <= now) ||
    (hdr.channelExpiresAtMs !== null && hdr.channelExpiresAtMs <= now);
  if (expired) return drop("channel_expired", ch.tenantId, false);

  if (ch.stopRequestedAt || ch.stoppedAt || ch.pipelineStatus !== "active") {
    // Offboarding oder gestoppte Pipeline: nichts verarbeiten, Teardown sicherstellen (idempotent)
    if (!ch.stoppedAt) {
      await d.queue.enqueueMany([{
        tenantId: ch.tenantId, kind: TEARDOWN_JOB_KIND, dedupeKey: `teardown:${ch.userId}`,
        payload: { userId: ch.userId, purgeUser: false, requestedAt: new Date(now).toISOString() },
      }]);
    }
    return drop("channel_stopped_or_revoked", ch.tenantId, false);
  }

  // Schneller Vorab-Check ohne Schreibzugriff; maßgeblich ist die atomare Prüfung in acceptGoogleNotification
  if (ch.lastMessageNumber !== null && hdr.messageNumber <= ch.lastMessageNumber) return drop("replay_or_stale", ch.tenantId, true);

  const job: GoogleJob | null =
    hdr.resourceState === "sync"
      ? null // Channel-Bestätigung: nichts zu synchronisieren
      : { kind: "pipeline.delta_sync", dedupeKey: `delta:${ch.pipelineId}`,
          payload: { pipelineId: ch.pipelineId, full: hdr.resourceState === "not_exists" } };

  const r = await d.repo.acceptGoogleNotification(ch.id, hdr.messageNumber, ch.tenantId, job);
  if (!r.fresh) return drop("replay_or_stale", ch.tenantId, true);
  // queued = false bei vorhandenem wartenden Job: gewollt, der bündelt alle Änderungen
  return { status: 200, outcome: "accepted", reason: null, jobQueued: r.queued };
}

// ---------------------------------------------------------------------------------------------------
// HTTP-Adapter (node:http)
// ---------------------------------------------------------------------------------------------------
export interface GoogleWebhookHttpOptions {
  maxBodyBytes?: number;
  requestId?: (req: IncomingMessage) => string;
  onResult?: (r: GoogleResult, durationMs: number) => void;
}

function end(res: ServerResponse, status: number): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store" });
  res.end();
}

/** Verwirft einen (bei Google nie vorhandenen) Body bis zum Limit, ohne ihn zu puffern. */
function drainBody(req: IncomingMessage, limit: number): Promise<boolean> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (!done && size > limit) {
        done = true;
        resolve(false);
      }
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(true);
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

/** Erster Eintrag aus X-Forwarded-For (vom ALB gesetzt), sonst Socket-Adresse */
function sourceIp(req: IncomingMessage): string | null {
  const xff = req.headers["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined;
  const ip = first || req.socket.remoteAddress || null;
  return ip && ip.length <= 45 ? ip : null;
}

export function createGoogleWebhookListener(deps: GoogleGuardDeps, opts: GoogleWebhookHttpOptions = {}) {
  const limit = opts.maxBodyBytes ?? 1024;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t0 = performance.now();
    const requestId = opts.requestId?.(req) ?? String(req.headers["x-request-id"] ?? "").slice(0, 100);
    const ip = sourceIp(req);
    const reject = (status: 400 | 403 | 405 | 413, reason: GoogleSecurityEvent["reason"]) => {
      req.resume();
      deps.securityEvent({ kind: "webhook_rejected", provider: "google", reason, requestId, channelRef: null, tenantId: null, sourceIp: ip, messageNumber: null });
      end(res, status);
      opts.onResult?.({ status, outcome: "rejected", reason: null, jobQueued: false }, performance.now() - t0);
    };

    if (req.method !== "POST") return reject(405, "method_not_allowed");
    if (req.headers.origin !== undefined) return reject(403, "origin_header");
    const hdr = parseGoogleHeaders(req.headers);
    if (!hdr) return reject(400, "malformed_headers");

    let bodyOk: boolean;
    try {
      bodyOk = await drainBody(req, limit);
    } catch {
      end(res, 400);
      return;
    }
    if (!bodyOk) return reject(413, "body_too_large");

    let r: GoogleResult;
    try {
      r = await handleGoogleNotification(hdr, { requestId, sourceIp: ip }, deps);
    } catch {
      r = { status: 503, outcome: "unavailable", reason: null, jobQueued: false };
    }
    end(res, r.status);
    opts.onResult?.(r, performance.now() - t0);
  };
}
