# Slotwise Marketing-Website

Ausgeliefert wird `slotwise-website-online/` (Vercel, Root Directory = dieser Ordner, Framework „Other“).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `website-src/vendor/site.original.js` | ursprünglicher Vite-Build (keine Quellen im Repo) |
| `website-src/KiAgentPage.jsx` | Seite `/ki-agent` |
| `website-src/SitePatches.jsx` | Warteliste, `/anmelden`, Demo-Widget, Layout mit Entwurfs-Banner, Datenschutzerklärung |
| `website-src/build.py` | setzt beides in `assets/site.js` ein |
| `slotwise-website-online/assets/site-extra.css` | zusätzliche Utilities und Komponenten-CSS |
| `slotwise-website-online/site-config.js` | Firmendaten, App-Status, Demo-Telefonnummer (ohne Neubau änderbar) |
| `slotwise-website-online/api/_lib/core/` | Warteliste – Geschäftslogik, plattformunabhängig (reine Daten rein, reine Daten raus) |
| `slotwise-website-online/api/_lib/http.js` | HTTP-Adapter: node:http, Express/Fastify, Vercel → Core |
| `slotwise-website-online/api/waitlist/*.js` | Vercel-Einstiege, je eine Zeile |
| `slotwise-website-online/server/standalone.js` | eigener Server ohne Vercel (Hetzner, OVH, Docker) |
| `slotwise-website-online/dashboard/` | Dashboard-Vorschau (`/dashboard`): Markup, Darstellung (`dashboard.js`), Datenschicht (`dashboard-data.js`), gebautes CSS |
| `website-src/dashboard/` | Tailwind-Quelle und -Konfiguration des Dashboards |

Nach Änderungen an den `.jsx`-Dateien oder am Dashboard-CSS:

```bash
python3 website-src/build.py        # esbuild + Tailwind-CLI über npx – oder ESBUILD=/pfad, TAILWINDCSS=/pfad
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

Dark-Mode-Dashboard im Stil der Website: KPI-Leiste, Wochenkalender (gebucht / KI-Vorschlag / blockiert), KI-Aktivitäts-Feed,
KI-Einstellungen (Autonomie, Termine pro Tag, Anweisung). Alle Daten kommen aus `SlotwiseAPI` in `dashboard-data.js`:
heute Mocks, später `SlotwiseAPI.live = true` und die dort dokumentierten Endpunkte. Einstellungen werden bis dahin im
Browser (localStorage) gehalten. Der KPI „Verifizierte Leads“ liest `GET /api/waitlist/stats`, sobald im Browser
`localStorage.setItem("slotwise.adminToken", "<WAITLIST_ADMIN_TOKEN>")` gesetzt ist – ohne Token bleibt der Beispielwert.

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
