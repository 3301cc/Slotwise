/**
 * Fehlerklassen der Provider-Aufrufe im Abgleich (eigenes Modul, damit Google-Unterklassen ohne Import-Zyklus
 * mit syncWorker.ts auskommen). Re-exportiert über syncWorker.ts.
 *
 * body wird nur klassifiziert (errorHandler.ts), nie gespeichert oder geloggt.
 */

/** Graph (oder Google) hat mit einem unerwarteten Status geantwortet */
export class GraphCallError extends Error {
  constructor(readonly status: number, readonly body: string, readonly retryAfter: string | null) {
    super(`HTTP ${status}`);
  }
}

/** Lauf bewusst abgebrochen (Checkpoint) – nie als Provider-Fehler klassifizieren */
export class RunAborted extends Error {}

/** Google Calendar / Directory API – klassifiziert mit classifyGoogleError statt classifyGraphError */
export class GoogleCallError extends GraphCallError {}

export type GoogleAuthStage = "aws" | "sts" | "iam" | "oauth" | "config";

/**
 * Token-Kette AWS → Google STS → IAM signJwt → OAuth (core/src/googleAuth.ts) ist gescheitert. code ist nur ein
 * fester OAuth-/Google-Fehlercode ([a-z_], z. B. unauthorized_client), nie eine Meldung.
 */
export class GoogleAuthError extends GoogleCallError {
  constructor(readonly stage: GoogleAuthStage, status: number, readonly code: string, retryAfter: string | null = null) {
    super(status, "", retryAfter);
    this.message = `google_${stage} HTTP ${status}${code ? ` ${code}` : ""}`;
  }
}

/**
 * Der Termin unter dieser ID trägt NICHT unsere Markierung (extendedProperties.private.calensyncRef) – fremder
 * Termin, nie ändern oder löschen. Status 400: im Abgleich wie ein einzeln abgelehnter Termin (event_rejected).
 */
export class ForeignEventError extends GoogleCallError {
  constructor() {
    super(400, JSON.stringify({ error: { errors: [{ reason: "calensyncRefMismatch" }] } }), null);
    this.message = "google foreign_event";
  }
}
