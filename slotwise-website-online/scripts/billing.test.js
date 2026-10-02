"use strict";
// node --test scripts/billing.test.js – Stripe-Checkout und -Webhook ohne Netz: fetch ist gefälscht, Schlüssel sind Attrappen.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");

// Vor dem ersten require von http.js: der Adapter liest die Umgebung einmal je Prozess.
const DATA_FILE = path.join(os.tmpdir(), `billing-test-${process.pid}-${Date.now()}.json`);
process.env.STRIPE_SECRET_KEY = "sk_test_FAKE";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_FAKE";
process.env.WAITLIST_DATA_FILE = DATA_FILE;
process.env.SITE_URL = "https://calensync.example";
delete process.env.VERCEL;
delete process.env.STRIPE_LIVE;

const test = require("node:test");
const assert = require("node:assert");
const { fromEnv } = require("../api/_lib/core/config");
const { memoryStore } = require("../api/_lib/core/store");
const { createBilling, PLAN_PRICES, unitAmount, encodeForm, verifyStripeSignature, RECORD_PREFIX, LOG_KEY } = require("../api/_lib/core/billing");
const { apiHandler, readRawBody } = require("../api/_lib/http");
const billingFn = require("../api/billing/[action].js");

const SECRET = "whsec_FAKE";
const quiet = { log() {}, error() {} };
const T0 = 1_790_000_000;   // feste Uhr (Sekunden)

function captureLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = queue ? queue.shift() : responses;
    if (r instanceof Error) throw r;
    const { status = 200, body = { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } } = r || {};
    return { status, ok: status < 300, headers: { get: (h) => (h === "request-id" ? "req_FAKE" : null) }, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
function billing(env = {}, deps = {}) {
  const config = fromEnv({ STRIPE_SECRET_KEY: "sk_test_FAKE", STRIPE_WEBHOOK_SECRET: SECRET, ...env });
  return createBilling(config, { store: memoryStore(), fetch: fakeFetch(), log: quiet, now: () => T0 * 1000, ...deps });
}
const checkoutInput = (body, ip = "203.0.113.1") => ({ body, ip, baseUrl: "https://calensync.example", headers: {} });
const formOf = (call) => new URLSearchParams(call.init.body);
function sign(raw, { t = T0, secret = SECRET } = {}) {
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return { t, sig, header: `t=${t},v1=${sig}` };
}
const event = (type, object, over = {}) => ({ id: `evt_${crypto.randomBytes(6).toString("hex")}`, object: "event", type, created: T0, livemode: false, data: { object }, ...over });

// ---------------------------------------------------------------------------------------------------------------------
test("Konfiguration: Test-, Live- und kaputte Schlüssel", () => {
  const off = fromEnv({}).billing;
  assert.deepStrictEqual([off.enabled, off.error], [false, ""], "ohne Variablen schlicht aus");

  const t = fromEnv({ STRIPE_SECRET_KEY: "sk_test_FAKE", STRIPE_WEBHOOK_SECRET: SECRET }).billing;
  assert.deepStrictEqual([t.enabled, t.test, t.error], [true, true, ""]);

  const liveNoFlag = fromEnv({ STRIPE_SECRET_KEY: "sk_live_FAKE", STRIPE_WEBHOOK_SECRET: SECRET }).billing;
  assert.strictEqual(liveNoFlag.enabled, false, "Live-Schlüssel ohne STRIPE_LIVE=1 sperrt");
  assert.match(liveNoFlag.error, /STRIPE_LIVE/);
  assert.ok(!liveNoFlag.error.includes("sk_live_FAKE") && !liveNoFlag.secretKey, "Fehlertext ohne Schlüssel");
  assert.strictEqual(fromEnv({ STRIPE_SECRET_KEY: "sk_live_FAKE", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_LIVE: "true" }).billing.enabled, false, "nur exakt \"1\"");

  const live = fromEnv({ STRIPE_SECRET_KEY: "sk_live_FAKE", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_LIVE: "1" }).billing;
  assert.deepStrictEqual([live.enabled, live.test], [true, false]);
  assert.strictEqual(fromEnv({ STRIPE_SECRET_KEY: "sk_test_FAKE", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_LIVE: "1" }).billing.test, true);

  for (const bad of ["pk_test_FAKE", "sk_FAKE", "whsec_FAKE", "sk_test_", "sk_test_FA KE"]) {
    const c = fromEnv({ STRIPE_SECRET_KEY: bad, STRIPE_WEBHOOK_SECRET: SECRET }).billing;
    assert.strictEqual(c.enabled, false, bad);
    assert.match(c.error, /Format/, bad);
  }
  const noWh = fromEnv({ STRIPE_SECRET_KEY: "sk_test_FAKE" }).billing;
  assert.strictEqual(noWh.enabled, false);
  assert.match(noWh.error, /STRIPE_WEBHOOK_SECRET/);
  assert.match(fromEnv({ STRIPE_WEBHOOK_SECRET: SECRET }).billing.error, /STRIPE_SECRET_KEY fehlt/);

  const flags = fromEnv({ STRIPE_SECRET_KEY: "sk_test_FAKE", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_REQUIRE_TOS: "1", STRIPE_AUTOMATIC_TAX: "1" }).billing;
  assert.deepStrictEqual([flags.requireTos, flags.automaticTax], [true, true]);
});

test("Konfiguration: Fehler wird geloggt, /config verrät keine Schlüssel", () => {
  const cap = captureLog();
  const b = createBilling(fromEnv({ STRIPE_SECRET_KEY: "sk_live_FAKE", STRIPE_WEBHOOK_SECRET: SECRET }), { store: memoryStore(), log: cap });
  assert.ok(cap.lines.some((l) => l.includes("STRIPE_LIVE")));
  assert.deepStrictEqual(b.publicConfig().body, { enabled: false, test: false });
  const ok = billing().publicConfig();
  assert.deepStrictEqual(ok.body, { enabled: true, test: true });
  assert.ok(!JSON.stringify(ok).includes("sk_") && !JSON.stringify(ok).includes("whsec_"));
});

test("Preistabelle entspricht plans.json", () => {
  const plans = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "2-packages-platform", "packages", "platform", "config", "plans.json"), "utf8"));
  assert.strictEqual(plans.currency, "EUR");
  for (const id of ["professional", "business"]) {
    assert.strictEqual(PLAN_PRICES[id].priceCentsMonthly, plans.plans[id].priceCentsMonthly, `${id} monatlich`);
    assert.strictEqual(PLAN_PRICES[id].priceCentsYearly, plans.plans[id].priceCentsYearly, `${id} jährlich`);
    assert.strictEqual(plans.plans[id].seatModel, "per-host");
    assert.strictEqual(PLAN_PRICES[id].name, `CalenSync ${plans.plans[id].name}`);
  }
  assert.deepStrictEqual(Object.keys(PLAN_PRICES).sort(), ["business", "professional"], "Starter/Enterprise nicht per Checkout");
  assert.deepStrictEqual([unitAmount("professional", "month"), unitAmount("professional", "year"), unitAmount("business", "month"), unitAmount("business", "year")], [1500, 14400, 2400, 22800]);
});

test("Formular-Kodierung mit Klammern", () => {
  assert.strictEqual(encodeForm({ a: { b: [{ c: 1, d: true }] }, e: "x y&z", f: undefined, g: null }), "a[b][0][c]=1&a[b][0][d]=true&e=x%20y%26z");
  assert.strictEqual(encodeForm({ u: "https://x/y?s={CHECKOUT_SESSION_ID}" }), "u=https%3A%2F%2Fx%2Fy%3Fs%3D%7BCHECKOUT_SESSION_ID%7D");
});

