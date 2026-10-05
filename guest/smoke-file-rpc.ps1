param(
    [string]$WorkerRoot = 'C:\AgentDesktop',
    [string]$WorkerUrl = 'http://127.0.0.1:8765'
)

$ErrorActionPreference = 'Stop'
$endpoint = [Uri]$WorkerUrl
if ($endpoint.Scheme -ne 'http' -or -not $endpoint.IsLoopback -or
    $endpoint.AbsolutePath -ne '/' -or $endpoint.Query -or $endpoint.Fragment -or
    $endpoint.UserInfo) {
    throw 'WorkerUrl must be a loopback HTTP origin.'
}
$tokenFile = Join-Path $WorkerRoot 'worker-token.dat'
$vmIdFile = Join-Path $WorkerRoot 'vm-id.txt'
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf) -or
    -not (Test-Path -LiteralPath $vmIdFile -PathType Leaf)) {
    throw 'Saved Guest Worker token or VM ID is missing.'
}
$secureToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$vmId = (Get-Content -LiteralPath $vmIdFile -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

try {
    $state = Invoke-RestMethod -Uri "$($endpoint.AbsoluteUri.TrimEnd('/'))/state" -Headers $headers -TimeoutSec 5
    if ($state.vm_id -ne $vmId -or $state.file_rpc -ne $true) {
        throw 'Running Guest Worker identity or file RPC capability does not match.'
    }
    $clientId = "file-rpc-smoke-$([Guid]::NewGuid().ToString('N'))"
    $fileName = "agent-desktop-file-rpc-smoke-$([Guid]::NewGuid().ToString('N')).txt"
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { throw 'Windows Desktop folder is unavailable.' }
    $path = Join-Path $desktop $fileName
    if (Test-Path -LiteralPath $path) { throw 'Temporary test file already exists.' }
    $content = "agent-desktop-file-rpc-smoke:$clientId"

    function Invoke-FileProbe([string]$Name) {
        $body = @{
            clientId = $clientId
            vmId = $vmId
            recoveryEpoch = $state.recovery_epoch
            method = 'inspect_file'
            args = @{ path = $Name }
        } | ConvertTo-Json -Depth 4 -Compress
        $reply = Invoke-RestMethod -Uri "$($endpoint.AbsoluteUri.TrimEnd('/'))/rpc" -Method Post `
            -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
        if (-not $reply.result) { throw 'Guest file RPC returned no result.' }
        return $reply.result
    }

    $before = Invoke-FileProbe $fileName
    if ($before.exists -or -not $before.complete) {
        throw 'Temporary test file is not absent at the baseline.'
    }
    $created = $false
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created = $true
        try { $stream.Write($bytes, 0, $bytes.Length) }
        finally { $stream.Dispose() }
        Start-Sleep -Milliseconds 20
        $after = Invoke-FileProbe $fileName
        $localHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $passed = $after.exists -eq $true -and $after.complete -eq $true -and
            $after.path -ieq $path -and $after.text -ceq $content -and
            $after.size -eq $bytes.Length -and $after.sha256 -eq $localHash -and
            $before.capturedAt -lt $after.capturedAt
        [PSCustomObject]@{
            test = 'guest_authenticated_file_rpc'
            passed = $passed
            expectedContent = $content
            before = $before
            after = $after
            localSha256 = $localHash
            note = 'Temporary file write tests RPC and collector, not a GUI save action or Graph gating.'
        } | ConvertTo-Json -Depth 6
        if (-not $passed) { throw 'Guest file RPC smoke check failed; review the JSON result above.' }
    } finally {
        if ($created) { Remove-Item -LiteralPath $path -Force }
    }
} finally {
    $token = $null
    Remove-Variable headers -ErrorAction SilentlyContinue
}
