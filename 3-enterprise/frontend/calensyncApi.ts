/**
 * CalenSync-Dashboard-API für das Frontend (React, Vue oder Vanilla – kein Framework nötig).
 *
 * Anmeldung: Microsoft Entra ID per MSAL (Authorization Code + PKCE). Das Frontend enthält KEIN Secret:
 * Client-ID, Tenant-ID und Scope sind öffentliche Werte. Tokens liegen im sessionStorage des Browsers,
 * die API bekommt sie als Bearer-Header – keine Cookies, daher kein CSRF und kein credentials: "include".
 *
 *   npm i @azure/msal-browser
 *
 *   const api = createCalensyncApi({
 *     apiBaseUrl: import.meta.env.VITE_CALENSYNC_API,              // https://acme.calensync.de
 *     getAccessToken: msalTokenProvider({
 *       tenantId: import.meta.env.VITE_ENTRA_TENANT_ID,
 *       clientId: import.meta.env.VITE_ENTRA_SPA_CLIENT_ID,
 *       scope:    [import.meta.env.VITE_CALENSYNC_API_SCOPE,          // api://calensync-acme/Sync.Read
 *                  import.meta.env.VITE_CALENSYNC_API_WRITE_SCOPE],   // api://calensync-acme/Sync.Write
 *       redirectUri: `${location.origin}/auth/callback`,
 *     }),
 *   });
 *   const status = await api.getSyncStatus();
 *   const key = crypto.randomUUID();                                  // einmal pro Dialog
 *   const p = await api.createPipeline({ mode: "busy", busyLabel: "Termin" }, key);
 *
 * Für createPipeline braucht die SPA zusätzlich den Scope Sync.Write (api://calensync-acme/Sync.Write).
 */
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";

// ---------------------------------------------------------------------------------------------------
// Typen (entsprechen app/src/statusApi.ts im Backend)
// ---------------------------------------------------------------------------------------------------
export interface PipelineStatus {
  id: string;
  status: "active" | "pending" | "pending_scope" | "paused" | "revoked" | "blocked_scope" | "config_error" | "error" | string;
  subscription: { active: boolean; expiresAt: string | null };
}

export interface SyncStatus {
  user: { active: boolean };
  pipelines: PipelineStatus[];
}

export interface CreatePipelineRequest {
  mode: "busy" | "full";
  /** nur bei mode "busy"; 1–64 Zeichen, keine Steuerzeichen/HTML */
  busyLabel?: string;
}

export interface CreatedPipeline {
  id: string;
  status: string;
  mode: "busy" | "full";
  busyLabel: string | null;
  /** true, wenn der Server eine frühere Anlage mit demselben Idempotency-Key zurückgegeben hat */
  replayed: boolean;
}

export type ApiErrorKind =
  | "unauthenticated"      // 401 nach Token-Erneuerung → neu anmelden
  | "forbidden"            // 403: Scope fehlt oder Origin nicht freigegeben
  | "not_provisioned"      // 404: Nutzer (noch) nicht per SCIM angelegt
  | "limit_reached"        // 409: maximale Anzahl Pipelines erreicht
  | "invalid_request"      // 400/413/415/422: Eingabe vom Server abgelehnt
  | "unavailable"          // 429/503 nach allen Wiederholungen
  | "network"              // offline, DNS, TLS oder CORS-Blockade durch den Browser
  | "timeout"
  | "unexpected";

export class CalensyncApiError extends Error {
  constructor(readonly kind: ApiErrorKind, message: string, readonly status: number | null = null, readonly requestId: string | null = null) {
    super(message);
    this.name = "CalensyncApiError";
  }
}

