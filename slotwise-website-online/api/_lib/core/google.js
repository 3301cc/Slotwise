"use strict";
/*
 * „Google Kalender verbinden“ – OAuth 2.0 und Calendar API, unabhängig von Vercel, Express oder node:http (wie core/billing.js).
 *
 *   connect     POST /api/google/connect     (Bearer) → { url }   Start: Authorization Code + PKCE (S256) + state
 *   callback    GET  /api/google/callback    Rücksprung von Google → 302 /dashboard/?google=connected
 *                                                                  bzw. /dashboard/?google=error&reason=<code>
 *   status      GET  /api/google/status      (Bearer) → { enabled, connected, email?, connectedAt?, lastError?, writeEvents? }
 *   disconnect  POST /api/google/disconnect  (Bearer) → Widerruf bei Google (best effort) + Löschen → { ok, revoked }
 *
 * Redirect-URI (exakt so in der Google Cloud Console eintragen): `${SITE_URL}/api/google/callback`.
 * Aus (503 { enabled: false }), solange GOOGLE_CLIENT_SECRET, SITE_URL, WAITLIST_SECRET oder ein Store fehlen.
 *
 * Sicherheit:
 *   - state: 32 Zufallsbytes, serverseitig im Store (Schlüssel = SHA-256 des state, TTL 10 min), an den Mandanten gebunden,
 *     genau einmal einlösbar (atomarer Zähler). Dazu ein HttpOnly-Cookie (SameSite=Lax, Pfad /api/google, 10 min), dessen
 *     Hash im state-Datensatz steht: Ein fremder Verbindungslink (state eines anderen Mandanten) funktioniert in einem Browser,
 *     der den Ablauf nicht selbst gestartet hat, nicht – sonst könnte jemand sein Konto mit dem Kalender eines Opfers verbinden.
 *   - PKCE: code_verifier bleibt serverseitig im state-Datensatz, Google bekommt nur die S256-Challenge.
 *   - Refresh-Token: AES-256-GCM, Schlüssel per HKDF-SHA256 aus WAITLIST_SECRET (info "slotwise-google-token-v1"), AAD =
 *     Mandant – ein Chiffrat lässt sich nicht in den Datenraum eines anderen Mandanten kopieren. Access-Tokens nur im
 *     Arbeitsspeicher (je Prozess), Erneuerung ~60 s vor Ablauf.
 *   - E-Mail-Adresse aus dem id_token der direkten TLS-Antwort des Token-Endpunkts (laut Google ohne Signaturprüfung zulässig,
 *     weil der Token direkt von Google kommt); geprüft werden iss, aud und exp.
 *   - Logs und Weiterleitungen enthalten nie Tokens, Codes, das Client-Secret oder Googles Fehlertexte – nur kurze Codes.
 *
 * Bereiche (Scopes): openid, email, calendar.freebusy (Belegt-Abgleich, Pflicht) und calendar.events.owned (Termine im eigenen
 * Kalender anlegen und löschen; „primary“ gehört dem Konto selbst). events.owned ist enger als calendar.events: kein Zugriff
 * auf fremde, nur geteilte Kalender. Lässt jemand events.owned bei der Zustimmung weg, bleibt der Belegt-Abgleich aktiv und
 * es werden nur keine Termine eingetragen (writeEvents: false).
 */
const crypto = require("node:crypto");
const { scopedStore } = require("./tenants");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL_API = "https://www.googleapis.com/calendar/v3";

const SCOPE_FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
const SCOPE_EVENTS = "https://www.googleapis.com/auth/calendar.events.owned";
const SCOPES = ["openid", "email", SCOPE_FREEBUSY, SCOPE_EVENTS];
const KNOWN_SCOPES = new Set([...SCOPES, "https://www.googleapis.com/auth/userinfo.email"]);

const STATE_TTL_SEC = 600;
const TOKEN_TIMEOUT_MS = 5000;
const FREEBUSY_TIMEOUT_MS = 3000;
const EVENT_TIMEOUT_MS = 4000;
const REVOKE_TIMEOUT_MS = 5000;
const REFRESH_MARGIN_MS = 60_000;

