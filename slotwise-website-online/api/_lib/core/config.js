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

/** Produktiv nur, wenn Signatur, Speicher und Mailversand eingerichtet sind. Lokal reicht der Dateispeicher. */
function readiness(config) {
  if (!config.deployed) return { ready: true, mode: "local", missing: [] };
  const missing = [];
  if (!config.secret) missing.push("WAITLIST_SECRET");
  if (!config.redis) missing.push("KV_REST_API_URL/KV_REST_API_TOKEN");
  if (!config.mail) missing.push("MAILJET_API_KEY/MAILJET_API_SECRET/WAITLIST_FROM_EMAIL");
  return { ready: missing.length === 0, mode: "production", missing };
}

module.exports = { fromEnv, readiness };
