param([string]$Name = 'AgentDesktop')

$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw 'VM name may contain only letters, digits, underscore, and hyphen.' }
$vm = Get-VM -Name $Name -ErrorAction Stop
$secureToken = Read-Host 'Paste the same Agent Desktop Worker token' -AsSecureString
if ($secureToken.Length -lt 32) { throw 'Token must be at least 32 characters.' }
$configDir = Join-Path $PSScriptRoot '..\.artifacts\agent-desktop'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$tokenFile = Join-Path $configDir 'worker-token.dat'
$secureToken | ConvertFrom-SecureString | Set-Content -LiteralPath $tokenFile -Encoding ASCII
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot 'start-agent-desktop-dashboard.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Name "{1}" -UseSavedToken' -f $script, $Name) `
    -WorkingDirectory (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'AgentDesktop Dashboard' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
[PSCustomObject]@{ TaskName = 'AgentDesktop Dashboard'; User = $identity; VM = $vm.Name; TokenFile = $tokenFile }
