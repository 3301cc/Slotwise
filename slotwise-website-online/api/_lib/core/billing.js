"use strict";
/*
 * Stripe-Abo-Checkout – Geschäftslogik, unabhängig von Vercel, Express oder node:http (wie core/waitlist.js).
 *
 *   publicConfig  GET  /api/billing/config    → { enabled, test }  (nie Schlüssel)
 *   checkout      POST /api/billing/checkout  { plan, interval, seats?, email? } → { url }  (Stripe Checkout Session)
 *   webhook       POST /api/billing/webhook   Stripe-Ereignisse; Signatur über den unveränderten Roh-Body
 *
 * Preise kommen aus der Tabelle unten (Server), nie vom Browser. Sie entspricht
 * 2-packages-platform/packages/platform/config/plans.json – ein Test vergleicht beide.
 * Produkte/Preise müssen im Stripe-Dashboard nicht angelegt werden: der Checkout nutzt price_data (inline).
 */
const crypto = require("node:crypto");
const { normalizeEmail } = require("./email");

const STRIPE_API = "https://api.stripe.com/v1";

/** Cent-Beträge netto (zzgl. MwSt.) pro Host und Monat; Jahresabo = 12 × Monatspreis bei jährlicher Zahlung. */
const PLAN_PRICES = {
  professional: { name: "CalenSync Professional", priceCentsMonthly: 1500, priceCentsYearly: 1200 },
  business: { name: "CalenSync Business", priceCentsMonthly: 2400, priceCentsYearly: 1900 },
};
const INTERVALS = new Set(["month", "year"]);
const SEATS_MIN = 1, SEATS_MAX = 50;
const CHECKOUT_FIELDS = new Set(["plan", "interval", "seats", "email"]);

const SIGNATURE_TOLERANCE_SEC = 300;
const EVENT_TTL_SEC = 7 * 24 * 3600;            // Stripe wiederholt Zustellungen bis zu 3 Tage
const RECORD_PREFIX = "billing:sub:";
const EVENT_PREFIX = "billing:evt:";
const LOG_KEY = "billing:log";
const LOG_MAX = 200;

