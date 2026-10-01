# CalenSync Enterprise: Architektur- und Compliance-Konzept

Stand 01.10.2026 · Zielbild für Kunden ab ca. 1.000 Mitarbeitenden in regulierten Branchen (Finanzwesen, Gesundheitswesen)

## Inhalt des Pakets

| Pfad | Inhalt | Prüfstatus |
|---|---|---|
| `terraform/` | Dedizierter Mandanten-Stack in eu-central-1: VPC (3 Schichten × 3 AZs), 4 KMS-Schlüssel, Aurora PostgreSQL Serverless v2, ECS Fargate (≥ 3 Tasks, Rolling 100/200 mit Alarm-Rollback), ALB + WAF, CloudTrail mit WORM-Archiv, Flow Logs, AWS Backup mit Vault Lock; `checks/assert-no-secrets-in-state.sh` als CI-Gate | Statisch geprüft (Klammern, alle Ressourcen-, Daten-, Variablen- und Local-Referenzen aufgelöst, Count-/Index-Konsistenz). **Kein `terraform validate/plan`**: Terraform-Binary und Registry waren in dieser Umgebung gesperrt. Erster Schritt beim Ausrollen: `terraform init && terraform validate && terraform plan` |
| `scim/` | SCIM-2.0-`/Users`-Endpunkt (TypeScript): framework-unabhängiger Kern, **gemeinsamer HTTP-Handler mit Transport-Guards** (`httpGuards.ts`, `nodeHandler.ts`: Origin/Sec-Fetch → 403, Pfad-Tricks, 415, 413 als Stream, UTF-8/JSON/Prototyp-Schlüssel, Zeitbudget → 503), Express-Adapter als dünne Hülle, Prisma-Store mit Kill-Switch-Transaktion und Audit-Hash-Kette; Token-Ablauf löst Alarm aus | Typecheck sauber, **47/47 Tests grün** (davon 17 Transport-Härtung über echtes `node:http`), Express-Adaptertests mit echtem Express 5 |
| `core/` | Teardown-Worker (Graph `DELETE /subscriptions/{id}`, Google `channels.stop`, danach Purge), KMS-signierte App-Tokens, IAM-DB-Login, Graph-Fehlerklassifikation (403-Replikation), Postgres-Delay-Queue mit ±15 % Jitter, Handshake-Worker, Webhook-Guard, Google-Push-Eingang mit Replay-Schutz, Verlängerung der Graph-Abos (Scheduler + Worker), strukturierter JSON-Logger mit Schwärzung, Graceful Shutdown, SQL-Migrationen | **71/71 Tests grün**, davon 7 gegen echtes PostgreSQL 16; Migrationen auf PostgreSQL 16 eingespielt (auch zweimal, idempotent) (Delay mit DB-Uhr, Dedupe, `SKIP LOCKED` mit zwei Workern, Lease-Übernahme). PG-Tests laufen mit dem echten `pg`-Treiber |
| `app/` | Deploybarer Server (`node:http`): `/healthz`, `/webhooks/graph`, `/webhooks/google`, `/scim/v2`, `/api/v1` mit strikter CORS-Allowlist, Entra-Token-Prüfung und Scope je Route; `POST /api/v1/me/pipelines` (Idempotency-Key, Limit, Advisory-Sperre gegen Offboarding-Race); Sicherheitsereignisse; Worker; Migrations-Runner | Typecheck, 21 Tests; Pipeline-Race mit pgbench gegen PostgreSQL 16 (0 Verstöße, Negativkontrolle ohne Sperre > 15 000) |
| `frontend/` | `calensyncApi.ts`: MSAL-Anmeldung + API-Client mit Fehlerbehandlung, `createPipeline` mit idempotenten Wiederholungen | Typecheck, 4 Tests gegen den App-Server |
| `Dockerfile`, `.github/workflows/deploy.yml`, `scripts/smoke/webhooks.sh`, `terraform/monitoring.tf`, `DEPLOYMENT.md` | distroless ARM64-Image; zweiphasiges Deployment; Smoke-Test aller Eingänge (25 Prüfungen); CloudWatch-Alarme auf Sicherheits- und Alarmereignisse | YAML geprüft; Smoke-Test 25/25 lokal gegen den echten Server; Terraform statisch geprüft |
| `powershell/` | `Set-CalenSyncMailboxScope.ps1` (RBAC for Applications + Legacy-AAP, Prüfungen, Nachweis-Export) und Schritt-für-Schritt-Anleitung inkl. Google Workspace | Klammer-/Quote-Prüfung; **nicht ausgeführt** (keine PowerShell, kein Exchange-Mandant). Vor Produktivnutzung mit `-WhatIf` in einem Testmandanten fahren |
| `CalenSync-Enterprise-Security-Fact-Sheet.docx` | Unterschriftsfähiger Fragen-/Antwortkatalog (Verschlüsselung, SIEM, RTO/RPO, Datenresidenz, Art. 28 DSGVO) mit Status je Antwort | Gerendert und geprüft |

