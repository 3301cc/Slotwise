# Mandantenweite Admin-Freigabe statt 1.500 Einzel-Zustimmungen

Ziel: Kein Mitarbeiter erteilt CalenSync selbst Zugriff. Die IT gibt die App einmal zentral frei, und zwar technisch begrenzt auf eine definierte Gruppe. Vorstand, HR und Funktionspostfächer sind für die App nicht erreichbar, auch wenn ein Bug oder ein Angreifer im CalenSync-Backend es versuchen würde: Exchange Online lehnt den Graph-Aufruf mit `403 ErrorAccessDenied` ab.

## Wichtige Vorbemerkung: Application Access Policies vs. RBAC for Applications

Microsoft führt **RBAC for Applications in Exchange Online** als Nachfolger der Application Access Policies (AAP). Für Neueinrichtungen ist RBAC der richtige Weg. `New-ApplicationAccessPolicy` funktioniert noch und ist im Skript als `-Mode LegacyAAP` enthalten, sollte aber nur genutzt werden, wenn RBAC im Mandanten nicht eingesetzt werden kann.

Der entscheidende Unterschied für die Freigabe:

| | RBAC for Applications (empfohlen) | Application Access Policy (Legacy) |
|---|---|---|
| Wo wird `Calendars.ReadWrite` erteilt? | **Nur** in Exchange (`New-ManagementRoleAssignment`), begrenzt auf eine Management Scope | In Entra ID per Admin-Consent (mandantenweit), dann per Policy eingeschränkt |
| Entra-Grant `Calendars.ReadWrite`? | **Darf nicht existieren.** Entra-Grant und Exchange-RBAC addieren sich; ein unbeschränkter Entra-Grant hebt die Begrenzung auf | Muss existieren |
| Ausschluss einzelner Abteilungen | Filter mit `-and Department -ne 'Personal'` möglich | Nur über Gruppenmitgliedschaft |
| Verschachtelte Gruppen | Nur direkte Mitglieder zählen | Nur direkte Mitglieder zählen |
| Wirksam nach | 30 Min. – 2 Std. (Exchange-Cache) | 30 Min. – 2 Std. (Exchange-Cache) |

## Schritt für Schritt (Entra ID + Exchange Online)

**1. Benutzer-Zustimmung mandantenweit abschalten**
Entra Admin Center → *Unternehmensanwendungen* → *Einwilligung und Berechtigungen* → *Benutzereinwilligungseinstellungen* → **„Benutzereinwilligung für Apps nicht zulassen“**. Zusätzlich den *Admin-Zustimmungsworkflow* aktivieren, damit Anfragen von Mitarbeitern bei der IT landen statt abgelehnt im Nichts zu verschwinden. Damit ist Schatten-IT über OAuth-Klicks für alle Apps unterbunden, nicht nur für CalenSync.

**2. CalenSync-App einmalig im Mandanten anlegen (Admin-Consent)**
Ein Globaler Administrator oder Privileged Role Administrator öffnet:

```
https://login.microsoftonline.com/<TENANT-ID>/adminconsent?client_id=<CALENSYNC-CLIENT-ID>
```

Im **RBAC-Modus** fordert die App dabei keine Graph-Anwendungsberechtigung für Kalender an, sondern nur, was für den Betrieb nötig ist (`User.Read.All` bzw. `User.ReadBasic.All` ist **erforderlich**, wenn das Ziel „zweites Konto“ genutzt wird: CalenSync prüft damit vor dem Schreiben, dass Quell- und Zielpostfach derselben Person gehören; nötig im eigenen und in jedem verbundenen Tochter-Mandanten. Die Berechtigung wirkt mandantenweit auf Verzeichnisdaten, nicht auf Postfächer). Ergebnis: ein Service Principal unter *Unternehmensanwendungen*. Notieren: **Application (client) ID** und **Object ID** des Service Principals (nicht der App-Registrierung).

