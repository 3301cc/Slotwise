<#
.SYNOPSIS
    Beschränkt die CalenSync-App (Microsoft Graph, Anwendungsberechtigung Calendars.ReadWrite) auf die
    Postfächer einer mailaktivierten Sicherheitsgruppe. Postfächer außerhalb (Vorstand, HR, Funktionspostfächer)
    sind für die App technisch nicht erreichbar – Graph antwortet dort mit 403 ErrorAccessDenied.

.DESCRIPTION
    Zwei Modi:

      -Mode RBAC   (Standard, empfohlen)
         Exchange Online "RBAC for Applications". Microsoft führt es als Nachfolger der Application Access
         Policies. Die Berechtigung wird NUR in Exchange erteilt und dort auf eine Management Scope begrenzt.
         WICHTIG: Die App darf in Entra ID KEINE mandantenweite Anwendungsberechtigung Calendars.* besitzen –
         Entra-Grant und Exchange-RBAC addieren sich (Vereinigungsmenge), ein unbeschränkter Entra-Grant hebt die
         Begrenzung auf. Das Skript prüft das und bricht ab, wenn ein solcher Grant existiert.

      -Mode LegacyAAP
         Application Access Policy (New-ApplicationAccessPolicy). Hier MUSS in Entra die Anwendungsberechtigung
         Calendars.ReadWrite per Admin-Consent erteilt sein; die Policy schränkt sie auf die Gruppe ein.
         Nur verwenden, wenn RBAC for Applications im Mandanten (noch) nicht genutzt werden kann.

    Ergebnis jeder Ausführung: Transkript + JSON-Nachweis (Evidence) für das ISMS / den Auditor.

.PARAMETER AppId
    Application (client) ID der CalenSync-Enterprise-App aus "Unternehmensanwendungen" (Enterprise Applications).

.PARAMETER ServicePrincipalObjectId
    Object ID des Service Principals (Enterprise Application, NICHT die App-Registrierung). Nur für -Mode RBAC.

.PARAMETER ScopeGroup
    Mailaktivierte Sicherheitsgruppe mit den freigegebenen Mitarbeitern (z. B. sg-calensync-users@contoso.de).
    Achtung: Verschachtelte Gruppen werden von MemberOfGroup NICHT aufgelöst – nur direkte Mitglieder zählen.

.PARAMETER ExcludeDepartments
    Nur -Mode RBAC: zusätzliche Sicherung. Postfächer mit diesen Department-Werten sind ausgeschlossen, selbst
    wenn sie versehentlich in die Gruppe geraten (Defense in Depth), z. B. "Vorstand","Personal".

.PARAMETER AllowedTestMailbox
    Postfach, das erreichbar sein MUSS (Mitglied der Gruppe).

.PARAMETER DeniedTestMailboxes
    Postfächer, die NICHT erreichbar sein dürfen (z. B. CEO, HR-Leitung). Schlägt ein Test fehl, endet das Skript
    mit Exit-Code 1.

.EXAMPLE
    .\Set-CalenSyncMailboxScope.ps1 -Mode RBAC `
        -AppId 11111111-2222-3333-4444-555555555555 `
        -ServicePrincipalObjectId 66666666-7777-8888-9999-000000000000 `
        -ScopeGroup sg-calensync-users@contoso.de `
        -ExcludeDepartments "Vorstand","Personal" `
        -AllowedTestMailbox max.mustermann@contoso.de `
        -DeniedTestMailboxes ceo@contoso.de, hr-leitung@contoso.de

.NOTES
    Voraussetzungen: PowerShell 7.4+, Module ExchangeOnlineManagement ≥ 3.4 und Microsoft.Graph.Applications.
    Rollen: Exchange-Administrator (bzw. Organization Management) + für die Entra-Prüfung Cloud Application
    Administrator oder Global Reader. Berechtigungsänderungen werden in Exchange gecacht: 30 Minuten bis
    2 Stunden, bis Graph-Aufrufe sie sehen. Die Test-Cmdlets umgehen den Cache.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('RBAC', 'LegacyAAP')]
    [string] $Mode = 'RBAC',

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string] $AppId,

    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string] $ServicePrincipalObjectId,

    [Parameter(Mandatory)]
    [string] $ScopeGroup,

    [string[]] $ExcludeDepartments = @(),

    [Parameter(Mandatory)]
    [string] $AllowedTestMailbox,

    [Parameter(Mandatory)]
    [string[]] $DeniedTestMailboxes,

    [string] $DisplayName = 'CalenSync Enterprise',

    [string] $EvidenceDirectory = (Join-Path -Path (Get-Location) -ChildPath 'calensync-evidence')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Microsoft-Graph-App-Rollen-IDs (feste, mandantenunabhängige GUIDs der Microsoft-Graph-Ressource)
