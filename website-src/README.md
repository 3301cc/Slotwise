# Slotwise Marketing-Website

Ausgeliefert wird `slotwise-website-online/` (Vercel, Root Directory = dieser Ordner, Framework „Other“).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `website-src/vendor/site.original.js` | ursprünglicher Vite-Build (keine Quellen im Repo) |
| `website-src/KiAgentPage.jsx` | Seite `/ki-agent` |
| `website-src/PraxenPage.jsx` | Seite `/praxen` für Arzt- und Zahnarztpraxen (Sie-Form, Pilotangebot, Praxis-Plan); Warteliste mit Quelle `praxen` |
| `slotwise-website-online/api/_lib/core/tenants.js` | Mandanten: mehrere Praxen/Unternehmen über `TENANTS_JSON` (eigener Datenraum, eigener Token, Zuordnung über angerufene Nummer). Ohne Variable: Einzelbetrieb wie bisher |
| `slotwise-website-online/api/_lib/core/agent/praxis.js` | Praxismodus des Agenten: Notfall-Gate (112/116 117), Medizin-Gate, Aufgaben (Rezept, Überweisung, Rückruf, Terminänderung) |
| `website-src/SitePatches.jsx` | Warteliste, `/anmelden`, Demo-Widget, Layout mit Entwurfs-Banner, Datenschutzerklärung |
| `website-src/build.py` | setzt beides in `assets/site.js` ein |
| `slotwise-website-online/assets/site-extra.css` | zusätzliche Utilities und Komponenten-CSS |
| `slotwise-website-online/site-config.js` | Firmendaten, App-Status, Demo-Telefonnummer (ohne Neubau änderbar) |
| `slotwise-website-online/api/_lib/core/` | Warteliste – Geschäftslogik, plattformunabhängig (reine Daten rein, reine Daten raus) |
| `slotwise-website-online/api/_lib/http.js` | HTTP-Adapter: node:http, Express/Fastify, Vercel → Core |
| `slotwise-website-online/api/waitlist/*.js` | Vercel-Einstiege, je eine Zeile |
| `slotwise-website-online/server/standalone.js` | eigener Server ohne Vercel (Hetzner, OVH, Docker) |
| `slotwise-website-online/api/_lib/core/agent/` | KI-Agent: Regelwerk (portiert aus `2-packages-platform`), Bedrock-Client, Twilio, Kalender, Aktivität, Orchestrator |
| `slotwise-website-online/api/agent/*.js` | Vercel-Einstiege des Agenten: `voice-webhook.js` (Twilio), `intake.js` (E-Mail), `[action].js` für alle Dashboard-Endpunkte (Vercel Hobby erlaubt max. 12 Funktionen) |
| `slotwise-website-online/api/_lib/core/billing.js`, `api/billing/[action].js`, `checkout/erfolg/` | Stripe-Abo-Checkout der Preisseite (siehe „Abo-Checkout (Stripe)“) |
| `slotwise-website-online/api/_lib/core/google.js`, `api/google/[action].js` | „Google Kalender verbinden“: OAuth, Belegt-Abgleich und Termine eintragen (siehe „Google Kalender verbinden“) |
| `slotwise-website-online/dashboard/` | Dashboard-Vorschau (`/dashboard`): Markup, Darstellung (`dashboard.js`), Datenschicht (`dashboard-data.js`), Ansichten Kunden / Event-Typen / Berichte (`views.js`, Hash-Routing `#kunden`, `#event-typen`, `#berichte`), Erklär-Tour (`tour.js`, eigenes CSS, kein Build nötig), gebautes CSS |
| `website-src/dashboard/` | Tailwind-Quelle und -Konfiguration des Dashboards |
| `slotwise-website-online/dashboard/enterprise.js`, `auth/callback/`, `vendor/msal-browser.min.js` | Microsoft-365-Anbindung ans Enterprise-Backend (`3-enterprise/`): aktiv, sobald die `CALENSYNC_API`/`ENTRA_*`-Werte in `site-config.js` gesetzt sind |