const CONN_KEY = "google:conn";
const STATE_PREFIX = "google:state:";
const STATE_USED_PREFIX = "google:state-used:";
const COOKIE = "sw_google_oauth";
const HKDF_INFO = "slotwise-google-token-v1";
const DASHBOARD = "/dashboard/";

const json = (status, body, headers) => ({ status, body, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------------
// Verschlüsselung des Refresh-Tokens
// ---------------------------------------------------------------------------------------------------------------------
function tokenKey(secret) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(String(secret), "utf8"), Buffer.alloc(0), HKDF_INFO, 32));
}
/** → "v1.<iv>.<tag>.<chiffrat>" (base64url). aad bindet das Chiffrat an den Mandanten. */
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
/** Wirft bei falschem Schlüssel, falschem Mandanten oder verändertem Chiffrat. */
function unseal(key, sealed, aad) {
  const [v, iv, tag, ct] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Chiffrat ungültig");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
const aadFor = (tenantId) => `google:${tenantId}`;

// ---------------------------------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------------------------------
/** Kurzer, unbedenklicher Fehlercode aus einer Google-Antwort (nie der Meldungstext). */
function codeOf(data) {
  if (data && typeof data.error === "string" && /^[a-z_]{1,40}$/.test(data.error)) return data.error;
  if (data && data.error && typeof data.error.status === "string" && /^[A-Z_]{1,40}$/.test(data.error.status)) return data.error.status;
  return "unknown";
}
const errName = (e) => (e && /^[A-Za-z]{1,40}$/.test(String(e.name)) ? e.name : "Error");

/** id_token-Nutzlast der direkten Token-Antwort: iss, aud, exp prüfen; nur die E-Mail-Adresse wird übernommen. */
function idTokenClaims(idToken, clientId, nowMs) {
  if (typeof idToken !== "string" || idToken.length > 8192) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p !== "object") return null;
  if (p.iss !== "https://accounts.google.com" && p.iss !== "accounts.google.com") return null;
  if (!(p.aud === clientId || (Array.isArray(p.aud) && p.aud.includes(clientId)))) return null;
  if (!Number.isFinite(p.exp) || p.exp * 1000 < nowMs - 300_000) return null; // 5 min Uhrenversatz
  const email = typeof p.email === "string" && p.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(p.email) && p.email_verified !== false
    ? p.email.toLowerCase() : null;
  return { email };
}