## 1 · Isolationsmodell

„Mathematisch ausgeschlossen“ ist kein Versprechen, das ein Betreiber seriös abgeben kann. Erreichbar ist: **Ein Datenleck zwischen Mandanten setzt einen Fehler in einer AWS-Isolationsgrenze voraus, nicht in CalenSync-Code.** Dafür sorgen vier Grenzen von außen nach innen:

```
AWS Organization (Betreiber)
├── Account "calensync-shared-ci"         Build, ECR (Images werden per Digest gezogen)
├── Account "calensync-tenant-acme"        ◀── terraform apply -var-file=acme.tfvars
│   └── VPC 10.40.0.0/16 (kein Peering, kein Transit Gateway zu anderen Mandanten)
│       ├── public  /24 ×3   ALB (TLS 1.3/1.2, WAF) · NAT-Gateways (feste Egress-IPs)
│       ├── app     /20 ×3   ECS Fargate (read-only FS, non-root, keine öffentliche IP) · VPC-Endpoints
│       └── data    /24 ×3   Aurora Serverless v2 (keine Route nach außen, nur :5432 aus app)
│       KMS: data · logs · tokens (90-Tage-Rotation) · signing (RSA, kms:Sign für Entra)
│       CloudTrail → S3 Object Lock COMPLIANCE (400 Tage) · AWS Backup Vault Lock
└── Account "calensync-tenant-<nächster>"  identischer Stack, eigener State, eigene Schlüssel
```

Warum ein eigener **Account** und nicht nur eine eigene VPC: IAM-Fehlkonfigurationen, Service-Quotas, CloudTrail und KMS-Schlüsselrichtlinien sind accountweit. `allowed_account_ids` im Provider verhindert, dass ein falsches AWS-Profil einen Stack in den Account eines anderen Kunden schreibt.

Für Kunden, die das US-CLOUD-Act-Risiko ausschließen müssen: Der Stack ist regionsparametrisiert und kann in der **AWS European Sovereign Cloud** (eusc-de-east-1, Brandenburg, seit 14.01.2026 verfügbar) betrieben werden. Den Dienstumfang dort vorab gegen die genutzten Ressourcen abgleichen.

### Bewusste Entscheidungen im Terraform

- **Anwendung ohne Datenbankpasswort:** IAM-Datenbank-Authentifizierung (`rds-db:connect` nur für `calensync_app`). Das Master-Passwort verwaltet und rotiert RDS in Secrets Manager. Es taucht weder in Code noch im State auf.
- **pgaudit protokolliert nur `ddl,role`**, keine Lese- oder Schreib-Statements. Sonst landen personenbezogene Werte in Logs (Datenminimierung).
- **ALB-Zugriffslogs mit SSE-S3:** Der ALB unterstützt für Access-Logs keine KMS-Schlüssel. Das ist im Fact Sheet offen benannt.
- **Vault Lock** (`changeable_for_days = 3`) wird nach drei Tagen unwiderruflich. Danach kann niemand Backups vor Ablauf der Mindestaufbewahrung löschen. Vor dem ersten Apply mit Datenschutz abstimmen, denn es kollidiert mit sehr kurzen Löschfristen.
- **DR-Kopie standardmäßig aus:** Deutschland hat im kommerziellen AWS nur die Region Frankfurt. Eine Kopie nach Irland ist DSGVO-konform, verletzt aber eine Vorgabe „nur Deutschland“. Das entscheidet der Kunde per `dr_copy_enabled`.