Nach Änderungen an den `.jsx`-Dateien oder am Dashboard-CSS:

```bash
python3 website-src/build.py        # esbuild + Tailwind-CLI über npx – oder ESBUILD=/pfad, TAILWINDCSS=/pfad
                                    # ohne esbuild: global installiertes TypeScript wird automatisch als JSX-Compiler genutzt
cd slotwise-website-online
npm test                            # API-Tests
npm run dev                         # http://localhost:3000, Warteliste speichert in .data/waitlist.json
```

## Architektur der Warteliste

```
api/waitlist/index.js  ──┐                       (Vercel: eine Zeile je Route)
server/standalone.js   ──┼─▶ api/_lib/http.js ─▶ api/_lib/core/waitlist.js ─▶ core/store.js   (Redis-REST | Datei | Memory)
Express: app.use(apiHandler) ┘   (Adapter)         (Geschäftslogik)          ├─▶ core/mailer.js  (Mailjet | Console)
                                                                            └─▶ core/tokens.js  (HMAC-Links)
```

Nur `api/_lib/http.js` kennt Plattform-Eigenheiten (Vercels vorgeparstes `req.body`/`req.query`, Streams bei node:http).
Nur `core/config.js` liest `process.env`. Die Geschäftslogik bekommt `{ body, query, headers, ip, baseUrl }` und liefert
`{ status, body, headers, redirect }` – so läuft sie in Tests ohne Netz und auf jedem Host ohne Umbau.

**Ohne Vercel betreiben (z. B. Hetzner):**

```bash
PORT=3000 WAITLIST_SECRET=… MAILJET_API_KEY=… MAILJET_API_SECRET=… WAITLIST_FROM_EMAIL=… SITE_URL=https://slotwise.app \
  KV_REST_API_URL=… KV_REST_API_TOKEN=…   node server/standalone.js
```

Statt Upstash geht jeder Redis mit REST-Schnittstelle; für einen Einzelserver reicht `WAITLIST_DATA_FILE=/var/lib/slotwise/waitlist.json`.
Ein klassischer Redis über TCP braucht eine weitere Store-Klasse in `core/store.js` (gleiche fünf Methoden). Beispiel für Express: `server/express-example.js`.

## Dashboard-Vorschau (`/dashboard`)

Dashboard im Stil der Website: KPI-Leiste, Wochenkalender (gebucht / KI-Vorschlag / blockiert), KI-Aktivitäts-Feed,
KI-Einstellungen (Autonomie, Termine pro Tag, Anweisung). Alle Daten kommen aus `SlotwiseAPI` in `dashboard-data.js`:
ohne Token Beispieldaten, mit Token live. Token einmalig im Browser hinterlegen:
`localStorage.setItem("slotwise.adminToken", "<WAITLIST_ADMIN_TOKEN>")`. Dann kommen Feed (Polling alle 10 s), Kalender,
Einstellungen, Freigaben und der Zähler „Verifizierte Leads“ von der API. Nur die drei Metriken Conversion, gesparte Zeit
und Event-Typen sind noch Beispielwerte (kein Endpunkt).

## KI-Agent (Telefon + E-Mail)

```
Twilio ──POST──▶ /api/agent/voice-webhook ─▶ core/agent/api.js ─▶ core/agent/agent.js (Orchestrator)
  ▲ TwiML                                                         │ Intent-Gate ─▶ Bedrock (Converse, Tool-Use) ─▶ ToolRouter
  └── <Say> (Polly-TTS) + <Gather input=speech> (STT) ◀───────────┤ Kalender (Slots, Konflikte, Tageslimit) · SMS (OTP)
Dashboard ◀── /api/agent/activity · week · settings · decision ◀──┘ Aktivitätslog (Store)
```

