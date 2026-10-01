# CalenSync Backend – Start hier

Details zu jedem Schritt stehen in `DEPLOYMENT.md`. Diese Seite ist nur die Reihenfolge.

## Was drin ist

| Ordner | Inhalt |
|---|---|
| `app/` | Der Server: API fürs Dashboard, SCIM, Webhooks, Worker |
| `core/` | Worker, Queue, Webhook-Eingänge, Logger, SQL-Migrationen |
| `scim/` | SCIM-Endpunkt für Entra (Nutzer anlegen/sperren) + Prisma-Schema |
| `frontend/calensyncApi.ts` | Fertiger API-Client fürs Dashboard (Login per Microsoft, Status, Pipeline anlegen) |
| `terraform/` | AWS-Stack (VPC, Aurora, ECS, ALB + WAF, KMS, Alarme) |
| `tenants/` | Beispiel-Konfiguration je Kunde |
| `scripts/smoke/` | Smoke-Test nach jedem Deployment |
| `.github/workflows/deploy.yml` | Deployment per GitHub Actions |

## Reihenfolge

1. **Lokal prüfen:** `npm ci && npm test` im Root (app), in `core/` und in `scim/`, dazu `npm run build`. Mit `DATABASE_URL` laufen zusätzlich die `*.pg.test`-Suiten.
2. **AWS:** `tenants/acme-prod.tfvars.example` kopieren und ausfüllen, dann in `terraform/`:
   `terraform init -backend-config=backend.hcl` → `terraform validate` → `terraform plan` → `terraform apply`
3. **Secret `APP_CONFIG` befüllen** (DEPLOYMENT.md, Abschnitt 2B). Nie über Terraform, nie ins Repo.
4. **Datenbank:** Bootstrap-Task, dann Migrator-Task (Abschnitt 1, Schritte 2–3). Migrationen `core/migrations/000–008` (001 legt das Basisschema an, 007 den Kalenderabgleich, 008 Google-Workspace-Ziele).
5. **DNS:** `acme.calensync.de` als CNAME auf `terraform output -raw alb_dns_name`.
6. **Entra:** API-App (`Sync.Read`, `Sync.Write`) + SPA-App fürs Dashboard (Abschnitt 3).
   Für zweite Konten (Ziel `account`) zusätzlich `User.Read.All` für die Graph-App – im eigenen und in jedem verknüpften
   Mandanten (Prüfung „dieselbe Person“, DEPLOYMENT.md, Abschnitt „Kalenderabgleich“).
   Für Google-Workspace-Ziele: GCP-Dienstkonto ohne Schlüssel, Workload Identity Federation (AWS), domänenweite
   Delegation, Directory-Konto – DEPLOYMENT.md, „Ziel Google Workspace“; `APP_CONFIG` erst **nach** dem Rollout von 008.
7. **Website (statische Seite in `slotwise-website-online/`, schon angebunden):**
   - In `slotwise-website-online/site-config.js` die fünf Werte eintragen: `CALENSYNC_API`, `ENTRA_TENANT_ID`,
     `ENTRA_SPA_CLIENT_ID`, `CALENSYNC_API_SCOPE`, `CALENSYNC_API_WRITE_SCOPE` (alle öffentlich, kein Secret, kein Neubau nötig)
   - Redirect-URI der SPA-App in Entra: `https://<website-domain>/auth/callback` (Plattform „Single-Page-Anwendung“)
   - Website-Domain exakt in `cors_allowed_origins` (tfvars) eintragen, kein `*`
   - Ergebnis: Im Dashboard erscheint die Karte „Microsoft 365“ (Anmelden, Sync-Status, Kalender verbinden).
     Code: `slotwise-website-online/dashboard/enterprise.js` (Portierung von `frontend/calensyncApi.ts`),
     `slotwise-website-online/auth/callback/index.html`, MSAL lokal unter `slotwise-website-online/vendor/`
   - `frontend/calensyncApi.ts` bleibt als Referenz für eine spätere Next.js- oder Vite-App.
8. **Testen:** `bash scripts/smoke/webhooks.sh https://acme.calensync.de` → muss mit 0 enden.

## API fürs Dashboard

| Methode | Pfad | Scope |
|---|---|---|
| GET | `/api/v1/me/sync-status` | `Sync.Read` |
| POST | `/api/v1/me/pipelines` (Header `Idempotency-Key`) | `Sync.Write` |
| GET | `/api/v1/me/sync-targets` | `Sync.Read` |
| DELETE | `/api/v1/me/pipelines/{id}` (beenden, Zieltermine werden entfernt) | `Sync.Write` |
| GET | `/api/v1/availability/busy?from&to` (Buchungsseite, statisches Token) | – |

## Noch nicht fertig

- **Kalenderabgleich** (`pipeline.delta_sync`): Worker, Migration 007 und API sind gebaut (DEPLOYMENT.md, Abschnitt
  „Kalenderabgleich“), aber nur gegen einen Graph-Fake getestet, nicht gegen echte Microsoft-365-Postfächer.
  Ziele: Microsoft 365 (zweites Konto, auch Tochter-Mandant; Team-Kalender), die Buchungsseite und – neu, Migration
  008 – ein **Google-Workspace-Konto derselben Person** (DWD, keyless über Workload Identity Federation). Nach
  Widerruf/Deaktivierung/Löschung entfernt ein Bereinigungs-Job die Zieltermine (ebenfalls nur gegen Fakes getestet).
- **Google-Ziel nur gegen gefälschte Google-Endpunkte getestet** (STS, IAM signJwt, OAuth, Calendar, Directory):
  Workload Identity Federation, `signJwt` mit föderiertem Token und DWD sind nicht gegen echtes Google geprüft.
  Vor dem ersten Kunden mit einem Test-Workspace Ende-zu-Ende fahren. Google als **Quelle** gibt es weiterhin nicht.
- **Google-Abo-Anlage** (`events.watch`): Der Eingang ist fertig, Channels entstehen noch nicht (der Workload-Identity-
  Token-Provider existiert jetzt, `core/src/googleAuth.ts`, ist dafür aber noch nicht verdrahtet).
- **Nicht ausgeführt:** `terraform plan`, Docker-Build, Deployment auf AWS.
