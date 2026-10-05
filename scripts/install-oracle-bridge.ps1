param(
    [string]$Name = 'AgentDesktop',
    [string]$GuestUser = 'agent',
    [switch]$RestartDashboard
)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid VM name.' }
$vm = Get-VM -Name $Name -ErrorAction Stop
if ($vm.State -ne 'Running') { throw "VM is not running: $Name" }
$task = Get-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $taskSid = ([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]) }
catch { throw 'Cannot resolve Dashboard scheduled task account.' }
if ($taskSid.Value -ne $identity.User.Value) {
    throw 'Run this installer as the same Windows user as AgentDesktop Dashboard.'
}
$credential = Get-Credential -UserName $GuestUser -Message 'Enter the AgentDesktop Guest Windows account. This is stored with Windows user protection; do not paste it into chat.'
if (-not $credential) { throw 'Guest credential was not provided.' }
$session = New-PSSession -VMName $Name -Credential $credential -ErrorAction Stop
try {
    $probe = Invoke-Command -Session $session -ScriptBlock {
        [pscustomobject]@{ user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
            testbenchInstalled=(Test-Path -LiteralPath 'C:\AgentDesktop\testbench\verify.ps1' -PathType Leaf) }
    }
} finally { Remove-PSSession -Session $session }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$private = Join-Path $root '.artifacts\agent-desktop\oracle-private'
New-Item -ItemType Directory -Path $private -Force | Out-Null
if ((Get-Item -LiteralPath $private).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Oracle private directory cannot be a reparse point.'
}
$dirAcl = Get-Acl -LiteralPath $private
$dirAcl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        ([Security.Principal.SecurityIdentifier]$sid), 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $dirAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $private -AclObject $dirAcl
$credentialPath = Join-Path $private 'guest-credential.xml'
$credential | Export-Clixml -LiteralPath $credentialPath
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'read-guest-oracle.ps1') `
    -Destination (Join-Path $private 'read-guest-oracle.ps1') -Force
@{ vmName=$vm.Name; vmId=$vm.Id.ToString(); installedAt=(Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $private 'bridge.json') -Encoding UTF8
foreach ($leaf in @('guest-credential.xml', 'read-guest-oracle.ps1', 'bridge.json')) {
    $path = Join-Path $private $leaf
    $fileAcl = Get-Acl -LiteralPath $path
    $fileAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            ([Security.Principal.SecurityIdentifier]$sid), 'FullControl', 'Allow')
        $fileAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $fileAcl
}
$bridgeReady = $false
if ($RestartDashboard) {
    $restartStartedAt = [DateTime]::UtcNow
    if ((Get-ScheduledTask -TaskName 'AgentDesktop Dashboard').State -eq 'Running') {
        Stop-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (-not (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    if (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Dashboard port 4173 is still in use; Oracle bridge was installed but Dashboard was not restarted.'
    }
    Start-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
    $statusPath = Join-Path $root '.artifacts\agent-desktop\oracle\bridge-status.json'
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { continue }
        try {
            $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
            $age = ([DateTime]::UtcNow - [DateTime]::Parse($status.updatedAt).ToUniversalTime()).TotalSeconds
            if ($status.state -eq 'running' -and $status.vmId -eq $vm.Id.ToString() -and
                [DateTime]::Parse($status.updatedAt).ToUniversalTime() -gt $restartStartedAt -and
                $age -ge 0 -and $age -le 15) {
                $bridgeReady = $true
                break
            }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $bridgeReady) { throw 'Dashboard restarted but Oracle bridge heartbeat was not observed.' }
}
[pscustomobject]@{ VMName=$vm.Name; VMId=$vm.Id; DashboardUser=$identity.Name;
    GuestUser=$probe.user; TestBenchInstalled=$probe.testbenchInstalled;
    BridgeReady=$bridgeReady;
    Next=$(if ($RestartDashboard) { 'Oracle bridge is ready.' } else { 'Restart AgentDesktop Dashboard once to load the Oracle bridge.' }) }