### Ausbaustufe 2 (nicht im Code)

- **Egress-Allowlist auf Domain-Ebene** mit AWS Network Firewall (`graph.microsoft.com`, `login.microsoftonline.com`, `*.googleapis.com`, `oauth2.googleapis.com`). Heute begrenzen Security Groups nur auf Port 443.
- **End-to-End-TLS** bis in den Container (Target Group `HTTPS`, Zertifikat aus AWS Private CA).
- **SIEM-Export als Modul:** CloudWatch-Subscription → Amazon Data Firehose → Splunk HEC bzw. Sentinel-Connector.
- **GuardDuty, Security Hub, AWS Config** org-weit über den Management-Account aktivieren, nicht pro Stack.

## 2 · Identitäten: SSO + SCIM + Kill-Switch

```
Entra ID / Okta (Kunde)                         CalenSync-Mandanten-Stack
─────────────────────────                       ──────────────────────────────────────────────
Mitarbeiter deaktiviert ──SCIM PATCH active=false──▶ /scim/v2/Users/{id}
                                                     1. Bearer-Token → tenantId (SHA-256 + Pepper, timing-sicher)
                                                     2. revokeSyncForUser()  ── EINE Transaktion (Serializable):
                                                          pipelines.status = 'revoked'
                                                          provider_tokens   → gelöscht
                                                          webhook_channels  → stop_requested
                                                          job_queue         → "subscription.teardown"
                                                        DELETE zusätzlich in derselben Transaktion:
                                                          scim_users        → Tombstone ohne PII (deletion_requested_at)
                                                     3. User-Datensatz: active=false (PATCH/PUT)
                                                     4. Audit-Event (Hash-Kette)
                     ◀────────── 200 / 204 ──────────  nach dem Commit; KEIN Aufruf bei Microsoft/Google im Request
TeardownJobWorker ──▶ Graph DELETE /v1.0/subscriptions/{id} · Google channels.stop
                      offen? → Backoff ±15 % · alles beendet? → Tombstone endgültig löschen (purge)
Webhook-Guard ──▶ verwirft jede Notification eines stop_requested-Channels (nichts wird gelesen)
```

**Was der Code garantiert:**
- **Kappen vor Antwort:** Die Antwort an den IdP geht erst raus, wenn die Kappung committed ist.
- **Jedes `active=false` kappt:** nicht nur der Übergang von aktiv zu inaktiv, sondern jede Operation mit diesem Ergebnis. Ein Retry von Entra heilt dadurch einen vorher abgebrochenen Lauf.
- **SCIM-Antwortzeit hängt nur an der eigenen Datenbank:** Kein Provider-Aufruf im Request. Kappung, Tombstone und Teardown-Job sind ein Commit – entweder alles oder nichts, ein IdP-Retry heilt.
- **Personenbezogene Daten fallen sofort, der Datensatz nach dem Teardown:** DELETE leert Name, Mail und externe IDs im selben Commit. Die interne ID bleibt, bis der Worker alle Abos beendet hat; dann löscht er den Tombstone. Notbremse nach 8 Tagen (Graph-Abos laufen spätestens nach 7 Tagen aus).
- **Abos sterben vor dem Datensatz:** `webhook_channels` hängt bewusst nicht per FK-Cascade am User, damit offene Stop-Retries die Löschung überleben.
- **Reaktivierung gibt nichts frei:** Pipelines bleiben `revoked`, bis jemand sie bewusst neu freigibt.
- **Mandantengrenzen sind dicht:** IDs eines anderen Mandanten liefern `404`, nie `403`.

