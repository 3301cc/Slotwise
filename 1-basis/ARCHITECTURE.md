# Slotwise — Architecture (MVP)

AI phone assistant + smart calendar scheduling. Built in Germany, all processing in the EU.

Status: **approved 2026-09-29 · M0 scaffold, M1 calendar-connect flow, M2 web booking with dynamic questions + round-robin routing implemented (pending first compile) · internal API hardened (§6) · double-booking guard (§4.6) · calendar sync via transactional outbox (§4.3) · repo fusion with the platform track (§0)** · Owner: DaiL

---

## 0. Repo fusion — website, app, platform in one monorepo

Two Slotwise code bases existed side by side: this one (the **app**: Next.js dashboard + booking pages, Python voice worker, calendar sync, routing — §1–§10 below) and the **platform track** (`slotwise-mono`: Vite marketing site, business layer with plans/entitlements/metering/adapters/state machine/outbox, its own Prisma schema, a queue worker). They were merged on 2026-09-29 without rewriting either — every part builds and tests as before, under one workspace:

| Part | Package | Origin | Role |
|---|---|---|---|
| `apps/site` | `@slotwise/site` | platform track (`apps/web-vite`) | **Website** slotwise.app: landing, Funktionen, KI-Agent, Preise, FAQ, Impressum/Datenschutz/AGB/AV-Vertrag. No login of its own — every CTA hands over to the app (`VITE_APP_URL`: `/login`, `/book/nordlicht/demo-call`). Copy and prices come from the platform's `content/marketing-de.json` and `config/plans.json`, so the website can never disagree with the entitlement checks or state a claim the content rules forbid. |
| `apps/web` + `apps/voice` | `@slotwise/web`, voice | app | **App** app.slotwise.app — everything in §1–§7. |
| `apps/worker` | `@slotwise/worker` | platform track | Platform composition root: BullMQ/pg-boss worker, calendar outbox relay (`LISTEN calendar_sync`), reconciler. |
| `packages/core` | `@slotwise/core` | app | App domain (availability engine, booking commit, routing, voice service). Unchanged name. |
| `packages/platform` | `@slotwise/platform` | platform track (was `@slotwise/core` there — renamed to avoid the clash) | Business layer: booking state machine + lifecycle, slot engine, entitlements, metering, adapters (CalDAV, Jitsi, Mollie), job queues, outbox, tenant alerts. 99 tests, no DB. Exports its JSON content (`./config/*`, `./content/*`) for the website. |
| `packages/platform-db` | `@slotwise/platform-db` | platform track (was `@slotwise/db`) | The platform's Prisma schema (snake_case tables, SQL migrations with triggers/EXCLUDE/views), PrismaDb adapter, drift check. **Own generated client** (`generated/`) and **own Postgres schema** (`PLATFORM_DATABASE_URL=…/slotwise?schema=platform`). |
| `infra/` | — | merged | One `docker-compose.yml` (Postgres 16 + Redis 7 + optional voice), nginx configs for the embed. |

**Two Prisma schemas, one Postgres.** The app schema (`apps/web/prisma`, PascalCase models, `?schema=public`) and the platform schema (`packages/platform-db`, snake_case, `?schema=platform`) live in separate Postgres schemas → separate `_prisma_migrations` histories, no table clashes, and each generated client has its own output directory (a pnpm workspace would otherwise let both `prisma generate` runs overwrite the same `node_modules/.prisma/client`). Today the **app schema is the runtime source of truth** for tenants, bookings and calendar sync; the platform schema backs `apps/worker` and the platform repositories.

**What overlaps, and the consolidation path** (next phase, not done in the fusion): both tracks model the same things with different names. The mapping below is the migration plan — the platform's business features (plans, metering, adapters, state machine) are the long-term home for these concepts; the app's tables carry the live data.

| App (`apps/web/prisma`) | Platform (`packages/platform-db`) | Consolidation |
|---|---|---|
| `Organization` | `Tenant` (+ `BillingSettings`, `TenantPrivacySettings`, `Plan`/`TenantAiPackage`) | Tenant gains what Organization has (slug, locale, retention); Organization → Tenant |
| `User` (host) | `Host` | one table; auth (Auth.js) stays on the app side |
| `EventType` (+ `EventTypeHost.match`) | `EventTypePolicy` | policy fields merge into EventType; answer-based routing (§4.5) stays |
| `Booking` (CONFIRMED/RESCHEDULED/CANCELLED/NEEDS_ATTENTION) | `Booking` (9-state machine, `BookingStatusTransition`, `BookingEvent`) | adopt the platform state machine; map the four app states onto it |
| `CalendarConnection` | `CalendarConnection` (+ `sync_state`) | same concept; provider enum union (google, microsoft, caldav, exchange_onprem) |
| `CalendarSyncJob` (§4.3) | `calendar_sync_jobs` (lease, per-booking ordering, NOTIFY) | one outbox — the platform version adds LISTEN/NOTIFY wake-ups and per-booking ordering, the app version adds tenant attribution + the alert chain (§4.7) |
| `SystemAlert` (§4.7) | `tenant_alerts` (`AlertView`) | same shape; the dashboard banner already speaks `syncHealth`, `AlertView` is the platform's contract for it |
| `CallInteraction` (+ `lastCommandAt`, §6 ordering) | `AgentState` | keep the app's model; the platform's `ToolRouter` (OTP verification for changes by phone) is the feature to adopt |
| — | `UsageEvent`/`UsagePeriod`/`UsageAlert`, `SmsPriceList`, `SubprocessorSnapshot`, `TenantIntegration` | platform-only: metering, hard-stop, subprocessor list — wire into the app when billing ships |

