/**
 * Sync-Ziele: Admin-Allowlist und Prüfung – EINE Implementierung für API (Pipeline-Anlage) und Sync-Worker
 * (vor jedem Schreibzugriff erneut). Ein Nutzer kann eine Pipeline nie auf ein beliebiges Postfach richten.
 *
 *   account  zweites Microsoft-365-Postfach DERSELBEN Person
 *            · anderer Entra-Mandant (Mutter/Tochter): entraTenantId ∈ linkedTenants, Domain ∈ deren domains
 *            · eigener Mandant: Domain ∈ ownDomains, nicht das Quellpostfach selbst
 *            Dieselbe Person wird per Graph geprüft (core/src/identity.ts), bei der Anlage UND im Worker
 *            (spätestens alle 24 h): identityAttribute "objectId" (nur eigener Mandant, exakt), "employeeId",
 *            "onPremisesImmutableId", "onPremisesSecurityIdentifier" – beide Seiten nicht leer und gleich.
 *            "localPart" (nur gleicher lokaler Teil, ohne Graph) ist ein ausdrückliches Opt-in: zwei verschiedene
 *            Personen mit gleichem lokalen Teil in verschiedenen Domains wären dann nicht unterscheidbar.
 *   team     Team-/Abteilungskalender (Ressourcenpostfach) aus teamCalendars – Postfach kommt aus der Config,
 *            nie aus dem Request
 *   booking  CalenSync-Buchungsseite: kein Provider-Schreibzugriff, Belegt-Zeiten nur über die Busy-API
 *
 *   account + provider "google": Google-Workspace-Kalender DERSELBEN Person in einem verknüpften Workspace
 *            (linkedGoogleWorkspaces): workspaceId ∈ Allowlist, Domain ∈ deren domains. Dieselbe Person prüft die
 *            Directory API (externalIds[type=organization] = employeeId) gegen Graph (employeeId des Inhabers),
 *            bei der Anlage UND im Worker – core/src/googleCalendar.ts. Opt-in localPart wie bei Microsoft.
 *            Geschrieben wird per domänenweiter Delegation NUR in das so geprüfte Postfach (Fact Sheet D4).
 * Rein funktional, ohne I/O – Ablehnungen liefern einen stabilen Code (API-Antwort, last_sync_error).
 */

export type SyncTargetKind = "account" | "team" | "booking";

/** Merkmal, an dem "dieselbe Person" erkannt wird (Werte beider Seiten per Graph gelesen) */
export type IdentityAttribute = "objectId" | "employeeId" | "onPremisesImmutableId" | "onPremisesSecurityIdentifier" | "localPart";
export const IDENTITY_ATTRIBUTES: readonly IdentityAttribute[] = ["objectId", "employeeId", "onPremisesImmutableId", "onPremisesSecurityIdentifier", "localPart"];

export interface LinkedTenant {
  entraTenantId: string;
  label: string;
  /** kleingeschrieben, ohne @ */
  domains: readonly string[];
  /** Default employeeId; objectId ist mandantenübergreifend nicht möglich */
  identityAttribute?: Exclude<IdentityAttribute, "objectId">;
}

/** Verknüpfter Google Workspace (Ziel account + provider google) */
export interface LinkedGoogleWorkspace {
  /** [a-z0-9_-], 1–64 Zeichen – steht in pipelines.target_workspace_id */
  id: string;
  label: string;
  /** kleingeschrieben, ohne @ – nur Postfächer dieser Domains sind Ziel */
  domains: readonly string[];
  /** Dienstkonto, dessen Client-ID im Workspace für DWD freigegeben ist (Signatur per IAM signJwt, keyless) */
  serviceAccountEmail: string;
  /** employeeId (Default: Graph employeeId = Google externalIds[type=organization]) oder Opt-in localPart */
  identityAttribute?: "employeeId" | "localPart";
  /** Workspace-Nutzer mit Admin-Rolle "Nutzer: Lesen" – Subjekt NUR für die Directory-Abfrage (employeeId) */
  directoryAdminSubject?: string | null;
}

export type TargetProvider = "microsoft" | "google";

export interface TeamCalendar {
  id: string;
  mailbox: string;
  label: string;
  /** full-Modus (Betreff + Ort) in diesen Kalender erlaubt? Default false */
  allowFullMode?: boolean;
}

