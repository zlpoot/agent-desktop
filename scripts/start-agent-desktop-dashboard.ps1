param(
    [string]$Name = 'AgentDesktop',
    [int]$WorkerPort = 8765,
    [switch]$UseSavedToken
)

$ErrorActionPreference = 'Stop'
$vm = Get-VM -Name $Name -ErrorAction Stop
$ipv4 = @(Get-VMNetworkAdapter -VMName $Name -ErrorAction Stop |
    ForEach-Object { $_.IPAddresses } |
    Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' }) |
    Select-Object -First 1
$workerUrl = if ($ipv4) { "http://${ipv4}:$WorkerPort" } else { $null }

$tokenFile = Join-Path $PSScriptRoot '..\.artifacts\agent-desktop\worker-token.dat'
if ($UseSavedToken) {
    if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
        throw "Saved token not found: $tokenFile. Run install-agent-desktop-host-autostart.ps1 first."
    }
    $secureToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim() | ConvertTo-SecureString
} else {
    $secureToken = Read-Host 'Paste the token used by the Guest Worker' -AsSecureString
}
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if (-not $token) { throw 'Token cannot be empty.' }

Write-Host "Starting dashboard for $Name ($($vm.Id)); Guest IP: $(if ($ipv4) { $ipv4 } else { 'pending' })"

$env:AGENT_DESKTOP_VM_ID = $vm.Id.ToString()
if ($workerUrl) { $env:AGENT_DESKTOP_WORKER_URL = $workerUrl }
$env:AGENT_DESKTOP_TOKEN = $token
Set-Location (Join-Path $PSScriptRoot '..')
try {
    npm.cmd run dashboard
    if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE" }
} finally {
    Remove-Item Env:AGENT_DESKTOP_VM_ID -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DESKTOP_WORKER_URL -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DESKTOP_TOKEN -ErrorAction SilentlyContinue
}