**Was er nicht garantieren kann:**
- **Entra überträgt im Provisionierungszyklus.** Inkrementelle Läufe kommen typischerweise im Abstand von bis zu ca. 40 Minuten. Für sofortiges Offboarding gehört „Bei Bedarf bereitstellen“ (Provision on demand) oder ein Lifecycle Workflow ins Runbook des Kunden.
- **Entra sendet `DELETE` erst bei endgültiger Löschung**, also nach 30 Tagen Papierkorb. Das Offboarding hängt deshalb am Deaktivieren, nicht am Löschen.

**Zweite Verteidigungslinie:** Selbst wenn SCIM zu spät kommt, scheitert der Graph-Zugriff auf Postfächer außerhalb der Freigabegruppe an Exchange RBAC (Abschnitt 3). Ein entfernter Mitarbeiter fällt aus der Gruppe und damit aus dem Scope, nach Ablauf des Exchange-Caches (30 Min. bis 2 Std.).

Der Sync-Worker muss **vor jedem Provider-Aufruf** den Pipeline-Status lesen. Diese Prüfung gehört in den Worker-Code und ist in der QA-Suite mit dem Muster `assert_pipeline_alive` bereits angelegt.

## 3 · Mandantenweite Admin-Freigabe

Siehe `powershell/ANLEITUNG-Admin-Consent.md`. Kernpunkte:

- **Application Access Policies sind abgelöst.** Microsoft führt RBAC for Applications als Nachfolger. Das Skript nutzt RBAC als Standard und AAP nur als Legacy-Modus.
- **Im RBAC-Modus darf die App in Entra keinen mandantenweiten Kalender-Grant haben.** Entra-Grants und Exchange-RBAC addieren sich, ein unbeschränkter Grant hebt die Begrenzung auf. Das Skript prüft das und bricht ab.
- **Ausschluss in zwei Schichten:** Gruppenmitgliedschaft (nur direkte Mitglieder zählen) und zusätzlich ein Abteilungsfilter (`Department -ne 'Personal'`). Ein HR-Postfach, das versehentlich in die Gruppe gerät, bleibt so trotzdem gesperrt.
- **Google Workspace hat kein plattformseitiges Gegenstück.** Domänenweite Delegation ist alles oder nichts. Das ist im Fact Sheet unter D4 als Restrisiko ausgewiesen. Für Google als Ziel „zweites Konto“ begrenzt CalenSync die Impersonation in Software (Allowlist in API und Worker, Directory-/Graph-Prüfung „dieselbe Person“, nur `calendar.events` für Zielkonten, `admin.directory.user.readonly` nur für ein Directory-Konto mit Rolle „Nutzer: Lesen“); das Dienstkonto hat keinen Schlüssel (IAM `signJwt` über Workload Identity Federation aus AWS). Details: DEPLOYMENT.md, „Ziel Google Workspace“.

## 4 · Compliance-Abbildung

| Anforderung | Umsetzung | Fundstelle |
|---|---|---|
| Art. 5 Abs. 1 lit. c DSGVO (Datenminimierung) | Keine Termininhalte persistent, SCIM-Attribut-Whitelist, pgaudit ohne Datenwerte | `scimUsers.ts` (applyPath), `database.tf` |
| Art. 25 (Privacy by Design/Default) | Busy-Modus ohne Inhalte, DR-Kopie per Default aus | QA-Suite PR-01, `variables.tf` |
| Art. 28 Abs. 3 lit. a–h | AVV-Zusagen G1–G8 | Fact Sheet, Abschnitt G |
| Art. 32 (TOMs) | Verschlüsselung, Isolation, Zugriffskontrolle, Wiederherstellung | Fact Sheet, B–F |
| Art. 33 (Meldung) | Meldung an Verantwortlichen ≤ 24 h | Fact Sheet G6 |
| Art. 17 / Vertragsende | Account-Abbau + Krypto-Löschung über KMS-Schlüssel | Fact Sheet G7 |
| ISO/IEC 27001 Anhang A (Logging, Kryptografie, Lieferanten, Backup) | CloudTrail-WORM, KMS, Vault Lock, SCIM-Audit | `audit.tf`, `kms.tf`, `backup.tf` |
| DORA Art. 30 (bei Finanzkunden) | Zusatzvereinbarung: Prüfrechte, Exit, Kündigung | Fact Sheet H4 |