export interface SyncAllowlist {
  /** Entra-Mandant des Kunden (Quelle aller Pipelines, Ziel für team und account im eigenen Mandanten) */
  homeEntraTenantId: string;
  ownDomains: readonly string[];
  /** Merkmal für account-Ziele im eigenen Mandanten, Default objectId (exakt dasselbe Entra-Objekt) */
  ownDomainsIdentityAttribute?: IdentityAttribute;
  linkedTenants: readonly LinkedTenant[];
  teamCalendars: readonly TeamCalendar[];
  bookingEnabled: boolean;
  /** Google Workspaces als Ziel für account (optional; leer/fehlend = keine Google-Ziele) */
  googleWorkspaces?: readonly LinkedGoogleWorkspace[];
}

export const EMPTY_ALLOWLIST: SyncAllowlist = Object.freeze({
  homeEntraTenantId: "", ownDomains: [], linkedTenants: [], teamCalendars: [], bookingEnabled: false,
});

/** Was der Client wählt (bereits syntaktisch geprüft, siehe parseTargetRequest) */
export type TargetRequest =
  /** provider fehlt = microsoft; google verlangt workspaceId und kein entraTenantId */
  | { kind: "account"; mailbox: string; entraTenantId: string | null; provider?: TargetProvider; workspaceId?: string | null }
  | { kind: "team"; teamId: string }
  | { kind: "booking" };

/** Was gespeichert und vom Worker benutzt wird (pipelines.target_*) */
export interface ResolvedTarget {
  kind: SyncTargetKind;
  /** Zielpostfach (account/team), sonst null */
  mailbox: string | null;
  /** null = Heim-Mandant; sonst ein verknüpfter Mandant */
  entraTenantId: string | null;
  /** team: ID aus teamCalendars */
  ref: string | null;
  /** Anzeigename für das Dashboard (nie ein fremdes Postfach) */
  label: string;
  /** nur account: wie dieselbe Person geprüft wird */
  identityAttribute?: IdentityAttribute;
  /** fehlt = microsoft */
  provider?: TargetProvider;
  /** nur provider google: ID aus linkedGoogleWorkspaces */
  workspaceId?: string | null;
}

export type TargetRejection =
  | "tenant_not_linked"
  | "workspace_not_linked"
  | "domain_not_allowed"
  | "not_same_person"
  | "target_is_source"
  | "own_mailboxes_not_configured"
  | "team_not_found"
  | "team_mailbox_changed"
  | "booking_disabled"
  | "owner_unknown"
  | "target_missing"
  | "identity_unverified"
  | "full_mode_not_allowed";

export type TargetCheck = { ok: true; target: ResolvedTarget } | { ok: false; reason: TargetRejection };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bewusst eng: keine Quotes, keine Kommentare, keine IP-Literale, keine Unicode-Tricks */
const MAILBOX = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const TEAM_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isGuid = (v: string): boolean => GUID.test(v);
export const isDomain = (v: string): boolean => v.length <= 253 && DOMAIN.test(v);

/** Kleinschreibung + Trim; null bei syntaktisch ungültiger Adresse */
export function normalizeMailbox(v: string): string | null {
  const m = v.trim().toLowerCase();
  return m.length <= 254 && MAILBOX.test(m) && !m.includes("..") ? m : null;
}

function split(mailbox: string): { local: string; domain: string } {
  const at = mailbox.lastIndexOf("@");
  return { local: mailbox.slice(0, at), domain: mailbox.slice(at + 1) };
}

/** Lokaler Teil des Inhabers aus scim_users.user_name (UPN); null, wenn es keine Adresse ist */
function ownerMailbox(ownerUserName: string | null): string | null {
  return ownerUserName ? normalizeMailbox(ownerUserName) : null;
}

const sameGuid = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Prüft eine gewünschte Zielwahl gegen die Allowlist. ownerUserName = scim_users.user_name des Inhabers.
 */