Rule for the interim: new business logic goes into `packages/platform` when it is about plans, billing, metering or adapters, and into `packages/core` when it is about availability, booking commit, routing or the voice flow. Nothing is duplicated a second time.

---

## 1. Scope

**MVP delivers**

1. Two-way calendar sync — Google Calendar and Microsoft 365/Outlook.
2. AI voice assistant — answers inbound calls on a German number, checks live availability, books/reschedules/cancels appointments, hands off to a human when out of scope.
3. Web app — dashboard (KPIs, calendar, Live AI Agent Feed), bookings, availability rules, event types, agent settings, public booking page. Design: `docs/design/slotwise-dashboard-v1.html`.

**Explicitly out of MVP:** outbound campaigns (reactivation/upsell), round-robin/team routing, CRM integrations, payments, SSO/SCIM, iCloud/Exchange on-prem.

---

## 2. Decisions

| Area | Decision | Rationale |
|---|---|---|
| Web app | Next.js (App Router, TypeScript), deployed on **Vercel `fra1`** | UI + API + webhooks in one deployable; zero-ops |
| Database | **PostgreSQL on Neon (Frankfurt)** + Prisma | Relational fits bookings; branching for previews |
| Auth | Auth.js v5, Google + Microsoft Entra providers | One OAuth consent = login **and** calendar tokens |
| Calendar | **Own adapters** (Google Calendar API, Microsoft Graph) behind a `CalendarProvider` interface; **Cronofy** as third adapter later for Exchange/iCloud | No extra subprocessor for the 90 % case; Cronofy (DE data centre) only where it saves months |
| Telephony | **Twilio, region IE1** (Ireland) — Programmable Voice + Media Streams (both available in IE1) | German numbers, EU media path; Telnyx as fallback provider |
| Voice pipeline | **Own pipeline on Pipecat** (Python) — `apps/voice`, deployed on **Fly.io `fra`** (Hetzner as prod path) | Full control, no US voice-AI middleman; Pipecat handles VAD, barge-in, turn-taking |
| STT / TTS | **AWS Transcribe streaming + AWS Polly**, `eu-central-1` | Same AVV as the LLM, all Frankfurt; Azure Speech (EU) is the swap option if German TTS quality is not good enough |
| LLM | **Claude via AWS Bedrock `eu-central-1`** (Haiku-class for turn-by-turn, Sonnet-class for summaries) | EU processing, strong tool use, one AWS AVV for the whole voice stack |
| Jobs | **Transactional outbox** `CalendarSyncJob` in Postgres (Prisma): a worker (`pnpm --filter @slotwise/web jobs`) or the **Vercel Cron** route `/api/cron/outbox` claims due rows with `FOR UPDATE SKIP LOCKED` | Calendar push/pull, renewals, confirmations, retention — no Redis, no queue library; job rows commit in the same transaction as the booking |
| UI | Tailwind v4 + shadcn/ui, Geist font, tokens from the mockup | Matches design 1:1, light + dark |
| Monorepo | Turborepo + pnpm | Two deployables (web, voice) share types and contracts |

Why the voice pipeline is a separate service: Twilio Media Streams is a long-lived WebSocket carrying 8 kHz μ-law audio both ways. Vercel functions cannot hold that connection; the pipeline needs a persistent process with sub-second round-trips to STT/LLM/TTS.

---

