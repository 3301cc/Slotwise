# Entwurf: Betriebsvereinbarung „CalenSync Kalenderabgleich“

> **Vorlage für Kunden, keine Rechtsberatung.** Vor Verwendung durch die Rechtsabteilung oder Fachanwälte für
> Arbeitsrecht prüfen lassen. Platzhalter stehen in `[eckigen Klammern]`. Technische Aussagen verweisen auf
> Fundstellen im Code, damit der Betriebsrat sie prüfen kann. Stand 01.10.2026.

Zwischen der **[Firma]** (Arbeitgeberin) und dem **[Gesamt-]Betriebsrat der [Firma]** wird gemäß § 87 Abs. 1 Nr. 6
BetrVG folgende Betriebsvereinbarung geschlossen.

## § 1 Gegenstand und Geltungsbereich

1. Die Vereinbarung regelt Einführung und Nutzung von **CalenSync** zum Abgleich dienstlicher Kalender
   (Microsoft 365 / Exchange Online, ggf. Google Workspace).
2. Sie gilt für alle Beschäftigten, die in der Entra-ID-Gruppe **[Gruppenname]** stehen. Nur diese Personen werden
   an CalenSync übermittelt (SCIM-Provisionierung) und nur deren Postfächer sind technisch erreichbar
   (Exchange-RBAC-Begrenzung, `powershell/Set-CalenSyncMailboxScope.ps1`).
3. Der KI-Telefonassistent und andere CalenSync-Funktionen sind **nicht** Gegenstand dieser Vereinbarung und im
   Enterprise-Stack deaktiviert.

## § 2 Zweck und Zweckbindung

1. Zweck ist ausschließlich, belegte Zeiten zwischen Kalendern abzugleichen, damit Doppelbuchungen vermieden werden.
   Mögliche Ziele sind ein zweites eigenes Postfach (auch in einer verbundenen Gesellschaft), ein von der IT
   freigegebener Team-Kalender und die Buchungsseite. Andere Ziele sind technisch gesperrt (Freigabeliste,
   `core/src/syncTargets.ts`, geprüft in API und Worker).
2. Eine Nutzung der Daten für andere Zwecke, insbesondere zur **Leistungs- oder Verhaltenskontrolle**, ist
   ausgeschlossen (§ 4).

## § 3 Verarbeitete Daten

| Kategorie | Inhalt | Speicherung |
|---|---|---|
| Stammdaten aus Entra ID | Anmeldename, Anzeigename, Vor-/Nachname, dienstliche E-Mail, Abteilung | Datenbank des Mandanten-Stacks, Frankfurt |
| Kalender-Metadaten | Termin-IDs, Beginn, Ende, Versionskennung | Datenbank, nur soweit für den Abgleich nötig |
| Termininhalte | Titel, Beschreibung, Ort, Teilnehmende | **Nicht gespeichert**, nur flüchtig im Arbeitsspeicher |
| Technische Protokolle | Zeitpunkt, Ereignisart, Fehlercodes; E-Mail-Adressen und Tokens werden geschwärzt | CloudWatch, [365] Tage (`log_retention_days`) |
| Audit-Log | Wer hat wann welche Verwaltungsaktion ausgelöst | Unveränderbar (Hash-Kette, WORM), [400] Tage (`audit_object_lock_days`) |

Telefonnummern, Adressen, Vorgesetzte und Fotos aus dem Verzeichnis werden bei der Übermittlung verworfen
(`scim/src/scimUsers.ts`, Test „speichert nur minimale Attribute“).

## § 4 Ausschluss von Leistungs- und Verhaltenskontrolle

1. Es werden **keine** Auswertungen, Ranglisten, Berichte oder Statistiken über einzelne Beschäftigte oder kleine
   Gruppen (unter [5] Personen) erstellt, etwa zu Anzahl, Dauer oder Uhrzeit von Terminen.
