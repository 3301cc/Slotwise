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

1. **Lokal prüfen:** `npm ci && npm test` (in `app/`, `core/`, `scim/`). Hier laufen die echten Pakete (Prisma, pg, Express), die in meiner Umgebung nicht installierbar waren.
2. **AWS:** `tenants/acme-prod.tfvars.example` kopieren und ausfüllen, dann in `terraform/`:
   `terraform init -backend-config=backend.hcl` → `terraform validate` → `terraform plan` → `terraform apply`
3. **Secret `APP_CONFIG` befüllen** (DEPLOYMENT.md, Abschnitt 2B). Nie über Terraform, nie ins Repo.
4. **Datenbank:** Bootstrap-Task, dann Migrator-Task (Abschnitt 1, Schritte 2–3). Migrationen `core/migrations/000–006`.
5. **DNS:** `acme.calensync.de` als CNAME auf `terraform output -raw alb_dns_name`.
6. **Entra:** API-App (`Sync.Read`, `Sync.Write`) + SPA-App fürs Dashboard (Abschnitt 3).
7. **Website (Next.js auf Vercel):**
   - `frontend/calensyncApi.ts` ins Projekt kopieren, `npm i @azure/msal-browser`
   - Seite `/auth/callback` anlegen (MSAL-Redirect)
   - Vercel-Variablen: `NEXT_PUBLIC_CALENSYNC_API`, `NEXT_PUBLIC_ENTRA_TENANT_ID`, `NEXT_PUBLIC_ENTRA_SPA_CLIENT_ID`,
     `NEXT_PUBLIC_CALENSYNC_API_SCOPE`, `NEXT_PUBLIC_CALENSYNC_API_WRITE_SCOPE`
   - Dashboard-Domain exakt in `cors_allowed_origins` (tfvars) eintragen, kein `*`
8. **Testen:** `bash scripts/smoke/webhooks.sh https://acme.calensync.de` → muss mit 0 enden.

## API fürs Dashboard

| Methode | Pfad | Scope |
|---|---|---|
| GET | `/api/v1/me/sync-status` | `Sync.Read` |
| POST | `/api/v1/me/pipelines` (Header `Idempotency-Key`) | `Sync.Write` |

## Noch nicht fertig

- **Kalenderabgleich** (`pipeline.delta_sync`): Jobs werden eingestellt, aber noch nicht abgearbeitet. Termine werden also noch nicht übertragen.
- **Google-Abo-Anlage** (`events.watch` + Workload Identity): Der Eingang ist fertig, Channels entstehen noch nicht.
- **Nicht ausgeführt:** `terraform plan`, Docker-Build, Deployment auf AWS.
