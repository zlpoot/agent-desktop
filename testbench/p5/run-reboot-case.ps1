param(
    [Parameter(Mandatory)][ValidateSet('preflight', 'prepare', 'resume')][string]$Phase,
    [string]$Name = 'AgentDesktop',
    [ValidatePattern('^[a-zA-Z0-9-]{1,64}$')][string]$CaseName = 'p5-os-reboot-20260929',
    [ValidatePattern('^1\d{10}$')][string]$TargetPhone = '13955556666'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$caseDir = Join-Path $repo (Join-Path '.artifacts' $CaseName)
$identityPath = Join-Path $caseDir 'case-identity.json'
$vm = Get-VM -Name $Name -ErrorAction Stop
if ($vm.State -ne 'Running') { throw "VM is $($vm.State); wait until $Name is running" }
$ip = Get-VMNetworkAdapter -VM $vm -ErrorAction Stop |
    ForEach-Object { $_.IPAddresses } |
    Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' } |
    Select-Object -First 1
if (-not $ip) { throw 'Guest has not reported an IPv4 address; wait for network setup' }
$workerUrl = [uri]"http://${ip}:8765"
$task = Get-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
$control = $null
if ($task.State -eq 'Running') {
    $control = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/desktop/control' -TimeoutSec 8
    if ($control.mode -ne 'PAUSED' -or $null -ne $control.taskId) {
        throw 'Dashboard has an active or retained task; do not stop it for this test'
    }
}

if ($Phase -eq 'preflight') {
    [pscustomobject]@{ Phase = $Phase; VMName = $vm.Name; VMId = $vm.Id.ToString();
        VMState = $vm.State.ToString(); WorkerUrl = $workerUrl.AbsoluteUri.TrimEnd('/');
        DashboardTask = $task.State.ToString(); ControlMode = $control.mode;
        CaseDir = $caseDir; CaseExists = Test-Path -LiteralPath (Join-Path $caseDir 'task-id.txt') }
    return
}
if ($Phase -eq 'prepare' -and (Test-Path -LiteralPath (Join-Path $caseDir 'task-id.txt'))) {
    throw 'This case already has a task; choose a fresh CaseName for prepare'
}
if ($Phase -eq 'resume' -and -not (Test-Path -LiteralPath (Join-Path $caseDir 'task-id.txt'))) {
    throw 'Prepared task ID not found; run prepare with this CaseName first'
}
if ($Phase -eq 'resume') {
    if (-not (Test-Path -LiteralPath $identityPath)) { throw 'Prepared VM identity not found; refusing resume' }
    $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
    if ($identity.vmId -ne $vm.Id.ToString() -or $identity.targetPhone -ne $TargetPhone) {
        throw 'Prepared VM identity or task parameter changed; refusing to bind this task to a different Guest'
    }
}

$dashboardWasRunning = $task.State -eq 'Running'
try {
    if ($dashboardWasRunning) {
        Stop-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
        $offline = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (-not (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)) {
                $offline = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $offline) { throw 'Dashboard port 4173 did not close; refusing concurrent Guest control' }
    }
    New-Item -ItemType Directory -Force -Path $caseDir | Out-Null
    $harness = Join-Path $repo 'testbench\p4\run-harness.ps1'
    $harnessPhase = if ($Phase -eq 'prepare') { 'first' } else { 'resume' }
    & $harness -Phase $harnessPhase -CaseDir $caseDir -TargetPhone $TargetPhone `
        -VmId $vm.Id -WorkerUrl $workerUrl |
        Tee-Object -FilePath (Join-Path $caseDir "$Phase-result.json")
    if ($LASTEXITCODE -ne 0) { throw "P5 harness failed with exit code $LASTEXITCODE" }
    if ($Phase -eq 'prepare') {
        @{ vmId = $vm.Id.ToString(); targetPhone = $TargetPhone; preparedAt = (Get-Date).ToUniversalTime().ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $identityPath -Encoding UTF8
    }
} finally {
    if ($dashboardWasRunning) {
        Start-ScheduledTask -TaskName 'AgentDesktop Dashboard' -ErrorAction Stop
    }
}