export function resolveSyncTarget(allow: SyncAllowlist, ownerUserName: string | null, req: TargetRequest): TargetCheck {
  switch (req.kind) {
    case "booking":
      return allow.bookingEnabled
        ? { ok: true, target: { kind: "booking", mailbox: null, entraTenantId: null, ref: null, label: "Buchungsseite" } }
        : { ok: false, reason: "booking_disabled" };
    case "team": {
      const team = allow.teamCalendars.find((t) => t.id === req.teamId);
      if (!team) return { ok: false, reason: "team_not_found" };
      return { ok: true, target: { kind: "team", mailbox: team.mailbox, entraTenantId: null, ref: team.id, label: team.label } };
    }
    case "account": {
      const owner = ownerMailbox(ownerUserName);
      if (!owner) return { ok: false, reason: "owner_unknown" };
      const mailbox = normalizeMailbox(req.mailbox);
      if (!mailbox) return { ok: false, reason: "domain_not_allowed" };
      const t = split(mailbox);
      const o = split(owner);
      if (req.provider === "google") {
        const ws = findWorkspace(allow, req.workspaceId);
        if (!ws || req.entraTenantId) return { ok: false, reason: "workspace_not_linked" };
        if (!ws.domains.includes(t.domain)) return { ok: false, reason: "domain_not_allowed" };
        if (mailbox === owner) return { ok: false, reason: "target_is_source" };
        const identityAttribute = ws.identityAttribute ?? "employeeId";
        if (identityAttribute === "localPart" && t.local !== o.local) return { ok: false, reason: "not_same_person" };
        return { ok: true, target: { kind: "account", provider: "google", workspaceId: ws.id, mailbox, entraTenantId: null, ref: null, label: `Google: ${ws.label}`, identityAttribute } };
      }
      const linkedId = req.entraTenantId && !sameGuid(req.entraTenantId, allow.homeEntraTenantId) ? req.entraTenantId : null;
      if (linkedId) {
        const tenant = allow.linkedTenants.find((l) => sameGuid(l.entraTenantId, linkedId));
        if (!tenant) return { ok: false, reason: "tenant_not_linked" };
        if (!tenant.domains.includes(t.domain)) return { ok: false, reason: "domain_not_allowed" };
        const identityAttribute = tenant.identityAttribute ?? "employeeId";
        // Ohne Graph-Prüfung (Opt-in localPart) bleibt nur der gleiche lokale Teil als Konvention
        if (identityAttribute === "localPart" && t.local !== o.local) return { ok: false, reason: "not_same_person" };
        return { ok: true, target: { kind: "account", mailbox, entraTenantId: tenant.entraTenantId.toLowerCase(), ref: null, label: tenant.label, identityAttribute } };
      }
      if (allow.ownDomains.length === 0) return { ok: false, reason: "own_mailboxes_not_configured" };
      if (!allow.ownDomains.includes(t.domain)) return { ok: false, reason: "domain_not_allowed" };
      const identityAttribute = allow.ownDomainsIdentityAttribute ?? "objectId";
      if (identityAttribute === "localPart" && t.local !== o.local) return { ok: false, reason: "not_same_person" };
      if (mailbox === owner) return { ok: false, reason: "target_is_source" };
      return { ok: true, target: { kind: "account", mailbox, entraTenantId: null, ref: null, label: t.domain, identityAttribute } };
    }
  }
}

/** Gespeicherte Spalten einer Pipeline (pipelines.target_*) */
export interface StoredTarget {
  kind: string | null;
  mailbox: string | null;
  entraTenantId: string | null;
  ref: string | null;
  /** pipelines.target_provider (008); fehlt/NULL = microsoft */
  provider?: string | null;
  /** pipelines.target_workspace_id (008) */
  workspaceId?: string | null;
}

const isGoogle = (s: { provider?: string | null }) => s.provider === "google";
function findWorkspace(allow: SyncAllowlist, id: string | null | undefined): LinkedGoogleWorkspace | null {
  if (!id) return null;
  return (allow.googleWorkspaces ?? []).find((w) => w.id === id) ?? null;
}
/** Konfiguration des Google Workspace eines Ziels (Dienstkonto, Directory-Subjekt) – null, wenn nicht (mehr) verknüpft */
export function googleWorkspaceFor(allow: SyncAllowlist, t: { provider?: string | null; workspaceId?: string | null }): LinkedGoogleWorkspace | null {
  return isGoogle(t) ? findWorkspace(allow, t.workspaceId) : null;
}

/**
 * Zweite Prüfung im Worker: Das gespeicherte Ziel muss NOCH erlaubt sein (Allowlist kann sich geändert haben,
 * userName kann sich per SCIM geändert haben) und exakt dem entsprechen, was die Allowlist heute ergibt.
 */