- **Regelwerk** (`tools.js`, `systemPrompt.js`, `toolRouter.js`) ist der L0-Freeze aus `2-packages-platform/…/agent/`, 1:1 nach
  CommonJS portiert: nur sechs Tools, deterministisches Intent-Gate gegen Änderungswünsche, OTP-Bindung vor `create_booking`.
- **Bedrock** (`bedrock.js`): Converse-API mit Tool-Use, SigV4 von Hand (kein SDK), Region eu-central-1. `AGENT_MODEL=fake`
  schaltet ein deterministisches Testmodell ein – so laufen Tests und lokale Demo ohne AWS.
- **Twilio** (`twilio.js`): Signaturprüfung, TwiML, SMS per REST. Der Ablauf ist rundenbasiert (jede Äußerung ein Webhook-Aufruf),
  deshalb läuft er auf Vercel-Funktionen genauso wie auf `server/standalone.js` – kein offener Media-Stream nötig.
- **Dashboard-Einstellungen** (Autonomie, Termine/Tag, Anweisung) liegen im Store und stehen bei jedem Modellaufruf als
  eigener Block im System-Prompt – Änderungen gelten ab dem nächsten Satz des Anrufers.
  `draft` → `create_booking` legt einen Vorschlag an (indigo, Freigabe im Dashboard), `auto` → feste Buchung (grün).
  Ist der Slot inzwischen belegt → Konflikt (rot) + Alternative. Tageslimit erreicht → nächster Tag.
- **Kalender** (`calendar.js`): Arbeitszeit Mo–Fr 09–17, Listen `cal:bookings`, `cal:proposals`, `cal:blocked` im Store.
  Externe Kalender schreiben Belegungen als Blocker (`calendar.setBlocked([...])`). **Noch nicht enthalten:** der laufende
  Sync-Job zu Google/Microsoft/CalDAV (Adapter-Ports liegen in `2-packages-platform/…/adapters`) und ein eingehender
  E-Mail-Webhook eines Mail-Providers – `POST /api/agent/intake` nimmt E-Mail-Text bereits entgegen (Bearer).

**Umgebungsvariablen (zusätzlich zur Warteliste):**

| Key | Pflicht | Inhalt |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | ja | IAM-Nutzer mit `bedrock:InvokeModel` (nur diese Berechtigung) |
| `AWS_REGION` | nein | Standard `eu-central-1` |
| `BEDROCK_MODEL_ID` | nein | Standard `eu.anthropic.claude-3-5-haiku-20241022-v1:0` (EU-Inferenzprofil). Modellzugriff in der Bedrock-Konsole freischalten. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | ja | Twilio-Konto; Auth-Token prüft auch die Webhook-Signatur |
| `TWILIO_FROM_NUMBER` | ja | Absendernummer für SMS (E.164) |
| `AGENT_COMPANY`, `AGENT_HOST_NAME` | empfohlen | Name im Begrüßungstext / in Bestätigungen |
| `AGENT_TIMEZONE` | nein | Standard `Europe/Berlin` |
| `AGENT_ESCALATION_PHONE` | nein | Nummer für die Übergabe an einen Menschen (`<Dial>`); ohne: Rückruf-Ansage |
| `AGENT_MODEL` | nein | `fake` = Testmodell ohne AWS (nie in Produktion setzen) |
| `SITE_URL` | ja | Basis der Webhook-Adresse, die in TwiML zurückgegeben wird |
| `ENTERPRISE_BUSY_URL`, `ENTERPRISE_BUSY_TOKEN` | nein | Belegte Zeiten aus CalenSync Enterprise (Ziel „Buchungsseite“), z. B. `https://acme.calensync.de/api/v1/availability/busy` + Bearer-Token. Slot-Suche: bei Ausfall nur lokaler Kalender (fail-open); Prüfung vor dem Buchen: bei Ausfall gilt der Slot als belegt, der Agent bietet Rückruf bzw. Buchungslink an (fail-closed). Mit `TENANTS_JSON` je Mandant `enterpriseBusyUrl`/`enterpriseBusyToken` (keine Vererbung) |
| `AGENT_RETENTION_TASKS_DAYS`, `AGENT_RETENTION_CALENDAR_DAYS`, `AGENT_RETENTION_ACTIVITY_DAYS` | nein | Löschfristen des Agenten in Tagen (Standard 30 / 90 / 90): Aufgaben ab Eingang, Termine und Vorschläge ab Terminende, Protokoll ab Eintrag (`agent/retention.js`). Bei Änderung die Datenschutzerklärung anpassen |