2. Technische Protokolle dienen nur der Fehlersuche und der IT-Sicherheit. Ein Zugriff mit Personenbezug ist nur bei
   konkretem Anlass zulässig, wird dokumentiert und dem Betriebsrat auf Verlangen mitgeteilt.
3. Erkenntnisse, die unter Verstoß gegen diese Vereinbarung gewonnen wurden, dürfen nicht für personelle Maßnahmen
   verwendet werden (Verwertungsverbot).

## § 5 Teilnahme

1. Ein Kalenderabgleich wird nur angelegt, wenn die beschäftigte Person ihn selbst im Dashboard einrichtet
   (`POST /api/v1/me/pipelines`, nur für das eigene Konto). Administratoren legen keine Abgleiche für andere an.
2. Voreinstellung ist der Modus **„Als beschäftigt markieren“**: Im Zielkalender erscheint nur ein frei wählbarer
   Titel (Standard „Termin“), keine Inhalte.
3. Beschäftigte können ihren Abgleich jederzeit im Dashboard beenden. Dabei entfernt CalenSync alle Termine, die
   es im Zielkalender angelegt hat (`DELETE /api/v1/me/pipelines/{id}`, `core/src/cleanupWorker.ts`). Aus der
   Nichtteilnahme entstehen keine Nachteile.
4. Im Team-Kalender erscheinen im Modus „Als beschäftigt markieren“ nur belegte Zeiten mit dem gewählten Titel.
   Der Modus „vollständig“ für Team-Kalender wird **[nicht / nur mit Zustimmung des Betriebsrats]** freigegeben.

## § 6 Zugriffsrechte

1. Verwaltungszugriff haben nur **[Rollen, z. B. 2 Personen der IT]**. Die Liste wird dem Betriebsrat übergeben und
   bei Änderungen aktualisiert.
2. Der Anbieter (CalenSync) hat keinen Zugriff auf Termininhalte. Betriebszugriffe des Anbieters erfolgen nur nach
   den Regeln der Auftragsverarbeitungsvereinbarung und werden protokolliert.

## § 7 Löschung

1. Wird eine Person in Entra ID deaktiviert, werden ihre Abgleiche im selben Vorgang gesperrt, die Zugriffe beim
   Kalenderanbieter beendet und alle von CalenSync angelegten Zieltermine entfernt (`deactivateAndRevoke`,
   `core/src/subscriptionTeardown.ts`, `core/src/cleanupWorker.ts`).
2. Beim Löschen in Entra ID werden Name, E-Mail und externe Kennungen sofort entfernt; der verbleibende technische
   Datensatz wird gelöscht, sobald alle Abos beendet sind, spätestens nach 8 Tagen.
3. Protokolle und Sicherungen werden nach Ablauf der in § 3 genannten Fristen automatisch gelöscht. Sicherungen
   bleiben [35] Tage (`backup_retention_days`).

## § 8 Transparenz und Kontrollrechte des Betriebsrats

1. Die Beschäftigten werden vor dem Start schriftlich über Zweck, Datenumfang und ihre Rechte informiert.
2. Der Betriebsrat erhält das Security-Fact-Sheet, die Datenschutz-Folgenabschätzung und auf Verlangen Einsicht in
   das Audit-Log. Er kann einen Sachverständigen nach § 80 Abs. 3 BetrVG hinzuziehen.

## § 9 Änderungen

Neue Funktionen, zusätzliche Datenkategorien, neue Auswertungen oder ein Wechsel des Hosting-Standorts bedürfen
einer Ergänzung dieser Vereinbarung.

## § 10 Schlussbestimmungen

1. Die Vereinbarung tritt am **[Datum]** in Kraft und kann mit einer Frist von [3] Monaten gekündigt werden. Sie
   wirkt bis zum Abschluss einer neuen Vereinbarung nach.
2. Sollte eine Bestimmung unwirksam sein, bleibt der Rest wirksam.

[Ort, Datum] · Für die Arbeitgeberin: ______________ · Für den Betriebsrat: ______________
