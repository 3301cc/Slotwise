# Slotwise online stellen – Schritt für Schritt

Drei Teile, in dieser Reihenfolge. Teil A reicht für die Website; B und C machen die App und den Telefonagenten funktional.

| Teil | Was | Wo | Dauer | Kosten |
|---|---|---|---|---|
| A | Website (`apps/site`) | Vercel | 10 min | 0 € (Hobby) |
| B | App (`apps/web`) + Datenbank | Vercel + Neon | 45 min | 0 € (Hobby + Neon Free) |
| C | Telefonagent (`apps/voice`) | Fly.io + Twilio + AWS | 60 min | ab ~5 €/Monat + Verbrauch |

Voraussetzungen auf deinem Rechner: Node 22, pnpm (`npm i -g pnpm`), Git, ein GitHub-Konto. **Vor dem ersten Push einmal lokal bauen** – das Repo wurde bisher ohne installierte Pakete entwickelt, der erste echte Compile läuft bei dir:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @slotwise/site build
pnpm --filter @slotwise/web build     # braucht eine .env mit DATABASE_URL (Docker: pnpm db:up), sonst nur typecheck
```

Schlägt etwas fehl: Fehlermeldung kopieren und mir schicken, ich fixe es.

## 0. Repo auf GitHub

```bash
cd slotwise
git init && git add -A && git commit -m "Slotwise monorepo"
# auf github.com ein leeres Repo "slotwise" anlegen (privat), dann:
git remote add origin git@github.com:<dein-user>/slotwise.git
git push -u origin main
```

## A. Website auf Vercel

1. vercel.com → **Add New… → Project** → GitHub-Repo `slotwise` importieren.
2. **Root Directory** auf `apps/site` stellen (Edit → Ordner wählen). Framework wird als Vite erkannt; `apps/site/vercel.json` liefert den SPA-Fallback.
3. **Environment Variables** (Production):

   | Key | Wert |
   |---|---|
   | `VITE_APP_URL` | `https://app.slotwise.app` (oder die Vercel-URL der App aus Teil B, z. B. `https://slotwise-app.vercel.app`) |
   | `VITE_DEMO_BOOKING_PATH` | `/book/nordlicht/demo-call` |
   | `VITE_COMPANY_NAME` … `VITE_COMPANY_VAT_ID` | deine Impressumsangaben (Liste in `apps/site/.env.example`) |

4. **Deploy**. Danach unter Settings → Domains `slotwise.app` (oder deine Domain) verbinden.
5. Schriften: `inter-latin-var.woff2` und `plus-jakarta-sans-latin-var.woff2` nach `apps/site/public/assets/fonts/` legen (Quellen in der README dort), committen, pushen – Vercel deployt bei jedem Push automatisch.

## B. App auf Vercel + Neon

### B1. Datenbank (Neon, Region Frankfurt)

1. neon.tech → Projekt anlegen, Region **Europe (Frankfurt)**, Postgres 16.
2. Connection String kopieren (pooled) → das ist `DATABASE_URL`.
3. Schema einspielen – von deinem Rechner aus:
   ```bash
   DATABASE_URL="<neon-url>" pnpm --filter @slotwise/web prisma migrate deploy
   DATABASE_URL="<neon-url>" pnpm --filter @slotwise/web db:migrate:constraints
   DATABASE_URL="<neon-url>" pnpm --filter @slotwise/web prisma db seed      # Demo-Tenant "nordlicht" mit Jana/Mehdi/Lena
   ```

### B2. Login-Provider (mindestens einer)

- **Google**: console.cloud.google.com → APIs & Dienste → OAuth-Zustimmungsbildschirm (extern), dann Anmeldedaten → OAuth-Client-ID (Webanwendung). Autorisierte Redirect-URI: `https://<app-domain>/api/auth/callback/google`. Google Calendar API aktivieren. → `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.
- **Microsoft**: portal.azure.com → Microsoft Entra ID → App-Registrierung (multi-tenant). Redirect-URI: `https://<app-domain>/api/auth/callback/microsoft-entra-id`. API-Berechtigungen: `openid profile email offline_access Calendars.ReadWrite`. → `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`.

