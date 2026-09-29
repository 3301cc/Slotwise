/**
 * Microsoft 365 / Outlook adapter — Microsoft Graph v1.0 via fetch.
 * Scopes: Calendars.ReadWrite offline_access (delegated).
 */

import {
  type BusyEvent,
  CalendarApiError,
  type CalendarInfo,
  type CalendarProvider,
  type ChangeSet,
  type ConnectionRef,
  CursorExpiredError,
  type EventDraft,
  providerFetch,
  type Subscription,
} from "./types";

const BASE = "https://graph.microsoft.com/v1.0";
// Fixed GUID for our extended property; any stable GUID works.
const BOOKING_PROP_ID = "String {c6d1a7c9-3b0e-4a6f-9d4e-2f0b1c7e5a11} Name slotwiseBookingId";

interface MEvent {
  id: string;
  "@removed"?: { reason: string };
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  isAllDay?: boolean;
  showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
}

interface MDeltaPage {
  value: MEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export class MicrosoftGraphProvider implements CalendarProvider {
  readonly kind = "MICROSOFT" as const;

  async listCalendars(conn: ConnectionRef): Promise<CalendarInfo[]> {
    const res = await providerFetch<{
      value: Array<{ id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean }>;
    }>("MICROSOFT", conn.tokens, `${BASE}/me/calendars`);
    return res.value.map((c) => ({ id: c.id, name: c.name, primary: !!c.isDefaultCalendar, canWrite: !!c.canEdit }));
  }

  async fetchChanges(conn: ConnectionRef, cursor: string | null, window: { from: Date; to: Date }): Promise<ChangeSet> {
    const upserts: BusyEvent[] = [];
    const deleted: string[] = [];
    let full = !cursor;
    let url =
      cursor ??
      `${BASE}/me/calendars/${encodeURIComponent(conn.externalCalendarId)}/calendarView/delta?startDateTime=${window.from.toISOString()}&endDateTime=${window.to.toISOString()}`;
    let deltaLink: string | undefined;

    const headers = { Prefer: 'outlook.timezone="UTC"' };
    try {
      for (;;) {
        const page = await providerFetch<MDeltaPage>("MICROSOFT", conn.tokens, url, { headers });
        for (const e of page.value) {
          if (e["@removed"]) {
            deleted.push(e.id);
            continue;
          }
          const busy = toBusy(e);
          if (busy) upserts.push(busy);
        }
        if (page["@odata.nextLink"]) {
          url = page["@odata.nextLink"];
          continue;
        }
        deltaLink = page["@odata.deltaLink"];
        break;
      }
    } catch (err) {
      // Graph returns 410 with "syncStateNotFound" when the delta token is stale.
      if (!(err instanceof CursorExpiredError) || !cursor) throw err;
      full = true;
      return this.fetchChanges(conn, null, window);
    }
    return { upserts, deletedExternalIds: deleted, cursor: deltaLink ?? "", full };
  }

  async createEvent(conn: ConnectionRef, draft: EventDraft): Promise<{ externalId: string }> {
    const body = {
      subject: draft.title,
      body: draft.description ? { contentType: "text", content: draft.description } : undefined,
      location: draft.location ? { displayName: draft.location } : undefined,
      start: { dateTime: draft.start.toISOString(), timeZone: "UTC" },
      end: { dateTime: draft.end.toISOString(), timeZone: "UTC" },
      singleValueExtendedProperties: [{ id: BOOKING_PROP_ID, value: draft.slotwiseBookingId }],
      ...(draft.attendeeEmail
        ? { attendees: [{ emailAddress: { address: draft.attendeeEmail }, type: "required" }] }
        : {}),
    };
    const res = await providerFetch<{ id: string }>(
      "MICROSOFT",
      conn.tokens,
      `${BASE}/me/calendars/${encodeURIComponent(conn.externalCalendarId)}/events`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { externalId: res.id };
  }

  async updateEvent(conn: ConnectionRef, externalId: string, patch: Partial<Pick<EventDraft, "start" | "end" | "title">>) {
    const body: Record<string, unknown> = {};
    if (patch.title) body.subject = patch.title;
    if (patch.start) body.start = { dateTime: patch.start.toISOString(), timeZone: "UTC" };
    if (patch.end) body.end = { dateTime: patch.end.toISOString(), timeZone: "UTC" };
    await providerFetch("MICROSOFT", conn.tokens, `${BASE}/me/events/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async deleteEvent(conn: ConnectionRef, externalId: string) {
    try {
      await providerFetch("MICROSOFT", conn.tokens, `${BASE}/me/events/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
    } catch (e) {
      if (e instanceof CursorExpiredError || (e instanceof CalendarApiError && e.status === 404)) return; // already gone
      throw e;
    }
  }

  async findEventByBookingId(conn: ConnectionRef, slotwiseBookingId: string): Promise<{ externalId: string } | null> {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${BOOKING_PROP_ID}' and ep/value eq '${slotwiseBookingId.replace(/'/g, "''")}')`;
    const url = `${BASE}/me/calendars/${encodeURIComponent(conn.externalCalendarId)}/events?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`;
    const res = await providerFetch<{ value: Array<{ id: string }> }>("MICROSOFT", conn.tokens, url);
    return res.value[0] ? { externalId: res.value[0].id } : null;
  }

  /** Graph subscriptions on events last < 7 days; renewal job extends daily. */
  async subscribe(conn: ConnectionRef, callbackUrl: string, secret: string): Promise<Subscription> {
    const expiration = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
    const res = await providerFetch<{ id: string; expirationDateTime: string }>(
      "MICROSOFT",
      conn.tokens,
      `${BASE}/subscriptions`,
      {
        method: "POST",
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl: callbackUrl,
          resource: `/me/calendars/${conn.externalCalendarId}/events`,
          expirationDateTime: expiration,
          clientState: secret,
        }),
      },
    );
    return { subscriptionId: res.id, expiresAt: new Date(res.expirationDateTime) };
  }

  async unsubscribe(conn: ConnectionRef, sub: Subscription) {
    await providerFetch("MICROSOFT", conn.tokens, `${BASE}/subscriptions/${encodeURIComponent(sub.subscriptionId)}`, {
      method: "DELETE",
    });
  }
}

function toBusy(e: MEvent): BusyEvent | null {
  if (!e.start?.dateTime || !e.end?.dateTime) return null;
  // With Prefer: outlook.timezone="UTC" the dateTime has no offset suffix → append Z.
  const z = (s: string) => (s.endsWith("Z") ? s : `${s}Z`);
  return {
    externalId: e.id,
    start: new Date(z(e.start.dateTime)),
    end: new Date(z(e.end.dateTime)),
    isAllDay: !!e.isAllDay,
    transparency: e.showAs === "free" ? "FREE" : "BUSY",
    slotwiseBookingId: e.singleValueExtendedProperties?.find((p) => p.id === BOOKING_PROP_ID)?.value ?? null,
  };
}
