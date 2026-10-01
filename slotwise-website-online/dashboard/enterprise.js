/* CalenSync Enterprise – Anbindung der Website an das Mandanten-Backend (3-enterprise/).
 *
 * Aktiv nur, wenn in site-config.js CALENSYNC_API, ENTRA_TENANT_ID, ENTRA_SPA_CLIENT_ID und CALENSYNC_API_SCOPE gesetzt sind.
 * Sonst passiert nichts: MSAL wird nicht geladen, die Karte „Microsoft 365“ bleibt verborgen.
 *
 * Anmeldung: Microsoft Entra ID per MSAL (Authorization Code + PKCE, Redirect-Flow). Kein Secret im Browser.
 * Die ganze Anmeldung läuft über /auth/callback (Redirect-URI der SPA-App). Tokens liegen im sessionStorage.
 * Die API bekommt sie als Bearer-Header – keine Cookies, daher kein CSRF und kein credentials: "include".
 *
 * API (app/src/statusApi.ts im Backend):
 *   GET  /api/v1/me/sync-status                         Scope Sync.Read
 *   GET  /api/v1/me/sync-targets                        Scope Sync.Read   (erlaubte Ziele: zweites Konto, Team, Buchungsseite)
 *   POST /api/v1/me/pipelines  (Header Idempotency-Key)  Scope Sync.Write  (Body: target, mode, busyLabel)
 * Alles, was vom Server kommt (Labels, Postfächer, Fehlercodes), wird als nicht vertrauenswürdig behandelt und escaped.
 * Der Client hier ist eine Portierung von 3-enterprise/frontend/calensyncApi.ts ohne Build-Schritt.
 */
