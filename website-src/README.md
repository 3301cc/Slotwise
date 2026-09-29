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
| `slotwise-website-online/api/waitlist/` | Vercel-Funktionen der Warteliste |

Nach Änderungen an den `.jsx`-Dateien:

```bash
python3 website-src/build.py        # nutzt esbuild (npx) – oder ESBUILD=/pfad/zu/esbuild
cd slotwise-website-online
npm test                            # API-Tests
npm run dev                         # http://localhost:3000, Warteliste speichert in .data/waitlist.json
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
