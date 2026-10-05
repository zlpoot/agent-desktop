param(
    [string]$DashboardUrl = 'http://127.0.0.1:4173',
    [int]$TimeoutMs = 2500,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 30000) { throw 'TimeoutMs must be 100..30000' }

function Test-TcpEndpoint([string]$HostName, [int]$Port, [int]$Timeout) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne($Timeout)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false }
    finally { $client.Dispose() }
}

$result = [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    dashboard = [ordered]@{ reachable = $false; error = $null }
    vm = $null
    sessions = @()
    readyForGuestVerification = $false
    nextAction = $null
}

try {
    $vmResponse = Invoke-RestMethod -Uri "$($DashboardUrl.TrimEnd('/'))/api/desktop/vm" -TimeoutSec ([Math]::Ceiling($TimeoutMs / 1000))
    $sessionResponse = Invoke-RestMethod -Uri "$($DashboardUrl.TrimEnd('/'))/api/desktop/sessions" -TimeoutSec ([Math]::Ceiling($TimeoutMs / 1000))
    $result.dashboard.reachable = $true
    $result.vm = [ordered]@{ name = $vmResponse.vm.name; state = $vmResponse.vm.state; ipv4 = $vmResponse.vm.ipv4 }
    foreach ($session in @($sessionResponse.sessions)) {
        $endpoint = $null
        $tcpReady = $false
        try {
            $endpoint = [Uri]$session.workerEndpoint
            $port = if ($endpoint.IsDefaultPort) { if ($endpoint.Scheme -eq 'https') { 443 } else { 80 } } else { $endpoint.Port }
            $tcpReady = Test-TcpEndpoint $endpoint.Host $port $TimeoutMs
        } catch { }
        $result.sessions += [ordered]@{
            id = $session.sessionId
            status = $session.status
            endpoint = $session.workerEndpoint
            tcpReachable = $tcpReady
            lastSeenAt = $session.lastSeenAt
            lastError = $session.lastError
        }
    }
    # The Dashboard may run with a different network token from this diagnostic shell.
    # Fresh authenticated Host polling is stronger evidence than this shell's TCP probe.
    $recentOnline = @($result.sessions | Where-Object {
        $_.status -eq 'online' -and $_.lastSeenAt -and
        ((Get-Date).ToUniversalTime() - [DateTime]::Parse($_.lastSeenAt).ToUniversalTime()).TotalSeconds -lt 15
    }).Count -gt 0
    $result.readyForGuestVerification = $result.vm.state -eq 'Running' -and
        $recentOnline
    if (-not $result.readyForGuestVerification) {
        $result.nextAction = if ($result.vm.state -ne 'Running') { 'Start the VM from the Dashboard.' }
            else { 'Log in to the Guest and start/restart the AgentDesktop Worker scheduled task; then rerun this check.' }
    } elseif (@($result.sessions | Where-Object { -not $_.tcpReachable }).Count -gt 0) {
        $result.nextAction = 'Dashboard authenticated polling is fresh; this shell cannot open the Guest TCP port. Use Dashboard for the live test.'
    }
} catch {
    $result.dashboard.error = $_.Exception.Message
    $result.nextAction = 'Start the Host Dashboard, then rerun this check.'
}

$json = $result | ConvertTo-Json -Depth 8
if ($OutputPath) {
    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
}
Write-Output $json
if (-not $result.readyForGuestVerification) { exit 1 }