(function () {
  "use strict";

  const env = window.SLOTWISE_ENV || {};
  const cfg = {
    api: String(env.CALENSYNC_API || "").trim().replace(/\/+$/, ""),
    tenantId: String(env.ENTRA_TENANT_ID || "").trim(),
    clientId: String(env.ENTRA_SPA_CLIENT_ID || "").trim(),
    scopes: [env.CALENSYNC_API_SCOPE, env.CALENSYNC_API_WRITE_SCOPE].map((s) => String(s || "").trim()).filter(Boolean),
  };
  const configured = Boolean(cfg.api && cfg.tenantId && cfg.clientId && cfg.scopes.length);
  const canWrite = Boolean(String(env.CALENSYNC_API_WRITE_SCOPE || "").trim());
  const RETURN_KEY = "calensync.enterprise.return";
  const ACCESS_KEY = "calensync.demo.access"; // gleiche Freischaltung wie gate.js
  const redirectUri = `${location.origin}/auth/callback`;

  // ------------------------------------------------------------------------------------------------
  // MSAL (lokal unter /vendor, nur bei Bedarf geladen)
  // ------------------------------------------------------------------------------------------------
  let msalReady = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error(`${src} nicht geladen`));
      document.head.appendChild(s);
    });
  }
  function msalApp() {
    if (!msalReady) {
      msalReady = (async () => {
        if (!window.msal) await loadScript("/vendor/msal-browser.min.js");
        const app = new window.msal.PublicClientApplication({
          auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}`, redirectUri, postLogoutRedirectUri: `${location.origin}/dashboard/` },
          cache: { cacheLocation: "sessionStorage" },
        });
        await app.initialize();
        const result = await app.handleRedirectPromise();
        if (result && result.account) app.setActiveAccount(result.account);
        return { app, result };
      })();
    }
    return msalReady;
  }
  const accountOf = (app) => app.getActiveAccount() || app.getAllAccounts()[0] || null;

  function login(returnTo) {
    try { sessionStorage.setItem(RETURN_KEY, returnTo || "/dashboard/"); } catch (_) {}
    location.assign("/auth/callback?login=1");
  }

  async function logout() {
    const { app } = await msalApp();
    const account = accountOf(app);
    if (account) return app.logoutRedirect({ account });
    location.reload();
  }

  // ------------------------------------------------------------------------------------------------
  // API-Client
  // ------------------------------------------------------------------------------------------------
  class CalensyncApiError extends Error {
    constructor(kind, message, status = null, requestId = null, code = null) {
      super(message);
      this.name = "CalensyncApiError"; this.kind = kind; this.status = status; this.requestId = requestId; this.code = code;
    }
  }

  // Nur eigene Schlüssel nachschlagen: Codes kommen vom Server ("constructor", "__proto__" dürfen nichts finden)
  const lookup = (map, key) => (typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);

  /** Fehlercodes von POST /me/pipelines (400/422) → Meldung im Formular */
  const REQUEST_ERRORS = {
    target_required: "Bitte wählen Sie aus, wohin Ihr Kalender abgeglichen werden soll.",
    target_not_allowed: "Dieses Ziel ist für Ihr Konto nicht freigegeben. Bitte wählen Sie ein anderes Ziel.",
    invalid_target: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    target_invalid: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    target_kind_invalid: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    target_team_id_invalid: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    target_mailbox_invalid: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    target_entra_tenant_id_invalid: "Das gewählte Ziel ist ungültig. Bitte schließen Sie das Formular und öffnen Sie es erneut.",
    idempotency_key_reused: "Zu diesem Vorgang gibt es schon eine Anfrage mit anderen Angaben. Bitte brechen Sie ab und laden Sie den Status neu.",
    busyLabel_length_1_64: "Der Titel muss 1 bis 64 Zeichen lang sein.",
    busyLabel_invalid_characters: "Der Titel enthält unzulässige Zeichen.",
    busyLabel_only_for_busy: "Ein Titel ist nur bei „Nur belegt“ möglich.",
    mode_must_be_busy_or_full: "Bitte wählen Sie, was im Zielkalender stehen soll.",
  };

  /** lastError einer Pipeline (Code aus dem Backend) → lesbare Meldung; unbekannt → der Code selbst */
  const PIPELINE_ERRORS = {
    target_not_allowed: "Das Ziel ist nicht mehr freigegeben.",
    // Codes des Sync-Workers (core/src/syncWorker.ts, FailureCategory)
    target_missing: "Das Ziel ist nicht mehr hinterlegt.",
    scope_propagation: "Die Freigabe wird gerade bei Microsoft wirksam – der Abgleich wird automatisch wiederholt.",
    transient: "Vorübergehender Fehler – der Abgleich wird automatisch wiederholt.",
    token: "Die Anmeldung bei Microsoft 365 wird erneuert – der Abgleich wird automatisch wiederholt.",
    blocked_scope: "Kein Zugriff auf das Zielpostfach – bitte die IT um Freigabe bitten.",
    config: "Konfigurationsfehler – bitte an Ihre IT wenden.",
    invalid_request: "Microsoft 365 hat den Abgleich abgelehnt – bitte an Ihre IT wenden.",
    exhausted: "Abgleich nach mehreren Versuchen abgebrochen – bitte an Ihre IT wenden.",
    target_not_found: "Der Zielkalender existiert nicht mehr.",
    mailbox_not_found: "Das Zielpostfach wurde nicht gefunden.",
    calendar_not_found: "Der Kalender wurde nicht gefunden.",
    access_denied: "Kein Zugriff auf den Kalender – bitte die IT um Freigabe bitten.",
    consent_required: "Die Freigabe durch Ihre IT fehlt noch.",
    token_expired: "Die Verbindung zum Konto ist abgelaufen.",
    throttled: "Microsoft drosselt gerade die Anfragen – der Abgleich wird automatisch wiederholt.",
    upstream_unavailable: "Microsoft 365 war nicht erreichbar – der Abgleich wird automatisch wiederholt.",
    timeout: "Zeitüberschreitung beim Abgleich – wird automatisch wiederholt.",
    subscription_failed: "Benachrichtigungen konnten nicht eingerichtet werden.",
    quota_exceeded: "Das Zielpostfach ist voll.",
    internal_error: "Interner Fehler bei CalenSync.",
  };
  const pipelineErrorMessage = (code) => lookup(PIPELINE_ERRORS, code) || `Fehler: ${String(code).slice(0, 80)}`;

  const TARGET_KINDS = { account: "Zweites Konto", team: "Team-Kalender", booking: "Buchungsseite" };
  /** "Zweites Konto: Tochter GmbH", "Team-Kalender: Vertrieb", "Buchungsseite" */
  function targetLabel(t) {
    if (!t || typeof t !== "object") return "Kalender-Abgleich";
    const kind = lookup(TARGET_KINDS, t.kind);
    const label = typeof t.label === "string" ? t.label.trim().slice(0, 120) : "";
    if (!kind) return label || "Kalender-Abgleich";
    return t.kind === "booking" || !label ? kind : `${kind}: ${label}`;
  }

  /** Nur die Felder, die der Server erwartet (kein Durchreichen fremder Eigenschaften) */
  function targetBody(t) {
    if (!t) return undefined;
    if (t.kind === "account") return { kind: "account", mailbox: t.mailbox, entraTenantId: t.entraTenantId || null };
    if (t.kind === "team") return { kind: "team", teamId: t.teamId };
    if (t.kind === "booking") return { kind: "booking" };
    return { kind: t.kind };
  }

  async function getAccessToken({ forceRefresh }) {
    const { app } = await msalApp();
    const account = accountOf(app);
    if (!account) throw new CalensyncApiError("unauthenticated", "Nicht angemeldet");
    try {
      return (await app.acquireTokenSilent({ scopes: cfg.scopes, account, forceRefresh })).accessToken;
    } catch (err) {
      if (err instanceof window.msal.InteractionRequiredAuthError) throw new CalensyncApiError("unauthenticated", "Anmeldung abgelaufen");
      throw err;
    }
  }

  function createApi(o) {
    const base = o.apiBaseUrl.replace(/\/+$/, "");
    if (!base.startsWith("https://") && !base.startsWith("http://localhost")) throw new Error("CALENSYNC_API muss https sein");
    const doFetch = o.fetchFn || fetch.bind(globalThis);
    const timeoutMs = o.timeoutMs || 10000;
    const maxRetries = o.maxRetries ?? 2;
    const backoff = async (attempt, retryAfter) => {
      const ra = Number(retryAfter);
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs * (0.85 + Math.random() * 0.3)));
    };

    // GET wiederholt 429/503. POST nur mit Idempotency-Key – dann sind Wiederholungen sicher.
    async function request(path, post) {
      let forceRefresh = false;
      for (let attempt = 0; ; attempt++) {
        const token = await o.getAccessToken({ forceRefresh });
        const requestId = crypto.randomUUID();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const headers = { Authorization: `Bearer ${token}`, "X-Request-Id": requestId };
        if (post) { headers["Content-Type"] = "application/json"; headers["Idempotency-Key"] = post.idempotencyKey; }
        let res;
        try {
          res = await doFetch(`${base}${path}`, { method: post ? "POST" : "GET", mode: "cors", credentials: "omit", headers, body: post ? post.body : undefined, signal: ctrl.signal });
        } catch (err) {
          if (post && attempt < maxRetries) { await backoff(attempt, null); continue; }
          if (ctrl.signal.aborted) throw new CalensyncApiError("timeout", "Zeitüberschreitung beim Abruf", null, requestId);
          throw new CalensyncApiError("network", "Keine Verbindung zur CalenSync-API (Netzwerk oder CORS)", null, requestId);
        } finally {
          clearTimeout(timer);
        }
        const rid = res.headers.get("x-request-id") || requestId;
        if (res.ok) return { body: await res.json(), res };
        if (res.status === 401 && !forceRefresh) { forceRefresh = true; continue; }
        if ((res.status === 429 || res.status === 503) && attempt < maxRetries) { await backoff(attempt, res.headers.get("retry-after")); continue; }
        const code = await res.json().then((b) => (b && typeof b.error === "string" ? b.error.slice(0, 80) : "")).catch(() => "");
        switch (res.status) {
          case 401: throw new CalensyncApiError("unauthenticated", "Anmeldung abgelaufen", 401, rid);
          case 403: throw new CalensyncApiError("forbidden", code === "origin_not_allowed" ? "Diese Website ist für die API nicht freigegeben" : "Keine Berechtigung", 403, rid);
          case 404: throw new CalensyncApiError("not_provisioned", "Ihr Konto ist noch nicht für CalenSync freigeschaltet", 404, rid);
          case 409: throw new CalensyncApiError("limit_reached", "Maximale Anzahl verbundener Kalender erreicht", 409, rid);
          case 400: case 413: case 415: case 422: throw new CalensyncApiError("invalid_request", (lookup(REQUEST_ERRORS, code) || (code.startsWith("unknown_field:target") ? REQUEST_ERRORS.invalid_target : null)) || `Eingabe abgelehnt (${code || res.status})`, res.status, rid, code || null);
          case 429: case 503: throw new CalensyncApiError("unavailable", "CalenSync ist gerade ausgelastet – bitte gleich erneut versuchen", res.status, rid);
          default: throw new CalensyncApiError("unexpected", `Unerwartete Antwort ${res.status}`, res.status, rid);
        }
      }
    }

    return {
      getSyncStatus: async () => (await request("/api/v1/me/sync-status")).body,
      getSyncTargets: async () => (await request("/api/v1/me/sync-targets")).body,
      // idempotencyKey pro Nutzeraktion EINMAL erzeugen und bei „Erneut versuchen“ wiederverwenden
      createPipeline: async (req, idempotencyKey = crypto.randomUUID()) => {
        const target = targetBody(req.target);
        const body = JSON.stringify(req.mode === "busy" && req.busyLabel !== undefined ? { target, mode: "busy", busyLabel: req.busyLabel } : { target, mode: req.mode });
        const r = await request("/api/v1/me/pipelines", { body, idempotencyKey });
        return { ...r.body, replayed: r.res.headers.get("idempotent-replayed") === "true" };
      },
    };
  }

  window.CalenSyncEnterprise = { configured, cfg, login, logout, msalApp, createApi, getAccessToken, CalensyncApiError, targetLabel, pipelineErrorMessage };
  if (!configured) return;

  // ------------------------------------------------------------------------------------------------
  // /auth/callback: Anmeldung starten bzw. Rückkehr von Microsoft verarbeiten
  // ------------------------------------------------------------------------------------------------
  const onCallback = /^\/auth\/callback\/?$/.test(location.pathname);
  if (onCallback) {
    const msg = document.getElementById("cb-message");
    const back = () => { let to = "/dashboard/"; try { to = sessionStorage.getItem(RETURN_KEY) || to; sessionStorage.removeItem(RETURN_KEY); } catch (_) {} return /^\/[^/]/.test(to) ? to : "/dashboard/"; };
    msalApp().then(async ({ app, result }) => {
      if (result && result.account) {
        try { localStorage.setItem(ACCESS_KEY, JSON.stringify({ at: new Date().toISOString(), via: "entra" })); } catch (_) {}
        return location.replace(back());
      }
      if (new URLSearchParams(location.search).get("login") === "1" && !accountOf(app)) return app.loginRedirect({ scopes: cfg.scopes, prompt: "select_account" });
      location.replace(back());
    }).catch((err) => {
      console.error("[enterprise] Anmeldung:", err);
      if (msg) msg.textContent = `Die Anmeldung mit Microsoft hat nicht geklappt (${err.errorCode || err.message}).`;
      const retry = document.getElementById("cb-retry");
      if (retry) retry.hidden = false;
    });
    return;
  }

  // ------------------------------------------------------------------------------------------------
  // Dashboard: Karte „Microsoft 365“
  // ------------------------------------------------------------------------------------------------
  const box = document.getElementById("microsoft-365");
  if (!box) return;
  box.hidden = false;
  const body = document.getElementById("m365-body");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
  const fmtDate = (iso) => { const d = typeof iso === "string" ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? fmt.format(d) : null; };
  const api = createApi({ apiBaseUrl: cfg.api, getAccessToken });

  const STATUS = {
    active: ["Aktiv", "border-emerald-200 bg-emerald-50 text-emerald-800"],
    pending: ["Wird eingerichtet", "border-slate-200 bg-slate-50 text-slate-700"],
    pending_scope: ["Freigabe fehlt", "border-amber-200 bg-amber-50 text-amber-900"],
    paused: ["Pausiert", "border-slate-200 bg-slate-50 text-slate-700"],
    revoked: ["Entzogen", "border-red-200 bg-red-50 text-red-800"],
    blocked_scope: ["Postfach gesperrt", "border-red-200 bg-red-50 text-red-800"],
    config_error: ["Konfigurationsfehler", "border-red-200 bg-red-50 text-red-800"],
    error: ["Fehler", "border-red-200 bg-red-50 text-red-800"],
  };
  const badge = (s) => { const [label, cls] = lookup(STATUS, s) || [String(s ?? "–"), "border-slate-200 bg-slate-50 text-slate-700"]; return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}">${esc(label)}</span>`; };

  const $ = (sel) => box.querySelector(sel);
  // Zustand des offenen „Kalender verbinden“-Formulars
  let pendingKey = null;      // Idempotency-Key – bei „Erneut versuchen“ mit gleichen Angaben derselbe
  let lastSent = null;        // zuletzt mit diesem Key gesendete Nutzlast
  let lastDefinitive = false; // letzter Fehler war eine klare Ablehnung (es wurde nichts angelegt)
  let targets = null;         // erlaubte Ziele aus /me/sync-targets, normalisiert
  let formSeq = 0;            // verwirft verspätete Antworten, wenn das Formular inzwischen geschlossen wurde
  const newButton = `<button type="button" class="btn-ghost" data-m365-new>Kalender verbinden</button>`;
  // Ablehnungen, nach denen der Server sicher nichts angelegt hat → bei geänderten Angaben neuer Key erlaubt
  const DEFINITIVE = new Set(["invalid_request", "limit_reached", "forbidden", "not_provisioned"]);

  /** Antwort von /me/sync-targets in Auswahloptionen übersetzen (Form prüfen, nichts blind übernehmen) */
  function normalizeTargets(t) {
    t = t && typeof t === "object" ? t : {};
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const accountAllowed = Boolean(t.account && t.account.allowed === true);
    const accounts = accountAllowed && Array.isArray(t.account.suggestions)
      ? t.account.suggestions.filter((x) => x && str(x.mailbox, 320)).slice(0, 50)
        .map((x) => ({ kind: "account", mailbox: str(x.mailbox, 320), entraTenantId: str(x.entraTenantId, 64) || null, label: str(x.label, 120) || str(x.mailbox, 320) }))
      : [];
    const teams = (Array.isArray(t.team) ? t.team : []).filter((x) => x && str(x.id, 128)).slice(0, 100)
      .map((x) => ({ kind: "team", teamId: str(x.id, 128), label: str(x.label, 120) || str(x.id, 128) }));
    const booking = Boolean(t.booking && t.booking.enabled === true);
    return { accountAllowed, accounts, teams, booking, any: accounts.length > 0 || teams.length > 0 || booking };
  }
  /** Radio-Wert → Ziel. Werte sind Indizes ("a0", "t1", "b"), damit keine Serverdaten in Attributen landen. */
  function pickTarget(v) {
    if (!targets) return null;
    if (v === "b") return targets.booking ? { kind: "booking" } : null;
    const m = /^([at])(\d{1,3})$/.exec(String(v || ""));
    if (!m) return null;
    return (m[1] === "a" ? targets.accounts : targets.teams)[Number(m[2])] || null;
  }

  function renderSignedOut(note) {
    body.innerHTML = `
      <p class="text-sm text-slate-600">Melden Sie sich mit Ihrem Microsoft-Konto an, um den Abgleich Ihres Outlook-Kalenders zu sehen und einzurichten.</p>
      ${note ? `<p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">${esc(note)}</p>` : ""}
      <button type="button" class="btn-primary mt-4" data-m365-login>Mit Microsoft anmelden</button>`;
  }

  const errorBox = (err) => `
      <p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">${esc((err && err.message) || "Unbekannter Fehler")}</p>
      ${err && err.requestId ? `<p class="mt-2 text-xs text-slate-500">Anfrage-ID für den Support: <code class="tabular break-words">${esc(err.requestId)}</code></p>` : ""}`;

  function renderError(err) {
    if (err && err.kind === "unauthenticated") return renderSignedOut(err.message === "Nicht angemeldet" ? "" : "Ihre Anmeldung ist abgelaufen.");
    body.innerHTML = `${errorBox(err)}
      <div class="mt-4 flex flex-wrap gap-2"><button type="button" class="btn-ghost" data-m365-reload>Erneut versuchen</button><button type="button" class="btn-ghost" data-m365-logout>Abmelden</button></div>`;
  }

  function pipelineItem(p) {
    const sub = p.subscription && p.subscription.active
      ? `Benachrichtigungen aktiv${fmtDate(p.subscription.expiresAt) ? ` bis ${esc(fmtDate(p.subscription.expiresAt))}` : ""}`
      : "Benachrichtigungen noch nicht aktiv";
    const synced = "lastSyncedAt" in p ? (fmtDate(p.lastSyncedAt) ? `Zuletzt abgeglichen: ${esc(fmtDate(p.lastSyncedAt))}` : "Noch nicht abgeglichen") : "";
    const lastError = typeof p.lastError === "string" && p.lastError ? pipelineErrorMessage(p.lastError) : "";
    return `<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" data-m365-pipeline>
            <span class="min-w-0"><span class="block break-words font-medium text-slate-900">${esc(targetLabel(p.target))}</span>
            <span class="block text-xs text-slate-500">${sub}</span>
            ${synced ? `<span class="block text-xs text-slate-500" data-m365-synced>${synced}</span>` : ""}
            ${lastError ? `<span class="block break-words text-xs text-red-700" data-m365-lasterror>${esc(lastError)}</span>` : ""}</span>
            ${badge(p.status)}</li>`;
  }

  function renderStatus(status, account) {
    const list = status && Array.isArray(status.pipelines) ? status.pipelines.filter((p) => p && typeof p === "object") : [];
    body.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span class="min-w-0 truncate text-slate-700">Angemeldet als <b class="text-slate-900">${esc((account && (account.username || account.name)) || "–")}</b></span>
        <button type="button" class="text-xs font-medium text-slate-500 hover:text-slate-900" data-m365-logout>Abmelden</button>
      </div>
      ${status && status.user && status.user.active === false ? `<p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Ihr Konto ist gesperrt. Bitte wenden Sie sich an Ihre IT.</p>` : ""}
      <ul class="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">
        ${list.length ? list.map(pipelineItem).join("") : `<li class="px-4 py-6 text-center text-sm text-slate-500">Noch kein Kalender verbunden.</li>`}
      </ul>
      ${canWrite ? `<div class="mt-4" id="m365-create">${pendingKey && targets && targets.any ? createForm() : newButton}</div>` : ""}`;
  }

  const radio = (value, checked, text, hint, disabled) => `
          <label class="mt-1 flex items-start gap-2 text-sm ${disabled ? "text-slate-400" : "text-slate-700"}"><input type="radio" name="syncTarget" value="${esc(value)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} class="mt-1 accent-indigo-600">
            <span class="min-w-0"><span class="block break-words">${esc(text)}</span>${hint ? `<span class="block break-words text-xs text-slate-500">${esc(hint)}</span>` : ""}</span></label>`;

  function targetFieldset(sel) {
    const t = targets;
    const single = t.accounts.length + t.teams.length + (t.booking ? 1 : 0) === 1; // nur eine Möglichkeit → vorausgewählt
    const isSel = (v) => sel === v || (!sel && single);
    const group = (title, inner) => `<div class="mt-3"><p class="text-xs font-semibold text-slate-500">${title}</p>${inner}</div>`;
    return `
        <fieldset>
          <legend class="text-sm font-medium text-slate-800">Wohin soll Ihr Kalender abgeglichen werden?</legend>
          ${t.accountAllowed ? group("Zweites Konto", t.accounts.length
            ? t.accounts.map((a, i) => radio(`a${i}`, isSel(`a${i}`), a.label, a.mailbox !== a.label ? a.mailbox : "")).join("")
            : radio("", false, "Kein zweites Konto hinterlegt", "Ihre IT hat noch kein Zielkonto für Sie eingetragen. Bitte wenden Sie sich an sie.", true)) : ""}
          ${t.teams.length ? group("Team-Kalender", t.teams.map((x, i) => radio(`t${i}`, isSel(`t${i}`), x.label, "")).join("")) : ""}
          ${t.booking ? group("Buchungsseite", radio("b", isSel("b"), "Buchungsseite", "Zu belegten Zeiten bietet Ihre Buchungsseite keine Termine an.")) : ""}
        </fieldset>`;
  }

  function createForm(error, v = { target: "", mode: "busy", busyLabel: "Termin" }) {
    return `
      <form id="m365-form" class="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4" novalidate>
        ${targetFieldset(v.target)}
        <fieldset>
          <legend class="mb-2 text-sm font-medium text-slate-800">Was soll im Zielkalender stehen?</legend>
          <label class="flex items-start gap-2 text-sm text-slate-700"><input type="radio" name="mode" value="busy" ${v.mode !== "full" ? "checked" : ""} class="mt-1 accent-indigo-600"> <span>Nur „belegt“ mit eigenem Titel (empfohlen)</span></label>
          <label class="mt-1 flex items-start gap-2 text-sm text-slate-700"><input type="radio" name="mode" value="full" ${v.mode === "full" ? "checked" : ""} class="mt-1 accent-indigo-600"> <span>Termine vollständig übertragen</span></label>
        </fieldset>
        <label class="block"><span class="mb-1 block text-xs font-medium text-slate-700">Titel für belegte Zeiten</span>
          <input name="busyLabel" class="field" maxlength="64" value="${esc(v.busyLabel)}" autocomplete="off"></label>
        ${error ? `<p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">${esc(error)}</p>` : ""}
        <div class="flex gap-2"><button type="submit" class="btn-primary">Verbinden</button><button type="button" class="btn-ghost" data-m365-cancel>Abbrechen</button></div>
      </form>`;
  }

  function noTargetsNote() {
    const why = targets && targets.accountAllowed
      ? "Ein zweites Konto ist zwar erlaubt, aber Ihre IT hat noch kein Zielkonto für Sie eingetragen."
      : "Für Ihr Konto ist noch kein Ziel freigegeben – weder ein zweites Konto noch ein Team-Kalender oder die Buchungsseite.";
    return `
      <div class="rounded-xl border border-slate-100 bg-slate-50/60 p-4 text-sm text-slate-600" data-m365-notargets>
        <p>${esc(why)} Bitte wenden Sie sich an Ihre IT.</p>
        <button type="button" class="btn-ghost mt-3" data-m365-cancel>Schließen</button>
      </div>`;
  }

  function closeForm() {
    pendingKey = null; lastSent = null; lastDefinitive = false; targets = null; formSeq++;
    const slot = $("#m365-create");
    if (slot) slot.innerHTML = newButton;
  }

  async function openForm() {
    const seq = ++formSeq;
    pendingKey = crypto.randomUUID(); lastSent = null; lastDefinitive = false; targets = null;
    const slot = $("#m365-create");
    slot.innerHTML = `<p class="text-sm text-slate-500">Lade mögliche Ziele …</p>`;
    let t;
    try { t = await api.getSyncTargets(); } catch (err) {
      if (seq !== formSeq) return;
      pendingKey = null;
      if (err && err.kind === "unauthenticated") return renderError(err);
      slot.innerHTML = `${errorBox(err)}<div class="mt-3 flex flex-wrap gap-2"><button type="button" class="btn-ghost" data-m365-new>Erneut versuchen</button><button type="button" class="btn-ghost" data-m365-cancel>Abbrechen</button></div>`;
      return;
    }
    if (seq !== formSeq) return; // inzwischen abgebrochen oder neu geöffnet
    targets = normalizeTargets(t);
    slot.innerHTML = targets.any ? createForm() : noTargetsNote();
  }

  async function refresh() {
    body.innerHTML = `<p class="text-sm text-slate-500">Lade Status …</p>`;
    let app;
    try { ({ app } = await msalApp()); } catch (err) { console.error("[enterprise] MSAL:", err); return renderError({ message: "Die Microsoft-Anmeldung konnte nicht geladen werden." }); }
    const account = accountOf(app);
    if (!account) return renderSignedOut();
    try { renderStatus(await api.getSyncStatus(), account); } catch (err) { renderError(err); }
  }

  box.addEventListener("click", (e) => {
    if (e.target.closest("[data-m365-login]")) return login(location.pathname + location.search + location.hash);
    if (e.target.closest("[data-m365-logout]")) return logout();
    if (e.target.closest("[data-m365-reload]")) return refresh();
    if (e.target.closest("[data-m365-new]")) return openForm();
    if (e.target.closest("[data-m365-cancel]")) return closeForm();
  });
  box.addEventListener("submit", async (e) => {
    if (e.target.id !== "m365-form") return;
    e.preventDefault();
    const f = e.target, mode = f.querySelector("input[name=mode]:checked") ? f.querySelector("input[name=mode]:checked").value : "busy";
    const label = f.busyLabel.value.trim();
    const chosen = f.querySelector("input[name=syncTarget]:checked");
    const v = { target: chosen ? chosen.value : "", mode, busyLabel: label };
    const target = pickTarget(v.target);
    const again = (msg) => { $("#m365-create").innerHTML = createForm(msg, v); };
    if (!target) return again("Bitte wählen Sie aus, wohin Ihr Kalender abgeglichen werden soll.");
    if (mode === "busy" && (!label || /[\u0000-\u001f<>]/.test(label))) return again("Bitte einen Titel mit 1 bis 64 Zeichen ohne Sonderzeichen wie < oder > angeben.");
    const req = mode === "busy" ? { target, mode, busyLabel: label } : { target, mode };
    // Gleiche Angaben → gleicher Key (keine Doppelanlage). Neuer Key nur, wenn der Server den letzten Versuch klar
    // abgelehnt hat UND die Angaben geändert wurden – sonst lehnt er den alten Key als idempotency_key_reused ab.
    const payload = JSON.stringify({ t: targetBody(target), mode, label: mode === "busy" ? label : null });
    if (lastSent !== null && lastSent !== payload && lastDefinitive) pendingKey = crypto.randomUUID();
    lastSent = payload;
    const seq = formSeq;
    const btn = f.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Verbinde …";
    try {
      await api.createPipeline(req, pendingKey);
      pendingKey = null; lastSent = null; targets = null; formSeq++;
      refresh(); // auch wenn inzwischen „Abbrechen“ geklickt wurde: angelegt ist angelegt
    } catch (err) {
      if (seq !== formSeq) return;
      lastDefinitive = DEFINITIVE.has(err && err.kind) && !(err && err.code === "idempotency_key_reused");
      if (err && err.kind === "unauthenticated") return renderError(err);
      again((err && err.message) || "Unbekannter Fehler"); // Eingaben bleiben erhalten
    }
  });
  refresh();
})();
