# CalenSync Enterprise – Deployment & Frontend-Anbindung

Stand 01.10.2026 · gilt für einen Mandanten-Stack (ein AWS-Account je Kunde, Region eu-central-1)

```
Browser (https://app.calensync.de, Vercel) ── Bearer-Token (Entra) ──┐
Microsoft Graph ── Change Notifications ─────────────────────────────┤
Entra ID / Okta ── SCIM 2.0 ─────────────────────────────────────────┤
                                                                     ▼
                         https://acme.calensync.de  →  ALB (TLS 1.3) + WAF
                                                                     │
                       ECS Fargate "app" (≥ 3 Tasks, 3 AZs, ein Image):
                         /healthz · /webhooks/graph · /scim/v2 · /api/v1 · Teardown- + Handshake-Worker
                                                                     │ IAM-Token, TLS verify-full
                                                     Aurora PostgreSQL Serverless v2 (privat)
```

Wichtig vorab: Es gibt keine CloudFront-Distribution im Stack. Der ALB ist der öffentliche Eingang. Ein CDN
davor bringt für eine API ohne cachebare Antworten nichts und würde die Webhook-Latenz nur verlängern.

---

## 1 · Terraform & Deployment

### Voraussetzungen

- [ ] Eigener AWS-Account für den Mandanten (AWS Organizations), Zugriff per SSO
- [ ] S3-Bucket für den Terraform-State **im Mandanten-Account** (Versionierung + SSE-KMS)
- [ ] ACM-Zertifikat in eu-central-1 für `acme.calensync.de`
- [ ] ECR-Repository `calensync-backend` im CI-Account; Repository-Policy erlaubt `ecr:BatchGetImage` und
      `ecr:GetDownloadUrlForLayer` für die Execution-Rollen des Mandanten-Accounts
- [ ] GitHub-OIDC-Provider in beiden Accounts, Rollen: `CI_ROLE_ARN` (ECR push), `DEPLOY_ROLE_ARN` (Terraform + ECS)
- [x] `prisma/schema.prisma` liegt im Repo (5 Modelle, nur für den Prisma-Client; `binaryTargets` inkl. ARM64).
      Die Tabellen legen allein die SQL-Migrationen an (`core/migrations/001_base_schema.sql` ff.)
- [x] `package-lock.json` in Root, `core/` und `scim/` committet (der Build nutzt `npm ci`)

### Erstinstallation (einmalig je Mandant)

```bash
cd terraform
cp ../tenants/acme-prod.tfvars.example ../tenants/acme-prod.tfvars     # Werte eintragen, keine Secrets
terraform init \
  -backend-config="bucket=<state-bucket>" \
  -backend-config="key=calensync/acme-prod.tfstate" \
  -backend-config="region=eu-central-1"

IMAGE="<ci-account>.dkr.ecr.eu-central-1.amazonaws.com/calensync-backend@sha256:<digest>"
terraform plan  -var-file=../tenants/acme-prod.tfvars -var "app_image=$IMAGE" -out=first.plan
terraform apply first.plan
bash checks/assert-no-secrets-in-state.sh                               # muss "OK" melden

# 1) Secret befüllen (Inhalt siehe Abschnitt 2) – NIE über Terraform
aws secretsmanager put-secret-value \
  --secret-id "calensync-acme-prod/app-config" --secret-string file://app-config.json
shred -u app-config.json

# 2) DB-Rollen anlegen (einziger Task mit Zugriff auf das von RDS verwaltete Master-Secret)
run_task() {   # $1 = Task-Familie
  aws ecs run-task --cluster "$(terraform output -raw ecs_cluster_name)" --task-definition "$1" \
    --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json app_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw app_security_group_id)],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text
}
T=$(run_task "$(terraform output -raw bootstrap_task_definition)")
aws ecs wait tasks-stopped --cluster "$(terraform output -raw ecs_cluster_name)" --tasks "$T"

# 3) Schema anlegen (core/migrations 001–008) als calensync_migrator
T=$(run_task "$(terraform output -raw migrate_task_definition)")
aws ecs wait tasks-stopped --cluster "$(terraform output -raw ecs_cluster_name)" --tasks "$T"
aws ecs describe-tasks --cluster "$(terraform output -raw ecs_cluster_name)" --tasks "$T" \
  --query 'tasks[0].containers[0].exitCode'                             # muss 0 sein

# 4) App neu starten (bisher fehlten Secret und Schema) und auf Stabilität warten
aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" --force-new-deployment
aws ecs wait services-stable --cluster "$(terraform output -raw ecs_cluster_name)" \
  --services "$(terraform output -raw ecs_service_name)"

# 5) DNS: CNAME acme.calensync.de → $(terraform output -raw alb_dns_name)
```

### Laufende Deployments (GitHub Actions, `.github/workflows/deploy.yml`)

`workflow_dispatch` mit `tenant=acme-prod`. Die Environment `acme-prod` verlangt eine Freigabe.

| Schritt | Was passiert | Bricht ab, wenn |
|---|---|---|
| test | Typecheck + Tests (app, core, scim) | ein Test rot ist |
| build | Image `linux/arm64` bauen, nach ECR pushen, **Digest** festhalten, SBOM + Provenance | Build scheitert |
| Phase 1 | `terraform apply` mit `app_image=<alt>`, `migrate_image=<neu>` | Plan/Apply oder Secret-Gate scheitert |
| Migration | `aws ecs run-task` Migrator, warten, Exit-Code prüfen | Exit-Code ≠ 0 – **die App läuft unverändert weiter** |
| Phase 2 | `terraform apply` mit `app_image=<neu>` → ECS Rolling Update | Apply scheitert |
| Stabilität | `services-stable` + laufende Revision == neuer Digest + `rolloutState COMPLETED` | Circuit Breaker oder Alarm haben zurückgerollt |
| Smoke-Test | `/healthz`, Webhook-Validierung, SCIM ohne Token = 401, fremde Origin = 403 | eine Antwort weicht ab (mit IP-Allowlist liefert die WAF für SCIM/API 403 – dann den Runner über einen festen Egress fahren oder diese zwei Prüfungen weglassen) |

### Warum dabei kein Webhook verloren geht

- [x] Rolling Update mit `minimum_healthy_percent = 100`, `maximum_percent = 200`: Neue Tasks laufen an, bevor alte gehen
- [x] ALB `deregistration_delay = 60 s`: Laufende Requests eines alten Tasks laufen zu Ende
- [x] `stopTimeout = 120 s` + Graceful Shutdown im Code: Worker beenden ihren Job, Leases geben Unfertiges frei
- [x] `/healthz` meldet ab SIGTERM 503; `keepAliveTimeout` (65 s) liegt über dem ALB-Idle-Timeout (60 s) → keine 502 durch geschlossene Keep-Alive-Verbindungen
- [x] Circuit Breaker + Alarm-Rollback (5xx, p99 > 2 s) während des Rollouts
- [x] Migrationen laufen **vor** dem neuen Code und müssen mit alter und neuer Version funktionieren (erst Spalten hinzufügen, im nächsten Release entfernen)
- [x] Selbst wenn ein Request verloren ginge: Graph wiederholt Zustellungen, `missed`-Events lösen einen vollen Delta-Abgleich aus

