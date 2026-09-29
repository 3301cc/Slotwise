# @slotwise/platform – Fachlogik der Plattform-Schiene (R0 · R1 · R2 Phase 1)

> Im fusionierten Monorepo heißt dieses Paket `@slotwise/platform` (vorher `@slotwise/core`); `@slotwise/core` ist die dependency-freie Domain-Logik der App (Availability-Engine, Booking-Commit, Routing, Voice-Service). Die Pg-Repositories hier zielen auf das Plattform-Schema in `packages/platform-db` (eigenes Postgres-Schema `platform`, siehe ARCHITECTURE.md §0).

Code, Datenbank-Migrationen, Konfiguration und Audit-Skripte für die R0-Tickets STW-101/102 (Widget & Lock), STW-201/202 (KI-Freeze & Metering), STW-301 (Embed), STW-401/402 (Tarife & Marketing) sowie die R1-Teilstücke A (EU-Modus-Adapter + SubprocessorService), B (BullMQ/pg-boss + Reconciler) und C (Fristen, No-Show, § 312j BGB). TypeScript/Node 22, PostgreSQL 15+, Redis 7.

```
npm install
npm test          # 99 Tests: Zeitzonen (DST 29.03./25.10.2026), Slot-Engine, Write-then-Verify-Lock, 429-Pfade, OTP-Router, Metering, Entitlements,
                  #           Adapter-Katalog/EU-Modus/Subprozessoren, CalDAV/Jitsi/Mollie, Zustandsmaschine/§ 312j, Queue-Anbindung, Reconciler
npm run typecheck # strict
# SQL-Migrationen liegen seit Phase 0 in packages/db (Prisma-Baseline + sql/legacy)
EMBED_URL=https://termine.kunde.de/jana?embed=1 ALLOWED_HOSTS=termine.kunde.de npm run audit:embed
```

## Epic 1 · Widget- und Logik-Refactoring

| Datei | Inhalt |
| --- | --- |
| `db/migrations/0001_timestamptz_and_exclusion.sql` | `TIMESTAMPTZ`-Umstellung mit Batch-Backfill (`start_local AT TIME ZONE hosts.timezone`), `booking_status`-Enum, IANA-Trigger auf `hosts.timezone`, `EXCLUDE USING gist (host_id WITH =, tstzrange(start_utc,end_utc,'[)') WITH &&) WHERE status IN ('tentative','pending_verification','confirmed')`, Idempotency-Index, `availability_rules`, `calendar_connections` mit `is_blocking`/`is_primary` |
| `src/time/tz.ts` | Zeitzonen-Engine ohne Abhängigkeiten (`Intl`): `wallToUtc`, `utcToWall`, `getOffsetMinutes`, Lücke/Überlappung dokumentiert |
| `src/availability/slotEngine.ts` | Slots aus Host-Regeln pro Kalendertag in UTC, Puffer, Vorlauf, Belegt-Blöcke, `isSlotInsideRules` als Server-Validierung |
| `src/booking/bookingService.ts` | 5-Schritt-Prozess: Frische (30 s) → Redis-Lock `SET NX PX 20000` → `createEvent(tentative)` → Live-Free/Busy über alle blockierenden Kalender → Postgres-Commit + `confirmEvent`. 429 in Schritt 3 oder 4 nach 3 Retries → `pending_verification` + Job |
| `src/booking/verifyPendingJob.ts` | Worker mit Backoff 15 s … 120 s, Frist 10 min, Ergebnis `confirmed` oder `cancelled_conflict` mit Benachrichtigung |
| `src/booking/redisLock.ts` | Lock mit Lua-Compare-and-Delete, In-Memory-Variante für Tests |
| `src/booking/pgBookingRepository.ts` | SQLSTATE `23P01` → `SlotTakenError`, `23505` → Idempotenz-Rückgabe |
| `src/booking/redisAvailabilityCache.ts` | Free/Busy-Cache mit Alter, Invalidierung über Provider-Webhooks |
| `src/widget/useBookerTimezone.ts`, `slotLabel.ts`, `TimezoneSelect.tsx` | Erkennung per `Intl.DateTimeFormat().resolvedOptions().timeZone`, `sessionStorage`-Persistenz mit try/catch, doppeltes Label bei Offset-Abweichung, Tagesverschiebung |

Anschluss ans Frontend (`slotwise-web`): `BookingWidget.jsx` bekommt `useBookerTimezone(HOST.timezone)`, rendert `<TimezoneSelect>` über der Slot-Liste und beschriftet Slots mit `slotLabel(start, end, bookerTz, hostTz)`. Die Slot-Daten kommen als UTC-ISO-Strings von `GET /v1/availability?tz=…`.