Der Admin-Token für Feed/Einstellungen/Freigaben ist `WAITLIST_ADMIN_TOKEN`, das Signatur-Geheimnis der OTP-Tokens `WAITLIST_SECRET`.
`GET /api/agent/status` zeigt ohne Token, was fehlt. Fehlt etwas, antwortet der Voice-Webhook mit 503.

**Twilio einrichten:** Nummer kaufen → Voice → „A call comes in“ → Webhook `https://<SITE_URL>/api/agent/voice-webhook`, HTTP POST.
Twilio-Region für EU-Verarbeitung: Irland (IE1), siehe `1-basis/ARCHITECTURE.md`.

**Lokal testen ohne AWS/Twilio:**

```bash
cd slotwise-website-online
AGENT_MODEL=fake AGENT_COMPANY="Nordlicht" npm run dev
curl -X POST localhost:3000/api/agent/voice-webhook -d "CallSid=CA1&From=%2B4915112345678"                  # Begrüßung (TwiML)
curl -X POST localhost:3000/api/agent/voice-webhook -d "CallSid=CA1&SpeechResult=Termin+nächste+Woche"       # Slots
curl localhost:3000/api/agent/activity -H "Authorization: Bearer local-admin"                                  # Feed
npm test                                                                                                       # 22 Tests
```

## Warteliste einrichten (einmalig)

Ohne diese Variablen antwortet `/api/waitlist` im Deployment mit 503 und das Formular zeigt „gerade nicht erreichbar“.

1. **Redis:** Vercel → Storage → Upstash for Redis → Region **Frankfurt (eu-central-1)** → mit dem Projekt verbinden. Setzt `KV_REST_API_URL` und `KV_REST_API_TOKEN`.
2. **Mailjet:** Konto anlegen, Absenderadresse/Domain verifizieren, API-Key erstellen.
3. **Environment Variables** (Production + Preview):
   - `WAITLIST_SECRET` – zufällig, mindestens 32 Zeichen (`openssl rand -hex 32`)
   - `MAILJET_API_KEY`, `MAILJET_API_SECRET`
   - `WAITLIST_FROM_EMAIL` (z. B. `hallo@slotwise.app`), optional `WAITLIST_FROM_NAME`
   - `SITE_URL` (z. B. `https://slotwise.app`)
   - optional `WAITLIST_NOTIFY_EMAIL` (Mail bei jeder Bestätigung), `WAITLIST_ADMIN_TOKEN` (CSV-Export)
4. Neu deployen.

Export: `curl -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" https://…/api/waitlist/export > warteliste.csv`

## Abo-Checkout (Stripe)

```
/preise ──GET──▶ /api/billing/config   { enabled, test }      (aus → Buttons bleiben bei der Warteliste)
        ──POST─▶ /api/billing/checkout { plan, interval } ─▶ Stripe Checkout Session (price_data inline) ─▶ { url }
Stripe  ──POST─▶ /api/billing/webhook  (Signatur über den Roh-Body) ─▶ Store: billing:sub:<sub_id>, Liste billing:log
```

Logik in `api/_lib/core/billing.js`, Vercel-Einstieg `api/billing/[action].js` (eine Funktion für alle drei Routen).
Preise stehen serverseitig in `PLAN_PRICES` (Professional 15 € / 12 €, Business 24 € / 19 € pro Host und Monat, netto);
ein Test vergleicht sie mit `2-packages-platform/packages/platform/config/plans.json`. Produkte oder Preise müssen im
Stripe-Dashboard nicht angelegt werden. Starter bleibt Warteliste, Enterprise Gesprächstermin.

