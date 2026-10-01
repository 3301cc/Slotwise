# Slotwise Marketing-Website

Ausgeliefert wird `slotwise-website-online/` (Vercel, Root Directory = dieser Ordner, Framework „Other“).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `website-src/vendor/site.original.js` | ursprünglicher Vite-Build (keine Quellen im Repo) |
| `website-src/KiAgentPage.jsx` | Seite `/ki-agent` |
| `website-src/PraxenPage.jsx` | Seite `/praxen` für Arzt- und Zahnarztpraxen (Sie-Form, Pilotangebot, Praxis-Plan); Warteliste mit Quelle `praxen` |
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
| `slotwise-website-online/api/agent/*.js` | Vercel-Einstiege des Agenten, je eine Zeile |
| `slotwise-website-online/dashboard/` | Dashboard-Vorschau (`/dashboard`): Markup, Darstellung (`dashboard.js`), Datenschicht (`dashboard-data.js`), Ansichten Kunden / Event-Typen / Berichte (`views.js`, Hash-Routing `#kunden`, `#event-typen`, `#berichte`), Erklär-Tour (`tour.js`, eigenes CSS, kein Build nötig), gebautes CSS |
| `website-src/dashboard/` | Tailwind-Quelle und -Konfiguration des Dashboards |

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

## Vor dem Livegang

- Firmendaten in `site-config.js` eintragen → Entwurfs-Banner und `noindex` verschwinden automatisch.
- Datenschutzerklärung rechtlich prüfen lassen (Abschnitte „Hosting dieser Website (Vercel)“ und „Warteliste“ nennen Vercel, Mailjet und Upstash).
- Sobald `app.slotwise.app` läuft: `VITE_APP_LIVE: "1"` in `site-config.js`.