## Epic 2 · KI-Agent und Metering

| Datei | Inhalt |
| --- | --- |
| `src/agent/systemPrompt.ts` | System-Prompt (DE/EN) mit L0-Freeze, wörtliche Standard-Absage, Pflichtansage zu Gesprächsbeginn |
| `src/agent/tools.ts` | Nur sechs L0-Tools (`find_availability`, `send_otp`, `verify_otp`, `create_booking`, `send_booking_link_sms`, `handover_to_human`), Exporte für OpenAI- und Anthropic-Schema, `strict: true` |
| `src/agent/toolRouter.ts` | Serverseitige Durchsetzung: Allow-List, deterministisches Intent-Gate vor dem Modellaufruf, OTP (6-stellig, 5 min, 3 Versuche, 3 Sendungen pro Anruf), HMAC-Token gebunden an Anruf + Nummer, Audit-Log |
| `db/migrations/0002_metering_ledger.sql` | `plans`, `plan_allowances`, `ai_packages`, `billing_settings` (Ausgabenlimit, Schwellen, `hard_stop`), `usage_events` (append-only, `idempotency_key UNIQUE`, Split-Constraint), `usage_periods`, `usage_alerts`, `agent_state`, `sms_price_list`; Seed mit den R0-Tarifen |
| `src/metering/rating.ts` | Mindestlaufzeit 30 s, 6-s-Takt, Overage-Cent mit 4 Nachkommastellen, GSM-7/UCS-2-Segmentzählung, Länderpreis aus E.164 |
| `src/metering/ledger.ts` | Transaktion mit `FOR UPDATE` auf Periode, `ON CONFLICT (idempotency_key) DO NOTHING`, Inklusiv/Overage-Split, Schwellen-Alarme einmal pro Periode, Hard-Stop → `agent_state` + Redis-Gate |
| `src/metering/hardStop.ts` | Redis-Flag ohne TTL, Pub/Sub `agent-state`; Gateway prüft synchron vor dem Annehmen, laufende Anrufe werden innerhalb von 30 s mit Ansage beendet |
| `src/metering/webhooks.ts` | Provider-Callbacks → Ledger, Idempotency-Key ausschließlich aus Provider-IDs (`call:<provider>:<sid>`, `sms:<provider>:<messageId>`) |

## Epic 3 · Datenschutz-Architektur und Embed

| Datei | Inhalt |
| --- | --- |
| `infra/nginx/embed.conf` | Server-Block je Kundendomain (CNAME), `frame-ancestors` per Map, `proxy_hide_header Set-Cookie`, CSP `default-src 'self'`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, CORP/COOP, HSTS, `Cache-Control: no-store`, anonymisiertes Log, Rate-Limit nur im Speicher |
| `infra/nginx/customer-reverse-proxy.conf` | Variante B: Inline über den Webserver des Kunden, kein Fremd-Request |
| `embed/index.html`, `embed/fonts.css`, `embed/bridge.ts`, `embed/host-snippet.html`, `embed/csrf.ts` | Seite ohne externe Ressourcen, self-hosted Schriften, ausgehende `postMessage`-Bridge mit Origin-Allow-List, CSRF-Token ohne Cookie |
| `audit/audit.spec.ts`, `audit/playwright.config.ts` | Nachweis: kein `Set-Cookie`, `document.cookie === ''`, keine Requests außerhalb `ALLOWED_HOSTS`, kein `localStorage`, nur erlaubte `sessionStorage`-Keys, Sicherheitsheader, Iframe mit blockierten Drittanbieter-Cookies, privater Modus. Projekte: Chromium (`--block-third-party-cookies`), Firefox, WebKit/ITP, iPhone |

Frontend: `slotwise-web/index.html` lädt keine Google Fonts mehr, `public/fonts.css` und `public/assets/fonts/README.md` beschreiben das Self-Hosting.

## Epic 4 · Tarif-Logik und Marketing

| Datei | Inhalt |
| --- | --- |
| `config/plans.json` | R0-Tarife: Starter 0 € (3 Terminarten, Kalender unbegrenzt, Basis-Erinnerungen), Professional 12 €, Business 19 € (Multi-Host bis 5, Routing, Round-Robin, 100/50 KI-Minuten), Enterprise ab 990 €; Overage-Preise, KI-Pakete, Integrationskatalog mit `kind` (nativ / via Make) und `tier` (1 EU, 2 US-Anbieter mit EU-RZ, 3 US-Hosting) |
| `src/entitlements/entitlements.ts` | Validierung der R0-Regeln beim Laden (wirft bei Kalender-Cap im Starter usw.), `can()`, `limit()`, `assertWithinLimit()` mit Upgrade-Hinweis, `integrationsFor()` nach EU-Modus, Basispreis inkl. Gast-Hosts |
| `content/marketing-de.json` | Rechtssichere Textbausteine: Hero-Badge, Datenschutz-Sektion mit Abschnitt „Verbundene Dienste“, Diagramm-Labels, KI-Transparenz mit Anbieter-Platzhalter, Vergleichsfußnote, Liste verbotener Formulierungen |