**Offen und im Fact Sheet als offen markiert:** ISO-27001-Zertifizierung des Betreibers, externer Penetrationstest, erster Restore-Test, End-to-End-TLS im VPC, SIEM-Anbindung. Diese Punkte entscheiden, ob das Fact Sheet heute unterschrieben werden kann. Sie sollten vor einem Rollout bei einem Kunden dieser Größe geschlossen oder vom Kunden schriftlich akzeptiert sein.

## 5 · Härtung Oktober 2026: vier Bruchstellen

| # | Befund | Umsetzung | Nachweis |
|---|---|---|---|
| 1 | Klartext-Passwort im Terraform-State | War bereits ausgeschlossen: `manage_master_user_password = true`, RDS erzeugt und rotiert das Passwort in Secrets Manager (KMS `data`). **`random_password` + `aws_secretsmanager_secret_version` wurde bewusst nicht eingeführt**, denn beide speichern den Klartext im State. Neu: `postcondition` am Cluster und CI-Gate `checks/assert-no-secrets-in-state.sh` (bricht bei `random_password`, `master_password` oder `secret_string` im Plan/State ab) | `database.tf`, `checks/` |
| 2 | Webhook-Abos überleben das SCIM-DELETE | `SubscriptionTeardown` beendet Abos aktiv mit App-Credentials (KMS-signierte Client-Assertion, kein Secret), seit Abschnitt 6 ausschließlich im Worker. Webhook-Guard als zweite Linie | `core/src/subscriptionTeardown.ts`, `core/src/teardownJob.ts` |
| 3 | 403 nach SCIM-Provisionierung blockiert Pipeline | `classifyGraphError`: 403 `ErrorAccessDenied` / 404 Postfach innerhalb von 8 h nach Freigabe → Retry nach 30, 60, 120, 240 min. Danach `blocked_scope` + Alarm. `Authorization_RequestDenied` sofort `config_error`. Delay-Queue in Postgres, weil SQS `DelaySeconds` bei 15 min endet | `core/src/errorHandler.ts`, `retryQueue.ts`, `handshakeWorker.ts` |
| 4 | Keine Zero-Downtime-Garantie | War bereits 3 Tasks / 100 % / 200 %. Neu: ALB-Drain 60 s, `stopTimeout` 120 s, Alarm-Rollback (5xx, p99), AZ-Rebalancing, `desired_count` vom Autoscaling entkoppelt, Graceful Shutdown im Code. Verlustfreiheit kommt zusätzlich aus Graph selbst (Retry bis 4 h) und dem Delta-Resync bei `missed` | `ecs.tf`, `edge.tf`, `core/src/shutdown.ts`, `webhookGuard.ts` |

**Verdrahtung im Backend:**

```ts
import pg from "pg";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { hostname } from "node:os";
import { KmsSignedGraphTokenProvider, PgChannelRepo, PgDelayedJobQueue, SubscriptionTeardown, TeardownJobWorker,
  installGracefulShutdown, iamDbSettingsFromEnv, createIamPgPool } from "@calensync/core";

const db = iamDbSettingsFromEnv();                        // bricht ab, wenn irgendwo ein DB-Passwort auftaucht
const pool = createIamPgPool(pg.Pool, db, (m, e) => console.error(m, e)); // 600 s Lebensdauer, error-Listener
const kms = new KMSClient({ region: "eu-central-1" });
const tokens = new KmsSignedGraphTokenProvider(loadEntraConfig, async (digest) =>
  Buffer.from((await kms.send(new SignCommand({ KeyId: process.env.SIGNING_KMS_KEY_ARN, Message: digest,
    MessageType: "DIGEST", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" }))).Signature!), fetch);
const channels = new PgChannelRepo(pool);
const teardown = new SubscriptionTeardown({ channels, tokens, fetchFn: fetch });

const queue = new PgDelayedJobQueue(pool);
const scimStore = new PrismaScimStore(prisma);           // Prisma über @prisma/adapter-pg mit demselben IAM-Pool
const teardownWorker = new TeardownJobWorker({
  queue, teardown, channels, users: scimStore, workerId: hostname(),
  audit: (e) => scimStore.appendAudit({ tenantId: e.tenantId, requestId: e.jobId, actor: "worker:subscription-teardown",
    action: e.action, targetUserId: e.userId, outcome: e.outcome, detail: e.detail, at: new Date().toISOString() }),
  alert: (e) => alerts.publish(e),                        // z. B. SNS → On-Call
});
setInterval(() => void teardownWorker.tick(), 5_000);
installGracefulShutdown({ server, workers: [teardownWorker, handshakeWorker], closePool: () => pool.end(), log: console.log });
```