**3. Anmeldung der App absichern**
- Unternehmensanwendung → *Eigenschaften* → **„Zuweisung erforderlich“ = Ja**, nur die Gruppe aus Schritt 4 zuweisen (steuert SSO und SCIM-Scope).
- CalenSync authentifiziert sich mit **Zertifikat** statt Client-Secret. Der private Schlüssel liegt im KMS-Schlüssel `alias/<tenant>-signing` (Terraform) und verlässt AWS nie. Das Zertifikat wird in der App-Registrierung des Betreibers hinterlegt.
- Optional (Lizenz *Workload Identities Premium*): Conditional Access für Workload-Identitäten. Anmeldungen des Service Principals nur von den festen NAT-IPs des Tenant-Stacks (Terraform-Output `nat_egress_ips`) zulassen.

**4. Mailaktivierte Sicherheitsgruppe anlegen**
z. B. `sg-calensync-users@contoso.de` mit den 1.500 Mitarbeitern als **direkte** Mitglieder. Vorstand, HR, Betriebsrat, Funktions- und Ressourcenpostfächer kommen nicht hinein. Pflege idealerweise automatisch (HR-getriebene Gruppen-Provisionierung oder Lifecycle Workflows).

**5. Skript ausführen**

```powershell
.\Set-CalenSyncMailboxScope.ps1 -Mode RBAC `
    -AppId <CLIENT-ID> -ServicePrincipalObjectId <SP-OBJECT-ID> `
    -ScopeGroup sg-calensync-users@contoso.de `
    -ExcludeDepartments "Vorstand","Personal","Betriebsrat" `
    -AllowedTestMailbox max.mustermann@contoso.de `
    -DeniedTestMailboxes ceo@contoso.de, hr-leitung@contoso.de, betriebsrat@contoso.de
```

Das Skript prüft vor jeder Änderung:
- ob die Gruppe wirklich mailaktiviert ist und ob verschachtelte Gruppen enthalten sind, deren Mitglieder sonst unbemerkt fehlen,
- ob ein gesperrtes Testpostfach versehentlich in der Gruppe ist,
- ob in Entra noch ein mandantenweiter Kalender- oder Mail-Grant existiert (RBAC-Modus: Abbruch, sonst wäre die Begrenzung wirkungslos),
- ob die App weitere Exchange-Rollen außerhalb der vorgesehenen Scope hat.

Danach legt es Scope und Rollenzuweisung an und testet sie mit `Test-ServicePrincipalAuthorization` (umgeht den Cache): Das erlaubte Postfach muss *InScope* sein, alle gesperrten dürfen es nicht. Transkript und JSON-Nachweis landen in `calensync-evidence/` und gehören in die ISMS-Dokumentation.

**6. Nach 2 Stunden End-to-End-Probe**
Mit dem App-Token einen Graph-Aufruf auf ein gesperrtes Postfach absetzen (`GET /users/ceo@contoso.de/calendar/events`). Erwartet: `403`. Das Ergebnis wird im Abnahmeprotokoll festgehalten.

**7. Rezertifizierung**
Vierteljährlich das Skript mit `-WhatIf` laufen lassen (Prüfungen ohne Änderungen) und die Gruppe per Entra Access Review gegenprüfen.

## Google Workspace – ehrliche Einordnung

Google bietet **kein Gegenstück** zur Exchange-Scope-Begrenzung. Domänenweite Delegation (DWD) gibt einem Dienstkonto Zugriff auf die Daten **aller** Nutzer der Domäne. Begrenzen lassen sich dort nur die OAuth-Scopes, nicht die Nutzermenge.

Zwei vertretbare Varianten:

1. **DWD mit minimalem Scope und anwendungsseitiger Sperre** (so umgesetzt für Google als *Ziel* „zweites Konto“, `core/src/googleCalendar.ts`). Kalender-Scope nur `https://www.googleapis.com/auth/calendar.events`, dazu `admin.directory.user.readonly` ausschließlich für ein eigenes Directory-Konto (Prüfung „dieselbe Person“). CalenSync impersoniert für den Kalender nur Google-Konten, die in einer freigegebenen Domain liegen, einer Pipeline eines per SCIM provisionierten, aktiven Mitglieds der Freigabegruppe gehören und laut Directory (Mitarbeiter-ID) und Entra (`employeeId`) dieselbe Person sind; nach dem Widerruf nur noch zum Löschen der eigenen Termine. Abgewiesene Ziele werden nicht aufgerufen, die Pipeline geht auf `config_error`, es gibt einen Betriebsalarm (`worker_alert`). Das Dienstkonto hat **keinen Schlüssel**: Google signiert die DWD-Assertion per IAM `signJwt`, CalenSync meldet sich dafür per Workload Identity Federation aus der AWS-Task-Rolle an. **Restrisiko:** Die Begrenzung auf Nutzer ist eine Eigenschaft der CalenSync-Software, nicht der Google-Plattform. Das gehört so ins Fact Sheet.
2. **Admin-vertraute OAuth-App ohne DWD.** Die App wird unter *Sicherheit → API-Steuerung → App-Zugriffssteuerung* nur für eine Organisationseinheit als *Vertrauenswürdig* markiert. Nutzer verbinden sich selbst, können aber keine andere, nicht freigegebene App verbinden. Die Plattformgrenze greift, dafür entsteht wieder ein Klick pro Mitarbeiter.