## R1 · A · EU-Modus-Adapter-Architektur und SubprocessorService

| Datei | Inhalt |
| --- | --- |
| `src/adapters/metadata.ts` | Pflicht-Metadaten je Adapter: `vendor`, `legal_entity`, `owner_country`, `hosting_regions`, `tier`, `transfer_mechanism`, `purpose`, `data_categories`, `documentation_url`, `kind`, `operated_by`. `deriveTier()` leitet die Stufe aus Sitz und Hosting ab; `assertMetadataValid()` weist widersprüchliche Angaben ab (falsche Stufe, Drittlandbezug ohne Rechtsgrundlage, Angemessenheitsbeschluss für Länder ohne einen) |
| `src/adapters/ports.ts` | `CalendarAdapter` (= R0-`CalendarProvider` + `meta`), `VideoAdapter`, `PaymentAdapter`, `CrmAdapter`, `AutomationAdapter` |
| `src/adapters/catalog.ts` | Metadaten aller 19 Integrationen aus `config/plans.json`; Test erzwingt Gleichheit der Stufen mit plans.json (Stripe dabei auf Stufe 3 korrigiert: US-Verarbeitung) |
| `src/adapters/registry.ts` | `AdapterRegistry`: Katalog + Bindungen (`bind(id, factory)`); `resolve(tenant, id, category, credentials)` prüft Kategorie, EU-Modus (`strict` ≤ 1, `balanced` ≤ 2, `off` ≤ 3) und Zugehörigkeit der Zugangsdaten, bevor ein Adapter entsteht |
| `src/adapters/tenantIntegrations.ts` | `TenantIntegrationService`: Aktivierung nur bei Plan-Berechtigung und EU-Modus, Make-Abhängigkeit für via-Make-Dienste, `setEuMode()` mit vollständiger Konfliktliste (kein stilles Deaktivieren); Pg- und Memory-Repository |
| `db/migrations/0003_tenant_integrations.sql` | `tenant_privacy_settings` (EU-Modus mit Historie), `tenant_integrations` (Stufe und EU-Modus zum Aktivierungszeitpunkt, `config` ohne Secrets – Trigger weist Schlüssel wie `token`/`password` ab, `secret_ref` in den Vault), `subprocessor_snapshots`; DB-Trigger sichern EU-Modus ↔ Stufe in beide Richtungen |
| `config/platform-subprocessors.json` | Subprozessoren von Slotwise selbst: Hosting (scope `platform`), SMS (`feature:smsWorkflows`), KI-Telefonie (`feature:aiAgent`). Konfigurierte Standard-Anbieter; vor Go-live mit den geschlossenen AV-Verträgen abgleichen – das ist die einzige Stelle, an der Anbieter geändert werden |
| `src/adapters/subprocessorService.ts` | `build(tenantId)`: Plattform-Einträge immer, funktionsgebundene nur bei Plan **und** Nutzung, aktivierte Integrationen nach Rolle (A Unterauftragsverarbeiter · B vom Kunden verbundene Dienste auf Weisung, Art. 28 Abs. 3 lit. a · C Eigenbetrieb). Versions-Hash (SHA-256, zeitstempelfrei), `publish()` mit Snapshot und Diff, `renderAvvAnnexHtml()` (eigenständiges HTML, `@page`, druck-/PDF-fähig), `renderChangeNoticeText()` für die Mitteilung nach Art. 28 Abs. 2 S. 2 |
| `src/adapters/impl/caldavCalendarAdapter.ts` | Stufe-1-Referenz über `fetch`: REPORT calendar-query mit `expand`, iCalendar-Parser (TZID/UTC/ganztägig/DURATION/TRANSP/STATUS, Faltung), PUT mit `If-None-Match: *`, ETag-Update, 429 → `ProviderRateLimitError`; `listOwnEvents()` für den Reconciler |
| `src/adapters/impl/jitsiVideoAdapter.ts` | Stufe-1-Referenz: nicht erratbare Räume, JWT HS256 mit `nbf`/`exp` am Terminfenster, Moderator nur für den Gastgeber, Aufzeichnung/Streaming deaktiviert |
| `src/adapters/impl/molliePaymentAdapter.ts` | Stufe-1-Referenz: Checkout, Statusabfrage, Refund; Webhook lädt den Status immer beim Anbieter nach |