---

## 2 · Produktions-Umgebung

Es gibt **kein JWT-Secret, kein Datenbank-Passwort und keinen Graph-Client-Secret**:

- **Dashboard-API:** prüft Entra-Tokens gegen die öffentlichen Schlüssel von Microsoft (JWKS)
- **Datenbank:** IAM-Token je Verbindung (15 min gültig), aus der ECS-Task-Rolle
- **Graph:** Client-Assertion, signiert von einem KMS-Schlüssel, der AWS nie verlässt

Was übrig bleibt, ist wenig und klar getrennt.

### A) Umgebungsvariablen der ECS-Task (nicht geheim, gesetzt von Terraform)

| Variable | Beispiel | Quelle |
|---|---|---|
| `NODE_ENV` | `production` | fest |
| `TENANT_ID` | `acme` | `var.tenant_id` |
| `PORT` | `8080` | `var.app_port` |
| `PUBLIC_BASE_URL` | `https://acme.calensync.de` | `var.public_hostname` |
| `CORS_ALLOWED_ORIGINS` | `https://app.calensync.de` | `var.cors_allowed_origins` (Liste, kommagetrennt) |
| `API_AUDIENCE` | `api://calensync-acme,<api-client-id>` | `var.api_audience` |
| `API_REQUIRED_SCOPE` | `Sync.Read` | `var.api_required_scope` |
| `API_WRITE_SCOPE` | `Sync.Write` (für `POST /api/v1/me/pipelines`) | `var.api_write_scope` |
| `MAX_PIPELINES_PER_USER` | `5` (nicht widerrufene Pipelines je Nutzer) | `var.max_pipelines_per_user` |
| `LOG_LEVEL` | leer = `info`, `debug` nur zur Fehlersuche | optional |
| `DB_HOST` / `DB_READER_HOST` / `DB_PORT` / `DB_NAME` | Aurora-Endpunkte | Terraform |
| `DB_USER` | `calensync_app` (Migrator: `calensync_migrator`) | fest |
| `DB_IAM_AUTH` | `true` | fest – die App startet sonst nicht |
| `DB_POOL_MAX` | `20` | `var.db_pool_max` (Obergrenze im Code: 20) |
| `AWS_REGION` | `eu-central-1` | `var.region` |
| `SIGNING_KMS_KEY_ARN` / `TOKEN_KMS_KEY_ARN` | KMS-ARNs | Terraform |

### B) `APP_CONFIG` – das einzige Secret (AWS Secrets Manager, KMS `data`)

ECS injiziert es beim Start. Terraform legt nur den leeren Container an, der Inhalt ist nie im State.

```json
{
  "entraTenantId": "<GUID des Kunden-Mandanten>",
  "graphClientId": "<GUID der Graph-App-Registrierung>",
  "graphCertSha256Hex": "<SHA-256 des Zertifikats aus dem KMS-Signaturschlüssel, 64 Hex>",
  "scimTokenPepper": "<mind. 32 Zufallszeichen>",
  "scimTokens": [
    { "tenantId": "acme", "sha256Hex": "<SHA-256(pepper ‖ 0x00 ‖ token)>", "expiresAt": "2027-04-01T00:00:00Z" }
  ]
}
```

```bash
# Pepper und SCIM-Token erzeugen; der Klartext-Token geht NUR ins Entra-Provisioning ("Secret Token")
PEPPER=$(openssl rand -base64 48); TOKEN=$(openssl rand -base64 48 | tr -d '/+=')
printf '%s\0%s' "$PEPPER" "$TOKEN" | sha256sum | cut -d' ' -f1   # → sha256Hex
```

Der Start bricht ab bei: fehlender oder ungültiger Variable, `*` oder `http://` in CORS, Pepper < 32 Zeichen,
gesetztem `DB_PASSWORD` oder Pool > 20 (`app/src/config.ts`).

### C) GitHub (nur Variablen, keine Secrets – Anmeldung per OIDC)

| Variable | Ebene |
|---|---|
| `ECR_REPOSITORY`, `CI_ROLE_ARN` | Repository |
| `DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET` | Environment `acme-prod` (mit Pflicht-Freigabe) |
| `SMOKE_FRONTEND_ORIGIN` (optional) | Environment – positiver CORS-Preflight im Smoke-Test |
| `SMOKE_SCIM` (optional, `0`) | Environment – SCIM-Smoke aus, wenn die WAF `/scim` per IP-Allowlist sperrt |

### D) Frontend (Vercel, öffentliche Werte)

| Variable | Beispiel |
|---|---|
| `VITE_CALENSYNC_API` | `https://acme.calensync.de` |
| `VITE_ENTRA_TENANT_ID` | GUID des Kunden-Mandanten |
| `VITE_ENTRA_SPA_CLIENT_ID` | GUID der SPA-App-Registrierung |
| `VITE_CALENSYNC_API_SCOPE` | `api://calensync-acme/Sync.Read` |
| `VITE_CALENSYNC_API_WRITE_SCOPE` | `api://calensync-acme/Sync.Write` |

(Bei Next.js `NEXT_PUBLIC_…` statt `VITE_…`.) Diese Werte stehen ohnehin im ausgelieferten JavaScript und sind keine Secrets.

### Pool-Größe und Skalierung

```
max. Tasks × DB_POOL_MAX  ≤  db_max_connections_budget  <  max_connections (Aurora)
   9      ×     20       =  180  ≤  400 (Default)
```

- **Max. Tasks** = `app_desired_count × 3` (Autoscaling-Obergrenze).
- **Prüfung in Terraform:** `check "db_connection_budget"` in `ecs.tf` warnt bei `plan`, wenn die Rechnung nicht aufgeht.
- **Abgleich mit der Datenbank:** `max_connections` hängt bei Aurora Serverless v2 von der Max-ACU ab. Nach dem ersten Deploy einmal `SHOW max_connections;` ausführen und das Budget daran ausrichten.
- **Webhook-Eingang:** braucht pro Request genau 2 Roundtrips. 20 Verbindungen pro Task reichen nach Messung für deutlich über 900 Requests/s.

---

## 3 · Frontend-Anbindung & CORS

### Entra-App-Registrierungen (im Kunden-Mandanten)

- [ ] **CalenSync API (acme)**
  - Application ID URI `api://calensync-acme`
  - Scopes `Sync.Read` und `Sync.Write` (beide delegiert, Admin-Consent). `Sync.Write` braucht nur die Pipeline-Anlage
  - `accessTokenAcceptedVersion = 2`
  - Client-ID zusätzlich in `api_audience` eintragen
- [ ] **CalenSync Dashboard**, Plattform *Single-page application*
  - Redirect-URI `https://app.calensync.de/auth/callback`
  - API-Berechtigungen `api://calensync-acme/Sync.Read` und `…/Sync.Write`, Admin-Consent
  - **kein** Client-Secret
- [ ] (bestehend) **CalenSync Graph** für das Backend: Zertifikat aus KMS, Kalender-Berechtigung per RBAC begrenzt (siehe `powershell/`)

