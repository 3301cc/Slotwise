# Entwurf: Datenschutz-Folgenabschätzung (Art. 35 DSGVO) „CalenSync Kalenderabgleich“

> **Vorlage für den Verantwortlichen (Kunde).** Die DSFA verantwortet der Kunde. Diese Vorlage liefert die
> Angaben des Anbieters und die technischen Maßnahmen mit Fundstellen. Platzhalter in `[eckigen Klammern]` füllt der
> Kunde mit seinem Datenschutzbeauftragten aus. Stand 01.10.2026.

## 1 Beschreibung der Verarbeitung

| Punkt | Angabe |
|---|---|
| Verantwortlicher | [Firma, Anschrift, DSB] |
| Auftragsverarbeiter | [CalenSync-Betreiber, Anschrift] |
| Zweck | Abgleich belegter Zeiten zwischen dienstlichen Kalendern, um Doppelbuchungen zu vermeiden |
| Betroffene | Beschäftigte in der Entra-ID-Gruppe [Name], ca. [Anzahl] Personen; mittelbar Termin-Teilnehmende |
| Rechtsgrundlage | [§ 26 BDSG / Art. 88 DSGVO i. V. m. Betriebsvereinbarung vom [Datum]] |
| Datenkategorien | siehe Betriebsvereinbarung § 3; Termininhalte werden nicht gespeichert |
| Ort | AWS eu-central-1 (Frankfurt), dedizierter Single-Tenant-Stack; Backup-Kopie in zweite Region standardmäßig aus (`dr_copy_enabled = false`) |
| Unterauftragsverarbeiter | Amazon Web Services EMEA SARL (Hosting); Microsoft bzw. Google als Kalenderanbieter des Kunden |

**Warum eine DSFA?** Beschäftigtendaten, systematische Verarbeitung vieler Personen, und Kalender können mittelbar
besondere Kategorien enthalten (z. B. „Arzttermin“, Art. 9 DSGVO).

## 2 Notwendigkeit und Verhältnismäßigkeit

- **Datenminimierung:** Nur fünf Stammdatenfelder aus Entra ID; Termininhalte nur flüchtig; Modus „Als beschäftigt
  markieren“ als Voreinstellung.
- **Begrenzter Zugriff:** Postfachzugriff technisch auf die Gruppe begrenzt (Exchange-RBAC), nicht mandantenweit.
- **Freiwilligkeit:** Beschäftigte legen ihren Abgleich selbst an und können ihn beenden.
- **Speicherbegrenzung:** feste Fristen für Protokolle, Audit-Log und Backups (Abschnitt 4).

## 3 Risiken für die Betroffenen

| Nr. | Risiko | Eintritt ohne Maßnahmen | Schwere | Maßnahmen (Abschnitt 4) | Restrisiko |
|---|---|---|---|---|---|
| R1 | Leistungs- oder Verhaltenskontrolle über Kalenderdaten | mittel | hoch | M1, M7 | gering |
| R2 | Termininhalte mit Gesundheitsbezug werden offengelegt | mittel | hoch | M2, M2a, M3 | gering, **nach Abnahme** (Abschnitt 5) |
| R2a | Termine bleiben nach Austritt im Team- oder Zielkalender stehen | mittel | mittel | M2b, M5 | gering |
| R3 | Zugriff auf Postfächer außerhalb der berechtigten Gruppe | mittel | hoch | M4 | gering |
| R4 | Ausgeschiedene Beschäftigte bleiben verbunden | mittel | mittel | M5 | gering |
| R5 | Unbefugter Zugriff auf die Datenbank | gering | hoch | M6 | gering |
| R6 | Zugriff durch US-Behörden (CLOUD Act) über AWS | gering | hoch | M8 | [vom Kunden zu bewerten] |
| R7 | Mandantenvermischung mit anderen Kunden | gering | hoch | M9 | sehr gering |

## 4 Technische und organisatorische Maßnahmen

| Nr. | Maßnahme | Fundstelle |
|---|---|---|
| M1 | Keine Auswertungsfunktionen pro Person; API liefert nur den eigenen Status (`/api/v1/me/…`) | `app/src/statusApi.ts` |
| M2 | Termininhalte nicht persistent; „Als beschäftigt markieren“ als Voreinstellung; im Modus „vollständig“ nur Titel und Ort | `core/src/syncWorker.ts`, Kanarienvogel-Tests in `core/test/syncWorker.test.ts` und `app/test/sync.pg.test.ts` |
| M2a | Ziele nur aus einer Freigabeliste der IT (eigenes Zweitpostfach, freigegebene Team-Kalender, Buchungsseite), geprüft in API und Worker | `core/src/syncTargets.ts` |
| M2b | Beenden, Deaktivieren und Löschen entfernen alle von CalenSync angelegten Zieltermine (Job in derselben Transaktion wie der Widerruf) | `core/src/cleanupWorker.ts` |
| M3 | Protokolle schwärzen Tokens, E-Mail-Adressen und Namen; Längen- und Tiefenbegrenzung | `core/src/logger.ts`, `core/test/logger.test.ts` |
| M4 | Exchange-RBAC begrenzt `Calendars.ReadWrite` auf eine Management Scope; kein mandantenweiter Entra-Grant | `powershell/Set-CalenSyncMailboxScope.ps1` |
| M5 | SCIM-Deaktivierung sperrt Abgleiche und beendet Abos in einem Commit; PII-freier Tombstone, Löschung nach Teardown | `scim/src/`, `core/src/subscriptionTeardown.ts` |
| M6 | Verschlüsselung mit 4 KMS-Schlüsseln, Datenbank im privaten Subnetz, IAM-Datenbank-Anmeldung, WAF | `terraform/kms.tf`, `network.tf`, `database.tf`, `edge.tf` |
| M7 | Unveränderbares Audit-Log (Hash-Kette, WORM, [400] Tage) | `terraform/audit.tf`, `audit_events` |
| M8 | Region parametrisierbar, Betrieb in der AWS European Sovereign Cloud möglich | `terraform/variables.tf` |
| M9 | Single-Tenant: eigener AWS-Account, eigene Datenbank und Schlüssel je Kunde | `terraform/` |

Fristen: Protokolle [365] Tage, Audit-Log [400] Tage, Backups [35] Tage (`terraform/variables.tf`).

## 5 Offene Punkte vor Produktivstart

- **Abnahme mit echtem Mandanten:** Abgleich und Bereinigung sind gegen eine Nachbildung von Microsoft Graph
  getestet. Vor Produktivstart mit einem echten Microsoft-365-Testmandanten abnehmen. Google-Ziele gibt es noch nicht.
- **Pentest und ISMS:** Externer Penetrationstest steht aus, ISO-27001-Zertifizierung ist geplant (Fact Sheet H1, H2).
- **Restore-Test:** Erster dokumentierter Restore-Test steht aus (Fact Sheet F3).
- **Vault Lock:** Wird nach 3 Tagen unwiderruflich und kann mit kurzen Löschfristen kollidieren; vor dem ersten
  Deployment mit dem Datenschutz abstimmen.

## 6 Ergebnis

[Vom Verantwortlichen auszufüllen: Bewertung des Restrisikos, Stellungnahme DSB, Konsultation der Aufsichtsbehörde
nach Art. 36 DSGVO ja/nein, Datum der Überprüfung.]
