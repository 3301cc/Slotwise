# Slotwise

Website, App und Plattform-Dienste in einem Monorepo. KI-Telefonassistent + Terminbuchung, betrieben in der EU.
Architektur, Schema und Entscheidungen: **[ARCHITECTURE.md](./ARCHITECTURE.md)** (§0 erklärt die Fusion der beiden Stränge). Design-Referenz: `docs/design/`.

```
apps/site            WEBSITE  Vite + React 18 — Landing, Funktionen, KI-Agent, Preise, FAQ, Rechtliches  → slotwise.app      (:5173)
apps/web             APP      Next.js 15 — Dashboard, Buchungsseiten, Kalender-Sync, interne Voice-API  → app.slotwise.app  (:3000)
apps/voice           APP      Python/Pipecat — Twilio ⇄ Transcribe / Bedrock Claude / Polly            → Fly.io fra        (:8080)
apps/worker          PLATFORM Queue-Worker (BullMQ | pg-boss) + Kalender-Outbox-Relay + Reconciler

packages/core        App-Domain: Availability-Engine, Booking-Commit (kein Double-Booking), Routing, Voice-Service — 51 Tests, keine Deps
packages/calendar    CalendarProvider-Interface + Google / Microsoft-Graph-Adapter
packages/contracts   Zod-Schemas der internen API (+ JSON-Schema-Export für Python), Booking-Fields, Routing-Regeln
packages/platform    Plattform-Schiene (vorher @slotwise/core im zweiten Repo): Zustandsmaschine, Entitlements/Pläne,
                     Metering, Adapter (CalDAV, Jitsi, Mollie), Job-Queues, Outbox, Tenant-Alerts — 99 Tests, keine DB nötig
packages/platform-db Prisma-Schema der Plattform-Schiene (snake_case, eigenes Postgres-Schema `platform`), PrismaDb-Adapter, Drift-Check
packages/config      gemeinsame tsconfigs (Bundler für App/Next, NodeNext für die Plattform-Pakete)
infra/               docker-compose (Postgres 16 + Redis 7, optional Voice), nginx-Konfiguration für das Embed
```

Die Website liest Preise und Marketing-Texte aus `packages/platform/config/plans.json` und `content/marketing-de.json` — dieselben Dateien, aus denen die Berechtigungsprüfung der Plattform liest. Alle Buttons der Website führen in die App (`VITE_APP_URL`): Anmelden → `/login`, Demo → `/book/nordlicht/demo-call`.

## Prerequisites

Node 22, pnpm 10, Docker, Python 3.11 (voice worker only).

## First run

```bash
pnpm install
cp .env.example .env                       # AUTH_SECRET, TOKEN_ENCRYPTION_KEY, INTERNAL_SHARED_SECRET eintragen
cp apps/site/.env.example apps/site/.env   # VITE_APP_URL (lokal: http://localhost:3000)
pnpm db:up                                 # Postgres 16 + Redis 7 in Docker (infra/docker-compose.yml)
pnpm db:migrate                            # App-Schema (apps/web/prisma): migrate dev + booking_no_overlap-Constraint
                                           # Upgrade einer DB mit SyncJobStatus FAILED? Kommentar am Enum in schema.prisma
pnpm db:seed                               # Demo-Daten: Nordlicht Consulting / Jana, Mehdi, Lena
pnpm dev                                   # Website :5173 · App :3000 (turbo startet beide)
```

Plattform-Schiene (nur nötig für `apps/worker`; eigenes Postgres-Schema, kollidiert nicht mit der App):

```bash
pnpm platform:generate                     # Prisma-Client → packages/platform-db/generated
pnpm platform:migrate                      # 0_baseline + calendar_outbox in Schema `platform`
pnpm worker                                # QUEUE_BACKEND=bullmq (Redis) | pgboss
```

Generate the secrets:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY (must decode to 32 bytes)
openssl rand -hex 32      # INTERNAL_SHARED_SECRET (same value in apps/voice)
```

## See the voice ⇄ calendar flow without any telephony

```bash
pnpm demo:call
```

Spins up an in-memory copy of the internal API, plays a caller who books a demo, retries the same slot (idempotent), lets a second caller collide (`409 SLOT_TAKEN`) and prints the resulting feed card. Runs with zero dependencies installed — only `tsx`.

## Tests

```bash
pnpm test                                  # core 51 (engine, routing, concurrency, command ordering) · contracts 8 · platform 99 · platform-db 2 · web (hmac, retry policy, alert policy)
RUN_DB_TESTS=1 pnpm --filter @slotwise/web test   # + ordering guard against the real Postgres (FOR UPDATE races, lock order, lost-update control) — needs db:up + db:migrate
cd apps/voice && pytest                    # Python 37: signing parity, retry, spool, ordering stamps, SpeechClock
pnpm --filter @slotwise/site build         # Website-Bundle (statisch, dist/)
pnpm typecheck
pnpm lint
```

## Exercise the real endpoints (after `pnpm dev` + `pnpm db:seed`)

```bash
DEMO_BASE_URL=http://localhost:3000 INTERNAL_SHARED_SECRET=<same as .env> pnpm demo:call
```

Same flow as the mock run, but against the real middleware, Prisma repo and seeded data. The first request is deliberately unsigned and must come back `401` — if it doesn't, the middleware is not active.

Every route under `/api/internal/*` is guarded twice: the Edge middleware rejects unsigned/stale/forged requests before any handler runs, and `internalRoute()` binds the body hash and blocks nonce replays (details: ARCHITECTURE.md §6). Tests: `apps/web/src/lib/hmac.test.ts`, `apps/web/src/lib/internal-auth.test.ts`, `apps/voice/tests/test_signing.py`.

## Deploy

Klick-für-Klick in **[DEPLOY.md](./DEPLOY.md)**: Website auf Vercel (10 min), App auf Vercel + Neon (45 min), Telefonagent auf Fly.io. `scripts/gen-secrets.sh` erzeugt die Secrets. Kalender-Push läuft direkt nach jeder Buchung (`after()`-Drain), die Crons in `apps/web/vercel.json` sind Hobby-kompatibel (täglich); auf Pro minütlich ergänzen.

| Component | Target | Notes |
|---|---|---|
| apps/site | Vercel / jeder statische Host (`pnpm --filter @slotwise/site build` → `dist/`) | `VITE_APP_URL=https://app.slotwise.app`, `VITE_COMPANY_*` für Impressum/Datenschutz; SPA-Fallback auf `index.html`; Schriften nach `public/assets/fonts/` legen (README dort) |
| apps/web | Vercel, region `fra1` (`apps/web/vercel.json`) | Neon Postgres Frankfurt; set every key from `.env.example`; crons drain sync/renew/purge |
| apps/voice | Fly.io `fra` (`apps/voice/fly.toml`) | needs `VOICE_PUBLIC_HOST`, AWS + Twilio secrets; Twilio number webhook → `/twilio/incoming` |
| App job worker (optional) | any Docker host: `pnpm --filter @slotwise/web jobs` | drains the `CalendarSyncJob` outbox with backoff (max 5 attempts → PERMANENT_FAILED + SystemAlert); on Vercel the `/api/cron/outbox` route (every minute) does the same |
| apps/worker (platform) | Docker host with Redis | `PLATFORM_DATABASE_URL`, `REDIS_URL`, `QUEUE_BACKEND`; runs the platform outbox relay / reconciler against the `platform` schema |

## Milestones

M0 scaffold ✔ · M1 auth + calendar connect · M2 availability + web booking · M3 voice worker live · M4 dashboard (month view) · M5 DSGVO hardening — details in ARCHITECTURE.md §10.