export interface CalensyncApiOptions {
  apiBaseUrl: string;
  getAccessToken: (opts: { forceRefresh: boolean }) => Promise<string>;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------------------------------
// API-Client
// ---------------------------------------------------------------------------------------------------
export function createCalensyncApi(o: CalensyncApiOptions) {
  const base = o.apiBaseUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://") && !base.startsWith("http://localhost")) throw new Error("apiBaseUrl muss https sein");
  const doFetch = o.fetchFn ?? fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxRetries = o.maxRetries ?? 2;

  const backoff = async (attempt: number, retryAfter: string | null) => {
    const ra = Number(retryAfter);
    const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs * (0.85 + Math.random() * 0.3))); // ±15 % Jitter
  };

  /**
   * GET: wiederholt 429/503. POST: nur mit Idempotency-Key – dann sind Wiederholungen nach 429/503,
   * Timeout und Netzwerkfehler sicher, weil der Server denselben Key auf dieselbe Pipeline abbildet.
   */
  async function request<T>(path: string, signal?: AbortSignal, post?: { body: string; idempotencyKey: string }): Promise<{ body: T; res: Response }> {
    let forceRefresh = false;
    for (let attempt = 0; ; attempt++) {
      const token = await o.getAccessToken({ forceRefresh });
      const requestId = crypto.randomUUID();
      const timeout = AbortSignal.timeout(timeoutMs);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Request-Id": requestId };
      if (post) {
        headers["Content-Type"] = "application/json";
        headers["Idempotency-Key"] = post.idempotencyKey;
      }
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method: post ? "POST" : "GET",
          mode: "cors",
          credentials: "omit",
          headers,
          ...(post ? { body: post.body } : {}),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err; // vom Aufrufer abgebrochen (z. B. Komponente ausgehängt)
        // POST mit Idempotency-Key: Antwort ging evtl. verloren, Server hat aber angelegt → gleicher Key, erneut
        if (post && attempt < maxRetries) {
          await backoff(attempt, null);
          continue;
        }
        if (timeout.aborted) throw new CalensyncApiError("timeout", "Zeitüberschreitung beim Abruf", null, requestId);
        // fetch wirft TypeError bei Netzwerkfehlern UND wenn der Browser die Antwort wegen CORS blockiert
        throw new CalensyncApiError("network", "Keine Verbindung zur CalenSync-API (Netzwerk oder CORS)", null, requestId);
      }

      const rid = res.headers.get("x-request-id") ?? requestId;
      if (res.ok) return { body: (await res.json()) as T, res };

      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true; // Token evtl. abgelaufen/widerrufen: einmal frisch holen
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      const code = await res.json().then((b: { error?: string }) => b.error ?? "").catch(() => "");
      switch (res.status) {
        case 401: throw new CalensyncApiError("unauthenticated", "Anmeldung abgelaufen", 401, rid);
        case 403: throw new CalensyncApiError("forbidden", code === "origin_not_allowed" ? "Diese Website ist für die API nicht freigegeben" : "Keine Berechtigung", 403, rid);
        case 404: throw new CalensyncApiError("not_provisioned", "Ihr Konto ist noch nicht für CalenSync freigeschaltet", 404, rid);
        case 409: throw new CalensyncApiError("limit_reached", "Maximale Anzahl verbundener Kalender erreicht", 409, rid);
        case 400:
        case 413:
        case 415:
        case 422: throw new CalensyncApiError("invalid_request", `Eingabe abgelehnt (${code || res.status})`, res.status, rid);
        case 429:
        case 503: throw new CalensyncApiError("unavailable", "CalenSync ist gerade ausgelastet – bitte gleich erneut versuchen", res.status, rid);
        default: throw new CalensyncApiError("unexpected", `Unerwartete Antwort ${res.status}`, res.status, rid);
      }
    }
  }

  return {
    getSyncStatus: async (signal?: AbortSignal) => (await request<SyncStatus>("/api/v1/me/sync-status", signal)).body,

    /**
     * Neue Pipeline anlegen. idempotencyKey pro Nutzeraktion EINMAL erzeugen (z. B. beim Öffnen des Dialogs)
     * und bei manuellem „Erneut versuchen“ wiederverwenden – dann entsteht nie eine doppelte Pipeline.
     */
    createPipeline: async (req: CreatePipelineRequest, idempotencyKey: string = crypto.randomUUID(), signal?: AbortSignal): Promise<CreatedPipeline> => {
      const body = JSON.stringify(req.mode === "busy" && req.busyLabel !== undefined ? { mode: "busy", busyLabel: req.busyLabel } : { mode: req.mode });
      const r = await request<Omit<CreatedPipeline, "replayed">>("/api/v1/me/pipelines", signal, { body, idempotencyKey });
      return { ...r.body, replayed: r.res.headers.get("idempotent-replayed") === "true" };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Token-Beschaffung mit MSAL (Redirect-Flow, funktioniert auch mit strengen Popup-Blockern)
// ---------------------------------------------------------------------------------------------------
export interface MsalOptions {
  tenantId: string;
  clientId: string;
  /** z. B. api://calensync-acme/Sync.Read – oder beide Scopes derselben API als Array (ein Token, scp enthält beide) */
  scope: string | readonly string[];
  redirectUri: string;
}

export function msalTokenProvider(m: MsalOptions): CalensyncApiOptions["getAccessToken"] {
  const msal = new PublicClientApplication({
    auth: { clientId: m.clientId, authority: `https://login.microsoftonline.com/${m.tenantId}`, redirectUri: m.redirectUri },
    cache: { cacheLocation: "sessionStorage" },
  });
  const ready = (async () => {
    await msal.initialize();
    const result = await msal.handleRedirectPromise(); // Rückkehr vom Login verarbeiten
    if (result?.account) msal.setActiveAccount(result.account);
  })();

  const scopes = typeof m.scope === "string" ? [m.scope] : [...m.scope];
  return async ({ forceRefresh }) => {
    await ready;
    const account: AccountInfo | null = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
    if (!account) {
      await msal.loginRedirect({ scopes });
      throw new CalensyncApiError("unauthenticated", "Weiterleitung zur Anmeldung");
    }
    try {
      const r = await msal.acquireTokenSilent({ scopes, account, forceRefresh });
      return r.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        await msal.acquireTokenRedirect({ scopes, account });
        throw new CalensyncApiError("unauthenticated", "Weiterleitung zur Anmeldung");
      }
      throw err;
    }
  };
}
