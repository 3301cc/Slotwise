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
 *   const targets = await api.getSyncTargets();                       // erlaubte Ziele für den Dialog
 *   const key = crypto.randomUUID();                                  // einmal pro Dialog
 *   const p = await api.createPipeline({ target: { kind: "team", teamId: "vertrieb" }, mode: "busy", busyLabel: "Termin" }, key);
 *
 * Für createPipeline braucht die SPA zusätzlich den Scope Sync.Write (api://calensync-acme/Sync.Write).
 * Labels, Postfächer und Fehlercodes kommen vom Server – in der UI immer escapen (z. B. textContent statt innerHTML).
 *
 * Eine Portierung ohne Build-Schritt liegt in slotwise-website-online/dashboard/enterprise.js – Änderungen dort mitziehen.
 */
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";

// ---------------------------------------------------------------------------------------------------
// Typen (entsprechen app/src/statusApi.ts im Backend)
// ---------------------------------------------------------------------------------------------------
export type SyncTargetKind = "account" | "team" | "booking";

export interface PipelineStatus {
  id: string;
  status: "active" | "pending" | "pending_scope" | "paused" | "revoked" | "blocked_scope" | "config_error" | "error" | string;
  subscription: { active: boolean; expiresAt: string | null };
  /** Ziel des Abgleichs; label kommt aus der Serverkonfiguration (nicht vertrauenswürdig → escapen) */
  target?: { kind: SyncTargetKind | string; label: string | null };
  /** ISO-Zeitpunkt des letzten erfolgreichen Abgleichs */
  lastSyncedAt?: string | null;
  /** Fehlercode des letzten Abgleichs (siehe pipelineErrorMessage) */
  lastError?: string | null;
  /** Aufräumen im Zielkalender nach dem Beenden */
  cleanup?: "pending" | "done" | null;
}

export interface EndedPipeline {
  id: string;
  status: "revoked";
  cleanup: "pending" | "done";
}

export interface SyncStatus {
  user: { active: boolean };
  pipelines: PipelineStatus[];
}

/** GET /api/v1/me/sync-targets – was der Nutzer als Ziel wählen darf */
export interface SyncTargets {
  account: { allowed: boolean; suggestions: { entraTenantId: string | null; label: string; mailbox: string }[] };
  team: { id: string; label: string }[];
  booking: { enabled: boolean };
}

export type SyncTarget =
  | { kind: "account"; mailbox: string; entraTenantId: string | null }
  | { kind: "team"; teamId: string }
  | { kind: "booking" };

export interface CreatePipelineRequest {
  target: SyncTarget;
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
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
    /** Fehlercode aus dem Antwort-Body ({"error": "..."}), z. B. target_not_allowed */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "CalensyncApiError";
  }
}

// Nur eigene Schlüssel: Codes kommen vom Server ("constructor" o. Ä. dürfen nichts finden)
const lookup = (map: Record<string, string>, key: unknown): string | null =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;