test("checkout: Anfrage an Stripe (monatlich, Professional)", async () => {
  const f = fakeFetch();
  const b = billing({}, { fetch: f });
  const r = await b.checkout(checkoutInput({ plan: "professional", interval: "month" }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.strictEqual(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.strictEqual(url, "https://api.stripe.com/v1/checkout/sessions");
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.headers.Authorization, "Bearer sk_test_FAKE");
  assert.strictEqual(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(init.headers["Idempotency-Key"], /^checkout-[0-9a-f-]{36}$/);
  assert.ok(init.body.includes("line_items[0][price_data][currency]=eur"), "Klammern unkodiert");
  const p = formOf(f.calls[0]);
  const expected = {
    mode: "subscription",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": "CalenSync Professional",
    "line_items[0][price_data][unit_amount]": "1500",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][tax_behavior]": "exclusive",
    "line_items[0][quantity]": "1",
    "line_items[0][adjustable_quantity][enabled]": "true",
    "line_items[0][adjustable_quantity][minimum]": "1",
    "line_items[0][adjustable_quantity][maximum]": "50",
    billing_address_collection: "required",
    "tax_id_collection[enabled]": "true",
    locale: "de",
    allow_promotion_codes: "true",
    "metadata[plan]": "professional", "metadata[interval]": "month", "metadata[source]": "website",
    "subscription_data[metadata][plan]": "professional", "subscription_data[metadata][interval]": "month", "subscription_data[metadata][source]": "website",
    success_url: "https://calensync.example/checkout/erfolg?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://calensync.example/preise?checkout=abgebrochen",
  };
  for (const [k, v] of Object.entries(expected)) assert.strictEqual(p.get(k), v, k);
  const msg = p.get("custom_text[submit][message]");
  assert.match(msg, /zahlungspflichtig/);
  assert.match(msg, /pro Host/);
  assert.match(msg, /Mehrwertsteuer/);
  assert.ok(msg.length <= 1200);
  for (const absent of ["customer_email", "consent_collection[terms_of_service]", "automatic_tax[enabled]"]) assert.strictEqual(p.get(absent), null, absent);
  // Keine Preise vom Browser, nichts Unerwartetes
  assert.deepStrictEqual([...p.keys()].filter((k) => !(k in expected) && k !== "custom_text[submit][message]"), []);
});

test("checkout: jährlich, Business, Sitze, E-Mail, ToS und Stripe Tax", async () => {
  const f = fakeFetch();
  const b = billing({ STRIPE_REQUIRE_TOS: "1", STRIPE_AUTOMATIC_TAX: "1" }, { fetch: f });
  const r = await b.checkout(checkoutInput({ plan: "business", interval: "year", seats: 7, email: " Chefin@Firma.DE " }));
  assert.strictEqual(r.status, 200);
  const p = formOf(f.calls[0]);
  assert.strictEqual(p.get("line_items[0][price_data][unit_amount]"), "22800");
  assert.strictEqual(p.get("line_items[0][price_data][recurring][interval]"), "year");
  assert.strictEqual(p.get("line_items[0][price_data][product_data][name]"), "CalenSync Business");
  assert.strictEqual(p.get("line_items[0][quantity]"), "7");
  assert.strictEqual(p.get("customer_email"), "chefin@firma.de");
  assert.strictEqual(p.get("consent_collection[terms_of_service]"), "required");
  assert.strictEqual(p.get("automatic_tax[enabled]"), "true");
  assert.strictEqual(p.get("metadata[interval]"), "year");
  assert.match(p.get("custom_text[submit][message]"), /jährlich/);
  // jede Anfrage eigener Idempotency-Key
  await b.checkout(checkoutInput({ plan: "business", interval: "year" }));
  assert.notStrictEqual(f.calls[0].init.headers["Idempotency-Key"], f.calls[1].init.headers["Idempotency-Key"]);
});

test("checkout: Eingaben werden streng geprüft", async () => {
  const f = fakeFetch();
  const b = billing({}, { fetch: f });
  const cases = [
    [null, "invalid_body"], [[], "invalid_body"], ["professional", "invalid_body"],
    [{ plan: "starter", interval: "month" }, "invalid_plan"], [{ plan: "enterprise", interval: "month" }, "invalid_plan"],
    [{ plan: "__proto__", interval: "month" }, "invalid_plan"], [{ plan: "Professional", interval: "month" }, "invalid_plan"],
    [{ interval: "month" }, "invalid_plan"],
    [{ plan: "professional" }, "invalid_interval"], [{ plan: "professional", interval: "yearly" }, "invalid_interval"],
    [{ plan: "professional", interval: "month", seats: 0 }, "invalid_seats"], [{ plan: "professional", interval: "month", seats: 51 }, "invalid_seats"],
    [{ plan: "professional", interval: "month", seats: 2.5 }, "invalid_seats"], [{ plan: "professional", interval: "month", seats: "3" }, "invalid_seats"],
    [{ plan: "professional", interval: "month", email: "kein-mail" }, "invalid_email"], [{ plan: "professional", interval: "month", email: 42 }, "invalid_email"],
    [{ plan: "professional", interval: "month", unit_amount: 1 }, "invalid_field"], [{ plan: "professional", interval: "month", price: "price_x" }, "invalid_field"],
  ];
  for (const [body, error] of cases) {
    const r = await b.checkout(checkoutInput(body));
    assert.deepStrictEqual([r.status, r.body.error], [422, error], JSON.stringify(body));
  }
  assert.strictEqual(f.calls.length, 0, "ungültige Eingaben erreichen Stripe nie");
  assert.strictEqual((await b.checkout(checkoutInput({ plan: "professional", interval: "month", seats: 50, email: "" }))).status, 200);
  assert.strictEqual((await b.checkout({ body: { plan: "professional", interval: "month" }, ip: "x", baseUrl: "" })).body.error, "base_url_missing");
});

test("checkout: 503 ohne Konfiguration, kein Stripe-Aufruf", async () => {
  const f = fakeFetch();
  for (const env of [{}, { STRIPE_SECRET_KEY: "sk_live_FAKE", STRIPE_WEBHOOK_SECRET: SECRET }]) {
    const b = createBilling(fromEnv(env), { store: memoryStore(), fetch: f, log: quiet });
    const r = await b.checkout(checkoutInput({ plan: "professional", interval: "month" }));
    assert.deepStrictEqual([r.status, r.body.error], [503, "billing_disabled"]);
  }
  assert.strictEqual(f.calls.length, 0);
});

test("checkout: Rate-Limit je IP", async () => {
  const f = fakeFetch();
  const b = billing({}, { fetch: f });
  for (let i = 0; i < 10; i++) assert.strictEqual((await b.checkout(checkoutInput({ plan: "professional", interval: "month" }, "198.51.100.7"))).status, 200);
  const r = await b.checkout(checkoutInput({ plan: "professional", interval: "month" }, "198.51.100.7"));
  assert.deepStrictEqual([r.status, r.body.error, r.headers["Retry-After"]], [429, "rate_limited", "600"]);
  assert.strictEqual((await b.checkout(checkoutInput({ plan: "professional", interval: "month" }, "198.51.100.8"))).status, 200, "andere IP nicht betroffen");
  assert.strictEqual(f.calls.length, 11);
});

test("checkout: Stripe-Fehler → sichere Codes, keine Meldungen oder Schlüssel", async () => {
  const leak = { error: { type: "invalid_request_error", code: "api_key_invalid", message: "Invalid API Key provided: sk_test_FAKE" } };
  const cases = [
    [[{ status: 401, body: leak }], 503, "billing_unavailable", 1],
    [[{ status: 403, body: leak }], 503, "billing_unavailable", 1],
    [[{ status: 429, body: leak }], 503, "billing_busy", 1],
    [[{ status: 400, body: { error: { type: "invalid_request_error", param: "line_items", message: "secret detail sk_test_FAKE" } } }], 502, "checkout_failed", 1],
    [[{ status: 500, body: leak }, { status: 500, body: leak }], 502, "stripe_unavailable", 2],
    [[{ status: 502, body: {} }, { status: 200 }], 200, undefined, 2],
    [[new TypeError("fetch failed"), new TypeError("fetch failed")], 502, "stripe_unavailable", 2],
    [[Object.assign(new Error("t"), { name: "TimeoutError" })], 502, "stripe_unavailable", 1],
    [[{ status: 200, body: { id: "cs_1", url: "https://evil.example/pay" } }], 502, "checkout_failed", 1],
    [[{ status: 200, body: { id: "cs_1" } }], 502, "checkout_failed", 1],
  ];
  for (const [responses, status, error, calls] of cases) {
    const f = fakeFetch(responses);
    const cap = captureLog();
    const b = billing({}, { fetch: f, log: cap });
    const r = await b.checkout(checkoutInput({ plan: "professional", interval: "month" }));
    assert.strictEqual(r.status, status, JSON.stringify(responses));
    assert.strictEqual(r.body.error, error);
    assert.strictEqual(f.calls.length, calls, "höchstens ein Wiederholversuch");
    if (calls === 2) assert.strictEqual(f.calls[0].init.headers["Idempotency-Key"], f.calls[1].init.headers["Idempotency-Key"], "Wiederholung mit demselben Key");
    const out = JSON.stringify(r);
    assert.ok(!/sk_test|Invalid API Key|secret detail|evil/.test(out), out);
    assert.ok(!cap.lines.some((l) => /sk_test|Invalid API Key|secret detail/.test(l)), "auch das Log enthält keine Stripe-Meldungen");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test("Signatur: gültig, falsch, abgelaufen, mehrere v1, kaputt", () => {
  const raw = Buffer.from('{"id":"evt_1","type":"x"}');
  const { header, sig } = sign(raw);
  assert.ok(verifyStripeSignature(raw, header, SECRET, T0).ok);
  assert.ok(verifyStripeSignature(raw, header, SECRET, T0 + 300).ok, "Grenze 300 s");
  assert.strictEqual(verifyStripeSignature(raw, header, SECRET, T0 + 301).reason, "expired");
  assert.strictEqual(verifyStripeSignature(raw, header, "whsec_OTHER", T0).reason, "mismatch");
  assert.strictEqual(verifyStripeSignature(Buffer.from('{"id":"evt_1", "type":"x"}'), header, SECRET, T0).reason, "mismatch", "ein Leerzeichen mehr");
  assert.strictEqual(verifyStripeSignature(raw, `t=${T0 + 1},v1=${sig}`, SECRET, T0).reason, "mismatch", "Zeitstempel ist Teil der Signatur");
  const other = "0".repeat(64);
  assert.ok(verifyStripeSignature(raw, `t=${T0},v1=${other},v1=${sig},v0=abc`, SECRET, T0).ok, "eine passende v1 genügt");
  assert.ok(verifyStripeSignature(raw, `t=${T0}, v1=${sig.toUpperCase()}`, SECRET, T0).ok);
  assert.strictEqual(verifyStripeSignature(raw, `t=${T0},v0=${sig}`, SECRET, T0).reason, "malformed", "nur v1 zählt");
  for (const bad of ["", "v1=" + sig, `t=abc,v1=${sig}`, `t=${T0},v1=${sig.slice(2)}`, "garbage"]) assert.ok(!verifyStripeSignature(raw, bad, SECRET, T0).ok, bad);
  assert.ok(!verifyStripeSignature(raw, undefined, SECRET, T0).ok);
  assert.ok(!verifyStripeSignature(raw.toString(), header, SECRET, T0).ok, "nur Buffer");
});

test("webhook: 503 ohne Konfiguration, 400 bei falscher Signatur oder fehlendem Roh-Body", async () => {
  const raw = Buffer.from(JSON.stringify(event("customer.subscription.created", { id: "sub_1" })));
  const off = createBilling(fromEnv({}), { store: memoryStore(), log: quiet });
  assert.strictEqual((await off.webhook({ rawBody: raw, headers: { "stripe-signature": sign(raw).header } })).status, 503);
  const b = billing();
  assert.deepStrictEqual((await b.webhook({ rawBody: raw, headers: {} })).body, { error: "invalid_signature" });
  assert.strictEqual((await b.webhook({ rawBody: raw, headers: { "stripe-signature": sign(raw, { secret: "whsec_OTHER" }).header } })).status, 400);
  assert.strictEqual((await b.webhook({ rawBody: raw, headers: { "stripe-signature": sign(raw, { t: T0 - 301 }).header } })).status, 400);
  assert.deepStrictEqual((await b.webhook({ rawBody: null, headers: { "stripe-signature": sign(raw).header } })).body, { error: "raw_body_unavailable" });
  const notJson = Buffer.from("nope");
  assert.deepStrictEqual((await b.webhook({ rawBody: notJson, headers: { "stripe-signature": sign(notJson).header } })).body, { error: "invalid_json" });
  const noId = Buffer.from('{"type":"x"}');
  assert.deepStrictEqual((await b.webhook({ rawBody: noId, headers: { "stripe-signature": sign(noId).header } })).body, { error: "invalid_event" });
});

async function deliver(b, ev) {
  const raw = Buffer.from(JSON.stringify(ev));
  return b.webhook({ rawBody: raw, headers: { "stripe-signature": sign(raw).header } });
}

test("webhook: Datensatz je Abo, Ereignisliste, Reihenfolge, unbekannte Ereignisse", async () => {
  const store = memoryStore();
  const b = billing({}, { store });
  const sub = { id: "sub_A1", object: "subscription", customer: "cus_C1", status: "incomplete", metadata: { plan: "business", interval: "year", source: "website" },
    items: { data: [{ quantity: 3, price: { recurring: { interval: "year" } } }] } };
  assert.strictEqual((await deliver(b, event("customer.subscription.created", sub))).status, 200);
  const session = { id: "cs_test_S1", object: "checkout.session", mode: "subscription", customer: "cus_C1", subscription: "sub_A1",
    customer_details: { email: "Chefin@Firma.de", name: "Erika Muster", address: { city: "Köln" } }, metadata: { plan: "business", interval: "year", source: "website" } };
  assert.deepStrictEqual((await deliver(b, event("checkout.session.completed", session, { created: T0 + 1 }))).body, { received: true, handled: true });
  await deliver(b, event("customer.subscription.updated", { ...sub, status: "active", items: { data: [{ quantity: 4 }] } }, { created: T0 + 5 }));
  // verspätetes, älteres Ereignis überschreibt den Status nicht
  await deliver(b, event("customer.subscription.updated", { ...sub, status: "incomplete" }, { created: T0 + 2 }));
  let rec = await store.getJson(`${RECORD_PREFIX}sub_A1`);
  assert.deepStrictEqual(
    { subscriptionId: rec.subscriptionId, customerId: rec.customerId, status: rec.status, plan: rec.plan, interval: rec.interval, quantity: rec.quantity, email: rec.email },
    { subscriptionId: "sub_A1", customerId: "cus_C1", status: "active", plan: "business", interval: "year", quantity: 4, email: "chefin@firma.de" },
  );
  assert.strictEqual(rec.updated, new Date(T0 * 1000).toISOString());
  assert.ok(!JSON.stringify(rec).includes("Muster") && !JSON.stringify(rec).includes("Köln"), "nur die Minimalfelder");

  // Neue API-Version: Abo-ID unter parent.subscription_details
  await deliver(b, event("invoice.payment_failed", { id: "in_1", customer: "cus_C1", parent: { subscription_details: { subscription: "sub_A1" } } }, { created: T0 + 6 }));
  rec = await store.getJson(`${RECORD_PREFIX}sub_A1`);
  assert.strictEqual(rec.lastPaymentFailedAt, new Date((T0 + 6) * 1000).toISOString());
  await deliver(b, event("invoice.payment_failed", { id: "in_2", customer: "cus_C2", subscription: "sub_B2", customer_email: "b@firma.de" }));
  assert.strictEqual((await store.getJson(`${RECORD_PREFIX}sub_B2`)).email, "b@firma.de");

  await deliver(b, event("customer.subscription.deleted", { ...sub, status: "canceled" }, { created: T0 + 9 }));
  assert.strictEqual((await store.getJson(`${RECORD_PREFIX}sub_A1`)).status, "canceled");

  const unknown = await deliver(b, event("charge.refunded", { id: "ch_1" }));
  assert.deepStrictEqual([unknown.status, unknown.body.handled], [200, false]);
  // Checkout ohne Abo (z. B. Einmalzahlung) → nichts gespeichert, trotzdem 200
  assert.strictEqual((await deliver(b, event("checkout.session.completed", { id: "cs_x", mode: "payment" }))).status, 200);

  const list = await store.listRange(LOG_KEY, 50);
  assert.strictEqual(list.length, 8, "unbekannte Ereignisse nicht in der Liste");
  assert.deepStrictEqual(list[0], { at: new Date(T0 * 1000).toISOString(), type: "checkout.session.completed", subscriptionId: null, status: null, plan: null });
  assert.deepStrictEqual(Object.keys(list[1]).sort(), ["at", "plan", "status", "subscriptionId", "type"]);
  assert.ok(!JSON.stringify(list).includes("@"), "keine E-Mail-Adressen in der Liste");
});

test("webhook: idempotent je Ereignis-ID, Fehler beim Verarbeiten → erneute Zustellung möglich", async () => {
  const store = memoryStore();
  const b = billing({}, { store });
  const ev = event("customer.subscription.created", { id: "sub_I1", customer: "cus_I1", status: "active", metadata: { plan: "professional", interval: "month" } });
  assert.deepStrictEqual((await deliver(b, ev)).body, { received: true, handled: true });
  assert.deepStrictEqual((await deliver(b, ev)).body, { received: true, duplicate: true });
  assert.strictEqual((await store.listRange(LOG_KEY, 50)).length, 1);

  const broken = { ...memoryStore(), async setJson() { throw new Error("redis down"); } };
  const b2 = billing({}, { store: broken });
  await assert.rejects(deliver(b2, ev), /redis down/);   // Adapter macht daraus 500 → Stripe wiederholt
});

// ---------------------------------------------------------------------------------------------------------------------
// Roh-Body durch den echten HTTP-Adapter
// ---------------------------------------------------------------------------------------------------------------------
function listen(handler) {
  return new Promise((resolve) => { const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(srv)); });
}
function request(port, { method = "POST", path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
// Bytes, die ein JSON.parse/stringify-Durchlauf verändern würde: Leerzeichen, Zeilenumbrüche, Unicode-Escapes, Umlaute
function trickyBody(id) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(`{\n  "id": "${id}",  "object":"event",\n  "type": "customer.subscription.created", "created": ${now},\n  "data": {"object": {"id": "sub_${id.slice(4)}", "customer": "cus_X", "status": "active", "metadata": {"plan": "professional", "interval": "month", "note": "M\\u00fcller – Köln"}, "items": {"data": [{"quantity": 2}]}}}\n}\n`, "utf8");
}
const liveSign = (raw) => sign(raw, { t: Math.floor(Date.now() / 1000) }).header;

test("Roh-Body: node:http (Standalone/Dev-Server) über apiHandler", async () => {
  const srv = await listen((req, res) => apiHandler(req, res));
  const { port } = srv.address();
  try {
    const raw = trickyBody("evt_node1");
    const ok = await request(port, { path: "/api/billing/webhook", headers: { "Content-Type": "application/json; charset=utf-8", "Stripe-Signature": liveSign(raw) }, body: raw });
    assert.deepStrictEqual([ok.status, JSON.parse(ok.body)], [200, { received: true, handled: true }]);
    const dup = await request(port, { path: "/api/billing/webhook", headers: { "Content-Type": "application/json", "Stripe-Signature": liveSign(raw) }, body: raw });
    assert.deepStrictEqual(JSON.parse(dup.body), { received: true, duplicate: true });
    const reser = Buffer.from(JSON.stringify(JSON.parse(trickyBody("evt_node2").toString())));
    const bad = await request(port, { path: "/api/billing/webhook", headers: { "Content-Type": "application/json", "Stripe-Signature": liveSign(trickyBody("evt_node2")) }, body: reser });
    assert.deepStrictEqual([bad.status, JSON.parse(bad.body).error], [400, "invalid_signature"], "neu serialisierter Body fällt durch");
    const get = await request(port, { method: "GET", path: "/api/billing/webhook" });
    assert.strictEqual(get.status, 405);
    const cfg = await request(port, { method: "GET", path: "/api/billing/config" });
    assert.deepStrictEqual(JSON.parse(cfg.body), { enabled: true, test: true });
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    assert.strictEqual(stored.kv[`${RECORD_PREFIX}sub_node1`].value.quantity, 2);
  } finally { srv.close(); }
});

/**
 * Nachbildung von @vercel/node (serverless-functions/helpers.ts, addHelpers): Body vorab lesen, req.body als
 * Lazy-Getter, Stream per restoreBody für 'data'/'end'-Listener wiederherstellen, req.query als Lazy-Getter.
 */
async function vercelize(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const replicate = new PassThrough();
  const on = replicate.on.bind(replicate), originalOn = req.on.bind(req);
  req.read = replicate.read.bind(replicate);
  req.on = req.addListener = (name, cb) => (name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb));
  replicate.write(body); replicate.end();
  const lazy = (prop, getter) => Object.defineProperty(req, prop, { configurable: true, enumerable: true, get: () => { const v = getter(); Object.defineProperty(req, prop, { configurable: true, enumerable: true, writable: true, value: v }); return v; } });
  let parsed = 0;
  lazy("body", () => { parsed++; return JSON.parse(body.toString()); });
  lazy("query", () => ({ action: new URL(req.url, "http://x").pathname.split("/").pop() }));
  return () => parsed;
}

test("Roh-Body: Vercel-Funktion api/billing/[action].js mit vorgelesenem Body", async () => {
  let parsedCount;
  const srv = await listen(async (req, res) => { parsedCount = await vercelize(req); billingFn(req, res); });
  const { port } = srv.address();
  try {
    const raw = trickyBody("evt_vercel1");
    const ok = await request(port, { path: "/api/billing/webhook", headers: { "Content-Type": "application/json", "Stripe-Signature": liveSign(raw) }, body: raw });
    assert.deepStrictEqual([ok.status, JSON.parse(ok.body)], [200, { received: true, handled: true }]);
    assert.strictEqual(parsedCount(), 0, "req.body (geparst) wurde nicht angefasst");
    const tampered = Buffer.from(raw.toString().replace('"quantity": 2', '"quantity": 9'));
    const bad = await request(port, { path: "/api/billing/webhook", headers: { "Content-Type": "application/json", "Stripe-Signature": liveSign(raw) }, body: tampered });
    assert.strictEqual(bad.status, 400);
    // Checkout über dieselbe Funktion (normaler JSON-Body, fetch gefälscht)
    const realFetch = global.fetch;
    const f = fakeFetch();
    global.fetch = f;
    try {
      const co = await request(port, { path: "/api/billing/checkout", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: "business", interval: "month" }) });
      assert.deepStrictEqual([co.status, JSON.parse(co.body)], [200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }]);
      assert.strictEqual(formOf(f.calls[0]).get("success_url"), "https://calensync.example/checkout/erfolg?session_id={CHECKOUT_SESSION_ID}");
    } finally { global.fetch = realFetch; }
    assert.strictEqual((await request(port, { method: "GET", path: "/api/billing/nix" })).status, 404);
    const wrong = await request(port, { method: "GET", path: "/api/billing/checkout" });
    assert.strictEqual(wrong.status, 405);
  } finally { srv.close(); }
});

test("Roh-Body: Express-Varianten und Grenzen", async () => {
  assert.strictEqual(await readRawBody({ body: { id: "evt_1" }, headers: {} }), null, "schon geparst → nicht prüfbar");
  assert.deepStrictEqual(await readRawBody({ body: Buffer.from("abc"), headers: {} }), Buffer.from("abc"), "express.raw()");
  assert.deepStrictEqual(await readRawBody({ rawBody: Buffer.from("xyz"), body: { a: 1 }, headers: {} }), Buffer.from("xyz"), "verify-Hook");
  const big = new PassThrough();
  const p = readRawBody(big, 10);
  big.write(Buffer.alloc(11)); big.end();
  assert.strictEqual(await p, null, "zu groß");
  // geparster Express-Body landet im Webhook als 400 statt als falsche Prüfung
  const b = billing();
  const raw = await readRawBody({ body: { id: "evt_1" }, headers: {} });
  assert.strictEqual((await b.webhook({ rawBody: raw, headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) } })).status, 400);
});

test.after(() => { try { fs.unlinkSync(DATA_FILE); } catch {} });
