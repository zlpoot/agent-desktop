param(
    [Parameter(Mandatory)][ValidateSet('first','resume')][string]$Phase,
    [Parameter(Mandatory)][string]$CaseDir,
    [Parameter(Mandatory)][ValidatePattern('^1\d{10}$')][string]$TargetPhone,
    [Parameter(Mandatory)][guid]$VmId,
    [Parameter(Mandatory)][uri]$WorkerUrl
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if ($WorkerUrl.Scheme -ne 'http' -or $WorkerUrl.Port -ne 8765) {
    throw 'Expected the local Guest Worker HTTP endpoint on port 8765'
}
$tokenFile = Join-Path $repo '.artifacts\agent-desktop\worker-token.dat'
$secureToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $env:AGENT_DESKTOP_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$env:AGENT_DESKTOP_VM_ID = $VmId.ToString()
$env:AGENT_DESKTOP_WORKER_URL = $WorkerUrl.AbsoluteUri.TrimEnd('/')
try {
    Set-Location $repo
    node --import tsx testbench/p4/recovery-harness.ts $Phase $CaseDir $TargetPhone
    if ($LASTEXITCODE -ne 0) { throw "Harness exited with code $LASTEXITCODE" }
} finally {
    Remove-Item Env:AGENT_DESKTOP_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DESKTOP_VM_ID -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_DESKTOP_WORKER_URL -ErrorAction SilentlyContinue
}