$GraphAppId = '00000003-0000-0000-c000-000000000000'
$ForbiddenGraphRoles = @('Calendars.ReadWrite', 'Calendars.Read', 'Calendars.ReadBasic.All', 'Mail.ReadWrite', 'Mail.Read')

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$transcript = Join-Path $EvidenceDirectory "calensync-scope-$Mode-$timestamp.log"
Start-Transcript -Path $transcript | Out-Null

$evidence = [ordered]@{
    executedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
    executedBy      = $null
    mode            = $Mode
    appId           = $AppId
    scopeGroup      = $ScopeGroup
    excludedDepts   = $ExcludeDepartments
    entraGrantCheck = $null
    configuration   = $null
    tests           = @()
    result          = 'failed'
}

function Write-Step([string] $Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

$script:exitCode = 0

try {
    # ---------------------------------------------------------------------------------------------
    Write-Step 'Module laden und anmelden'
    foreach ($m in 'ExchangeOnlineManagement', 'Microsoft.Graph.Applications') {
        if (-not (Get-Module -ListAvailable -Name $m)) {
            throw "Modul $m fehlt. Install-Module $m -Scope CurrentUser"
        }
    }
    Import-Module ExchangeOnlineManagement
    Import-Module Microsoft.Graph.Applications

    Connect-ExchangeOnline -ShowBanner:$false
    Connect-MgGraph -Scopes 'Application.Read.All' -NoWelcome
    $evidence.executedBy = (Get-MgContext).Account

    # ---------------------------------------------------------------------------------------------
    Write-Step "Gruppe prüfen: $ScopeGroup"
    $group = Get-DistributionGroup -Identity $ScopeGroup
    if ($group.RecipientTypeDetails -ne 'MailUniversalSecurityGroup') {
        throw "$ScopeGroup ist keine mailaktivierte Sicherheitsgruppe (Typ: $($group.RecipientTypeDetails))."
    }
    $members = @(Get-DistributionGroupMember -Identity $group.Identity -ResultSize Unlimited)
    $nested = @($members | Where-Object { $_.RecipientType -like '*Group*' })
    if ($nested.Count -gt 0) {
        $msg = ("Die Gruppe enthält {0} verschachtelte Gruppe(n): {1}. Deren Mitglieder sind NICHT im Scope. " +
            "Mitglieder direkt aufnehmen.") -f $nested.Count, (($nested | ForEach-Object Name) -join ', ')
        Write-Warning $msg
    }
    $mailboxMembers = @($members | Where-Object { $_.RecipientType -eq 'UserMailbox' })
    Write-Host ("Direkte Postfach-Mitglieder: {0}" -f $mailboxMembers.Count)
    $evidence.groupDn = $group.DistinguishedName
    $evidence.groupDirectMailboxMembers = $mailboxMembers.Count
    $evidence.groupNestedGroups = $nested.Count

    foreach ($denied in $DeniedTestMailboxes) {
        $deniedRecipient = Get-Recipient -Identity $denied
        if ($mailboxMembers.PrimarySmtpAddress -contains $deniedRecipient.PrimarySmtpAddress) {
            throw "Gesperrtes Postfach $denied ist Mitglied von $ScopeGroup – Gruppe bereinigen."
        }
    }

    # ---------------------------------------------------------------------------------------------
    Write-Step 'Entra-ID-Anwendungsberechtigungen der App prüfen'
    $sp = Get-MgServicePrincipal -Filter "appId eq '$AppId'"
    if (-not $sp) { throw "Kein Service Principal mit AppId $AppId gefunden (Admin-Consent noch nicht erteilt?)." }
    if ($ServicePrincipalObjectId -and $sp.Id -ne $ServicePrincipalObjectId) {
        throw "ServicePrincipalObjectId passt nicht zur AppId (erwartet $($sp.Id))."
    }
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
    $assignments = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All |
        Where-Object { $_.ResourceId -eq $graphSp.Id })
    $grantedRoles = @(foreach ($a in $assignments) {
            ($graphSp.AppRoles | Where-Object { $_.Id -eq $a.AppRoleId }).Value
        })
    Write-Host ("Microsoft-Graph-Anwendungsberechtigungen in Entra: {0}" -f (($grantedRoles | Sort-Object) -join ', '))
    $evidence.entraGrantCheck = @{ grantedGraphAppRoles = $grantedRoles }

    if ($Mode -eq 'RBAC') {
        $conflict = @($grantedRoles | Where-Object { $ForbiddenGraphRoles -contains $_ })
        if ($conflict.Count -gt 0) {
            $msg = ("RBAC-Modus abgebrochen: Die App hat in Entra mandantenweit {0}. Diese Grants addieren sich zu " +
                "Exchange-RBAC und heben die Begrenzung auf. Admin-Consent für diese Rollen in Entra entziehen " +
                "(Unternehmensanwendungen → CalenSync → Berechtigungen) und Skript erneut ausführen.") -f ($conflict -join ', ')
            throw $msg
        }
    }
    else {
        if ($grantedRoles -notcontains 'Calendars.ReadWrite') {
            throw 'LegacyAAP-Modus: Entra-Anwendungsberechtigung Calendars.ReadWrite fehlt. Admin-Consent erteilen und erneut ausführen.'
        }
    }

    # ---------------------------------------------------------------------------------------------
    if ($Mode -eq 'RBAC') {
        Write-Step 'RBAC for Applications einrichten'
        if (-not $ServicePrincipalObjectId) { throw '-ServicePrincipalObjectId ist im RBAC-Modus Pflicht.' }

        $exoSp = Get-ServicePrincipal -ErrorAction SilentlyContinue | Where-Object { $_.AppId -eq $AppId }
        if (-not $exoSp) {
            if ($PSCmdlet.ShouldProcess($AppId, 'New-ServicePrincipal')) {
                $exoSp = New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalObjectId -DisplayName $DisplayName
            }
        }

        # Filter: direkte Gruppenmitgliedschaft UND (optional) nicht in ausgeschlossenen Abteilungen
        $filter = "MemberOfGroup -eq '$($group.DistinguishedName)'"
        foreach ($dept in $ExcludeDepartments) {
            $safe = $dept.Replace("'", "''")
            $filter += " -and Department -ne '$safe'"
        }
        $scopeName = "CalenSync-Scope-$($group.Alias)"

        $scope = Get-ManagementScope -Identity $scopeName -ErrorAction SilentlyContinue
        if ($scope) {
            if ($scope.RecipientFilter -ne $filter -and $PSCmdlet.ShouldProcess($scopeName, 'Set-ManagementScope')) {
                Set-ManagementScope -Identity $scopeName -RecipientRestrictionFilter $filter
            }
        }
        elseif ($PSCmdlet.ShouldProcess($scopeName, 'New-ManagementScope')) {
            New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $filter | Out-Null
        }

        $role = 'Application Calendars.ReadWrite'
        # Bestehende Exchange-Grants der App auslesen (ohne -Resource: alle Rollen mit ihrem Scope)
        $grants = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -ErrorAction SilentlyContinue |
            Where-Object { $_.RoleName -like 'Application Calendars.*' -or $_.RoleName -like 'Application Mail.*' })
        $foreign = @($grants | Where-Object { $_.AllowedResourceScope -ne $scopeName })
        if ($foreign.Count -gt 0) {
            $list = ($foreign | ForEach-Object { "$($_.RoleName) → $($_.AllowedResourceScope)" }) -join '; '
            throw "Die App hat weitere Exchange-Rollen außerhalb von '$scopeName': $list. Entfernen (Get-/Remove-ManagementRoleAssignment) und erneut ausführen."
        }
        if (-not ($grants | Where-Object { $_.RoleName -eq $role -and $_.AllowedResourceScope -eq $scopeName })) {
            if ($PSCmdlet.ShouldProcess($role, "New-ManagementRoleAssignment -CustomResourceScope $scopeName")) {
                New-ManagementRoleAssignment -App $ServicePrincipalObjectId -Role $role -CustomResourceScope $scopeName | Out-Null
            }
        }
        $evidence.configuration = @{ scopeName = $scopeName; recipientFilter = $filter; role = $role }

        Write-Step 'Wirksamkeit prüfen (Test-ServicePrincipalAuthorization umgeht den Cache)'
        $check = {
            param([string] $Mailbox)
            $r = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $Mailbox |
                Where-Object { $_.RoleName -eq 'Application Calendars.ReadWrite' })
            return ($r.Count -gt 0 -and ($r | Where-Object { $_.InScope }).Count -gt 0)
        }
    }
    else {
        Write-Step 'Application Access Policy einrichten (Legacy)'
        $existingPolicy = @(Get-ApplicationAccessPolicy -ErrorAction SilentlyContinue | Where-Object { $_.AppId -contains $AppId })
        $wrong = @($existingPolicy | Where-Object { $_.AccessRight -ne 'RestrictAccess' })
        if ($wrong.Count -gt 0) {
            throw "Für die App existiert eine Policy mit AccessRight DenyAccess o. ä. ($($wrong.Identity -join ', ')). Manuell prüfen/entfernen."
        }
        if ($existingPolicy.Count -gt 0) {
            Write-Host ("Vorhandene Policy: {0} (Scope: {1}) – wird nicht verändert." -f ($existingPolicy.Identity -join ', '), ($existingPolicy.ScopeName -join ', '))
        }
        if ($existingPolicy.Count -eq 0 -and $PSCmdlet.ShouldProcess($AppId, 'New-ApplicationAccessPolicy')) {
            New-ApplicationAccessPolicy -AppId $AppId -PolicyScopeGroupId $group.PrimarySmtpAddress `
                -AccessRight RestrictAccess `
                -Description "CalenSync Enterprise: Kalenderzugriff nur fuer $($group.PrimarySmtpAddress)" | Out-Null
        }
        $evidence.configuration = @{ accessRight = 'RestrictAccess'; policyScopeGroup = $group.PrimarySmtpAddress }

        Write-Step 'Wirksamkeit prüfen (Test-ApplicationAccessPolicy)'
        $check = {
            param([string] $Mailbox)
            return ((Test-ApplicationAccessPolicy -AppId $AppId -Identity $Mailbox).AccessCheckResult -eq 'Granted')
        }
    }

    # ---------------------------------------------------------------------------------------------
    $failures = 0
    $allowed = & $check $AllowedTestMailbox
    Write-Host ("{0,-40} erwartet: erlaubt  → {1}" -f $AllowedTestMailbox, $(if ($allowed) { 'erlaubt  OK' } else { 'GESPERRT  FEHLER' }))
    if (-not $allowed) { $failures++ }
    $evidence.tests += @{ mailbox = $AllowedTestMailbox; expected = 'granted'; actual = $(if ($allowed) { 'granted' } else { 'denied' }) }

    foreach ($denied in $DeniedTestMailboxes) {
        $granted = & $check $denied
        Write-Host ("{0,-40} erwartet: gesperrt → {1}" -f $denied, $(if ($granted) { 'ERLAUBT  FEHLER' } else { 'gesperrt OK' }))
        if ($granted) { $failures++ }
        $evidence.tests += @{ mailbox = $denied; expected = 'denied'; actual = $(if ($granted) { 'granted' } else { 'denied' }) }
    }

    if ($failures -gt 0) { throw "$failures Prüfung(en) fehlgeschlagen – Konfiguration NICHT freigeben." }
    $evidence.result = 'passed'
    Write-Host "`nAlle Prüfungen bestanden. Graph-Aufrufe sehen die Änderung nach 30 Minuten bis 2 Stunden (Exchange-Cache)." -ForegroundColor Green
}
catch {
    $evidence.error = $_.Exception.Message
    Write-Error $_.Exception.Message
    $script:exitCode = 1
}
finally {
    $evidencePath = Join-Path $EvidenceDirectory "calensync-scope-$Mode-$timestamp.json"
    $evidence | ConvertTo-Json -Depth 6 | Set-Content -Path $evidencePath -Encoding utf8
    Write-Host "Nachweis: $evidencePath"
    Stop-Transcript | Out-Null
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
}

if ($script:exitCode -eq 1) { exit 1 }
exit 0