### Was der Server erlaubt (`app/src/cors.ts`, `app/src/server.ts`)

| Pfad | CORS | Auth |
|---|---|---|
| `/api/v1/*` | nur exakte Origins aus `CORS_ALLOWED_ORIGINS`; `GET, POST, OPTIONS`; Header `Authorization, Content-Type, X-Request-Id, Idempotency-Key`; sichtbar `X-Request-Id, Retry-After, Location, Idempotent-Replayed`; keine Credentials; `Vary: Origin`; Preflight-Cache 10 min | Entra-Bearer-Token: Signatur, `iss`, `tid`, `aud`, `exp`/`nbf` (±60 s), Scope je Route |
| `/scim/v2/*` | **keins** – `Origin` (auch `null`) oder `Sec-Fetch-*` → 403, noch vor der Authentisierung | SCIM-Bearer-Token (gehasht, timing-sicher, mit Ablaufdatum) |
| `/webhooks/graph` | keins | Validierungs-Handshake + `clientState` je Abo |

Weitere Absicherung im Server:

- Pfade mit `..`, `//` oder kodierten Punkten und Slashes → 400. Damit kann niemand über `/webhooks/../api` an der WAF-Ausnahme vorbei.
- HSTS 2 Jahre und `nosniff` auf jeder Antwort, `Cache-Control: no-store`.

Ein eigenes Express-CORS-Middleware gibt es nicht: Der Produktionsserver ist `node:http` (`app/src/server.ts`).
SCIM ist reiner Server-zu-Server-Verkehr und hat bewusst **kein** CORS.

### SCIM-Transport-Härtung (`scim/src/httpGuards.ts`, `scim/src/nodeHandler.ts`)

Ein Handler für beide Einbettungen: `app/src/server.ts` und `scim/src/expressRouter.ts` (dünne Hülle für bestehende
Express-Apps) rufen dasselbe `createScimNodeHandler` auf. Reihenfolge, billig vor teuer:

| Prüfung | Antwort | Sicherheitsereignis |
|---|---|---|
| `Origin` oder `Sec-Fetch-Site/-Mode` vorhanden | 403 | `scim_browser_origin` |
| Pfad mit `..`, `//`, `%2e`, `%2f`, `%5c`, `%00`, `\` (auf der rohen URL) | 400 | `bad_path` |
| Methode nicht `GET/POST/PUT/PATCH/DELETE` | 405 + `Allow` | – |
| Body-Methode ohne `application/scim+json` bzw. `application/json` (UTF-8) | 415 | – |
| `Content-Length` ungültig / > 256 KB, oder Stream > 256 KB | 400 / 413 | – |
| kein UTF-8, kein JSON-Objekt, Schlüssel `__proto__`/`constructor`/`prototype` | 400 `invalidSyntax` | – |
| doppelte Query-Parameter, > 20 Parameter | 400 `invalidValue` | – |
| Token falsch, fehlt oder abgelaufen | 401 | `scim_auth_failed` (ohne Token) |
| Kern braucht > 10 s (DB hängt) | 503 + `Retry-After: 5` | Log `scim_timeout` |

Ein **abgelaufenes, sonst korrektes** SCIM-Token löst zusätzlich den Alarm `scim_token_expired` aus. Grund: Ohne gültiges
Token stoppt das Offboarding, gesperrte Nutzer würden weiter synchronisiert. Rotation vor `expiresAt` einplanen.

Express-Einbettung: `app.use("/scim/v2", scimRouter(deps, { security: logger }))` **vor** jedem globalen
`express.json()`. Hat ein Parser den Body schon gelesen, antwortet der Router mit 500 + Log `scim_router_misconfigured`,
statt die Limits zu umgehen. Hinweis WAF: Das AWS Common Rule Set blockt Bodies > 8 KB auf `/scim` mit 403. Entra
sendet Einzel-User-Requests deutlich darunter; für Massen-PATCH wäre eine Ausnahme wie bei `/webhooks/` nötig.

### Frontend-Code (`frontend/calensyncApi.ts`)

```ts
import { useEffect, useState } from "react";
import { createCalensyncApi, msalTokenProvider, CalensyncApiError, type SyncStatus } from "./calensyncApi";

const api = createCalensyncApi({
  apiBaseUrl: import.meta.env.VITE_CALENSYNC_API,
  getAccessToken: msalTokenProvider({
    tenantId: import.meta.env.VITE_ENTRA_TENANT_ID,
    clientId: import.meta.env.VITE_ENTRA_SPA_CLIENT_ID,
    // beide Scopes derselben API → ein Token, scp = "Sync.Read Sync.Write"
    scope: [import.meta.env.VITE_CALENSYNC_API_SCOPE, import.meta.env.VITE_CALENSYNC_API_WRITE_SCOPE],
    redirectUri: `${location.origin}/auth/callback`,
  }),
});

// React
export function useSyncStatus() {
  const [state, setState] = useState<{ data?: SyncStatus; error?: CalensyncApiError }>({});
  useEffect(() => {
    const ac = new AbortController();
    api.getSyncStatus(ac.signal)
      .then((data) => setState({ data }))
      .catch((error) => { if (!ac.signal.aborted) setState({ error }); });
    return () => ac.abort();
  }, []);
  return state;
}

// Pipeline anlegen: Key EINMAL je Dialog erzeugen, bei „Erneut versuchen“ wiederverwenden
const key = crypto.randomUUID();
const p = await api.createPipeline({ mode: "busy", busyLabel: "Termin" }, key);
// p.replayed === true: der Server kannte den Key schon (z. B. Antwort ging verloren) – keine zweite Pipeline
```

Fehlerarten (`CalensyncApiError.kind`):

| Kind | Bedeutung | Was die UI tun sollte |
|---|---|---|
| `unauthenticated` | Anmeldung abgelaufen | neu anmelden |
| `forbidden` | Scope fehlt oder Origin nicht freigegeben | Hinweis anzeigen |
| `not_provisioned` | Konto noch nicht per SCIM angelegt | Hinweis anzeigen |
| `unavailable` | 429/503 nach 2 Wiederholungen mit `Retry-After` | später erneut versuchen |
| `network` | offline oder CORS-Blockade | Verbindung bzw. CORS-Freigabe prüfen |
| `timeout` | keine Antwort innerhalb von 10 s | erneut versuchen |
| `limit_reached` | 409: maximale Anzahl Pipelines | bestehende Verbindung entfernen |
| `invalid_request` | 400/413/415/422 (z. B. Key mit anderer Nutzlast wiederverwendet) | Eingabe korrigieren, neuen Key erzeugen |

### Pipeline-Anlage (`POST /api/v1/me/pipelines`, `app/src/pipelineStore.ts`)

```http
POST /api/v1/me/pipelines
Authorization: Bearer <Entra-Token mit Sync.Write>
Idempotency-Key: 0b7c1d1e-6a43-4c7e-9d2b-2f2a0d6f9c11      (16–64 Zeichen [A-Za-z0-9_-], Pflicht)
Content-Type: application/json

