"use strict";
/*
 * Konfiguration aus Umgebungsvariablen – der einzige Ort, der process.env liest.
 * Alles andere bekommt das fertige config-Objekt übergeben.
 */
const { loadTenants } = require("./tenants");
const { parseBusySource } = require("./agent/calendar");

const REQUIRED_SECRET_LENGTH = 32;

function fromEnv(env = process.env) {
  const deployed = Boolean(env.VERCEL || env.NODE_ENV === "production");
  const redisUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_URL || "";
  const redisToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_TOKEN || "";
  const secret = env.WAITLIST_SECRET && env.WAITLIST_SECRET.length >= REQUIRED_SECRET_LENGTH ? env.WAITLIST_SECRET : "";

  // Mandanten einmal je Prozess prüfen. Fehler werfen bewusst nicht (kein Absturz-Neustart-Kreislauf mit Logflut),
  // sondern sperren den Mandantenbetrieb und erscheinen in /api/agent/status (siehe tenants.js).
  const t = loadTenants(env.TENANTS_JSON || "", console, { waitlistAdminToken: env.WAITLIST_ADMIN_TOKEN || "" });

  return {
    deployed,
    secret: secret || (deployed ? "" : "local-dev-secret-not-for-production-use"),
    siteUrl: (env.SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).replace(/\/$/, ""),
    redis: redisUrl && redisToken ? { url: redisUrl.replace(/\/$/, ""), token: redisToken } : null,
    dataFile: env.WAITLIST_DATA_FILE || "",
    mail: env.MAILJET_API_KEY && env.MAILJET_API_SECRET && env.WAITLIST_FROM_EMAIL
      ? { apiKey: env.MAILJET_API_KEY, apiSecret: env.MAILJET_API_SECRET, from: env.WAITLIST_FROM_EMAIL, fromName: env.WAITLIST_FROM_NAME || "Slotwise" }
      : null,
    notifyEmail: env.WAITLIST_NOTIFY_EMAIL || "",
    adminToken: env.WAITLIST_ADMIN_TOKEN || (deployed ? "" : "local-admin"),
    tokenTtlMs: 72 * 60 * 60 * 1000,
    rateLimit: { max: 5, windowSec: 600 },
    // Mandanten (mehrere Praxen/Unternehmen). Leer = ein Mandant wie bisher. Format: siehe core/tenants.js
    tenants: t.tenants,
    tenantsError: t.error,   // "" = in Ordnung; sonst Grund ohne Tokens

    // Stripe-Abo-Checkout (core/billing.js). Ohne Schlüssel: aus, die Preisseite bleibt bei der Warteliste.
    billing: stripeConfig(env),

    // „Google Kalender verbinden“ (core/google.js). Client-ID ist öffentlich, das Secret kommt nur aus der Umgebung.
    // Ohne GOOGLE_CLIENT_SECRET (oder ohne SITE_URL/WAITLIST_SECRET/Store): aus, Endpunkte antworten 503 { enabled: false }.
    google: googleConfig(env),

    // KI-Agent (Telefon + E-Mail)
    agent: {
      model: env.AGENT_MODEL || "",                                    // "fake" = deterministisches Testmodell ohne AWS
      modelId: env.BEDROCK_MODEL_ID || "eu.anthropic.claude-3-5-haiku-20241022-v1:0",
      aws: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || "", region: env.AWS_REGION || "eu-central-1" }
        : null,
      twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER
        ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER }
        : null,
      company: env.AGENT_COMPANY || "Slotwise",
      hostName: env.AGENT_HOST_NAME || "der Host",
      timezone: env.AGENT_TIMEZONE || "Europe/Berlin",
      escalationPhone: env.AGENT_ESCALATION_PHONE || "",
      // Belegte Zeiten aus CalenSync Enterprise (Ziel „Buchungsseite“), z. B. https://acme.calensync.de/api/v1/availability/busy.
      // Beide leer = aus. Mit TENANTS_JSON gilt das nur für den Einzelbetrieb; Mandanten tragen eigene Werte ein (tenants.js).
      enterpriseBusy: parseBusySource(env.ENTERPRISE_BUSY_URL, env.ENTERPRISE_BUSY_TOKEN),
      // Löschfristen in Tagen (agent/retention.js); leer = Standard 30 / 90 / 90
      retention: {
        tasksDays: Number(env.AGENT_RETENTION_TASKS_DAYS) || undefined,
        calendarDays: Number(env.AGENT_RETENTION_CALENDAR_DAYS) || undefined,
        activityDays: Number(env.AGENT_RETENTION_ACTIVITY_DAYS) || undefined,
      },
    },
  };
}