| Key | Pflicht | Inhalt |
|---|---|---|
| `STRIPE_SECRET_KEY` | ja | Geheimer Schlüssel `sk_test_…` (oder eingeschränkter `rk_test_…` mit Schreibrecht auf Checkout Sessions). Ohne: Checkout aus, Preisseite unverändert |
| `STRIPE_WEBHOOK_SECRET` | ja | Signatur-Geheimnis des Webhook-Endpunkts (`whsec_…`). Ohne: Checkout ebenfalls aus, damit keine Abos unbemerkt abgeschlossen werden |
| `STRIPE_LIVE` | nein | Nur `"1"` erlaubt einen Live-Schlüssel (`sk_live_…`/`rk_live_…`). Sonst sperrt ein Live-Schlüssel die Abrechnung (Log: „Live-Schlüssel, aber STRIPE_LIVE …“) – Schutz, damit vor dem Livegang der App kein echtes Geld eingezogen wird |
| `STRIPE_REQUIRE_TOS` | nein | `"1"`: Kunde muss im Checkout den AGB zustimmen (`consent_collection`). Vorher im Stripe-Dashboard unter Einstellungen → Öffentliche Unternehmensdetails eine AGB-URL hinterlegen, sonst lehnt Stripe jede Session ab |
| `STRIPE_AUTOMATIC_TAX` | nein | `"1"`: Stripe Tax berechnet die Umsatzsteuer (`automatic_tax`). Die Preise sind netto (`tax_behavior: exclusive`); **ohne Stripe Tax wird keine MwSt. aufgeschlagen**. Stripe Tax im Dashboard aktivieren und die Steuerregistrierung (Deutschland) eintragen, dann setzen |
| `SITE_URL` | ja | Basis für Rücksprung-Adressen: `<SITE_URL>/checkout/erfolg?session_id=…` und `<SITE_URL>/preise?checkout=abgebrochen` |

Gespeichert wird im selben Store wie die Warteliste (Upstash Redis Frankfurt): je Abo `subscriptionId`, `customerId`,
`checkoutSessionId`, `status`, `plan`, `interval`, `quantity`, `email`, `updated` (+ `lastPaymentFailedAt`), dazu die letzten
200 Ereignisse ohne E-Mail und je Ereignis-ID ein Merker für 7 Tage (doppelte Zustellung). Die Rate-Grenze für Checkout-Starts
ist 10 je IP in 10 Minuten.

**Stripe einrichten:**

1. Testmodus: Entwickler → API-Schlüssel → geheimen Schlüssel als `STRIPE_SECRET_KEY` (Vercel, Production + Preview).
2. Entwickler → Webhooks → Endpunkt hinzufügen: URL `https://<SITE_URL>/api/billing/webhook`, Ereignisse
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Signatur-Geheimnis als `STRIPE_WEBHOOK_SECRET`.
3. Einstellungen → Kunden-E-Mails: „Erfolgreiche Zahlungen“ und Rechnungs-E-Mails einschalten (die Erfolgsseite kündigt eine
   Bestätigung von Stripe an).
4. Optional: AGB-URL hinterlegen → `STRIPE_REQUIRE_TOS=1`; Stripe Tax aktivieren → `STRIPE_AUTOMATIC_TAX=1`.
5. Neu deployen. `GET /api/billing/config` zeigt `{"enabled":true,"test":true}`, die Preisseite „Jetzt abonnieren“ und den
   Hinweis „Testmodus – es wird nichts abgebucht.“ Testkarte `4242 4242 4242 4242`.
6. Live erst nach dem App-Start: Webhook-Endpunkt im Live-Modus neu anlegen (eigenes `whsec_…`), `STRIPE_SECRET_KEY=sk_live_…`
   und `STRIPE_LIVE=1` setzen.

