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
 *   POST /api/v1/me/pipelines  (Header Idempotency-Key)  Scope Sync.Write
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
    constructor(kind, message, status = null, requestId = null) {
      super(message);
      this.name = "CalensyncApiError"; this.kind = kind; this.status = status; this.requestId = requestId;
    }
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
        const code = await res.json().then((b) => (b && b.error) || "").catch(() => "");
        switch (res.status) {
          case 401: throw new CalensyncApiError("unauthenticated", "Anmeldung abgelaufen", 401, rid);
          case 403: throw new CalensyncApiError("forbidden", code === "origin_not_allowed" ? "Diese Website ist für die API nicht freigegeben" : "Keine Berechtigung", 403, rid);
          case 404: throw new CalensyncApiError("not_provisioned", "Ihr Konto ist noch nicht für CalenSync freigeschaltet", 404, rid);
          case 409: throw new CalensyncApiError("limit_reached", "Maximale Anzahl verbundener Kalender erreicht", 409, rid);
          case 400: case 413: case 415: case 422: throw new CalensyncApiError("invalid_request", `Eingabe abgelehnt (${code || res.status})`, res.status, rid);
          case 429: case 503: throw new CalensyncApiError("unavailable", "CalenSync ist gerade ausgelastet – bitte gleich erneut versuchen", res.status, rid);
          default: throw new CalensyncApiError("unexpected", `Unerwartete Antwort ${res.status}`, res.status, rid);
        }
      }
    }

    return {
      getSyncStatus: async () => (await request("/api/v1/me/sync-status")).body,
      // idempotencyKey pro Nutzeraktion EINMAL erzeugen und bei „Erneut versuchen“ wiederverwenden
      createPipeline: async (req, idempotencyKey = crypto.randomUUID()) => {
        const body = JSON.stringify(req.mode === "busy" && req.busyLabel !== undefined ? { mode: "busy", busyLabel: req.busyLabel } : { mode: req.mode });
        const r = await request("/api/v1/me/pipelines", { body, idempotencyKey });
        return { ...r.body, replayed: r.res.headers.get("idempotent-replayed") === "true" };
      },
    };
  }

  window.CalenSyncEnterprise = { configured, cfg, login, logout, msalApp, createApi, getAccessToken, CalensyncApiError };
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
  const badge = (s) => { const [label, cls] = STATUS[s] || [s, "border-slate-200 bg-slate-50 text-slate-700"]; return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}">${esc(label)}</span>`; };

  const $ = (sel) => box.querySelector(sel);
  let pendingKey = null; // Idempotency-Key des offenen „Kalender verbinden“-Formulars

  function renderSignedOut(note) {
    body.innerHTML = `
      <p class="text-sm text-slate-600">Melden Sie sich mit Ihrem Microsoft-Konto an, um den Abgleich Ihres Outlook-Kalenders zu sehen und einzurichten.</p>
      ${note ? `<p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">${esc(note)}</p>` : ""}
      <button type="button" class="btn-primary mt-4" data-m365-login>Mit Microsoft anmelden</button>`;
  }

  function renderError(err) {
    if (err && err.kind === "unauthenticated") return renderSignedOut(err.message === "Nicht angemeldet" ? "" : "Ihre Anmeldung ist abgelaufen.");
    body.innerHTML = `
      <p class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">${esc((err && err.message) || "Unbekannter Fehler")}</p>
      ${err && err.requestId ? `<p class="mt-2 text-xs text-slate-500">Anfrage-ID für den Support: <code class="tabular">${esc(err.requestId)}</code></p>` : ""}
      <div class="mt-4 flex flex-wrap gap-2"><button type="button" class="btn-ghost" data-m365-reload>Erneut versuchen</button><button type="button" class="btn-ghost" data-m365-logout>Abmelden</button></div>`;
  }

  function renderStatus(status, account) {
    const list = (status && status.pipelines) || [];
    body.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span class="min-w-0 truncate text-slate-700">Angemeldet als <b class="text-slate-900">${esc((account && (account.username || account.name)) || "–")}</b></span>
        <button type="button" class="text-xs font-medium text-slate-500 hover:text-slate-900" data-m365-logout>Abmelden</button>
      </div>
      ${status && status.user && status.user.active === false ? `<p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Ihr Konto ist gesperrt. Bitte wenden Sie sich an Ihre IT.</p>` : ""}
      <ul class="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">
        ${list.length ? list.map((p) => `<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <span class="min-w-0"><span class="block font-medium text-slate-900">Kalender-Abgleich</span>
            <span class="block text-xs text-slate-500">${p.subscription && p.subscription.active ? `Benachrichtigungen aktiv${p.subscription.expiresAt ? ` bis ${esc(fmt.format(new Date(p.subscription.expiresAt)))}` : ""}` : "Benachrichtigungen noch nicht aktiv"}</span></span>
            ${badge(p.status)}</li>`).join("") : `<li class="px-4 py-6 text-center text-sm text-slate-500">Noch kein Kalender verbunden.</li>`}
      </ul>
      ${canWrite ? `<div class="mt-4" id="m365-create">${pendingKey ? createForm() : `<button type="button" class="btn-ghost" data-m365-new>Kalender verbinden</button>`}</div>` : ""}`;
  }

  function createForm(error, v = { mode: "busy", busyLabel: "Termin" }) {
    return `
      <form id="m365-form" class="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4" novalidate>
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
    if (e.target.closest("[data-m365-new]")) { pendingKey = crypto.randomUUID(); $("#m365-create").innerHTML = createForm(); return; }
    if (e.target.closest("[data-m365-cancel]")) { pendingKey = null; $("#m365-create").innerHTML = `<button type="button" class="btn-ghost" data-m365-new>Kalender verbinden</button>`; }
  });
  box.addEventListener("submit", async (e) => {
    if (e.target.id !== "m365-form") return;
    e.preventDefault();
    const f = e.target, mode = f.mode.value, label = f.busyLabel.value.trim();
    if (mode === "busy" && (!label || /[\u0000-\u001f<>]/.test(label))) { $("#m365-create").innerHTML = createForm("Bitte einen Titel mit 1 bis 64 Zeichen ohne Sonderzeichen wie < oder > angeben.", { mode, busyLabel: label }); return; }
    const btn = f.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Verbinde …";
    try {
      await api.createPipeline(mode === "busy" ? { mode, busyLabel: label } : { mode }, pendingKey);
      pendingKey = null;
      refresh();
    } catch (err) {
      if (err.kind === "unauthenticated") return renderError(err);
      $("#m365-create").innerHTML = createForm(err.message, { mode, busyLabel: label }); // gleicher Key beim erneuten Versuch: keine Doppelanlage
    }
  });
  refresh();
})();