/**
 * Stripe: Testschlüssel (sk_test_/rk_test_) gehen immer, Live-Schlüssel (sk_live_/rk_live_) nur mit STRIPE_LIVE="1".
 * So kann vor dem Livegang der App kein echtes Geld eingezogen werden, auch wenn versehentlich ein Live-Schlüssel gesetzt ist.
 * error: "" = in Ordnung oder schlicht nicht eingerichtet; sonst ein Grund ohne Schlüsselinhalt (landet im Log).
 */
function stripeConfig(env) {
  const secretKey = String(env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  const liveAllowed = env.STRIPE_LIVE === "1";
  const base = {
    enabled: false, test: true, secretKey: "", webhookSecret: "", error: "",
    requireTos: env.STRIPE_REQUIRE_TOS === "1",
    automaticTax: env.STRIPE_AUTOMATIC_TAX === "1",
  };
  if (!secretKey && !webhookSecret) return base;
  const isTest = /^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey);
  const isLive = /^(sk|rk)_live_[A-Za-z0-9]+$/.test(secretKey);
  let error = "";
  if (!secretKey) error = "STRIPE_SECRET_KEY fehlt (STRIPE_WEBHOOK_SECRET ist gesetzt) – Abrechnung aus";
  else if (isLive && !liveAllowed) error = "STRIPE_SECRET_KEY ist ein Live-Schlüssel, aber STRIPE_LIVE ist nicht \"1\" – Abrechnung gesperrt, damit vor dem Livegang kein echtes Geld eingezogen wird";
  else if (!isTest && !isLive) error = "STRIPE_SECRET_KEY hat kein gültiges Format (erwartet sk_test_… oder, mit STRIPE_LIVE=\"1\", sk_live_…) – Abrechnung aus";
  else if (!/^whsec_\S+$/.test(webhookSecret)) error = "STRIPE_WEBHOOK_SECRET fehlt oder hat kein gültiges Format (whsec_…) – Abrechnung aus, sonst gingen abgeschlossene Abos verloren";
  if (error) return { ...base, test: !isLive, error };
  return { ...base, enabled: true, test: isTest, secretKey, webhookSecret };
}

const DEFAULT_GOOGLE_CLIENT_ID = "437100738800-2cqlbpg2obj5ft673c2gr4d4c5hp0krj.apps.googleusercontent.com";

/** error: "" = in Ordnung oder schlicht nicht eingerichtet; sonst ein Grund ohne Secret (landet im Log). */
function googleConfig(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim() || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return { clientId: "", clientSecret: "", error: "GOOGLE_CLIENT_ID hat kein gültiges Format (…apps.googleusercontent.com) – Google Kalender aus" };
  }
  return { clientId, clientSecret, error: "" };
}

/** Produktiv nur, wenn Signatur, Speicher und Mailversand eingerichtet sind. Lokal reicht der Dateispeicher. */
function readiness(config) {
  if (!config.deployed) return { ready: true, mode: "local", missing: [] };
  const missing = [];
  if (!config.secret) missing.push("WAITLIST_SECRET");
  if (!config.redis) missing.push("KV_REST_API_URL/KV_REST_API_TOKEN");
  if (!config.mail) missing.push("MAILJET_API_KEY/MAILJET_API_SECRET/WAITLIST_FROM_EMAIL");
  return { ready: missing.length === 0, mode: "production", missing };
}

module.exports = { fromEnv, readiness, DEFAULT_GOOGLE_CLIENT_ID };
