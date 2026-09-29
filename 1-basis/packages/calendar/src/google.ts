/**
 * Google Calendar adapter — REST v3 via fetch.
 * Scopes needed at OAuth time: https://www.googleapis.com/auth/calendar.readonly
 * (busy cache) + https://www.googleapis.com/auth/calendar.events (write bookings).
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

const BASE = "https://www.googleapis.com/calendar/v3";
const BOOKING_PROP = "slotwiseBookingId";

interface GEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  transparency?: "opaque" | "transparent";
  extendedProperties?: { private?: Record<string, string> };
}

interface GEventList {
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = "GOOGLE" as const;

  async listCalendars(conn: ConnectionRef): Promise<CalendarInfo[]> {
    const res = await providerFetch<{
      items?: Array<{ id: string; summary: string; primary?: boolean; accessRole: string; timeZone?: string }>;
    }>("GOOGLE", conn.tokens, `${BASE}/users/me/calendarList?minAccessRole=reader`);
    return (res.items ?? []).map((c) => ({
      id: c.id,
      name: c.summary,
      primary: !!c.primary,
      canWrite: c.accessRole === "owner" || c.accessRole === "writer",
      ...(c.timeZone ? { timezone: c.timeZone } : {}),
    }));
  }

  async fetchChanges(conn: ConnectionRef, cursor: string | null, window: { from: Date; to: Date }): Promise<ChangeSet> {
    const cal = encodeURIComponent(conn.externalCalendarId);
    const upserts: BusyEvent[] = [];
    const deleted: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let full = !cursor;

    const run = async (useCursor: string | null) => {
      do {
        const params = new URLSearchParams({ singleEvents: "true", maxResults: "250", showDeleted: "true" });
        if (useCursor) params.set("syncToken", useCursor);
        else {
          params.set("timeMin", window.from.toISOString());
          params.set("timeMax", window.to.toISOString());
        }
        if (pageToken) params.set("pageToken", pageToken);
        const page = await providerFetch<GEventList>("GOOGLE", conn.tokens, `${BASE}/calendars/${cal}/events?${params}`);
        for (const e of page.items ?? []) {
          if (e.status === "cancelled") {
            deleted.push(e.id);
            continue;
          }
          const busy = toBusy(e);
          if (busy) upserts.push(busy);
        }
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
    };

    try {
      await run(cursor);
    } catch (err) {
      if (!(err instanceof CursorExpiredError)) throw err;
      full = true;
      pageToken = undefined;
      await run(null);
    }
    return { upserts, deletedExternalIds: deleted, cursor: nextSyncToken ?? cursor ?? "", full };
  }

  async createEvent(conn: ConnectionRef, draft: EventDraft): Promise<{ externalId: string }> {
    const cal = encodeURIComponent(conn.externalCalendarId);
    const body = {
      summary: draft.title,
      description: draft.description,
      location: draft.location,
      start: { dateTime: draft.start.toISOString() },
      end: { dateTime: draft.end.toISOString() },
      extendedProperties: { private: { [BOOKING_PROP]: draft.slotwiseBookingId } },
      ...(draft.attendeeEmail ? { attendees: [{ email: draft.attendeeEmail }] } : {}),
      reminders: { useDefault: true },
    };
    const res = await providerFetch<{ id: string }>("GOOGLE", conn.tokens, `${BASE}/calendars/${cal}/events`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { externalId: res.id };
  }

  async updateEvent(conn: ConnectionRef, externalId: string, patch: Partial<Pick<EventDraft, "start" | "end" | "title">>) {
    const cal = encodeURIComponent(conn.externalCalendarId);
    const body: Record<string, unknown> = {};
    if (patch.title) body.summary = patch.title;
    if (patch.start) body.start = { dateTime: patch.start.toISOString() };
    if (patch.end) body.end = { dateTime: patch.end.toISOString() };
    await providerFetch("GOOGLE", conn.tokens, `${BASE}/calendars/${cal}/events/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async deleteEvent(conn: ConnectionRef, externalId: string) {
    const cal = encodeURIComponent(conn.externalCalendarId);
    try {
      await providerFetch("GOOGLE", conn.tokens, `${BASE}/calendars/${cal}/events/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
    } catch (e) {
      // already gone (deleted by the user) is success for a delete
      if (e instanceof CursorExpiredError || (e instanceof CalendarApiError && e.status === 404)) return;
      throw e;
    }
  }

  async findEventByBookingId(conn: ConnectionRef, slotwiseBookingId: string): Promise<{ externalId: string } | null> {
    const cal = encodeURIComponent(conn.externalCalendarId);
    const params = new URLSearchParams({ privateExtendedProperty: `${BOOKING_PROP}=${slotwiseBookingId}`, maxResults: "1", showDeleted: "false" });
    const res = await providerFetch<GEventList>("GOOGLE", conn.tokens, `${BASE}/calendars/${cal}/events?${params}`);
    const hit = res.items?.find((e) => e.status !== "cancelled");
    return hit ? { externalId: hit.id } : null;
  }

  /** Google push channels live ≤ 7 days; the renewal job re-subscribes daily. */
  async subscribe(conn: ConnectionRef, callbackUrl: string, secret: string): Promise<Subscription> {
    const cal = encodeURIComponent(conn.externalCalendarId);
    const id = crypto.randomUUID();
    const res = await providerFetch<{ resourceId: string; expiration: string }>(
      "GOOGLE",
      conn.tokens,
      `${BASE}/calendars/${cal}/events/watch`,
      {
        method: "POST",
        body: JSON.stringify({ id, type: "web_hook", address: callbackUrl, token: secret, params: { ttl: "604800" } }),
      },
    );
    return { subscriptionId: id, resourceId: res.resourceId, expiresAt: new Date(Number(res.expiration)) };
  }

  async unsubscribe(conn: ConnectionRef, sub: Subscription) {
    await providerFetch("GOOGLE", conn.tokens, `${BASE}/channels/stop`, {
      method: "POST",
      body: JSON.stringify({ id: sub.subscriptionId, resourceId: sub.resourceId }),
    });
  }
}

function toBusy(e: GEvent): BusyEvent | null {
  const startRaw = e.start?.dateTime ?? e.start?.date;
  const endRaw = e.end?.dateTime ?? e.end?.date;
  if (!startRaw || !endRaw) return null;
  return {
    externalId: e.id,
    start: new Date(startRaw),
    end: new Date(endRaw),
    isAllDay: !e.start?.dateTime,
    transparency: e.transparency === "transparent" ? "FREE" : "BUSY",
    slotwiseBookingId: e.extendedProperties?.private?.[BOOKING_PROP] ?? null,
  };
}