/** Fehlercodes von POST /me/pipelines (400/422) → deutsche Meldung */
export const REQUEST_ERROR_MESSAGES: Record<string, string> = {
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

/** lastError-Codes einer Pipeline → deutsche Meldung */
export const PIPELINE_ERROR_MESSAGES: Record<string, string> = {
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
  event_rejected: "Ein einzelner Termin wurde vom Zielkalender abgelehnt; die übrigen werden abgeglichen.",
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

/** Lesbare Meldung zu PipelineStatus.lastError; unbekannte Codes werden als Code angezeigt */
export function pipelineErrorMessage(code: string): string {
  return lookup(PIPELINE_ERROR_MESSAGES, code) ?? `Fehler: ${String(code).slice(0, 80)}`;
}

const TARGET_KINDS: Record<string, string> = { account: "Zweites Konto", team: "Team-Kalender", booking: "Buchungsseite" };

/** "Zweites Konto: Tochter GmbH", "Team-Kalender: Vertrieb", "Buchungsseite" (Rückgabe ist Klartext → escapen) */
export function targetLabel(t: PipelineStatus["target"] | null | undefined): string {
  if (!t || typeof t !== "object") return "Kalender-Abgleich";
  const kind = lookup(TARGET_KINDS, t.kind);
  const label = typeof t.label === "string" ? t.label.trim().slice(0, 120) : "";
  if (!kind) return label || "Kalender-Abgleich";
  return t.kind === "booking" || !label ? kind : `${kind}: ${label}`;
}

/** Nur die Felder, die der Server erwartet (unbekannte Felder lehnt er mit 400 ab) */
function targetBody(t: SyncTarget | undefined): SyncTarget | undefined {
  if (!t) return undefined;
  switch (t.kind) {
    case "account": return { kind: "account", mailbox: t.mailbox, entraTenantId: t.entraTenantId ?? null };
    case "team": return { kind: "team", teamId: t.teamId };
    default: return { kind: t.kind };
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
  async function request<T>(path: string, signal?: AbortSignal, post?: { body: string; idempotencyKey: string }, method?: "DELETE"): Promise<{ body: T; res: Response }> {
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
          method: method ?? (post ? "POST" : "GET"),
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
      const code = await res.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error.slice(0, 80) : "")).catch(() => "");
      switch (res.status) {
        case 401: throw new CalensyncApiError("unauthenticated", "Anmeldung abgelaufen", 401, rid);
        case 403: throw new CalensyncApiError("forbidden", code === "origin_not_allowed" ? "Diese Website ist für die API nicht freigegeben" : "Keine Berechtigung", 403, rid);
        case 404: throw new CalensyncApiError("not_provisioned", "Ihr Konto ist noch nicht für CalenSync freigeschaltet", 404, rid);
        case 409: throw new CalensyncApiError("limit_reached", "Maximale Anzahl verbundener Kalender erreicht", 409, rid);
        case 400:
        case 413:
        case 415:
        case 422: throw new CalensyncApiError("invalid_request", lookup(REQUEST_ERROR_MESSAGES, code) ?? (code.startsWith("unknown_field:target") ? REQUEST_ERROR_MESSAGES.invalid_target : null) ?? `Eingabe abgelehnt (${code || res.status})`, res.status, rid, code || null);
        case 429:
        case 503: throw new CalensyncApiError("unavailable", "CalenSync ist gerade ausgelastet – bitte gleich erneut versuchen", res.status, rid);
        default: throw new CalensyncApiError("unexpected", `Unerwartete Antwort ${res.status}`, res.status, rid);
      }
    }
  }

  return {
    getSyncStatus: async (signal?: AbortSignal) => (await request<SyncStatus>("/api/v1/me/sync-status", signal)).body,

    /** Erlaubte Ziele für „Kalender verbinden“ (Scope Sync.Read). Nicht verfügbare Optionen in der UI ausblenden. */
    getSyncTargets: async (signal?: AbortSignal) => (await request<SyncTargets>("/api/v1/me/sync-targets", signal)).body,

    /**
     * Abgleich beenden (202 neu beendet, 200 schon beendet). Der Server entzieht die Pipeline und entfernt danach
     * alle von CalenSync angelegten Termine im Zielkalender (cleanup "pending" → "done" in getSyncStatus).
     */
    deletePipeline: async (id: string, signal?: AbortSignal): Promise<EndedPipeline> =>
      (await request<EndedPipeline>(`/api/v1/me/pipelines/${encodeURIComponent(id)}`, signal, undefined, "DELETE")).body,

    /**
     * Neue Pipeline anlegen. idempotencyKey pro Nutzeraktion EINMAL erzeugen (z. B. beim Öffnen des Dialogs)
     * und bei manuellem „Erneut versuchen“ wiederverwenden – dann entsteht nie eine doppelte Pipeline.
     */
    createPipeline: async (req: CreatePipelineRequest, idempotencyKey: string = crypto.randomUUID(), signal?: AbortSignal): Promise<CreatedPipeline> => {
      const target = targetBody(req.target);
      const body = JSON.stringify(req.mode === "busy" && req.busyLabel !== undefined ? { target, mode: "busy", busyLabel: req.busyLabel } : { target, mode: req.mode });
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