## 3. System overview

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                       EU only                                │
                    │                                                              │
 Owner (browser) ───┼──▶ apps/web · Next.js · Vercel fra1 ──────▶ Neon Postgres    │
 Public booker ─────┼──▶   /book/[slug]                           (Frankfurt)      │
                    │      /api/auth, /api/bookings                  ▲             │
                    │      /api/calendar/webhooks/{google,ms}        │ outbox      │
                    │      /api/internal/voice/*  ◀──────┐           │ jobs        │
                    │                                    │ HMAC      │             │
 Google Calendar ◀──┼──▶ CalendarProvider adapters       │           │             │
 Microsoft Graph ◀──┼──▶ (OAuth tokens encrypted)        │           │             │
                    │                                    │           │             │
 Caller ☎ ──▶ Twilio│IE1 ──Media Streams (wss)──▶ apps/voice · Pipecat · Fly fra  │
                    │                                    │                         │
                    │                                    ├──▶ AWS Transcribe  ─┐   │
                    │                                    ├──▶ Bedrock Claude   ├ eu-central-1
                    │                                    └──▶ AWS Polly       ─┘   │
                    └──────────────────────────────────────────────────────────────┘
```

Three runtime components, one database, one internal contract:

- **apps/web** owns all business logic: users, availability engine, bookings, calendar sync, the dashboard, and the internal API the voice worker calls.
- **apps/voice** owns the real-time call: audio in/out, speech, the conversation, tool calls. It holds **no business rules** and **no database access** — every decision goes through `apps/web`'s internal API.
- **Neon Postgres** is the single source of truth. External calendars are synchronized into a busy-time cache; bookings are pushed out to them.

---

## 4. Core flows

### 4.1 Inbound call

1. Twilio receives the call on the org's number → `POST https://voice.slotwise.app/twilio/incoming` (signature-verified) → returns TwiML `<Connect><Stream url="wss://voice.slotwise.app/ws/{callSid}"/>`.
2. `apps/voice` opens the pipeline: Twilio serializer → Transcribe STT → context/LLM (Bedrock Claude) → Polly TTS → back to Twilio. Silero VAD for barge-in.
3. First utterance is the disclosure (DE/EN by number config): *"Hallo, hier ist der digitale Assistent von {org}. Ich kann Termine buchen, verschieben oder absagen. Wie kann ich helfen?"*
4. `apps/web` is called once at start: `POST /api/internal/voice/session` with `{callSid, to, from}` → returns agent config (persona, language, event types, opening hours, escalation number) and creates a `CallInteraction` row (status `in_progress`).
5. Claude drives the conversation with **tools** (Bedrock tool use):

   | Tool | What it does |
   |---|---|
   | `check_availability(eventTypeSlug, dateFrom, dateTo, preferredTimes?)` | Free slots from the availability engine, already merged with external busy times |
   | `book_appointment(eventTypeSlug, startsAt, name, phone, note?)` | Creates the booking + provider calendar event, sends SMS confirmation; idempotent on `callSid + startsAt` |
   | `find_bookings(phone)` | Existing upcoming bookings for the caller (matched on E.164 phone) |
   | `reschedule_appointment(bookingId, newStartsAt)` / `cancel_appointment(bookingId)` | Self-explanatory, both idempotent |
   | `transfer_to_human(reason)` | Twilio `<Dial>` to the escalation number; logs status `transferred` |
   | `end_call(summary, outcome)` | Closes the interaction, stores the one-paragraph summary shown in the feed |
   | `request_callback(name, phone?, topic, preferredTime?)` | Offline tool for outages: captures the callback wish locally, delivered later; outcome `CALLBACK_REQUESTED` |

6. On hangup: `apps/voice` posts the final outcome (`booked / rescheduled / cancelled / transferred / missed / info`), duration, summary, and — only if the org enabled it — the transcript. Recording is **off by default** (§ 201 StGB requires consent; not needed for the MVP).

Latency budget per turn: STT end-of-speech → LLM first token → TTS first audio ≤ 1.2 s p50. Haiku-class model for the loop; summaries can use a larger model after the call.

**When `apps/web` is unreachable (502/504/timeout):** the client retries with exponential backoff inside a per-call deadline (booking ≤ 12 s); if that fails the call switches to the *fallback script* — the assistant says it cannot finalise the appointment right now, notes the caller's number and promises a callback within five minutes, records it with the offline `request_callback` tool, and ends the call. The callback wish is checkpointed to a local SQLite outbox the moment it is voiced; at hangup every result is written to that outbox **before** any network call (write-ahead), delivered inline when possible, otherwise by a sweeper with per-item backoff — undeliverable items land in a dead-letter status with a reason, never in the void. Queue latency (`lag_ms`) and backlog stats are logged per delivery/sweep (`CALLBACK_REQUESTED` card in the feed once delivered). If even the session lookup fails, the call is answered in degraded mode with the same script. Details: `apps/voice/README.md`.

### 4.2 Web booking (public page)

`/book/[org]/[eventType]` → availability engine → pick slot → name/email/phone → server action → `commitBooking()` (§4.5) — the same write path as the voice tool → provider calendar event + confirmation email/SMS. One code path for both channels.

### 4.3 Calendar sync (two-way) — via the outbox, never inside a request

```
Provider ──push notification──▶ /api/calendar/webhooks/{google|microsoft}
                                  └─ CalendarSyncJob PULL_CHANGES (dedupeKey pull:<conn>)
Booking insert / reschedule / cancel ──(same $transaction)──▶ CalendarSyncJob PUSH_BOOKING (dedupeKey push:booking:<id>)
                                                            + SEND_CONFIRMATION
Worker / cron: claim due jobs (FOR UPDATE SKIP LOCKED) ──▶ handler
   PULL_CHANGES   incremental fetch (Google syncToken / Graph delta) ──▶ upsert busy cache; 410 → full resync;
                  our event moved/deleted externally ──▶ booking NEEDS_ATTENTION
   PUSH_BOOKING   idempotent: findEventByBookingId(slotwiseBookingId) before create; cancel → delete (404 = done)
   failure        classify → retryable (5xx/429/network; Retry-After honoured) → PENDING with backoff 30 s·1·2·4 min,
                  5th failure → PERMANENT_FAILED · fatal (400/404) → PERMANENT_FAILED at once · reauth (401/invalid_grant) →
                  connection REAUTH_REQUIRED + PERMANENT_FAILED; every outcome written to CalendarConnection.lastError
   PERMANENT_FAILED ──▶ alerting chain (§4.7): SystemAlert for the tenant → dashboard banner → audit → optional webhook
Schedulers: PULL for all connections every 15 min (missed-webhook safety net), renewals daily, retention purge daily
```

The booking transaction (§4.6) never calls a provider. The outbox row is the contract: if it committed, the calendar entry *will* be attempted until it succeeds or a human is told — "told" meaning the tenant's dashboard banner (§4.7), not a log line.

`CalendarProvider` interface (`packages/calendar`):

```ts
interface CalendarProvider {
  listCalendars(conn): Promise<Calendar[]>
  fetchChanges(conn, calendarId, cursor?): Promise<{ events: BusyEvent[]; cursor: string; full: boolean }>
  createEvent(conn, calendarId, draft: EventDraft): Promise<{ externalId: string }>
  updateEvent(conn, calendarId, externalId, patch): Promise<void>
  deleteEvent(conn, calendarId, externalId): Promise<void>
  subscribe(conn, calendarId, callbackUrl): Promise<{ subscriptionId; expiresAt }>
  unsubscribe(conn, subscriptionId): Promise<void>
}
```

Implementations: `google.ts`, `microsoft.ts`; later `cronofy.ts` behind the same interface.

### 4.4 Availability engine (`packages/core/availability`)

Inputs: `AvailabilityRule[]` (weekly windows per user, IANA timezone), `DateOverride[]`, `EventType` (duration, buffers, min notice, max horizon, slot interval), existing `Booking[]`, `CalendarEvent[]` busy cache for all connected calendars marked `checkForConflicts`.
Output: sorted list of free `[start, end)` slots in UTC, rendered in the requester's timezone.
Pure function, no I/O → unit-tested (node:test). It only *computes*; it never reserves.

### 4.5 Custom questions + team routing

*Custom questions:* `EventType.bookingFields` holds a JSON list of `BookingField`s (`text | textarea | email | phone | number | select | multiselect | checkbox`, `required`, `options` …). `buildAnswersSchema(fields)` (`packages/contracts/booking-fields.ts`) turns it into one zod object used **three times**: react-hook-form on the booking page (instant feedback), the server action (authority, before routing), and the voice service's `answersValidator` (the assistant is told which required questions are still missing and asks them). Answers are stored in `Booking.answers` (⚑, pseudonymised with the rest after 90 days).

*Routing:* `EventType.routing = SINGLE` books `hostUserId`; `ROUND_ROBIN` picks from the `EventTypeHost` pool — only members free at the slot, then higher `priority`, fewer upcoming bookings, least recently assigned (`packages/core/src/booking/routing.ts`). Availability shown to callers/visitors is the **union** over the pool. Each candidate is committed through `commitBooking()` (§4.6), so a lost race just moves on to the next member; three simultaneous requests for one slot land on three different people, the fourth gets `SLOT_TAKEN`.

*Answer-based routing:* a pool member can carry segment rules in `EventTypeHost.match` (JSON, shape `routingMatch` in contracts, e.g. `[{ field: "employees", values: ["50-249", "250+"] }]` = "Ben takes enterprises"). `rankCandidates()` applies them to the **validated** answers before the round-robin ranking: members whose rules match → tier `MATCH` (tried first, round-robin among themselves); members without rules → tier `FALLBACK` (catch-all, only when no matching specialist is free); members whose rules don't match → never tried. Rules on one member are AND-ed, values OR-ed; multiselect answers match any-of. A pool where every member has rules is strictly segmented — a payload nobody is configured for is rejected with `NoEligibleHostError` (voice `NO_ELIGIBLE_HOST` 422 → assistant escalates; web: "kein Ansprechpartner hinterlegt") before any lock is taken, never silently handed to the wrong person. `RoutedBooking.routedBy` (`SINGLE | MATCH | FALLBACK`) records why a host was chosen. Determinism: same pool state + same answers → same host; order of arrival, rotation state or load never move a request across segments (`packages/core/test/routing.test.ts`, `packages/contracts/test/routing-answers.test.ts`). Known limit: public availability is still the union over the whole pool, so on a strictly segmented pool a visitor can pick a slot only the *other* segment can serve and gets `SLOT_TAKEN`; filtering slots by answers (ask the questions first) is a follow-up.

### 4.6 Booking commit — no double bookings (`packages/core/src/booking/`)

Phone assistant and web page share one write path, `commitBooking()`, with three layers (innermost is authoritative):

| Layer | Where | Scope | What it does |
|---|---|---|---|
| 1. Slot reservation | `SlotReservations.tryReserve()` — **synchronous** | one process | Marks the guard window (buffers included) as "being written" for the milliseconds of the commit. Two requests in the same millisecond are ordered by the event loop; the second is rejected immediately (`SLOT_TAKEN`, reason `reserved`) without touching the DB. Active reservations are merged into the busy list, so `check_availability` and the web slot picker never offer a slot that is mid-write. TTL 5 s → a crashed request cannot poison a slot. |
| 2. Atomic insert | `createBookingIfFree()` — Prisma: `$transaction` + `pg_advisory_xact_lock(hashtext('booking:'‖hostUserId))` + `SET LOCAL lock_timeout='3s'`, READ COMMITTED; MemoryRepo: `KeyedMutex` per host | all instances | Pessimistic per-host lock held until COMMIT. A parallel transaction waits (≤ 3 s), then re-counts conflicts and sees the committed row → `null`. Lock wait > 3 s → `null` as well (caller offers another time). |
| 3. Exclusion constraint | `booking_no_overlap` — `EXCLUDE USING gist ("hostUserId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE status <> 'CANCELLED'` (`prisma/sql`, applied by `pnpm db:migrate`) | the database | Postgres itself refuses overlapping non-cancelled bookings per host, whatever code path writes them. SQLSTATE `23P01` is mapped to `null`. |

Tests: `packages/core/test/routing.test.ts`, `packages/contracts/test/booking-fields.test.ts`, `packages/core/test/availability.test.ts` → *concurrency* suite — same-millisecond double book, 25-way stress, reservation overlay, and a regression guard proving the unlocked repo would double-book.

---

### 4.7 Alerting chain — a dead job is never silent (`apps/web/src/server/alerts/`)

```
runDueJobs ── fail() → PERMANENT_FAILED ──▶ raiseSyncAlert(job, {reason, message, attempts})
   1. attribute the job to a tenant: job.organizationId, else connection.user.organizationId, else booking.organizationId
      (PUSH_BOOKING carries no connectionId — the host's destination calendar is resolved like the handler does)
   2. describeSyncFailure() (pure, tested): kind · severity · German text · dedupeKey
        reauth (401 / invalid_grant)  → CALENDAR_REAUTH_REQUIRED  CRITICAL  "neu verbinden", no retry button
        PUSH_BOOKING / PULL_CHANGES   → CALENDAR_SYNC_BLOCKED     CRITICAL  retry button
        RENEW_SUBSCRIPTION            → CALENDAR_SYNC_BLOCKED     WARNING   (periodic pull still runs)
        SEND_CONFIRMATION             → CONFIRMATION_FAILED       WARNING
   3. SystemAlert upsert by dedupeKey ("calendar_sync:conn:<id>" | "…:booking:<id>" | "…:org:<id>"):
        new → OPEN · repeat → occurrences+1, text refreshed, acknowledgement kept · RESOLVED cause returns → re-opened
        WARNING that escalates to CRITICAL → re-shouts (acknowledgement cleared)
   4. AuditLog alert.raised/reopened (actor system) · console.error · ALERT_WEBHOOK_URL POST {text, alert} (Slack-compatible,
      5 s timeout, fire-and-forget, no attendee data, no tokens) — only on new/re-opened, never per retry

Resolution (automatic, "system"):  a job of the same shape succeeds → resolveAlertsForJob() · recordSuccess(connection) →
   resolveAlerts({connectionId}) · owner reconnects (connectCalendar) → requeuePermanentFailed(connection) + resolve
   (bookings made while the token was dead finally reach the calendar) · owner disconnects → resolve (cause removed)
Owner actions (dashboard):  ack → ACKNOWLEDGED (slim bar while the cause persists) · retry → requeue the tenant's
   PERMANENT_FAILED jobs behind the alert (refused for a dead token → reconnect instead); the alert closes on the next success
```

Surface: `GET /api/alerts` (session-scoped `syncHealth`: `blocked`, open alerts with connection + owner, tenant job counts) and
`POST /api/alerts/:id {action: ack|retry}`. The dashboard **layout** renders `<SyncAlertBanner>` above every page from the
server-fetched state and re-polls every 60 s while the tab is visible: CRITICAL+OPEN = full-width red banner with `role="alert"`;
acknowledged / WARNING = one slim line. The home page additionally flags the "Open slots" KPI while blocked (external busy
times may be missing). `blocked` = any CRITICAL alert that is OPEN or ACKNOWLEDGED. Why a table, not a user flag: one alert per
cause (dedupe), history (audit), ack/resolve semantics, and several team members' calendars per tenant.

## 5. Data model

All tables carry `organizationId` (tenant isolation) and `createdAt/updatedAt`. Times are stored in UTC (`timestamptz`); timezones as IANA strings. Personal data fields are marked ⚑ in comments for the data map.

```prisma
// ---------- tenancy & auth ----------
model Organization {
  id            String   @id @default(cuid())
  name          String
  slug          String   @unique          // booking URL: /book/{slug}
  timezone      String   @default("Europe/Berlin")
  locale        String   @default("de")
  dataRetentionDays Int  @default(30)     // transcripts/summaries
  users         User[]
  eventTypes    EventType[]
  bookings      Booking[]
  agents        AiAgent[]
  phoneNumbers  PhoneNumber[]
  interactions  CallInteraction[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model User {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  email          String   @unique         // ⚑
  name           String?                  // ⚑
  image          String?
  timezone       String   @default("Europe/Berlin")
  role           Role     @default(OWNER)
  accounts       Account[]                // Auth.js
  sessions       Session[]                // Auth.js
  calendarConnections CalendarConnection[]
  availabilityRules   AvailabilityRule[]
  dateOverrides       DateOverride[]
  bookings       Booking[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
enum Role { OWNER MEMBER }

// Account / Session / VerificationToken: standard Auth.js Prisma adapter tables.
// Account.refresh_token / access_token are stored encrypted (AES-256-GCM, app-level).

// ---------- calendars ----------
model CalendarConnection {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider       CalendarProviderKind         // GOOGLE | MICROSOFT | CRONOFY
  accountId      String                       // FK to Auth.js Account (token source)
  externalCalendarId String
  displayName    String
  isDestination  Boolean  @default(false)      // bookings get written here (exactly one per user)
  checkForConflicts Boolean @default(true)
  syncCursor     String?                      // Google syncToken / Graph deltaLink
  subscriptionId String?
  subscriptionExpiresAt DateTime?
  lastSyncedAt   DateTime?
  status         ConnectionStatus @default(ACTIVE)   // ACTIVE | REAUTH_REQUIRED | DISABLED
  events         CalendarEvent[]
  @@unique([userId, provider, externalCalendarId])
}
enum CalendarProviderKind { GOOGLE MICROSOFT CRONOFY }
enum ConnectionStatus { ACTIVE REAUTH_REQUIRED DISABLED }

// Busy-time cache. Data minimisation: no titles/attendees of foreign events, only the time block.
model CalendarEvent {
  id             String   @id @default(cuid())
  connectionId   String
  connection     CalendarConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  externalId     String
  startsAt       DateTime
  endsAt         DateTime
  isAllDay       Boolean  @default(false)
  transparency   Transparency @default(BUSY)   // BUSY | FREE (free events don't block)
  bookingId      String?  @unique              // set when the event is one we created
  booking        Booking? @relation(fields: [bookingId], references: [id])
  updatedAt      DateTime @updatedAt
  @@unique([connectionId, externalId])
  @@index([connectionId, startsAt, endsAt])
}
enum Transparency { BUSY FREE }

// ---------- availability ----------
model AvailabilityRule {
  id        String @id @default(cuid())
  userId    String
  user      User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  weekday   Int                 // 0 = Sunday … 6
  startTime String              // "09:00" local time in user.timezone
  endTime   String              // "17:00"
  @@index([userId, weekday])
}

model DateOverride {                       // holidays, one-off hours
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  date      DateTime @db.Date
  startTime String?                        // null + null = unavailable all day
  endTime   String?
  @@unique([userId, date])
}

model EventType {                           // "Demo call · 30 min"
  id             String @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  slug           String
  title          String
  description    String?
  durationMin    Int      @default(30)
  bufferBeforeMin Int     @default(0)
  bufferAfterMin  Int     @default(0)
  slotIntervalMin Int     @default(30)
  minNoticeMin   Int      @default(120)
  maxDaysAhead   Int      @default(60)
  location       LocationKind @default(PHONE)   // PHONE | VIDEO | IN_PERSON
  hostUserId     String                          // MVP: single host; round-robin later
  isActive       Boolean  @default(true)
  bookableByAi   Boolean  @default(true)
  bookings       Booking[]
  @@unique([organizationId, slug])
}
enum LocationKind { PHONE VIDEO IN_PERSON }

// ---------- bookings ----------
model Booking {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  eventTypeId    String
  eventType      EventType @relation(fields: [eventTypeId], references: [id])
  hostUserId     String
  host           User     @relation(fields: [hostUserId], references: [id])
  startsAt       DateTime
  endsAt         DateTime
  status         BookingStatus @default(CONFIRMED)
  source         BookingSource                  // WEB | AI_PHONE | MANUAL
  attendeeName   String                         // ⚑
  attendeePhone  String?                        // ⚑ E.164
  attendeeEmail  String?                        // ⚑
  attendeeTz     String   @default("Europe/Berlin")
  note           String?                        // ⚑ caller's stated reason, ≤ 500 chars
  answers        Json?                          // ⚑ answers to EventType.bookingFields
  cancelReason   String?
  interactionId  String?  @unique               // the call that created it
  interaction    CallInteraction? @relation(fields: [interactionId], references: [id])
  calendarEvent  CalendarEvent?
  reminders      Reminder[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([organizationId, startsAt])
  @@index([hostUserId, startsAt, endsAt])
  @@index([attendeePhone])
}
enum BookingStatus { CONFIRMED RESCHEDULED CANCELLED NEEDS_ATTENTION }
enum BookingSource { WEB AI_PHONE MANUAL }

model Reminder {
  id        String   @id @default(cuid())
  bookingId String
  booking   Booking  @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  channel   Channel                          // SMS | EMAIL
  sendAt    DateTime
  sentAt    DateTime?
}
enum Channel { SMS EMAIL }

// ---------- AI agents & telephony ----------
model AiAgent {
  id             String  @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  name           String  @default("Assistent")
  languages      String[] @default(["de", "en"])
  voiceId        String  @default("Vicki")         // Polly voice; swap per TTS provider
  greeting       String?                           // overrides default disclosure text
  persona        String?                           // free-text instructions merged into system prompt
  bookableEventTypeIds String[]
  escalationPhone String?                          // transfer_to_human target
  businessHoursOnly Boolean @default(false)
  storeTranscripts Boolean @default(false)         // default off (data minimisation)
  isActive       Boolean  @default(true)
  phoneNumbers   PhoneNumber[]
  interactions   CallInteraction[]
}

model PhoneNumber {
  id             String @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  agentId        String?
  agent          AiAgent? @relation(fields: [agentId], references: [id])
  e164           String  @unique                  // +4930…
  provider       String  @default("twilio")
  providerSid    String
  region         String  @default("ie1")
}

// One row per call = one card in the Live AI Agent Feed.
model CallInteraction {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  agentId        String
  agent          AiAgent  @relation(fields: [agentId], references: [id])
  direction      CallDirection                     // INBOUND | OUTBOUND
  providerCallId String   @unique                  // Twilio CallSid
  fromNumber     String                            // ⚑ masked in UI (+49 30 4467 ••81)
  toNumber       String
  startedAt      DateTime
  endedAt        DateTime?
  durationSec    Int?
  outcome        CallOutcome @default(IN_PROGRESS)
  summary        String?                           // ⚑ one paragraph, LLM-written
  language       String?
  transcript     Json?                             // ⚑ only if agent.storeTranscripts
  toolCalls      Json?                             // audit: which tools, which args, result codes
  expiresAt      DateTime                          // = startedAt + org.dataRetentionDays → purge job
  booking        Booking?
  @@index([organizationId, startedAt])
  @@index([expiresAt])
}
enum CallDirection { INBOUND OUTBOUND }
enum CallOutcome { IN_PROGRESS BOOKED RESCHEDULED CANCELLED CONFIRMED TRANSFERRED MISSED INFO FAILED }

// ---------- ops ----------
model WebhookEvent {                         // idempotency for Twilio/Google/Graph callbacks
  id         String   @id                    // provider event id / signature hash
  provider   String
  receivedAt DateTime @default(now())
  processedAt DateTime?
}

model AuditLog {
  id             String   @id @default(cuid())
  organizationId String
  actorType      String                         // user | ai_agent | system
  actorId        String?
  action         String                         // booking.created, booking.cancelled, calendar.connected …
  targetType     String
  targetId       String
  meta           Json?
  createdAt      DateTime @default(now())
  @@index([organizationId, createdAt])
}
```

Feed KPIs on the dashboard are plain aggregates: bookings this week (`Booking`), calls handled / resolved (`CallInteraction.outcome`), open slots this week (availability engine).

---

## 6. Internal API — `apps/voice` → `apps/web`

Base: `https://app.slotwise.app/api/internal/voice/`.

**Auth — two layers, one secret (`INTERNAL_SHARED_SECRET`, ≥ 32 chars, identical in both apps):**

```
Authorization: HMAC-SHA256 <ts>:<nonce>:<sig>      sig = HMAC_SHA256(secret, ts \n nonce \n METHOD \n path \n bodySha256)
X-Body-SHA256: <sha256 hex of the raw body>        (empty body → sha256(""))
```

1. `apps/web/src/middleware.ts` (Edge, matcher `/api/internal/:path*`) verifies scheme, format, ±60 s timestamp and the signature — **without reading the body** — and answers `401` before any route handler, Prisma client or business code runs. New routes under `/api/internal/` are covered automatically.
2. `internalRoute()` (`apps/web/src/lib/api.ts`) wraps every handler: verifies again (tests/misconfigured matcher), checks `sha256(body) === X-Body-SHA256` (binds the body to the signature), claims the nonce in `WebhookEvent` (`internal:<nonce>`, unique → exact replays inside the window get `401`), validates the payload with Zod, then calls the handler.

The client side lives in `apps/web/src/lib/hmac.ts` (`signRequest`, WebCrypto, runs in Edge/Node/tests) and `apps/voice/app/slotwise_client.py` (`sign_headers`); both are pinned to the same known vector in `hmac.test.ts` / `tests/test_signing.py`. Never send the raw secret over the wire, never include the query string in `path`.

| Method | Path | Body → Response |
|---|---|---|
| POST | `/session` | `{callSid, from, to}` → `{interactionId, agent, eventTypes[], org{tz, locale}}` |
| POST | `/availability` | `{interactionId, eventTypeSlug, from, to}` → `{slots: [{start, end}]}` (≤ 20 slots, engine picks spread) |
| POST | `/bookings` | `{interactionId, eventTypeSlug, startsAt, attendee{name, phone, note}, answers?, clientTimestamp}` → `{id, startsAt, alreadyExisted, …}` |
| GET | `/bookings?interactionId=&phone=&clientTimestamp=` | → `{bookings: [...]}` |
| PATCH | `/bookings/{id}` | `{action: "reschedule", startsAt, clientTimestamp}` or `{action: "cancel", reason?, clientTimestamp}` — `409 STALE_COMMAND` when outranked |
| POST | `/session/{id}/end` | `{outcome, durationSec, summary, transcript?, callback?, clientTimestamp}` → `{ok, outcome, ignored?}` |

Zod schemas for these live in `packages/contracts` and are exported as JSON Schema for the Python side (generated at build). The **mock endpoint in Step 3** implements `/session`, `/availability`, `/bookings` against seed data so the call flow can be exercised with `curl` before any telephony exists.

**Ordering — a late command never undoes a later one.** Requests of one call can arrive out of order: the client retries with backoff (a "reschedule" attempt stuck behind a proxy lands after the caller's "cancel" went through), the outbox sweeper delivers a `call_started`/callback checkpoint hours later, the model may emit two tool calls in one turn. Sequence numbers from the HTTP layer would say nothing about *what the caller said when*, so the voice worker stamps every request with `clientTimestamp` — the unix-ms time of the **speech event** behind it: `SpeechClock` (a frame processor right after STT) records the wall clock of each final transcription, `CallState.event_timestamp_ms()` uses it (falls back to "now" when older than 90 s) and makes it strictly increasing within the call; the stamp is chosen once per tool call, so every retry re-sends the same value; the hangup result is stamped last, the `call_started` checkpoint at call start. On the web side the stamp travels as `CommandStamp` into the repo write itself: `createBookingIfFree` / `updateBooking` / `updateInteraction` run `SELECT … FOR UPDATE` on the `CallInteraction` row **in the same transaction** as the change, refuse when `lastCommandAt > stamp` (`StaleCommandError` → `409 STALE_COMMAND`, nothing written) and otherwise record the stamp as `lastCommandAt`/`lastCommandTool`. Equal stamps pass, so a retried command hits the existing idempotency (`alreadyExisted`, cancel-of-cancelled) instead of the guard. The row lock serialises all stamped writes of one call across every instance — the newer command wins whatever arrives first. Tested on three layers: `packages/core/test/ordering.test.ts` (service + MemoryRepo: both arrival orders ×20, three-command race, and a *control* run without stamps that reproduces the lost update), `apps/web/src/server/voice/ordering.integration.test.ts` (Prisma repo on real Postgres, `RUN_DB_TESTS=1`: the `FOR UPDATE` window held open while the second transaction arrives, equal stamps, host→call vs call→booking lock order without deadlock, unguarded control), and `apps/voice/tests/test_ordering.py` + `test_speech_clock.py` (stamp source, monotonicity, identical body across re-signed retries, `STALE_COMMAND` handling). A stale `end` (checkpoint after a booking) answers `ok: true, ignored: true` — the call is closed, outcome and summary untouched, and the outbox deletes the row. The Python guard turns `STALE_COMMAND` into "do not retry; call `find_bookings` and tell the caller the current state". Without a stamp (older client, demo script) nothing is enforced. Only stamps of the same call are ever compared, so clock skew between machines is irrelevant; a stamp more than 5 min in the future is rejected as garbage.

---

## 7. Security & DSGVO

**Data map (what, why, where, how long)**

| Data | Purpose (Art. 6) | Store | Region | Retention |
|---|---|---|---|---|
| Owner account (email, name) | Contract | Neon | Frankfurt | Account lifetime |
| OAuth refresh tokens | Contract (calendar sync) | Neon, AES-256-GCM | Frankfurt | Until disconnect |
| External calendar busy blocks | Legitimate interest (conflict check) — times only, no titles | Neon | Frankfurt | Rolling window −7 / +90 days |
| Booking attendee (name, phone/email, note) | Contract / pre-contract | Neon | Frankfurt | Until 90 days after appointment, then pseudonymised |
| Call audio | — | **not stored** | Twilio IE1 transit, AWS eu-central-1 streaming | 0 |
| Call summary + masked number | Legitimate interest (feed, quality) | Neon | Frankfurt | `Organization.dataRetentionDays` (default 30) |
| Transcript | Consent per org (`storeTranscripts`) | Neon | Frankfurt | same |
| Logs | Security | Vercel / Fly | fra | 7 days, phone numbers masked |

**Subprocessors (AVV/DPA each):** Vercel (fra1), Neon (Frankfurt), Twilio (IE1), AWS (eu-central-1), Fly.io (fra), Google (calendar API — data controller's own account), Microsoft (Graph — same). Retell/Vapi/ElevenLabs/Deepgram: none.

**Controls**

- AI disclosure at call start (Art. 13 DSGVO, AI Act Art. 50); opt-out "human please" → transfer.
- Recording off; transcripts off by default; summaries purged by the nightly `retention.purge` job (`CallInteraction.expiresAt`).
- Row-level tenant isolation via `organizationId` in every query (Prisma extension enforces it), no cross-org lookups by phone.
- Tokens encrypted with `TOKEN_ENCRYPTION_KEY` (32 bytes, env; KMS later). Never logged.
- Twilio request signature validation; HMAC on internal API; Google/Graph webhook tokens validated; all webhook handlers idempotent.
- Deletion: `DELETE /api/me` (owner) and `POST /api/bookings/{id}/erase` (attendee request) cascade + audit entry.
- Data minimisation in prompts: the LLM sees event-type names and free slots, never other attendees or event titles.
- Prompt-injection posture: caller speech is untrusted input; tools validate every argument with Zod; the model cannot access anything not exposed by the six tools.

---

## 8. Repository layout

```
slotwise/
├─ apps/
│  ├─ web/                          # Next.js — Vercel fra1
│  │  ├─ src/app/
│  │  │  ├─ (dashboard)/            # dashboard, ai-assistant, calendar, integrations, settings
│  │  │  ├─ book/[org]/[eventType]/ # public booking page
│  │  │  └─ api/
│  │  │     ├─ auth/[...nextauth]/
│  │  │     ├─ bookings/
│  │  │     ├─ calendar/webhooks/{google,microsoft}/
│  │  │     └─ internal/voice/{session,availability,bookings}/
│  │  ├─ src/server/                # services: booking, calendar-sync, jobs (CalendarSyncJob outbox runner)
│  │  ├─ src/components/            # shadcn/ui + design tokens from the mockup
│  │  └─ prisma/                    # schema.prisma, migrations, seed.ts
│  │  ├─ src/server/                # voice/ (Prisma repo), calendar/ (sync, tokens), jobs/, dashboard.ts
│  │  └─ src/app/api/cron/[job]/    # Vercel Cron: sync-all, renew, purge
│  └─ voice/                        # Pipecat — Fly.io fra (Python 3.11)
│     ├─ app/main.py                # FastAPI: /twilio/incoming (TwiML, signature check), /ws
│     ├─ app/pipeline.py            # Transcribe → Bedrock Claude → Polly, VAD, barge-in, summary
│     ├─ app/tools.py               # six tool schemas + handlers → apps/web internal API
│     ├─ app/prompts.py             # system prompt DE/EN, disclosure, summary prompt
│     ├─ app/slotwise_client.py     # HMAC-signed client (mirror of apps/web/src/lib/hmac.ts)
│     ├─ Dockerfile · fly.toml · pyproject.toml
├─ packages/
│  ├─ core/                         # availability engine + VoiceToolService + MemoryRepo (pure TS, node:test)
│  ├─ calendar/                     # CalendarProvider interface + google/microsoft adapters (fetch, no SDKs)
│  ├─ contracts/                    # Zod schemas for internal API + JSON Schema export
│  └─ config/                       # shared tsconfig
├─ scripts/demo-call.ts             # end-to-end mock call against the in-memory API (pnpm demo:call)
├─ docs/design/                     # slotwise-dashboard-v1.html / .png (reference)
├─ infra/docker-compose.yml         # local Postgres 16 + Redis 7 (+ optional voice profile); infra/nginx for the embed
├─ apps/site/                       # website (Vite + React 18) — see §0
├─ apps/worker/, packages/platform/, packages/platform-db/   # platform track — see §0
├─ turbo.json · pnpm-workspace.yaml · biome.json · package.json
├─ .env.example
└─ ARCHITECTURE.md
```

---

## 9. Configuration (`.env.example`)

```
DATABASE_URL=postgresql://slotwise:slotwise@localhost:5432/slotwise
AUTH_SECRET=
AUTH_GOOGLE_ID= / AUTH_GOOGLE_SECRET=                # scopes: openid email profile calendar calendar.events
AUTH_MICROSOFT_ENTRA_ID_ID= / _SECRET= / _TENANT_ID=common   # scopes: Calendars.ReadWrite offline_access
TOKEN_ENCRYPTION_KEY=                                # 32-byte base64
APP_URL=http://localhost:3000
INTERNAL_SHARED_SECRET=                                 # HMAC between apps/voice and apps/web
TWILIO_ACCOUNT_SID= / TWILIO_AUTH_TOKEN= / TWILIO_REGION=ie1
AWS_REGION=eu-central-1 / AWS_ACCESS_KEY_ID= / AWS_SECRET_ACCESS_KEY=
BEDROCK_MODEL_ID=                                    # Claude Haiku-class in eu-central-1
POLLY_VOICE_ID=Vicki
SMS_PROVIDER=twilio                                  # confirmations/reminders
```

---

## 10. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold (Step 3) | Monorepo boots, Postgres via Docker, Prisma migrated + seeded, **mock internal voice API answers `curl`** |
| M1 | Auth + calendar connect | Google & Microsoft login, calendars listed, busy cache syncing via push + cron |
| M2 | Availability + web booking | Engine tested, public booking page books into the provider calendar, confirmations sent |
| M3 | Voice worker | Pipecat pipeline on Fly `fra`, Twilio IE1 number, end-to-end: call → slot → booking → feed card |
| M4 | Dashboard | Mockup implemented: KPIs, month calendar, day list, Live AI Agent Feed, agent settings |
| M5 | DSGVO hardening | Retention job, deletion endpoints, AVV list, log masking, penetration checklist |

**Open questions for you**

1. German TTS quality: Polly `Vicki` (neural) is acceptable for MVP? If not, Azure Speech (EU) `de-DE-KatjaNeural` is the swap (adds Microsoft as subprocessor — already there via Graph).
2. Twilio IE1 German numbers require a regulatory bundle (business address proof) — who provides the DaiL documents?
3. Cronofy: keep on the roadmap only (my reading of "1-2"), or wire the adapter in M1 already?