Google, Microsoft Graph, Zoom, Stripe, HubSpot usw. sind im Katalog mit Metadaten enthalten, aber nicht gebunden (`AdapterNotBoundError`); die Bindung erfolgt mit `registry.bind(id, factory)` gegen das jeweilige SDK.

## R1 · B · Queue-Anbindung und Reconciler

| Datei | Inhalt |
| --- | --- |
| `src/jobs/types.ts` | Job-Namen und Payloads (`verify-booking`, `reconcile-calendars`, `auto-complete-bookings`, `publish-subprocessors`), `JobQueuePort` (erweitert den R0-`JobQueue`), Backend-Retry (5 Versuche, 15 s → 120 s, ±30 % Jitter), Pläne (Reconciler alle 10 min, Auto-Complete alle 15 min, UTC) |
| `src/jobs/backoff.ts` | `computeBackoffMs()` exponentiell mit Deckel und Jitter, injizierbare Zufallsquelle |
| `src/jobs/bullmqQueue.ts` | `BullMqJobQueue` (eine Queue `slotwise`, `delay`, `jobId` aus `dedupeKey`, `repeat` für Pläne, `removeOnComplete/Fail`), `startBullMqWorker()` mit `backoffStrategy` und `lockDuration` 60 s. BullMQ-Klassen werden strukturell typisiert und übergeben – kompiliert ohne installiertes Paket |
| `src/jobs/pgBossQueue.ts` | `PgBossJobQueue` (pg-boss 10: `createQueue` je Job, `send` mit `startAfter`/`singletonKey`, `schedule`), `startPgBossWorker()` (Batch-Handler, Fehler → Retry durch pg-boss) |
| `src/jobs/memoryQueue.ts` | Deterministische In-Memory-Queue mit `drain(handlers, until)` für Tests; zeigt fachlichen Backoff (verifyPendingJob) und Backend-Retry zusammen |
| `src/jobs/worker.ts` | `buildHandlers()`, `registerSchedules()`, `createQueue()`, `startWorker()` (liefert Stop-Funktion für SIGTERM), `queueEnvFromProcess()` (`QUEUE_BACKEND=bullmq|pgboss`, `REDIS_URL`) |
| `src/booking/reconciler.ts` | `CalendarReconciler.run(hostId|null)`: (1) verwaiste Slotwise-Einträge ohne aktive Buchung nach 20 min Mindestalter löschen, (2) bestätigte Buchungen ohne Kalendereintrag markieren und Gastgeber informieren (keine automatische Stornierung), (3) hängende `pending_verification` erneut einreihen. Fenster −2 Tage … +90 Tage, Fehler je Host isoliert, Laufprotokoll |
| `src/booking/pgReconcilerRepository.ts`, `db/migrations/0005_reconciler.sql` | `bookings.external_event_missing_at`, `reconciler_runs` mit 90-Tage-Aufbewahrung |

## R1 · C · Fristen, No-Show, § 312j BGB