export function recheckStoredTarget(allow: SyncAllowlist, ownerUserName: string | null, s: StoredTarget): TargetCheck {
  if (s.kind === "booking") return resolveSyncTarget(allow, ownerUserName, { kind: "booking" });
  if (s.kind === "team") {
    if (!s.ref) return { ok: false, reason: "team_not_found" };
    const r = resolveSyncTarget(allow, ownerUserName, { kind: "team", teamId: s.ref });
    if (r.ok && r.target.mailbox !== (s.mailbox ?? "").toLowerCase()) return { ok: false, reason: "team_mailbox_changed" };
    return r;
  }
  if (s.kind === "account") {
    if (!s.mailbox) return { ok: false, reason: "target_missing" };
    if (s.provider && s.provider !== "microsoft" && s.provider !== "google") return { ok: false, reason: "target_missing" };
    if (isGoogle(s)) {
      if (s.entraTenantId) return { ok: false, reason: "workspace_not_linked" };
      return resolveSyncTarget(allow, ownerUserName, { kind: "account", provider: "google", workspaceId: s.workspaceId ?? null, mailbox: s.mailbox, entraTenantId: null });
    }
    if (s.workspaceId) return { ok: false, reason: "target_missing" };
    return resolveSyncTarget(allow, ownerUserName, { kind: "account", mailbox: s.mailbox, entraTenantId: s.entraTenantId });
  }
  return { ok: false, reason: "target_missing" };
}

/**
 * Prüfung für die BEREINIGUNG (nur Löschen eigener Zieltermine nach Widerruf): Das Ziel muss weiter in der
 * Allowlist stehen (Mandant verknüpft, Domain erlaubt, Team-Postfach unverändert). Die Same-Person-Prüfung
 * entfällt bewusst – nach SCIM-DELETE ist der userName schon geschwärzt; gelöscht werden ohnehin nur Termine,
 * deren IDs CalenSync selbst in genau diesem Postfach angelegt hat.
 */
export function recheckTargetForCleanup(allow: SyncAllowlist, s: StoredTarget): { ok: true } | { ok: false; reason: TargetRejection } {
  if (s.kind === "booking") return { ok: true };
  const mailbox = s.mailbox ? normalizeMailbox(s.mailbox) : null;
  if (!mailbox) return { ok: false, reason: "target_missing" };
  if (s.kind === "team") {
    const team = allow.teamCalendars.find((t) => t.id === s.ref);
    if (!team) return { ok: false, reason: "team_not_found" };
    return team.mailbox === mailbox ? { ok: true } : { ok: false, reason: "team_mailbox_changed" };
  }
  if (s.kind === "account") {
    const { domain } = split(mailbox);
    if (isGoogle(s)) {
      const ws = findWorkspace(allow, s.workspaceId);
      if (!ws) return { ok: false, reason: "workspace_not_linked" };
      return ws.domains.includes(domain) ? { ok: true } : { ok: false, reason: "domain_not_allowed" };
    }
    if (s.entraTenantId && !sameGuid(s.entraTenantId, allow.homeEntraTenantId)) {
      const tenant = allow.linkedTenants.find((l) => sameGuid(l.entraTenantId, s.entraTenantId));
      if (!tenant) return { ok: false, reason: "tenant_not_linked" };
      return tenant.domains.includes(domain) ? { ok: true } : { ok: false, reason: "domain_not_allowed" };
    }
    return allow.ownDomains.includes(domain) ? { ok: true } : { ok: false, reason: "domain_not_allowed" };
  }
  return { ok: false, reason: "target_missing" };
}

/** Dashboard-Anzeige eines gespeicherten Ziels – nur Label, nie das Postfach */
export function targetLabel(allow: SyncAllowlist, s: StoredTarget): { kind: SyncTargetKind; label: string | null; provider?: "google" } | null {
  if (s.kind === "booking") return { kind: "booking", label: "Buchungsseite" };
  if (s.kind === "team") return { kind: "team", label: allow.teamCalendars.find((t) => t.id === s.ref)?.label ?? null };
  if (s.kind === "account" && isGoogle(s)) {
    const ws = findWorkspace(allow, s.workspaceId);
    return { kind: "account", label: ws ? `Google: ${ws.label}` : "Google", provider: "google" };
  }
  if (s.kind === "account") {
    if (s.entraTenantId) return { kind: "account", label: allow.linkedTenants.find((l) => sameGuid(l.entraTenantId, s.entraTenantId))?.label ?? null };
    return { kind: "account", label: s.mailbox ? split(s.mailbox).domain : null };
  }
  return null;
}

export type AccountSuggestion =
  | {
    entraTenantId: string | null;
    label: string;
    mailbox: string;
    /** immer false: Vorschlag aus lokalem Teil × Domain; dieselbe Person prüft erst die Anlage per Graph */
    verified: false;
  }
  | {
    /** Google Workspace: Anlage mit { kind: "account", provider: "google", workspaceId, mailbox } */
    provider: "google";
    workspaceId: string;
    label: string;
    mailbox: string;
    /** immer false: dieselbe Person prüft erst die Anlage (Directory API + Graph) */
    verified: false;
  };