Für Kunden mit dem Anspruch „technisch unmöglich, Vorstandskalender zu lesen“ ist bei Google nur Variante 2 plattformseitig belastbar.

### Einrichtung Variante 1 (Google-Admin, ca. 30 Minuten)

Vollständig mit Beispielwerten in `DEPLOYMENT.md`, Abschnitt „Kalenderabgleich → Ziel Google Workspace“. Kurzfassung:

1. **Google Cloud (Projekt des Betreibers):** APIs *IAM Service Account Credentials*, *Security Token Service*, *Google Calendar* und *Admin SDK* aktivieren. Dienstkonto `calensync-dwd@…` anlegen, **keinen Schlüssel** erzeugen (Organisationsrichtlinie `iam.disableServiceAccountKeyCreation`). Die numerische **Client-ID** (Unique ID) notieren.
2. **Workload Identity Federation:** Pool + Provider vom Typ **AWS** mit der AWS-Konto-ID des CalenSync-Mandanten-Stacks, Bedingung `attribute.aws_role == "arn:aws:sts::<KONTO>:assumed-role/calensync-<tenant>-<env>-ecs-task"`. Auf dem Dienstkonto `roles/iam.serviceAccountTokenCreator` nur für dieses `principalSet://…/attribute.aws_role/…`.
3. **Admin-Konsole → Sicherheit → Zugriffs- und Datenkontrolle → API-Steuerung → Domainweite Delegierung:** Client-ID aus 1. mit genau `https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/admin.directory.user.readonly`.
4. **Directory-Konto:** Nutzer `calensync-directory@…` mit einer benutzerdefinierten Admin-Rolle, die nur *Admin-API → Nutzer → Lesen* enthält. Mitarbeiter-ID der Nutzer = Entra `employeeId` pflegen.
5. Werte an den Betreiber: Pool-/Provider-Ressource (`audience`), Dienstkonto, Domains, Directory-Konto → `APP_CONFIG` (`googleWorkloadIdentity`, `linkedGoogleWorkspaces`).

Zur Kontrolle nach dem Einrichten: In der Admin-Konsole unter *Berichte → Audit und Untersuchung → OAuth-Logereignisse* sollten nur Token-Ausgaben an die Client-ID des Dienstkontos für Konten verbundener Mitarbeiter und für das Directory-Konto erscheinen. (Die Google-Anbindung ist bisher nur gegen gefälschte Google-Endpunkte getestet – vor dem ersten Kunden mit einem Test-Workspace prüfen.)