Lokal testen: `stripe listen --forward-to localhost:3000/api/billing/webhook` liefert ein `whsec_…` für `npm run dev`.
Der Webhook prüft die Signatur über die unveränderten Bytes (`readRawBody` in `http.js`, funktioniert mit node:http,
Express ohne vorgeschalteten Body-Parser und Vercel); ein vorher zu JSON geparster Body wird mit 400 abgelehnt.

## Google Kalender verbinden

```
Dashboard ──POST─▶ /api/google/connect  (Bearer)  ─▶ { url } + HttpOnly-Cookie ─▶ Google-Anmeldung (Code + PKCE S256 + state)
Google    ──GET──▶ /api/google/callback?code&state ─▶ Token-Austausch ─▶ Store: google:conn (Refresh-Token AES-256-GCM)
                                                   ─▶ 302 /dashboard/?google=connected  bzw.  ?google=error&reason=<code>
Dashboard ──GET──▶ /api/google/status   (Bearer)  ─▶ { enabled, connected, email?, connectedAt?, lastError?, writeEvents? }
          ──POST─▶ /api/google/disconnect (Bearer) ─▶ Widerruf bei Google (best effort) + Löschen
Agent     ── freeBusy.query("primary") bei Suche (fail-open) und letzter Prüfung (fail-closed) · events.insert bei fester Buchung
```

Logik in `api/_lib/core/google.js`, Kalender-Anbindung in `api/_lib/core/agent/calendar.js`, Vercel-Einstieg
`api/google/[action].js` (eine Funktion für alle vier Routen – Vercel Hobby: jetzt 10 von 12 Funktionen). Je Mandant eine
Verbindung im eigenen Schlüsselraum (`t:<id>:google:conn`, Einzelbetrieb `google:conn`); Bearer wie bei den Agenten-Routen
(`WAITLIST_ADMIN_TOKEN` bzw. `adminToken` aus `TENANTS_JSON`). Karte „Google Kalender“ in der Dashboard-Übersicht (nur live).

| Key | Pflicht | Inhalt |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | ja | Client-Secret des OAuth-Clients (`GOCSPX-…`). Nur als Umgebungsvariable, nie ins Repo. Ohne: Funktion aus, Endpunkte antworten 503 `{ "enabled": false }`, Dashboard zeigt „Nicht eingerichtet“ |
| `GOOGLE_CLIENT_ID` | nein | Client-ID (öffentlich). Standard: `437100738800-2cqlbpg2obj5ft673c2gr4d4c5hp0krj.apps.googleusercontent.com` |
| `SITE_URL` | ja | Basis der Redirect-URI, `https://…` (lokal auch `http://localhost:<port>`) |
| `WAITLIST_SECRET` | ja | Aus ihm wird per HKDF (`slotwise-google-token-v1`) der Schlüssel für die Refresh-Tokens abgeleitet. **Wechsel = alle Verbindungen müssen neu verbunden werden** |
| `KV_REST_API_URL`/`KV_REST_API_TOKEN` | ja (Deployment) | Store für Verbindungen und `state` (10 Minuten, einmalig) |

**Redirect-URI (exakt so eintragen):** `<SITE_URL>/api/google/callback`, z. B. `https://slotwise.app/api/google/callback`.
Das Dashboard muss unter derselben Domain wie `SITE_URL` geöffnet werden: Der Rücksprung prüft ein Cookie aus dem Browser, der die
Verbindung gestartet hat (Fehler sonst `reason=session_mismatch`; Vorschau-Deployments mit anderer Domain gehen daher nicht).

**Google Cloud Console einrichten:**

1. Projekt wählen (das der Client-ID oben) → APIs & Dienste → Bibliothek → **Google Calendar API** aktivieren.
2. OAuth-Zustimmungsbildschirm (Google Auth Platform → Branding/Zielgruppe): Typ „Extern“, App-Name, Support-E-Mail,
   Startseite, Link zur Datenschutzerklärung (`<SITE_URL>/datenschutz`) und autorisierte Domain (Domain von `SITE_URL`).