### B3. Vercel-Projekt für die App

1. **Add New… → Project** → dasselbe Repo noch einmal importieren, **Root Directory `apps/web`**.
2. Secrets erzeugen: `./scripts/gen-secrets.sh` (gibt sechs Zeilen aus).
3. **Environment Variables** (Production) – aus `.env.example`, mindestens:

   | Key | Woher |
   |---|---|
   | `DATABASE_URL` | Neon (B1) |
   | `APP_URL` | `https://<app-domain>` |
   | `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `INTERNAL_SHARED_SECRET`, `CRON_SECRET`, `GOOGLE_WEBHOOK_TOKEN`, `MICROSOFT_WEBHOOK_CLIENT_STATE` | `gen-secrets.sh` |
   | `AUTH_TRUST_HOST` | `true` |
   | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` und/oder `AUTH_MICROSOFT_ENTRA_ID_*` | B2 |
   | `ALERT_WEBHOOK_URL` | optional (Slack Incoming Webhook) |

4. **Deploy**. Region ist in `apps/web/vercel.json` auf `fra1` festgelegt.
5. Domain `app.slotwise.app` verbinden; danach in Teil A `VITE_APP_URL` darauf setzen und die Website neu deployen.
6. Test: `https://<app-domain>/login` → Google/Microsoft → Dashboard. `https://<app-domain>/book/nordlicht/demo-call` → eine Buchung machen → erscheint im Dashboard, Kalender-Push läuft direkt nach der Buchung (Inline-Drain) – auf dem Hobby-Plan zusätzlich zwei tägliche Crons (Renewal 03:00, Purge 03:30). Auf **Vercel Pro** in `apps/web/vercel.json` ergänzen: `{ "path": "/api/cron/outbox", "schedule": "* * * * *" }` und `{ "path": "/api/cron/sync-all", "schedule": "*/15 * * * *" }`.

## C. Telefonagent auf Fly.io

1. Twilio: Konto, Region IE1, eine deutsche Nummer kaufen. → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
2. AWS: IAM-User mit Rechten für Transcribe, Polly, Bedrock (Region eu-central-1); im Bedrock-Konsole-Modellzugang Claude Haiku 4.5 und Sonnet 4.5 (EU-Inferenzprofil) freischalten. → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
3. Fly: `flyctl auth login`, dann
   ```bash
   cd apps/voice
   fly launch --copy-config --no-deploy          # App-Name z. B. slotwise-voice, Region fra
   fly volumes create spool --region fra --size 1
   fly secrets set INTERNAL_SHARED_SECRET=<gleicher Wert wie in Vercel> VOICE_API_BASE_URL=https://<app-domain> \
     AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… \
     VOICE_PUBLIC_HOST=slotwise-voice.fly.dev SPOOL_DIR=/data
   fly deploy
   ```
4. Twilio-Nummer → Voice → „A call comes in“: Webhook `POST https://slotwise-voice.fly.dev/twilio/incoming`.
5. In der App unter Integrationen die Nummer dem Demo-Agenten zuordnen (Seed: `+4930555123456` – auf deine Twilio-Nummer ändern, `apps/web/prisma/seed.ts` oder Dashboard).
6. Anrufen. Der Feed im Dashboard zeigt das Gespräch; `fly logs` zeigt `spool.inline_ok` nach dem Auflegen.

## Danach

- Jeder `git push` auf `main` deployt Website und App automatisch (Vercel-Git-Integration); die Voice-App mit `fly deploy`.
- Plattform-Strang (`apps/worker`, eigenes Postgres-Schema) ist für den Betrieb der Website und App nicht nötig – erst wenn Abrechnung/Metering live gehen (ARCHITECTURE.md §0).