/**
 * Prüft den Modus gegen das Ziel: full (Betreff + Ort) in einen Team-Kalender nur mit allowFullMode.
 * Für account/booking gibt es keine Einschränkung (eigenes Postfach bzw. keine Inhalte).
 */
export function fullModeAllowed(allow: SyncAllowlist, target: Pick<ResolvedTarget, "kind" | "ref">): boolean {
  if (target.kind !== "team") return true;
  return allow.teamCalendars.find((t) => t.id === target.ref)?.allowFullMode === true;
}

/** Vorschläge für das Dashboard: lokaler Teil des Inhabers × konfigurierte Domains (ohne das Quellpostfach) */
export function accountSuggestions(allow: SyncAllowlist, ownerUserName: string | null): AccountSuggestion[] {
  const owner = ownerMailbox(ownerUserName);
  if (!owner) return [];
  const { local } = split(owner);
  const out: AccountSuggestion[] = [];
  for (const d of allow.ownDomains) {
    const m = `${local}@${d}`;
    if (m !== owner && normalizeMailbox(m)) out.push({ entraTenantId: null, label: d, mailbox: m, verified: false });
  }
  for (const t of allow.linkedTenants) {
    for (const d of t.domains) {
      const m = `${local}@${d}`;
      if (normalizeMailbox(m)) out.push({ entraTenantId: t.entraTenantId.toLowerCase(), label: t.label, mailbox: m, verified: false });
    }
  }
  for (const w of allow.googleWorkspaces ?? []) {
    for (const d of w.domains) {
      const m = `${local}@${d}`;
      if (m !== owner && normalizeMailbox(m)) out.push({ provider: "google", workspaceId: w.id, label: w.label, mailbox: m, verified: false });
    }
  }
  return out;
}

export type TargetParse = { ok: true; target: TargetRequest } | { ok: false; error: string };

/** Syntaxprüfung des Request-Felds `target` (strikt: unbekannte Felder → Fehler) */
export function parseTargetRequest(v: unknown): TargetParse {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "target_invalid" };
  const o = v as Record<string, unknown>;
  const allowed: Record<string, readonly string[]> = { account: ["kind", "mailbox", "entraTenantId", "provider", "workspaceId"], team: ["kind", "teamId"], booking: ["kind"] };
  if (typeof o.kind !== "string" || !Object.hasOwn(allowed, o.kind)) return { ok: false, error: "target_kind_invalid" };
  for (const k of Object.keys(o)) if (!allowed[o.kind].includes(k)) return { ok: false, error: `unknown_field:target.${k.slice(0, 24)}` };
  if (o.kind === "booking") return { ok: true, target: { kind: "booking" } };
  if (o.kind === "team") {
    if (typeof o.teamId !== "string" || !TEAM_ID.test(o.teamId)) return { ok: false, error: "target_team_id_invalid" };
    return { ok: true, target: { kind: "team", teamId: o.teamId } };
  }
  if (typeof o.mailbox !== "string") return { ok: false, error: "target_mailbox_invalid" };
  const mailbox = normalizeMailbox(o.mailbox);
  if (!mailbox) return { ok: false, error: "target_mailbox_invalid" };
  let entraTenantId: string | null = null;
  if (o.entraTenantId !== undefined && o.entraTenantId !== null) {
    if (typeof o.entraTenantId !== "string" || !GUID.test(o.entraTenantId)) return { ok: false, error: "target_entra_tenant_id_invalid" };
    entraTenantId = o.entraTenantId.toLowerCase();
  }
  const provider = o.provider === undefined || o.provider === null ? "microsoft" : o.provider;
  if (provider !== "microsoft" && provider !== "google") return { ok: false, error: "target_provider_invalid" };
  const hasWorkspace = o.workspaceId !== undefined && o.workspaceId !== null;
  if (provider === "microsoft") {
    if (hasWorkspace) return { ok: false, error: "target_workspace_id_invalid" };
    return { ok: true, target: { kind: "account", mailbox, entraTenantId } };
  }
  // Google: Workspace Pflicht, Entra-Mandant verboten (kein Mischen der beiden Allowlists)
  if (entraTenantId !== null) return { ok: false, error: "target_entra_tenant_id_invalid" };
  if (typeof o.workspaceId !== "string" || !TEAM_ID.test(o.workspaceId)) return { ok: false, error: "target_workspace_id_invalid" };
  return { ok: true, target: { kind: "account", provider: "google", workspaceId: o.workspaceId, mailbox, entraTenantId: null } };
}
