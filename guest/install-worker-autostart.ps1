param([Parameter(Mandatory = $true)][string]$VmId)

$ErrorActionPreference = 'Stop'
$parsedId = [guid]::Empty
if (-not [guid]::TryParse($VmId, [ref]$parsedId)) { throw 'VmId must be a UUID.' }
$secureToken = Read-Host 'Paste the same Agent Desktop Worker token' -AsSecureString
if ($secureToken.Length -lt 32) { throw 'Token must be at least 32 characters.' }
$tokenFile = Join-Path $PSScriptRoot 'worker-token.dat'
$vmIdFile = Join-Path $PSScriptRoot 'vm-id.txt'
$secureToken | ConvertFrom-SecureString | Set-Content -LiteralPath $tokenFile -Encoding ASCII
$parsedId.ToString() | Set-Content -LiteralPath $vmIdFile -Encoding ASCII
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot 'start-worker.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -UseSavedToken' -f $script)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'AgentDesktop Worker' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
# Hyper-V Default Switch may choose a new IPv4 subnet after a Host reboot. Keep
# access limited to the VM's local IPv4 subnet across Private/Public profiles.
$ruleName = 'AgentDesktop-Worker-LocalSubnet'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Profile Any -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort 8765 -RemoteAddress LocalSubnet4
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'AgentDesktop Worker (local subnet)' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 `
        -RemoteAddress LocalSubnet4 -Profile Any | Out-Null
}
$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    Start-ScheduledTask -TaskName 'AgentDesktop Worker'
    Start-Sleep -Seconds 2
    $listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        throw 'Worker task was registered but port 8765 is not listening. Check Get-ScheduledTaskInfo and the task history.'
    }
}
[PSCustomObject]@{ TaskName = 'AgentDesktop Worker'; User = $identity; VmId = $parsedId.ToString(); TokenFile = $tokenFile; Listening = [bool]$listener }