{ "mode": "busy", "busyLabel": "Termin" }                   (mode busy|full; busyLabel nur bei busy, 1–64 Zeichen)
```

| Antwort | Bedeutung |
|---|---|
| 201 + `Location` | angelegt, Status `pending`; Handshake-Job im selben Commit |
| 200 + `Idempotent-Replayed: true` | gleicher Key, gleiche Nutzlast → dieselbe Pipeline, nichts Neues |
| 400 | Key fehlt/ungültig, JSON kaputt, unbekanntes Feld (auch `__proto__`), Label mit Steuer-/Bidi-Zeichen oder `<>` |
| 401 / 403 | Token ungültig/abgelaufen / Scope `Sync.Write` fehlt |
| 404 | Nutzer nicht (mehr) per SCIM aktiv |
| 409 | `MAX_PIPELINES_PER_USER` erreicht (widerrufene zählen nicht) |
| 413 / 415 | Body > 4 KiB / kein `application/json` |
| 422 | Key schon mit anderer Nutzlast benutzt |
| 503 + `Retry-After` | Sperre/DB ausgelastet; Client wiederholt mit **demselben** Key |

Die Nutzer-ID kommt nur aus dem Token (`oid`), nie aus dem Body. Die Anlage nimmt dieselbe Advisory-Sperre wie die
SCIM-Deaktivierung und prüft `active` erst danach – ein gerade gesperrter Nutzer bekommt so nie eine aktive Pipeline.
Race-Test auf PostgreSQL: `DATABASE_URL=… bash scripts/bench/pipeline_race/run.sh` (mit Sperre 0 Verstöße, Negativkontrolle
ohne Sperre muss Verstöße zeigen). Migration `005_pipeline_create.sql`: Spalten `mode`, `busy_label`, `idempotency_key`,
`created_at`, eindeutiger Index je Nutzer und Key, Checks auf `mode` und Label-Länge.


### Vercel: Content-Security-Policy (`vercel.json`)

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Content-Security-Policy",
        "value": "default-src 'self'; connect-src 'self' https://acme.calensync.de https://login.microsoftonline.com; frame-ancestors 'none'" },
      { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains" }
    ]
  }]
}
```

---

## 4 · Webhook-Live-Schaltung

### URL

Der Eingang heißt **`/webhooks/graph`**, nicht `/webhook-ingress`. Der Handshake-Worker setzt beim Anlegen jeder
Graph-Subscription:

```
notificationUrl          = ${PUBLIC_BASE_URL}/webhooks/graph
lifecycleNotificationUrl = ${PUBLIC_BASE_URL}/webhooks/graph
clientState              = 32 Zufallsbytes je Abo, gespeichert in webhook_channels
```

Niemand trägt die URL von Hand bei Microsoft ein, und der Browser bekommt keinen Endpunkt, der Webhooks anlegt.

### Absicherung des Endpunkts

| Schicht | Maßnahme |
|---|---|
| Netz | ALB nimmt 443 weltweit an (Graph-Absender-IPs sind nicht fest). Eine optionale IP-Allowlist gilt nur für `/api` und `/scim` (WAF-Regel `allowlist-except-webhooks`). |
| WAF | Common Rule Set ohne 8-KB-Body-Grenze für `/webhooks/`, eigenes Rate-Limit `webhook_rate_limit_per_5min`, IP-Reputation |
| App | Validierungs-Token wird nur als `text/plain` zurückgegeben; `clientState` wird timing-sicher geprüft (Abweichung = Sicherheitsereignis im Log); unbekannte Abos und Abos gesperrter Nutzer werden verworfen; Body max. 1 MiB; Zeitbudget 2,5 s, sonst 503 (Graph wiederholt) |
| Last | 2 DB-Roundtrips je Request, gemessen bis > 900 Requests/s, CI-Gates in `calensync-qa/.github/workflows/webhook-ingress.yml` |

Graph-Change-Notifications haben **keine HMAC-Signatur** im Header; der `clientState` ist der vorgesehene
Echtheitsnachweis. Wer zusätzlich Signaturen braucht, muss auf Rich Notifications mit `validationTokens` (JWT von Microsoft)
umstellen – das ist eine eigene Ausbaustufe.

### Ablauf der Live-Schaltung

- [ ] Deployment grün inkl. Smoke-Test (Validierungs-Echo über das Internet)
- [ ] `curl -X POST "https://acme.calensync.de/webhooks/graph?validationToken=test"` liefert `test`
- [ ] WAF-Metriken prüfen: `rate-limit-webhooks` und `aws-common-webhooks` blockieren nichts
- [ ] Pipelines auf `pending` setzen bzw. bestehende Pipelines neu einstellen:
      `INSERT … pipeline.handshake` je Pipeline (der Worker legt die Abos an)
- [ ] Alte Abos (falls von einer Vorversion mit anderer URL): **nicht umbiegen**. Neu anlegen lassen und die alten über den Teardown-Worker beenden
- [ ] CloudWatch-Metric-Filter auf `"level":"security"` (clientState-Abweichung) und `"level":"alert"` (blocked_scope, Teardown-Fristen) mit Alarm anlegen

### Google Calendar (`/webhooks/google`, `core/src/googleWebhook.ts`)

Google schickt keinen Body, nur Header. Prüfkette je Notification:

1. Nur `POST`, kein `Origin`-Header, Body ≤ 1 KiB
2. Header-Syntax mit festen Zeichensätzen und Längen: Channel-ID ≤ 64, Token 16–256, Resource-State `sync|exists|not_exists`, Message-Number > 0
3. Ein Lookup: Channel mit `provider = 'google'`
4. Token (`client_state`) und Resource-ID werden **beide** timing-sicher verglichen
5. Abgelaufen (DB oder `X-Goog-Channel-Expiration`), gestoppt oder Pipeline nicht aktiv → verwerfen, Teardown sicherstellen
6. Ein Schreibzugriff, atomar: `last_message_number` steigt nur, und nur dann wird der Job eingestellt → **Replay-Schutz**

| Antwort | Wann |
|---|---|
| `200` | angenommen **oder** verworfen. Bewusst gleich, damit niemand Channel-IDs oder Tokens ausprobieren kann |
| `400` / `403` / `405` / `413` | ungültige Header / Browser-Origin / falsche Methode / Body zu groß |
| `503` | Datenbank langsamer als 2,5 s oder Fehler. Google wiederholt nur bei 500/502/503/504 |

Abgewiesene Requests landen als `"level":"security"` im Log, mit Grund, Request-ID, Quell-IP und gehashter Channel-ID.
Das Token und die Klartext-ID stehen nie im Log.

Migration `004_google_channels.sql`:

- Spalte `last_message_number`
- Check-Constraint: Ein Google-Channel ohne Token oder Resource-ID ist nicht speicherbar

**Noch offen für Google insgesamt:**

- **Watch-Handshake:** `events.watch` mit `id` = UUID, `token` = 32 Zufallsbytes base64url, `address` = `${PUBLIC_BASE_URL}/webhooks/google`
- Der Google-Token-Provider (Workload Identity Federation, keyless) existiert inzwischen für Google-**Ziele**
  (`core/src/googleAuth.ts`, Abschnitt „Kalenderabgleich → Ziel Google Workspace“); für `events.watch` auf einer
  Google-**Quelle** ist er noch nicht verdrahtet.