function cookieValue(headers, name) {
  const raw = String((headers && headers.cookie) || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** Zeitbegrenzter Abruf: Timer gilt für Antwort UND Body; eigener Timer statt AbortSignal.timeout() (wie calendar.js). */
async function timedFetch(fetchFn, url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout nach ${ms} ms`)), ms);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal, redirect: "error" });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const formHeaders = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
// Termin-ID für Google: base32hex (a–v, 0–9), 5–1024 Zeichen. Aus der Buchung abgeleitet → ein erneuter Versuch legt keinen
// zweiten Termin an (409), und die ID ist auch ohne gespeicherte Antwort bekannt.
const eventIdFor = (tenantId, bookingId) => `sl${sha256hex(`${tenantId}|${bookingId}`).slice(0, 32)}`;

// ---------------------------------------------------------------------------------------------------------------------
function createGoogle(config, deps = {}) {
  const g = config.google || { clientId: "", clientSecret: "", error: "" };
  const store = deps.store || null;
  const log = deps.log || console;
  const info = typeof log.log === "function" ? (...a) => log.log(...a) : () => {};
  const now = deps.now || (() => Date.now());
  const fetchFn = deps.fetch || ((...a) => fetch(...a));
  const siteUrl = String(config.siteUrl || "");
  const tenants = config.tenants || [];

  const siteOk = /^https:\/\/[^/\s]+$/.test(siteUrl) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl);
  const storeOk = Boolean(store) && (Boolean(config.redis) || !config.deployed);
  const missing = [];
  if (!g.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!siteOk) missing.push("SITE_URL (https)");
  if (!config.secret) missing.push("WAITLIST_SECRET");
  if (!storeOk) missing.push("KV_REST_API_URL/KV_REST_API_TOKEN");
  const enabled = Boolean(g.clientId) && missing.length === 0;
  if (g.error) log.error("[google]", g.error);
  else if (g.clientSecret && !enabled) log.error(`[google] Google Kalender aus – es fehlt: ${missing.join(", ")}`);

  const redirectUri = `${siteUrl}/api/google/callback`;
  const key = enabled ? tokenKey(config.secret) : null;
  const cookieAttrs = `Path=/api/google; HttpOnly; SameSite=Lax${siteUrl.startsWith("https://") ? "; Secure" : ""}`;
  const clearCookie = `${COOKIE}=; Max-Age=0; ${cookieAttrs}`;

  const storeFor = (tenantId) => (tenantId === "default" ? store : scopedStore(store, tenantId));
  const tenantKnown = (id) => !config.tenantsError && (tenants.length ? tenants.some((t) => t.id === id) : id === "default");

  // Access-Tokens nur im Arbeitsspeicher: tenantId → { token, exp, gen } (gen = connectedAt; neue Verbindung → neuer Eintrag)
  const accessCache = new Map();
  const inflight = new Map();

  const disabled = () => json(503, { enabled: false });
  const done = (query) => ({ status: 302, redirect: `${DASHBOARD}?${query}`, headers: { "Set-Cookie": clearCookie } });
  const fail = (reason) => done(`google=error&reason=${reason}`);

  async function revoke(token) {
    try {
      const r = await timedFetch(fetchFn, REVOKE_URL, { method: "POST", headers: formHeaders, body: new URLSearchParams({ token }).toString() }, REVOKE_TIMEOUT_MS);
      if (r.status !== 200) log.error(`[google] Widerruf abgelehnt: HTTP ${r.status} ${codeOf(r.data)}`);
      return r.status === 200;
    } catch (e) {
      log.error(`[google] Widerruf nicht erreichbar: ${errName(e)}`);
      return false;
    }
  }

  /** state genau einmal einlösen: atomarer Zähler (INCR) entscheidet, wer zuerst kommt; Datensatz wird gelöscht. */
  async function consumeState(state) {
    const h = sha256hex(state);
    const first = (await store.incrWithTtl(STATE_USED_PREFIX + h, STATE_TTL_SEC, now())) === 1;
    const rec = await store.getJson(STATE_PREFIX + h, now());
    await store.delKey(STATE_PREFIX + h);
    if (!first || !rec || typeof rec !== "object" || !(Number(rec.exp) > now())) return null;
    return rec;
  }

  /** Zugriff widerrufen/abgelaufen: Verbindung als getrennt markieren (nur wenn inzwischen nicht neu verbunden wurde). */
  async function markReconnect(tenantId, s, rec) {
    accessCache.delete(tenantId);
    const cur = await s.getJson(CONN_KEY);
    if (!cur || cur.connectedAt !== rec.connectedAt) return;
    await s.setJson(CONN_KEY, { v: 1, connected: false, email: cur.email || null, connectedAt: cur.connectedAt, scopes: [], refreshToken: null, lastError: "reconnect_required", lastErrorAt: iso(now()) });
  }

  async function refresh(tenantId, s, rec) {
    let refreshToken;
    try { refreshToken = unseal(key, rec.refreshToken, aadFor(tenantId)); } catch {
      throw new Error("Google: gespeicherter Token nicht entschlüsselbar (WAITLIST_SECRET geändert?) – bitte neu verbinden");
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: g.clientId, client_secret: g.clientSecret }).toString();
    const r = await timedFetch(fetchFn, TOKEN_URL, { method: "POST", headers: formHeaders, body }, TOKEN_TIMEOUT_MS);
    if (r.status === 400 && codeOf(r.data) === "invalid_grant") {
      await markReconnect(tenantId, s, rec);
      throw new Error("Google: Zugriff widerrufen oder abgelaufen (invalid_grant) – Verbindung getrennt, bitte neu verbinden");
    }
    if (r.status !== 200 || !r.data || typeof r.data.access_token !== "string" || !r.data.access_token) {
      throw new Error(`Google-Token-Erneuerung: HTTP ${r.status} ${codeOf(r.data)}`);
    }
    const ttl = Math.min(Math.max(Number(r.data.expires_in) || 3600, 120), 86400);
    accessCache.set(tenantId, { token: r.data.access_token, exp: now() + ttl * 1000, gen: rec.connectedAt });
    // Google rotiert Refresh-Tokens normalerweise nicht; falls doch, den neuen verschlüsselt übernehmen
    if (typeof r.data.refresh_token === "string" && r.data.refresh_token && r.data.refresh_token !== refreshToken) {
      await s.setJson(CONN_KEY, { ...rec, refreshToken: seal(key, r.data.refresh_token, aadFor(tenantId)) });
    }
    return r.data.access_token;
  }

  async function accessToken(tenantId, s, rec) {
    const c = accessCache.get(tenantId);
    if (c && c.gen === rec.connectedAt && now() < c.exp - REFRESH_MARGIN_MS) return c.token;
    if (inflight.has(tenantId)) return inflight.get(tenantId); // parallele Anfragen teilen sich eine Erneuerung
    const p = refresh(tenantId, s, rec).finally(() => inflight.delete(tenantId));
    inflight.set(tenantId, p);
    return p;
  }

  /** Aufruf der Calendar API mit Access-Token; 401 verwirft das Token im Speicher (nächster Aufruf erneuert). */
  async function calendarCall(tenantId, s, rec, url, init, ms) {
    const token = await accessToken(tenantId, s, rec);
    const r = await timedFetch(fetchFn, url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: "application/json" } }, ms);
    if (r.status === 401) accessCache.delete(tenantId);
    return r;
  }

  /**
   * Kalender-Anbindung eines Mandanten für agent/calendar.js. null, wenn das Feature aus ist.
   *   connection() → null (nicht verbunden) | { key, writeEvents, freeBusy(minIso, maxIso), insertEvent(ev), deleteEvent(id) }
   * Alle Methoden werfen bei Fehlern (Timeout, HTTP, kaputte Antwort) – der Kalender entscheidet über fail-open/-closed.
   */
  function forTenant(tenantId) {
    if (!enabled) return null;
    const s = storeFor(tenantId);
    return {
      async connection() {
        const rec = await s.getJson(CONN_KEY);
        if (!rec || !rec.connected || !rec.refreshToken) return null;
        const scopes = Array.isArray(rec.scopes) ? rec.scopes : [];
        return {
          // Schlüssel für den Belegt-Zwischenspeicher: je Verbindung eindeutig (Hash des Chiffrats, zufälliger IV), ohne Token
          key: `${tenantId}|${sha256hex(String(rec.refreshToken)).slice(0, 16)}`,
          writeEvents: scopes.includes(SCOPE_EVENTS),

          /** Belegte Zeiten des Hauptkalenders → [{ start, end }] (Rohwerte; der Kalender prüft und normalisiert). */
          async freeBusy(timeMin, timeMax) {
            const r = await calendarCall(tenantId, s, rec, `${CAL_API}/freeBusy`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ timeMin, timeMax, timeZone: "UTC", items: [{ id: "primary" }] }),
            }, FREEBUSY_TIMEOUT_MS);
            if (r.status !== 200) throw new Error(`Google freeBusy: HTTP ${r.status} ${codeOf(r.data)}`);
            const cals = r.data && r.data.calendars && typeof r.data.calendars === "object" ? r.data.calendars : null;
            const vals = cals ? Object.values(cals) : [];
            const cal = cals && (cals.primary || (vals.length === 1 ? vals[0] : null));
            if (!cal || typeof cal !== "object") throw new Error("Google freeBusy: Antwort ohne Kalender");
            if (Array.isArray(cal.errors) && cal.errors.length) {
              const reason = cal.errors.map((e) => (e && /^[A-Za-z]{1,40}$/.test(String(e.reason)) ? e.reason : "unknown")).join(",");
              throw new Error(`Google freeBusy: Kalenderfehler ${reason}`);
            }
            if (!Array.isArray(cal.busy)) throw new Error("Google freeBusy: Antwort ohne busy[]");
            return cal.busy;
          },

          /** Termin im Hauptkalender anlegen → Google-Termin-ID, oder null ohne Schreibrecht (Scope abgewählt). */
          async insertEvent(ev) {
            if (!scopes.includes(SCOPE_EVENTS)) return null;
            const id = eventIdFor(tenantId, ev.bookingId);
            const r = await calendarCall(tenantId, s, rec, `${CAL_API}/calendars/primary/events?sendUpdates=none`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id,
                summary: ev.summary,
                description: ev.description,
                start: { dateTime: ev.start, timeZone: ev.timeZone },
                end: { dateTime: ev.end, timeZone: ev.timeZone },
                transparency: "opaque",
                visibility: "private",            // Freigaben des Kalenders sehen nur „beschäftigt“
                reminders: { useDefault: true },
                extendedProperties: { private: { slotwise: "1" } },
              }),
            }, EVENT_TIMEOUT_MS);
            if (r.status === 200) return r.data && typeof r.data.id === "string" ? r.data.id : id;
            if (r.status === 409) return id; // schon angelegt (Wiederholung)
            throw new Error(`Google events.insert: HTTP ${r.status} ${codeOf(r.data)}`);
          },

          /** Termin löschen; schon gelöscht (404/410) gilt als erledigt. */
          async deleteEvent(eventId) {
            if (!scopes.includes(SCOPE_EVENTS) || typeof eventId !== "string" || !/^[a-v0-9]{5,1024}$/.test(eventId)) return false;
            const r = await calendarCall(tenantId, s, rec, `${CAL_API}/calendars/primary/events/${eventId}?sendUpdates=none`, { method: "DELETE" }, EVENT_TIMEOUT_MS);
            if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) return true;
            throw new Error(`Google events.delete: HTTP ${r.status} ${codeOf(r.data)}`);
          },
        };
      },
    };
  }

  return {
    enabled,
    redirectUri,
    disabled,
    forTenant,

    /** POST (Bearer, Mandant bereits aufgelöst) → { url } + HttpOnly-Cookie, das den Ablauf an diesen Browser bindet. */
    async connect(_input, tenantId) {
      if (!enabled) return disabled();
      const state = b64u(crypto.randomBytes(32));
      const verifier = b64u(crypto.randomBytes(32));   // 43 Zeichen, RFC 7636
      const browser = b64u(crypto.randomBytes(32));
      await store.setJson(STATE_PREFIX + sha256hex(state), { tenantId, verifier, browser: sha256hex(browser), exp: now() + STATE_TTL_SEC * 1000 }, STATE_TTL_SEC, now());
      const u = new URL(AUTH_URL);
      u.searchParams.set("client_id", g.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES.join(" "));
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", b64u(sha256(verifier)));
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "true");
      return json(200, { url: u.toString() }, { "Set-Cookie": `${COOKIE}=${browser}; Max-Age=${STATE_TTL_SEC}; ${cookieAttrs}` });
    },

    /** GET ?code&state (oder ?error&state) von Google. Antwortet immer mit 302 ins Dashboard. */
    async callback({ query, headers }) {
      if (!enabled) return disabled();
      const q = query || {};
      const state = typeof q.state === "string" ? q.state : "";
      const rec = /^[A-Za-z0-9_-]{43}$/.test(state) ? await consumeState(state) : null;
      if (typeof q.error === "string" && q.error) return fail(q.error === "access_denied" ? "access_denied" : "google_error");
      if (!rec) return fail("invalid_state");
      const given = cookieValue(headers, COOKIE);
      const a = Buffer.from(given ? sha256hex(given) : ""), b = Buffer.from(String(rec.browser || ""));
      if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail("session_mismatch");
      if (!tenantKnown(rec.tenantId)) return fail("invalid_state");
      const code = typeof q.code === "string" ? q.code : "";
      if (!code || code.length > 2048) return fail("invalid_request");

      let r;
      try {
        r = await timedFetch(fetchFn, TOKEN_URL, {
          method: "POST",
          headers: formHeaders,
          body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: rec.verifier, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirectUri }).toString(),
        }, TOKEN_TIMEOUT_MS);
      } catch (e) {
        log.error(`[google] Token-Austausch nicht erreichbar: ${errName(e)}`);
        return fail("token_exchange_failed");
      }
      if (r.status !== 200 || !r.data || typeof r.data !== "object") {
        log.error(`[google] Token-Austausch abgelehnt: HTTP ${r.status} ${codeOf(r.data)}`);
        return fail("token_exchange_failed");
      }
      const t = r.data;
      const scopes = typeof t.scope === "string" ? t.scope.split(/\s+/).filter(Boolean) : [];
      const leftover = (typeof t.refresh_token === "string" && t.refresh_token) || (typeof t.access_token === "string" && t.access_token) || "";
      if (!scopes.includes(SCOPE_FREEBUSY)) {
        if (leftover) await revoke(leftover); // ohne Belegt-Abgleich nutzlos – Zugriff nicht offen lassen
        return fail("missing_scope");
      }
      if (typeof t.access_token !== "string" || !t.access_token) return fail("token_exchange_failed");
      if (typeof t.refresh_token !== "string" || !t.refresh_token) { await revoke(t.access_token); return fail("no_refresh_token"); }
      const claims = idTokenClaims(t.id_token, g.clientId, now());
      if (!claims) { await revoke(t.refresh_token); return fail("invalid_id_token"); }

      const connectedAt = iso(now());
      await storeFor(rec.tenantId).setJson(CONN_KEY, {
        v: 1,
        connected: true,
        email: claims.email,
        connectedAt,
        scopes: scopes.filter((x) => KNOWN_SCOPES.has(x)),
        refreshToken: seal(key, t.refresh_token, aadFor(rec.tenantId)),
        lastError: null,
      });
      const ttl = Math.min(Math.max(Number(t.expires_in) || 3600, 120), 86400);
      accessCache.set(rec.tenantId, { token: t.access_token, exp: now() + ttl * 1000, gen: connectedAt });
      info(`[google] Kalender verbunden (Mandant ${rec.tenantId}, Termine eintragen: ${scopes.includes(SCOPE_EVENTS) ? "ja" : "nein"})`);
      return done("google=connected");
    },

    async status(_input, tenantId) {
      if (!enabled) return disabled();
      const rec = await storeFor(tenantId).getJson(CONN_KEY);
      if (!rec) return json(200, { enabled: true, connected: false });
      const connected = Boolean(rec.connected && rec.refreshToken);
      const body = { enabled: true, connected };
      if (rec.email) body.email = rec.email;
      if (rec.connectedAt) body.connectedAt = rec.connectedAt;
      if (rec.lastError) body.lastError = rec.lastError;
      if (connected) body.writeEvents = Array.isArray(rec.scopes) && rec.scopes.includes(SCOPE_EVENTS);
      return json(200, body);
    },

    /** Trennen: Token bei Google widerrufen (best effort, Ergebnis in revoked) und Verbindung löschen. */
    async disconnect(_input, tenantId) {
      if (!enabled) return disabled();
      const s = storeFor(tenantId);
      const rec = await s.getJson(CONN_KEY);
      accessCache.delete(tenantId);
      let token = null;
      if (rec && rec.refreshToken) {
        try { token = unseal(key, rec.refreshToken, aadFor(tenantId)); } catch { log.error("[google] gespeicherter Token nicht entschlüsselbar – wird nur gelöscht"); }
      }
      await s.delKey(CONN_KEY);
      const revoked = token ? await revoke(token) : false;
      info(`[google] Kalender getrennt (Mandant ${tenantId}, widerrufen: ${revoked ? "ja" : "nein"})`);
      return json(200, { ok: true, revoked });
    },
  };
}

module.exports = {
  createGoogle, tokenKey, seal, unseal, idTokenClaims, eventIdFor,
  SCOPES, SCOPE_FREEBUSY, SCOPE_EVENTS, CONN_KEY, STATE_PREFIX, COOKIE, HKDF_INFO,
  TOKEN_URL, REVOKE_URL, AUTH_URL, CAL_API,
};