| Datei | Inhalt |
| --- | --- |
| `src/booking/policy.ts` | `EventTypePolicy`: `minNoticeMinutes`, `cancelCutoffMinutes`, `rescheduleCutoffMinutes`, `maxReschedules`, `noShowFeeCents`, `lateCancelFeeCents`, `feeMode` (`none`/`prepaid_forfeit`/`charge_on_file`/`invoice`), `feeAppliesTo` (`no_show`/`late_cancel`/`both`), Karenz und Fenster für No-Show, Kulanzfrist, `withdrawalRight`, `priceCents`. `validatePolicy()` mit Invarianten (Gebühr ⇔ feeMode, Stornofrist ≥ Vorlauf bei Gebühren) |
| `src/booking/stateMachine.ts` | Zustandstabelle mit Akteuren (`booker`/`host`/`system`) und reine Funktion `validateBookingStateTransition(currentStatus, newStatus, startUtc, nowUtc, policy, options?)` → erlaubter Übergang mit `FeeOutcome` (`cancelled_free` vs. `cancelled_late` mit Gebühr, Einbehalt bis zur Vorkasse, Erstattung, Kulanz) oder Ablehnung mit Code, Alternative und Frist. Fristen sind Dauern, daher DST-neutral; `deadlinesFor()` liefert die Instants für die Anzeige |
| `src/booking/consumerOrder.ts` | § 312j: `orderRequirements()` → Beschriftung „Zahlungspflichtig buchen“ bei jeder Zahlungspflicht, Pflichtangaben unmittelbar vor der Schaltfläche (Leistung, Gesamtpreis, Fristen, Pauschale), Satz nach § 309 Nr. 5 lit. b BGB, Zustimmung nach § 356 Abs. 4 BGB bei Termin innerhalb der Widerrufsfrist, Ausschluss § 312g Abs. 2 Nr. 9. `assertOrderEvidence()` lehnt Buchungen ab, deren angezeigte Beschriftung/Inhalte (Hash) nicht passen – sonst läge nach § 312j Abs. 4 kein Vertrag vor |
| `src/booking/lifecycleService.ts` | Anwendung auf gespeicherte Buchungen in einer Transaktion: `cancel()` (späte Absage nur mit bestätigter Gebühr), `markNoShow()`, `waiveFee()`, `markRescheduled()`, `complete()`, `autoCompleteBatch()`; Erstattung über den `PaymentAdapter` vor dem Statuswechsel, Fehler rollen zurück |
| `db/migrations/0004_event_type_policy.sql` | `event_type_policies` mit denselben Invarianten als CHECKs, Buchungsspalten (Zähler, Vorkasse, Gebühr, Erstattung, Zeitstempel, `is_consumer`, `order_button_label`, `legal_notice_snapshot`), `booking_status_transitions` + Guard-Trigger (Akteur über `SET LOCAL slotwise.actor`), `booking_events` als Protokoll, Sicht `bookings_auto_complete` |

Die Formulierungen in `consumerOrder.ts` (Pflichtangaben, Widerrufshinweis, § 309-Satz) sind zentral gehalten und für die juristische Freigabe vorgesehen; sie sind keine Rechtsberatung.

## R2 · Phase 1 · Outbox und Dead-Letter (`src/sync/`)

| Datei | Inhalt |
| --- | --- |
| `types.ts` | `CalendarSyncJob`, Ports `OutboxRepository`/`AlertRepository`, `AlertView` (Banner-Vertrag) |
| `errorClassifier.ts` | Provider-Fehler → retry / dead_letter / succeeded_noop, erkennt SDK-Fehlerformen über HTTP-Status |
| `outbox.ts` | `Outbox.enqueue(tx, job)`, `kick(job)`, `createPayloadFor()` |
| `outboxWorker.ts` | Relay mit Lease, Reihenfolge je Buchung, Backoff+Jitter, Dead-Letter → `sync_state` + Alarm, `markReauthorized()`, `retryFailed()` |
| `alerts.ts` | `AlertService.raise/resolve/viewFor` mit deutschen Texten und Aktionslinks |
| `pgSyncRepositories.ts`, `memorySyncRepositories.ts` | PostgreSQL- und In-Memory-Implementierungen |

Integration: `BookingService` (CONFIRM-Job bei gescheiterter Bestätigung, Alarm bei 401), `LifecycleService` (DELETE-Job in der Transaktion), `verifyPendingJob` (401 → Alarm + Abschluss), `reconciler` (respektiert offene Jobs), `jobs/` (`calendar-sync`, `calendar-sync-sweep`).

## Offene Punkte für die Integration (bewusst nicht im Paket)

- Provider-Adapter für Google Calendar, Microsoft Graph, Zoom, Stripe, HubSpot, Pipedrive, Salesforce gegen die jeweiligen SDKs; Metadaten liegen im Katalog, die Bindung erfolgt über `registry.bind()`. Für den Reconciler brauchen Google/Graph eine Markierung eigener Einträge (`privateExtendedProperty` bzw. `singleValueExtendedProperties`).
- `bullmq` und `pg-boss` sind optionale Abhängigkeiten; die Anbindung ist gegen strukturelle Typen geschrieben und mit Doubles getestet. Ein Integrationstest gegen echtes Redis/PostgreSQL gehört in die CI der Zielumgebung.
- Belastung eines hinterlegten Zahlungsmittels (`charge_on_file`) setzt ein Mandat/Setup beim Zahlungsanbieter voraus (Mollie: Mandate über Customers-API); der Lifecycle-Service prüft nur, dass ein Adapter verbunden ist.
- Redis-/pg-Clients werden über die minimalen Interfaces (`RedisLike`, `RedisKv`, `RedisGate`, `PgLike`, `Db`) angebunden; ioredis und node-postgres erfüllen sie ohne Adapter.
- WOFF2-Dateien der Schriften müssen aus den Upstream-Releases abgelegt werden (siehe `slotwise-web/public/assets/fonts/README.md`).