Für Google-Ziele gibt es `WorkloadIdentityGoogleTokenProvider` (`core/src/googleAuth.ts`: SigV4-signierter `GetCallerIdentity` → Google STS → IAM `signJwt` → OAuth, Cache je Dienstkonto/Postfach/Scope); `SyncWorker` und `TargetCleanupWorker` bekommen ihn als `googleTokens`. Für Google-Channels (`events.watch`) muss er noch in einen zusammengesetzten `AppTokenProvider` eingehängt werden.

## 6 · Abschluss-Audit: drei weitere Befunde

| # | Befund | Bewertung | Umsetzung |
|---|---|---|---|
| 1 | SCIM-DELETE wartet auf Microsoft | Berechtigt als Architektur-Punkt (vorher mit 5-s-Budget abgesichert, aber trotzdem Provider-Latenz im Request) | Kein Provider-Aufruf mehr im SCIM-Request. Kappung, PII-freier Tombstone und Job `subscription.teardown` in **einer** Transaktion. Antwort **204** (RFC 7644 §3.6 schreibt 204 für DELETE vor, 202 wäre nicht spezifikationskonform). `TeardownJobWorker` beendet die Abos und löscht den Tombstone erst danach |
| 2 | Passwort im Terraform-State | War nicht der Fall. IAM-DB-Auth und `rds-db:connect` waren schon aktiv; das Master-Passwort verwaltet RDS (Aurora verlangt immer einen Master-User). Der State enthält nur die Secret-ARN | Fehlender Baustein war die Anwendungsseite: `core/src/dbAuth.ts` (Token je Verbindung, TLS verify-full, Start-Abbruch bei statischem Passwort), Bootstrap `000_bootstrap_roles.sql` (Rollen ohne Passwort, `GRANT rds_iam`), Postcondition + CI-Gate prüfen jetzt auch IAM-Auth, `DB_PORT` in der Task-Definition |
| 3 | Synchrone Retry-Wellen | Jitter gab es schon (+10–30 %, nur nach oben). Umgestellt auf symmetrisch ±15 % wie gefordert | `backoff.ts` (±15 %), `retryQueue.ts` (`rescheduleWithBackoff`, `spreadMs` beim Einstellen), Retry-After wird nie unterschritten und nur nach oben gestreut. Test: 50 gleichzeitige 403 → höchstens eine Handvoll Retries pro Minute statt 50 |

**Hinweis zu ±15 %:** Der erste Retry nach einem 403 kommt damit nach 25,5–34,5 min statt frühestens nach 30 min. Kommt er zu früh, gibt es einen weiteren 403 und einen Retry nach nominal 60 min. Das kostet nichts.

## 7 · Abschluss-Audit II: Pool, Sperren, k6