Der Eingang ist fertig. Echte Google-Channels entstehen erst mit dem Watch-Handshake.

### Smoke-Test nach jedem Deployment (`scripts/smoke/webhooks.sh`)

25 Prüfungen von außen über ALB und WAF: Health, Graph-Echo, Google-Annahme ohne Orakel, sieben Google-Abwehrfälle,
Pfad-Trick, acht SCIM-Fälle (401 ×2, Origin, Sec-Fetch, 415, 413, 405, Pfad), Pipeline-API (401 ×2, fremder Preflight 403,
mit `SMOKE_FRONTEND_ORIGIN` zusätzlich der eigene Preflight inkl. `Idempotency-Key` → 204). Jede Antwort < 3 s.
Optional kommt der positive Pfad dazu, über einen **dedizierten** Smoke-Channel (`SMOKE_GOOGLE_*`): `sync` → 200, derselbe Request erneut → 200 und als Replay verworfen.
Niemals einen echten Channel nehmen: Die Smoke-Message-Number würde den Replay-Schutz für echte Zustellungen verschieben.

### Verlängerung der Graph-Abos (`core/src/renewalWorker.ts`, Migration `006_channel_renewal.sql`)

Graph-Abos auf Kalender laufen nach höchstens 7 Tagen ab, wir legen sie mit 6 Tagen an. Ohne Verlängerung stünde der
Sync nach knapp einer Woche still, ohne Fehler, ohne Alarm.

- **Scheduler** (alle 10 min, ein `INSERT … SELECT`): Abos mit Ablauf < 24 h → Job `channel.renew`, gestreut über 30 min,
  aber nie später als 10 min vor Ablauf. Nur lebende Microsoft-Abos aktiver Pipelines, nicht nach einem endgültigen Fehler (6 h Pause).
- **Worker**: `PATCH /subscriptions/{id}` mit neuer Ablaufzeit. Gleicher Job für das Lifecycle-Event `reauthorizationRequired`.

| Graph antwortet | Folge |
|---|---|
| 200 | `expires_at` fortgeschrieben |
| 404 | Channel als gestoppt markiert + Handshake-Job für eine Neuanlage, **ein** Statement |
| 401 | Token verworfen, sofort zweiter Versuch |
| 429 / 5xx / Netz | Backoff ab 15 s, `Retry-After` nie unterschritten, max. 8 Versuche → Alarm `renewal_failed` |
| 403 | Backoff 30 / 60 / 120 min (RBAC-Replikation), nach 4 Versuchen Alarm |
| sonstige 4xx | sofort Alarm, Verlängerung 6 h pausiert |

Gestoppte Channels, nicht aktive Pipelines und deaktivierte Nutzer werden nie verlängert.

Mit dabei ein Fix im Handshake: `activateWithChannel` schreibt den Channel nur noch, wenn die Pipeline nicht `revoked`/`paused`
und der Nutzer aktiv ist (`FOR UPDATE` auf die Pipeline, wartet auf eine laufende Deaktivierung). Vorher konnte ein
während des Graph-POST deaktivierter Nutzer ein lebendes Abo behalten, bis die erste Notification den Teardown auslöste.

Der Kalenderabgleich selbst (`pipeline.delta_sync`) ist im folgenden Abschnitt beschrieben. Webhooks und
Lifecycle-Events stellen die Jobs ein (je Pipeline höchstens einer wartend), der Sync-Worker arbeitet sie ab.

### Kalenderabgleich (`core/src/syncWorker.ts`, Migration `007_sync.sql`)

Quelle ist immer das Microsoft-365-Postfach des Inhabers (`users/{entraObjectId}/calendarView/delta`, Fenster
jetzt − 1 Tag … + 90 Tage, alle 24 h neu aufgespannt). Ziel je Pipeline: `account` (zweites Postfach derselben Person,
auch in einem verknüpften Entra-Mandanten **oder in einem verknüpften Google Workspace**, Migration
`008_google_target.sql`, Unterabschnitt „Ziel Google Workspace“ unten), `team` (Team-Kalender im eigenen Mandanten)
oder `booking` (Buchungsseite, kein Schreibzugriff). Ziele nur aus dieser Allowlist in `APP_CONFIG`
(alle Schlüssel optional):

```json
{
  "ownDomains": ["acme-alias.de"],
  "ownDomainsIdentityAttribute": "objectId",
  "linkedTenants": [{ "entraTenantId": "<GUID Tochter-Mandant>", "label": "Acme Tochter GmbH",
                      "domains": ["acme-tochter.de"], "identityAttribute": "employeeId" }],
  "teamCalendars": [{ "id": "vertrieb", "mailbox": "vertrieb@acme.de", "label": "Vertrieb", "allowFullMode": false }],
  "bookingApiToken": "<mind. 32 Zufallszeichen, nur serverseitig>",
  "syncTentative": false
}
```

- **account:** Domain aus `linkedTenants[].domains` (anderer Mandant) bzw. `ownDomains` (eigener Mandant, nicht das
  Quellpostfach). **Dieselbe Person prüft Microsoft Graph** – bei der Anlage und im Worker (vor dem ersten Schreiben,
  dann spätestens alle 24 h): `GET /users/{id|upn}?$select=id,<Merkmal>` für Inhaber (Heim-Token) und Zielpostfach
  (Token des Zielmandanten); beide Werte nicht leer und exakt gleich.
  - `identityAttribute` je verknüpftem Mandanten: `employeeId` (Default), `onPremisesImmutableId`,
    `onPremisesSecurityIdentifier` – ein Merkmal, das in beiden Mandanten für dieselbe Person gleich gepflegt ist.
  - `ownDomainsIdentityAttribute`: `objectId` (Default, exakt: das Zielpostfach ist dasselbe Entra-Objekt wie der
    Inhaber) oder eines der drei Merkmale (zweites Konto derselben Person mit eigenem Objekt).
  - `localPart` (beide Schlüssel): **nur ausdrückliches Opt-in, ohne Graph-Prüfung** – es reicht dann der gleiche lokale
    Teil. Warnung: Zwei verschiedene Personen mit gleichem lokalen Teil in zwei freigegebenen Domains (z. B.
    jana@acme.de und jana@acme-alias.de) sind so nicht zu unterscheiden.
  - Ablehnung bei der Anlage: `422 target_not_allowed` mit `reason: "identity_unverified"`; Graph vorübergehend nicht
    erreichbar: `503 identity_check_unavailable` + `Retry-After` (nie „erlaubt“). Im Worker: kein Schreiben,
    Pipeline `config_error`, `lastError: identity_unverified`, Alarm. Gespeichert werden nur Zeitpunkt und Merkmal
    (`identity_verified_at`, `identity_attribute`), nie der Wert. Vorschläge in `GET /me/sync-targets` tragen
    `verified: false`.
  - Berechtigung: Graph-Anwendungsberechtigung `User.Read.All` (für `objectId` genügt `User.ReadBasic.All`) im
    eigenen **und** in jedem verknüpften Mandanten.
  Im verknüpften Mandanten muss die Graph-App per Admin-Consent freigegeben und per RBAC auf die Zielpostfächer
  begrenzt sein (`powershell/`, dort ausführen). Token je Entra-Mandant mit derselben KMS-Assertion; der Cache ist je
  Entra-Mandant getrennt.
