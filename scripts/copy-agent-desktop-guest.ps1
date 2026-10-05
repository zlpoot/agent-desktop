param(
    [string]$Name = 'AgentDesktop',
    [string]$GuestPath = 'C:\AgentDesktop'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command Copy-VMFile -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V Guest Service file copy is unavailable on this host.'
}
$vm = Get-VM -Name $Name -ErrorAction Stop
if ($vm.State -ne 'Running') { throw "VM must be running: $Name" }
if ($GuestPath -notmatch '^[A-Za-z]:\\') { throw 'GuestPath must be an absolute Windows path.' }
$services = @(Get-VMIntegrationService -VMName $Name -ErrorAction Stop)
$service = $services |
    Where-Object { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480$' } |
    Select-Object -First 1
if (-not $service) {
    $details = $services | Select-Object Name, Id, Enabled | Format-Table -AutoSize | Out-String
    throw "Guest Service Interface integration service was not found. Available services:`n$details"
}
if (-not $service.Enabled) {
    Enable-VMIntegrationService -VMName $Name -Name $service.Name -ErrorAction Stop
}
foreach ($file in @('worker.ps1', 'start-worker.ps1', 'install-worker-autostart.ps1',
        'action-worker.py', 'desktop-worker.py', 'vision.py', 'install-action-worker.ps1',
        'python-command.ps1', 'apps.json', 'input_control.py', 'human_input.py', 'subprocess_rpc.py',
        'file_evidence.py', 'desktop_readiness.py', 'smoke-file-rpc.ps1')) {
    $relative = switch ($file) {
        'desktop-worker.py' { '..\src\runtime\desktop\worker.py' }
        'vision.py' { '..\src\runtime\desktop\vision.py' }
        'apps.json' { '..\config\agent-desktop-apps.json' }
        default { "..\guest\$file" }
    }
    $source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot $relative)).Path
    $destination = Join-Path $GuestPath $file
    Copy-VMFile -Name $Name -SourcePath $source -DestinationPath $destination `
        -FileSource Host -CreateFullPath -Force -ErrorAction Stop
}
[PSCustomObject]@{
    VMName = $vm.Name
    VMId = $vm.Id.ToString()
    GuestPath = $GuestPath
    Files = 'worker.ps1, start-worker.ps1, install-worker-autostart.ps1, action-worker.py, desktop-worker.py, vision.py, install-action-worker.ps1, python-command.ps1, apps.json, input_control.py, human_input.py, subprocess_rpc.py, file_evidence.py, desktop_readiness.py, smoke-file-rpc.ps1'
}