const json = (status, body, headers) => ({ status, body, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function unitAmount(plan, interval) {
  const p = PLAN_PRICES[plan];
  return interval === "year" ? p.priceCentsYearly * 12 : p.priceCentsMonthly;
}

/**
 * application/x-www-form-urlencoded mit Stripes Klammer-Schreibweise:
 *   { a: { b: [ { c: 1 } ] } } → a[b][0][c]=1   (Klammern unkodiert wie in stripe-node, Werte kodiert)
 */
function encodeForm(obj) {
  const out = [];
  const enc = (s) => encodeURIComponent(s).replace(/%5B/g, "[").replace(/%5D/g, "]");
  (function walk(value, key) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${key}[${i}]`));
    if (typeof value === "object") return Object.keys(value).forEach((k) => walk(value[k], key ? `${key}[${k}]` : k));
    out.push(`${enc(key)}=${encodeURIComponent(String(value))}`);
  })(obj, "");
  return out.join("&");
}

/**
 * Prüft den Stripe-Signature-Header nach Stripes Schema:
 *   t=<Unix-Sekunden>,v1=<hex>[,v1=<hex>…][,v0=…]   ·   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
 * Jede passende v1-Signatur genügt (beim Rotieren des Geheimnisses schickt Stripe mehrere). Vergleich zeitkonstant.
 * Zu alt (> tolerance Sekunden) gilt als Replay.
 */
function verifyStripeSignature(rawBody, header, secret, nowSec, tolerance = SIGNATURE_TOLERANCE_SEC) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || !header || !secret) return { ok: false, reason: "missing" };
  let t = "";
  const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || v1.length === 0) return { ok: false, reason: "malformed" };
  const expected = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody])).digest();
  const match = v1.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), expected);
  });
  if (!match) return { ok: false, reason: "mismatch" };
  if (tolerance > 0 && Number(t) < nowSec - tolerance) return { ok: false, reason: "expired" };
  return { ok: true, timestamp: Number(t) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hilfen für Webhook-Daten: nur kurze, geprüfte Werte speichern
// ---------------------------------------------------------------------------------------------------------------------
const idOf = (v, prefix) => {
  const s = typeof v === "string" ? v : v && typeof v === "object" && typeof v.id === "string" ? v.id : "";
  return new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`).test(s) ? s : null;
};
const planOf = (v) => (typeof v === "string" && Object.prototype.hasOwnProperty.call(PLAN_PRICES, v) ? v : null);
const intervalOf = (v) => (typeof v === "string" && INTERVALS.has(v) ? v : null);
const statusOf = (v) => (typeof v === "string" && /^[a-z_]{1,32}$/.test(v) ? v : null);
const qtyOf = (v) => (Number.isInteger(v) && v >= 0 && v <= 10000 ? v : null);
const meta = (o) => (o && typeof o.metadata === "object" && o.metadata) || {};

function createBilling(config, deps = {}) {
  const cfg = config.billing || { enabled: false, test: true, error: "" };
  const store = deps.store;
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const rateLimit = deps.rateLimit || { max: 10, windowSec: 600 };   // je IP: 10 Checkout-Starts in 10 Minuten

  if (cfg.error) log.error("[billing]", cfg.error);

  async function rateLimited(ip) {
    const key = crypto.createHash("sha256").update(`billing:${ip || "unknown"}`).digest("hex").slice(0, 32);
    return (await store.incrWithTtl(`b:${key}`, rateLimit.windowSec, now())) > rateLimit.max;
  }

  function validateCheckout(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
    for (const k of Object.keys(body)) if (!CHECKOUT_FIELDS.has(k)) return { error: "invalid_field" };
    const plan = planOf(body.plan);
    if (!plan) return { error: "invalid_plan" };
    const interval = intervalOf(body.interval);
    if (!interval) return { error: "invalid_interval" };
    let seats = 1;
    if (body.seats !== undefined) {
      if (!Number.isInteger(body.seats) || body.seats < SEATS_MIN || body.seats > SEATS_MAX) return { error: "invalid_seats" };
      seats = body.seats;
    }
    let email = null;
    if (body.email !== undefined && body.email !== null && body.email !== "") {
      email = normalizeEmail(body.email);
      if (!email) return { error: "invalid_email" };
    }
    return { plan, interval, seats, email };
  }

  function sessionParams({ plan, interval, seats, email }, baseUrl) {
    const md = { plan, interval, source: "website" };
    const period = interval === "year" ? "jährlich" : "monatlich";
    return {
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: PLAN_PRICES[plan].name },
          unit_amount: unitAmount(plan, interval),
          recurring: { interval },
          tax_behavior: "exclusive",
        },
        quantity: seats,
        adjustable_quantity: { enabled: true, minimum: SEATS_MIN, maximum: SEATS_MAX },
      }],
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      automatic_tax: cfg.automaticTax ? { enabled: true } : undefined,
      consent_collection: cfg.requireTos ? { terms_of_service: "required" } : undefined,
      locale: "de",
      allow_promotion_codes: true,
      customer_email: email || undefined,
      metadata: md,
      subscription_data: { metadata: md },
      success_url: `${baseUrl}/checkout/erfolg?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/preise?checkout=abgebrochen`,
      custom_text: {
        submit: {
          message: `Mit „Abonnieren“ bestellst du zahlungspflichtig ein Abo von ${PLAN_PRICES[plan].name}. ` +
            `Abgerechnet wird pro Host, ${period} im Voraus, zuzüglich der gesetzlichen Mehrwertsteuer.`,
        },
      },
    };
  }

  /** Stripe-Fehler → sichere Codes. Stripes Meldungstexte (können Schlüsselfragmente enthalten) gehen nie nach außen. */
  function mapStripeError(status, err, requestId) {
    log.error("[billing] Stripe-Fehler", JSON.stringify({ status, type: err && err.type, code: err && err.code, param: err && err.param, requestId }));
    if (status === 401 || status === 403) return json(503, { error: "billing_unavailable" });
    if (status === 429) return json(503, { error: "billing_busy" }, { "Retry-After": "30" });
    if (status >= 500) return json(502, { error: "stripe_unavailable" });
    return json(502, { error: "checkout_failed" });
  }

  async function stripePost(path, params, idempotencyKey) {
    const init = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body: encodeForm(params),
    };
    let last;
    // Höchstens ein Wiederholversuch bei Netz-/Serverfehlern – mit demselben Idempotency-Key, also nie zwei Sessions.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(`${STRIPE_API}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
        const data = await res.json().catch(() => null);
        last = { status: res.status, data, requestId: res.headers && typeof res.headers.get === "function" ? res.headers.get("request-id") : null };
        if (res.status < 500) return last;
      } catch (e) {
        last = { status: 0, data: null, networkError: e && e.name };
        if (e && e.name === "TimeoutError") return last;
      }
    }
    return last;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Webhook: minimaler Datensatz je Abo
  // -------------------------------------------------------------------------------------------------------------------
  async function upsert(subscriptionId, patch, eventCreated) {
    const key = RECORD_PREFIX + subscriptionId;
    const prev = (await store.getJson(key)) || { subscriptionId };
    const next = { ...prev };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) continue;
      // Status/Anzahl nur aus dem jüngsten Abo-Ereignis (Stripe garantiert keine Reihenfolge)
      if ((k === "status" || k === "quantity") && prev.statusAt && eventCreated < prev.statusAt) continue;
      next[k] = v;
    }
    if (patch.status && !(prev.statusAt && eventCreated < prev.statusAt)) next.statusAt = eventCreated;
    next.updated = new Date(now()).toISOString();
    await store.setJson(key, next);
    return next;
  }

  async function handleEvent(event) {
    const obj = (event.data && event.data.object) || {};
    const created = Number.isInteger(event.created) ? event.created : Math.floor(now() / 1000);
    let rec = null;
    switch (event.type) {
      case "checkout.session.completed": {
        const sub = idOf(obj.subscription, "sub");
        if (!sub) break;  // kein Abo-Checkout
        const m = meta(obj);
        rec = await upsert(sub, {
          customerId: idOf(obj.customer, "cus"),
          plan: planOf(m.plan),
          interval: intervalOf(m.interval),
          email: normalizeEmail((obj.customer_details && obj.customer_details.email) || obj.customer_email),
          checkoutSessionId: idOf(obj.id, "cs"),
        }, created);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = idOf(obj.id, "sub");
        if (!sub) break;
        const m = meta(obj);
        const item = obj.items && Array.isArray(obj.items.data) ? obj.items.data[0] : null;
        const recurring = item && item.price && item.price.recurring;
        rec = await upsert(sub, {
          customerId: idOf(obj.customer, "cus"),
          status: statusOf(obj.status) || (event.type === "customer.subscription.deleted" ? "canceled" : null),
          plan: planOf(m.plan),
          interval: intervalOf(m.interval) || intervalOf(recurring && recurring.interval),
          quantity: qtyOf(item && item.quantity) ?? qtyOf(obj.quantity),
        }, created);
        break;
      }
      case "invoice.payment_failed": {
        // Ältere API-Versionen: invoice.subscription; ab 2025: invoice.parent.subscription_details.subscription
        const sub = idOf(obj.subscription, "sub") || idOf(obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription, "sub");
        if (!sub) break;
        rec = await upsert(sub, {
          customerId: idOf(obj.customer, "cus"),
          email: normalizeEmail(obj.customer_email),
          lastPaymentFailedAt: new Date(created * 1000).toISOString(),
        }, created);
        break;
      }
      default:
        return { handled: false };
    }
    await store.listPush(LOG_KEY, {
      at: new Date(now()).toISOString(),
      type: event.type,
      subscriptionId: rec ? rec.subscriptionId : null,
      status: rec ? rec.status || null : null,
      plan: rec ? rec.plan || null : null,
    }, LOG_MAX);
    return { handled: true };
  }

  return {
    config: cfg,

    publicConfig() {
      return json(200, { enabled: Boolean(cfg.enabled), test: Boolean(cfg.enabled && cfg.test) });
    },

    /** POST { plan: "professional"|"business", interval: "month"|"year", seats?: 1–50, email? } */
    async checkout({ body, ip, baseUrl }) {
      if (!cfg.enabled) return json(503, { error: "billing_disabled" });
      const v = validateCheckout(body);
      if (v.error) return json(422, { error: v.error });
      if (!baseUrl) return json(500, { error: "base_url_missing" });
      if (await rateLimited(ip)) return json(429, { error: "rate_limited" }, { "Retry-After": String(rateLimit.windowSec) });

      const r = await stripePost("/checkout/sessions", sessionParams(v, baseUrl), `checkout-${crypto.randomUUID()}`);
      if (r.status === 0) {
        log.error("[billing] Stripe nicht erreichbar:", r.networkError || "unbekannt");
        return json(502, { error: "stripe_unavailable" });
      }
      if (r.status !== 200) return mapStripeError(r.status, r.data && r.data.error, r.requestId);
      const url = r.data && typeof r.data.url === "string" ? r.data.url : "";
      if (!/^https:\/\/[a-z0-9.-]+\.stripe\.com\//i.test(url)) {
        log.error("[billing] Antwort ohne gültige Checkout-URL", JSON.stringify({ requestId: r.requestId }));
        return json(502, { error: "checkout_failed" });
      }
      return json(200, { url });
    },

    /** Eingabe: { rawBody: Buffer|null, headers } – rawBody sind die unveränderten Bytes der Anfrage. */
    async webhook({ rawBody, headers }) {
      if (!cfg.enabled) return json(503, { error: "billing_disabled" });
      if (!Buffer.isBuffer(rawBody)) {
        log.error("[billing] Webhook ohne Roh-Body – wurde der Body vorher geparst? Signatur nicht prüfbar.");
        return json(400, { error: "raw_body_unavailable" });
      }
      const sig = verifyStripeSignature(rawBody, headers && headers["stripe-signature"], cfg.webhookSecret, Math.floor(now() / 1000));
      if (!sig.ok) return json(400, { error: "invalid_signature" });
      let event;
      try { event = JSON.parse(rawBody.toString("utf8")); } catch { return json(400, { error: "invalid_json" }); }
      if (!event || typeof event !== "object" || typeof event.id !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(event.id) || typeof event.type !== "string") {
        return json(400, { error: "invalid_event" });
      }
      const seenKey = EVENT_PREFIX + event.id;
      if (await store.getJson(seenKey)) return json(200, { received: true, duplicate: true });
      const r = await handleEvent(event);   // Fehler → 500 (Adapter), Stripe stellt erneut zu; Ereignis gilt dann nicht als gesehen
      await store.setJson(seenKey, { at: now() }, EVENT_TTL_SEC);
      return json(200, { received: true, handled: r.handled });
    },
  };
}

module.exports = { createBilling, PLAN_PRICES, unitAmount, encodeForm, verifyStripeSignature, RECORD_PREFIX, LOG_KEY };