- **team:** Postfach kommt nur aus der Config; es muss im RBAC-Scope der App liegen (Schreibrecht). Modus `full`
  (Betreff + Ort) nur mit `allowFullMode: true` (Default false): sonst `422 target_not_allowed` /
  `reason: "full_mode_not_allowed"`; wird die Freigabe später entzogen, schreibt der Worker alle Zieltermine einmal
  inhaltsfrei neu (Ort geleert, auch vergangene) und meldet `lastError: full_mode_not_allowed`.
  `GET /me/sync-targets` liefert je Team `fullMode: boolean`.
- Geprüft wird bei der Anlage (`422 target_not_allowed` + `reason`) und vor jedem Lauf im Worker erneut
  (sonst `config_error` + Alarm). Vor **jedem** Graph-Aufruf liest der Worker den Pipeline-Status neu.
- Gespeichert werden nur Quell-/Ziel-ID, Beginn, Ende, changeKey (`sync_event_map`), Delta-Link, `last_synced_at`,
  `last_sync_error` (nur Code). Termine, die aus dem Fenster fallen (Vergangenheit), werden **archiviert**
  (`archived_at`), nicht vergessen: kein Abgleich, keine Busy-API, aber die Bereinigung löscht auch ihre Zieltermine.
  Dieselbe Quell-ID mehrfach auf einer Delta-Seite: das letzte Vorkommen gilt. `busy`: Ziel bekommt Zeit, `showAs=busy`, `busyLabel`; `full`: zusätzlich Betreff und
  Ort, private Termine wie `busy`; Text und Teilnehmer nie.
- Jobs: Webhooks, erster voller Abgleich bei Aktivierung (gleiches Statement), Scheduler alle 15 min für Pipelines,
  deren letzter Abgleich > 12 h zurückliegt.
- `GET /api/v1/availability/busy?from=…&to=…` (≤ 62 Tage, ISO mit Zeitzone) mit `Authorization: Bearer <bookingApiToken>`
  liefert `{ "busy": [{ "start", "end" }] }` über alle aktiven `booking`-Pipelines, ohne Nutzerbezug. Zusammengefasst
  wird in SQL (`range_agg`, PostgreSQL ≥ 14) – vollständig, ohne Zeilenlimit; mehr als 5 000 zusammengefasste
  Intervalle → `503 busy_too_many` (nie stilles Abschneiden). Nur vom Server der Buchungsseite aufrufen, nie aus dem Browser.
- **Ende einer Pipeline = Spuren weg** (`core/src/cleanupWorker.ts`, Job `pipeline.target_cleanup`, dedupe je Pipeline):
  SCIM-Deaktivierung, SCIM-DELETE und `DELETE /api/v1/me/pipelines/{id}` (Nutzer, `Sync.Write`) setzen die Pipeline auf
  `revoked`, markieren `cleanup_requested_at` und stellen den Job **im selben Commit** ein. Der Worker löscht jeden von
  CalenSync angelegten Zieltermin (`404` = schon weg; unbestätigte Anlagen über die Extended Property), danach werden
  Zuordnungen gelöscht und das Zielpostfach genullt (`cleanup_done_at`). Nur DELETE-Aufrufe; keine
  „Inhaber aktiv“-Prüfung, aber Allowlist (ohne Same-Person-Prüfung, der Name ist nach DELETE geschwärzt).
  Fehler: Backoff; endgültig → Alarm `target_cleanup_failed`, Zuordnungen bleiben zur Nacharbeit.
  Nach SCIM-DELETE behält der Tombstone Zielpostfach und Termin-IDs, bis die Bereinigung fertig ist; erst dann löscht
  der Teardown-Worker ihn endgültig – spätestens nach 8 Tagen (Notbremse, Alarm `cleanup_deadline`).
- `DELETE /api/v1/me/pipelines/{id}`: `202 {id, status:"revoked", cleanup:"pending"}`, erneut `200` (cleanup
  `pending`/`done`), fremde/unbekannte ID `404 pipeline_not_found`, Nutzer nicht aktiv `404 user_not_provisioned`.
  Stoppt nur das Graph-Abo dieser Pipeline. `sync-status` zeigt je Pipeline `cleanup: "pending" | "done" | null`.
- Nicht enthalten: Fortsetzen sehr großer Kalender über mehrere Sync-Läufe (Budget 8 min je Lauf; die Bereinigung
  setzt dagegen fort).

#### Ziel Google Workspace (`core/src/googleCalendar.ts`, `core/src/googleAuth.ts`, Migration `008_google_target.sql`)

> **Nur gegen gefälschte Google-Endpunkte getestet** (STS, IAM, OAuth, Calendar, Directory in
> `core/test/googleTarget.test.ts`), nicht gegen echtes Google Cloud / Google Workspace. Vor dem ersten Kunden mit
> einem Test-Workspace Ende-zu-Ende prüfen.

Das zweite Konto derselben Person kann ein Google-Workspace-Konto sein. CalenSync schreibt per **domänenweiter
Delegation (DWD)** in den **Primärkalender** genau dieses Kontos – **ohne Dienstkonto-Schlüssel**:

```
ECS-Task-Rolle ──SigV4──▶ signierter sts:GetCallerIdentity (wird NICHT an AWS gesendet, nur an Google übergeben)
   ──▶ sts.googleapis.com/v1/token (Token-Exchange; Google prüft Konto + Rolle gegen den WIF-Provider)
   ──▶ iamcredentials …/serviceAccounts/<SA>:signJwt  (Google signiert { iss: SA, sub: <Zielpostfach>, scope, aud })
   ──▶ oauth2.googleapis.com/token (jwt-bearer) → Access Token nur für dieses Postfach und diesen Scope
```

`APP_CONFIG` (zusätzlich, optional):

```json
{
  "googleWorkloadIdentity": {
    "audience": "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/calensync-aws/providers/acme-prod",
    "serviceAccountEmail": "calensync-dwd@calensync-acme.iam.gserviceaccount.com"
  },
  "linkedGoogleWorkspaces": [{
    "id": "acme-google", "label": "Acme Google", "domains": ["acme-g.de"],
    "serviceAccountEmail": "calensync-dwd@calensync-acme.iam.gserviceaccount.com",
    "identityAttribute": "employeeId",
    "directoryAdminSubject": "calensync-directory@acme-g.de"
  }]
}
```

- `id` `[a-z0-9_-]` (steht in `pipelines.target_workspace_id`), `label` wird im Dashboard als „Zweites Konto (Google): …“
  gezeigt. `domains` dürfen sich mit `ownDomains`/`linkedTenants[].domains` nicht überschneiden (Start bricht ab).