| # | Befund | Bewertung | Umsetzung |
|---|---|---|---|
| 1 | IAM-Token läuft nach 15 min ab, Pool-Verbindungen sterben | Trifft so nicht zu: AWS prüft das Token nur beim Verbindungsaufbau, bestehende Verbindungen laufen weiter. Neue Verbindungen holten schon vorher je Connect ein frisches Token | `POOL_LIMITS`: `maxLifetimeSeconds 600`, `max 20`, `idleTimeoutMillis 30 000`. Nutzen: entzogene IAM-Rechte wirken nach spätestens 10 min, Neuverteilung nach Failover. Neu und wichtiger: `createIamPgPool()` hängt immer einen `error`-Listener an – ohne ihn beendet ein Verbindungsabbruch im Leerlauf (z. B. Failover) den ganzen Node-Prozess |
| 2 | Deadlocks durch die SCIM-Transaktion | Deadlocks: im Lasttest keine (0 in allen Läufen). Echtes Problem war SERIALIZABLE: rund **ein Drittel** der Transaktionen brach mit Serialisierungsfehler ab (→ HTTP 500). Außerdem eine Lücke: Deaktivierung und Kappung liefen in zwei Transaktionen | Transaktion bleibt (sie ist die Outbox – ohne sie Dual-Write-Lücke). Neu: READ COMMITTED, User-Sperre (`pg_advisory_xact_lock`) als erste Sperre, feste Reihenfolge `scim_users → pipelines → provider_tokens → webhook_channels → job_queue`, `lock_timeout 3 s`, Prisma `maxWait 2 s`/`timeout 5 s`, 3 Versuche mit Jitter, danach **503 + Retry-After** statt 500. Deaktivierung + Kappung jetzt ein Commit (`deactivateAndRevoke`). pgbench, 64 Clients: alt 32–34 % Abbrüche und 4–6 inaktive User mit Token, neu 0 % und 0 |
| 3 | k6-OOM durch `uuidv4()` je Iteration | `uuidv4()` lief nur in `setup()`. Speicherhebel lagen woanders | siehe `calensync-qa/README-chaos.md`, Phase 7: numerischer changeKey, `discardResponseBodies`, `systemTags` ohne `url`, Serialisierung einmal je Aufgabe |

**Pflicht für alle anderen Schreibpfade** (Dashboard, OAuth-Callback, Pipeline-Anlage): `lockUserForWrite(tx, tenantId, userId)` als erste Anweisung und im selben Commit `active = true AND deletion_requested_at IS NULL` prüfen. Sonst kann ein gerade gesperrter User wieder ein Token bekommen.

## 8 · Webhook-Eingang unter Last

**Befund:** Der Eingang machte je Notification zwei Datenbank-Roundtrips (Lookup + INSERT) nacheinander. Bei
20 Notifications pro Graph-Batch waren das 40 Roundtrips je Request; die Pool-Verbindung blieb so lange belegt.

**Änderung:** `findBySubscriptionIds` (ein Lookup mit `= ANY($1)`) und `enqueueMany` (ein mehrzeiliger INSERT,
nach `(kind, dedupe_key)` sortiert, Duplikate im Batch zusammengefasst). Feste Last: 2 Roundtrips je Request,
unabhängig von der Batchgröße. Dazu Zeitbudget 2,5 s mit 503 (Graph stellt erneut zu), DB-Fehler → 503 statt
202, Body-Limit 1 MiB als Stream, neuer `node:http`-Adapter `webhookHttp.ts`.

**Messung** (Details `core/bench/webhook-ingress/README.md`): bei 3 000 Notifications/s und 1 ms DB-RTT
p95 1 395 ms → 7,5 ms, Max-RSS 117 → 81 MiB; Sättigung 164 → 906 Requests/s. CI-Gates in
`calensync-qa/.github/workflows/webhook-ingress.yml`: k6-Thresholds, Max-RSS, Roundtrips/Request ≤ 2, 0 Deadlocks.

## Ausrollen (Kurzfassung)

```bash
cd terraform
cp terraform.tfvars.example acme.tfvars            # Werte des Mandanten eintragen
cp backend.hcl.example backend.hcl                 # State-Bucket im Tenant-Account
terraform init -backend-config=backend.hcl
terraform validate && terraform plan -var-file=acme.tfvars -out=acme.plan
terraform apply acme.plan

# Danach: vollständiger Ablauf in DEPLOYMENT.md (Bootstrap-Task, Migrator-Task, Rolling Deploy)
```