3. Datenzugriff/Bereiche: `openid`, `…/auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.freebusy`,
   `https://www.googleapis.com/auth/calendar.events.owned`.
4. Clients → OAuth-Client „Webanwendung“: autorisierte Weiterleitungs-URI `<SITE_URL>/api/google/callback` (für lokale Tests
   zusätzlich `http://localhost:3000/api/google/callback`). Client-Secret als `GOOGLE_CLIENT_SECRET` in Vercel (Production).
5. Solange die App im Status „Testen“ ist: unter Zielgruppe die Google-Konten als **Testnutzer** eintragen (max. 100); alle
   anderen sehen „Zugriff blockiert“. Refresh-Tokens laufen im Testmodus nach 7 Tagen ab (Dashboard zeigt dann „Neu verbinden“).
6. Für alle Nutzer: App veröffentlichen und **Verifizierung** beantragen. `calendar.freebusy` und `calendar.events.owned` sind
   sensible Bereiche → Prüfung durch Google (Begründung, Demo-Video, Datenschutzerklärung mit „Limited Use“-Hinweis – steht im
   Abschnitt „Google Kalender verbinden“ der Datenschutzerklärung). Ohne Verifizierung zeigt Google einen Warnhinweis.

Verhalten: Belegte Zeiten aus dem Hauptkalender werden ~60 s je Fenster im Prozess zwischengespeichert (Timeout 3 s). Ist Google
nicht erreichbar, bietet die Suche trotzdem Slots an (fail-open), die letzte Prüfung vor dem Buchen gilt aber als belegt
(fail-closed, `kind: "unverified"`) – wie bei CalenSync Enterprise. Feste Buchungen (Automatik oder Freigabe im Dashboard) werden als
privater Termin „Termin: <Name>“ eingetragen (Praxismodus: „Termin (Slotwise)“ ohne Namen), ohne Telefonnummer, E-Mail oder
Notizen, ohne Einladung; Fehler dabei brechen keine Buchung ab. Widerruft jemand den Zugriff bei Google (`invalid_grant`), gilt die
Verbindung als getrennt (`lastError: "reconnect_required"`) und es wird ohne Google weitergebucht, bis neu verbunden ist.
Access-Tokens liegen nur im Arbeitsspeicher; Logs und Weiterleitungen enthalten weder Tokens noch Googles Fehlertexte.

## Vor dem Livegang

- Firmendaten in `site-config.js` eintragen → Entwurfs-Banner und `noindex` verschwinden automatisch.
- Datenschutzerklärung rechtlich prüfen lassen (Abschnitte „Hosting dieser Website (Vercel)“ und „Warteliste“ nennen Vercel, Mailjet und Upstash; „Zahlungsabwicklung über Stripe“ nennt Stripe; „Google Kalender verbinden“ nennt Google und enthält den „Limited Use“-Hinweis).
- Sobald `app.slotwise.app` läuft: `VITE_APP_LIVE: "1"` in `site-config.js`.

## Mehrere Praxen (Mandanten)

```bash
TENANTS_JSON='[{"id":"praxis-berger","company":"Praxis Dr. Berger","hostName":"Dr. Berger",
  "adminToken":"<mindestens 24 zufällige Zeichen>","phoneNumbers":["+4921112345678"],"escalationPhone":"+492119876543"}]'
```

- Dashboard: Token der Praxis einmalig im Browser hinterlegen (`localStorage.setItem("slotwise.adminToken", "<adminToken>")`).
- Twilio: jede Praxisnummer zeigt auf dieselbe Webhook-URL; die angerufene Nummer (`To`) bestimmt die Praxis.
- Grenze: Token statt Benutzerkonten. Für Teams mit mehreren Mitarbeitenden fehlen noch Konten, Rollen und Protokoll.