- `serviceAccountEmail` je Workspace optional (Default: das aus `googleWorkloadIdentity`).
- `identityAttribute`: `employeeId` (Default) – **dieselbe Person** heißt: Entra `employeeId` des Inhabers (Graph,
  `User.Read.All` wie bisher) ist nicht leer und exakt gleich `externalIds[type=organization]` des Google-Kontos
  (Directory API `users.get`, genau ein Wert). Dazu muss das Google-Konto die Primäradresse sein (kein Alias) und
  darf nicht gesperrt sein. `localPart` = Opt-in ohne Prüfung (Warnung wie bei Microsoft).
- `directoryAdminSubject`: Pflicht bei `employeeId`. Nur dieses Konto wird für die Directory-Abfrage impersoniert
  (Scope `admin.directory.user.readonly`). Warum nicht der Zielnutzer selbst mit `viewType=domain_public`: die
  Mitarbeiter-ID ist ein Admin-Feld und dort nicht zuverlässig sichtbar.
- Request: `{ "kind": "account", "provider": "google", "workspaceId": "acme-google", "mailbox": "jana@acme-g.de" }`
  (ohne `provider` bzw. `provider: "microsoft"` bleibt alles wie bisher). Neue Fehler: `400 target_provider_invalid`,
  `400 target_workspace_id_invalid` (fehlt/ungültig bzw. bei Microsoft gesetzt), `400 target_entra_tenant_id_invalid`
  (Google mit Entra-Mandant), `422 target_not_allowed` + `reason: "workspace_not_linked"`.
- `GET /me/sync-targets`: Vorschläge zusätzlich `{ provider: "google", workspaceId, label, mailbox, verified: false }`;
  `sync-status`: `target: { kind: "account", label: "Google: <label>", provider: "google" }`.

Was geschrieben wird (`calendars/primary/events`, `sendUpdates=none`): `busy` = `summary` (busyLabel),
`transparency: "opaque"`, Beginn/Ende, Erinnerungen aus – kein `description`, `location`, `attendees`; `full` =
zusätzlich Betreff und Ort, private Termine wie `busy`. Jeder Termin hat eine **deterministische ID** (base32hex des
Hashes aus Pipeline + Quelltermin) und `extendedProperties.private.calensyncRef` (derselbe Hash, kein Inhalt).
Absturz nach dem Einfügen → nächster Lauf PATCHt dieselbe ID; `409` beim Einfügen (ID existiert, auch gelöscht) →
PATCH mit `status: "confirmed"`; `404`/`410` beim Löschen = erledigt. Die Bereinigung löscht alle Zieltermine
(auch archivierte und unbestätigte Anlagen) mit genau diesen IDs, nur per DELETE.
Vor jedem PATCH/DELETE einer ID, die nicht im selben Lauf angelegt wurde (gespeicherte ID, `409`), liest CalenSync
den Termin: er muss `calensyncRef` = erwarteter Hash tragen, sonst wird er **nie** geändert oder gelöscht
(Abgleich: `event_rejected` + Alarm `foreign_event`; Bereinigung: übersprungen + Alarm). Ein PATCH setzt die jeweils
andere Zeitart ausdrücklich auf `null` (Google führt `start`/`end` beim PATCH zusammen; sonst `400` beim Wechsel
ganztägig ↔ mit Uhrzeit). Bereinigung bei gelöschtem Google-Konto: Token-Tausch `invalid_grant` **und** Directory
`404` → Termine gelten als weg, erledigt; gesperrtes Konto bleibt ein Fehler (`blocked_scope` + Alarm).

Sicherheitsregeln wie bei Microsoft: Allowlist in API **und** Worker (Workspace + Domain), Prüfung „dieselbe Person“
bei der Anlage und spätestens alle 24 h im Worker, Pipeline-Status vor **jedem** Google-Aufruf (auch vor jedem Schritt
der Token-Kette), keine Inhalte in DB/Log/Alarm (Kanarienvogel-Tests). Tokens werden je (Dienstkonto, Postfach,
Scope) gecacht – ein Token von Person A kommt nie für Person B aus dem Cache. Fehler (`classifyGoogleError`):
`403 rateLimitExceeded/userRateLimitExceeded/quotaExceeded`, `429`, `5xx` → Backoff; `401` → Token neu;
`403 accessNotConfigured/insufficientPermissions/domainPolicy` → `config_error`; sonstige `403`, `404` →
`blocked_scope` (in den ersten 8 h nach Anlage: Wiederholung); Token-Kette: `unauthorized_client` (DWD fehlt) →
`config_error`, `invalid_grant` (Konto unbekannt/gesperrt) → `blocked_scope`, STS/IAM-Ablehnung → `config_error`.

**Was der Google-Admin des Kunden (bzw. der Betreiber im eigenen GCP-Projekt) einrichten muss:**

1. **GCP-Projekt des Betreibers** (eines je CalenSync-Mandant empfohlen): APIs aktivieren – *IAM Service Account
   Credentials API*, *Security Token Service API*, *Google Calendar API*, *Admin SDK API*.
2. **Dienstkonto** `calensync-dwd@<projekt>.iam.gserviceaccount.com` anlegen. **Keinen Schlüssel erzeugen**; per
   Organisationsrichtlinie `iam.disableServiceAccountKeyCreation` absichern. Notieren: **OAuth-2-Client-ID** (numerische
   „Unique ID“) des Dienstkontos.
3. **Workload Identity Pool + AWS-Provider**: Pool `calensync-aws`, Provider `acme-prod` vom Typ AWS mit der
   **AWS-Konto-ID des Mandanten-Stacks**; Attribut-Bedingung auf die Task-Rolle, z. B.
   `attribute.aws_role == "arn:aws:sts::<KONTO>:assumed-role/calensync-<tenant>-<env>-ecs-task"`.
   Die volle Provider-Ressource ist `audience` in `APP_CONFIG`.
4. **Impersonation erlauben**: auf dem Dienstkonto `roles/iam.serviceAccountTokenCreator` für
   `principalSet://iam.googleapis.com/projects/<NUMMER>/locations/global/workloadIdentityPools/calensync-aws/attribute.aws_role/arn:aws:sts::<KONTO>:assumed-role/calensync-<tenant>-<env>-ecs-task`
   (nur diese Rolle, nicht der ganze Pool). Mehr IAM-Rechte bekommt das Dienstkonto nicht.
5. **Google Workspace Admin-Konsole** → *Sicherheit → Zugriffs- und Datenkontrolle → API-Steuerung →
   Domainweite Delegierung*: Client-ID aus 2. mit **genau** diesen Scopes eintragen:
   `https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/admin.directory.user.readonly`.
6. **Directory-Subjekt**: Nutzer `calensync-directory@…` anlegen (keine Lizenz für Gmail/Kalender nötig), eine
   **benutzerdefinierte Admin-Rolle** nur mit *Admin-API-Berechtigungen → Nutzer → Lesen* erstellen und nur ihm
   zuweisen. Bei den Nutzern muss die Mitarbeiter-ID (*Nutzerinformationen → Mitarbeiter-ID*) = Entra `employeeId`
   gepflegt sein (z. B. per Google Cloud Directory Sync / Provisioning).
7. AWS: keine neue Berechtigung nötig (`sts:GetCallerIdentity` braucht keine). Egress 443 zu `sts.googleapis.com`,
   `iamcredentials.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `admin.googleapis.com`.

**Grenze (Fact Sheet D4):** Google kann DWD nicht auf Nutzer oder Gruppen einschränken – das Dienstkonto *könnte*
jedes Konto des Workspace impersonieren. CalenSync begrenzt das in Software: Kalender-Scope nur für Postfächer, die
(a) in `linkedGoogleWorkspaces[].domains` liegen, (b) einer Pipeline eines per SCIM provisionierten, aktiven Inhabers
gehören (also Mitglied der Freigabegruppe in Entra) und (c) nach Directory + Graph derselben Person gehören; nach
einem Widerruf nur noch DELETE der eigenen Termine (Bereinigung). Directory-Scope nur für `directoryAdminSubject`.
Abgewiesene Ziele: `config_error` + Alarm `worker_alert`; die Admin-Rolle des Directory-Subjekts begrenzt dessen
Leserechte plattformseitig.

**Reihenfolge beim Einführen:** erst Migration 008 + neuen Code ausrollen, **danach** `linkedGoogleWorkspaces` in
`APP_CONFIG` eintragen (neuer Task-Start). Ein noch laufender alter Task kennt Google-Ziele nicht und würde eine
Google-Pipeline als `target_not_allowed` stilllegen.

---

## 5 · Logging & Monitoring (`core/src/logger.ts`, `terraform/monitoring.tf`)

Eine JSON-Zeile je Ereignis auf stdout → awslogs → CloudWatch. Felder: `t`, `level`, `service`, `tenant`, `msg`, dazu
`requestId`, `ip`, `method`, `path` bei Sicherheitsereignissen.

- **Geschwärzt** werden Schlüssel wie `authorization`, `cookie`, `token`, `client_state`, `x-goog-channel-token`, `email`,
  `userName`, `name`; in jedem String zusätzlich JWTs, `Bearer …` und E-Mail-Adressen.
- **Begrenzt:** Strings 512 Zeichen, Tiefe 4, 40 Schlüssel, 20 Array-Elemente. Gepuffert und einmal je Event-Loop-Runde
  geschrieben; Überlauf (> 2 000 Zeilen) wird gezählt und als `log_lines_dropped` gemeldet statt Speicher zu fressen.
- **Level** `security` für abgewiesene Anfragen (`webhook_rejected`, `client_state_mismatch`, `scim_auth_failed`,
  `scim_browser_origin`, `api_auth_failed`, `api_insufficient_scope`, `cors_origin_rejected`, `bad_path`), `alert` für
  Betriebsalarme (`worker_alert`, `scim_token_expired`).

Alarme (Namespace `CalenSync/<tenant>`, je 5 min, an SNS-Topic mit eigenem KMS-Schlüssel):

| Metrik | Schwelle | Typischer Auslöser |
|---|---|---|
| SecurityEvents | ≥ 100 (`security_events_threshold`) | Scan, Brute-Force auf SCIM/API |
| SecretMismatch | ≥ 5 | falscher `clientState`/Google-Token → Abo kompromittiert oder Fehlkonfiguration |
| AlertEvents | ≥ 1 | `blocked_scope`, Teardown-Frist, abgelaufenes SCIM-Token |
| ErrorEvents | ≥ 20 | Fehlerwelle nach Deployment |
| LogLinesDropped | ≥ 1 | Logging kommt nicht hinterher |

- [ ] `alert_emails` in `tenants/<tenant>.tfvars` setzen und die Bestätigungsmail von SNS **annehmen** (sonst keine Alarme)
- [ ] Nach dem ersten Deployment: Smoke-Test laufen lassen und in CloudWatch prüfen, dass `SecurityEvents` steigt

---

## Prüfstatus dieses Pakets

| Teil | Geprüft |
|---|---|
| `app/` | Typecheck; 21 Tests (Config, Entra-Token mit echten RSA-Schlüsseln, Routing, CORS, Sicherheitsereignisse, Pipeline-Store mit Sperr-Reihenfolge, Replay, Limit, Race vor der Sperre, Lock-Timeout → 503, 19 manipulierte Bodies, Route 201/200/400/401/403/404/409/413/415/422/503) |
| `scim/` | 47 Tests, davon 17 neu für die Transport-Härtung über echtes `node:http` (Origin/Sec-Fetch, 10 Pfad-Tricks, 405, 415, 413 per Header und Chunked-Stream, `__proto__`, UTF-8, Timeout → 503, Fehlkonfiguration). Express-Adapter-Tests laufen über `node:http` (kein `fetch`, das `Sec-Fetch-Mode: cors` sendet) |
| Pipeline-Race | pgbench auf PostgreSQL 16, 24 Clients, 15 s, laufende Invarianten-Prüfung: mit Sperre 0 Verstöße bei ~3 900 Pipelines; ohne Sperre (Negativkontrolle) > 15 000 beobachtete Verstöße |
| Smoke-Test | 25/25 gegen den echten `createAppServer` lokal (HTTP), nicht gegen AWS |
| Migrationen | gegen PostgreSQL 16: Bootstrap, Vorwärts, Idempotenz, Rollback bei Fehler, Prüfsummen-Schutz, Default-Privileges (App darf DML, kein TRUNCATE/DDL) |
| `frontend/` | Typecheck; 4 Tests gegen den echten App-Server (200, 401 → Token-Erneuerung, 403, 404, 503 mit Retry-After, Netzwerkfehler, `createPipeline` inkl. Replay, 409, 422, verlorene Antwort → Retry mit demselben Key, genau eine Pipeline) |
| Google-Ziel | `core/test/googleTarget.test.ts` (16 Tests: Token-Kette mit echter SigV4-Signatur inkl. AWS-Testvektor, Caches je Subjekt, Anlage/Änderung/Löschung, 409 → PATCH, busy/full, Kanarienvogel, Allowlist, dieselbe Person, Bereinigung inkl. archivierter, Fehlerklassen) und `app/test/sync.pg.test.ts` (Migration 008). **Nur gegen gefälschte Google-Endpunkte** |
| `core/` | 71 Tests inkl. der PostgreSQL-16-Tests (Queue, Google-Replay-Schutz, Renewal-Scheduler und 404-Neuanlage, Aktivierung nach Deaktivierung), Logger, Renewal-Worker (200, 404, 401, 429/503/Timeout, 403, 400, Offboarding-Vorrang); Migration 006 zweimal eingespielt |
| Terraform | `terraform validate` mit hashicorp/aws 6.67.0: gültig; `terraform fmt` sauber. **Kein** `terraform plan` (keine AWS-Zugangsdaten) – vor dem ersten Apply zwingend |
| Dockerfile, Deploy-Workflow | YAML geprüft, **nicht gebaut/ausgeführt** (kein Docker, kein AWS in der Sandbox) |
| `pg`, Prisma, AWS SDK, MSAL | mit den echten Paketen geprüft (`npm ci`, Typecheck, `npm run build`); Migrationen 000–006 auf leerem PostgreSQL 16 angewendet, zweiter Lauf ohne Änderung; alle Suiten inkl. `*.pg.test` grün |
