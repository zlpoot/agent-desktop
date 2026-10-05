param([int]$Port = 8765, [switch]$UseSavedToken)

$ErrorActionPreference = 'Stop'
if ($UseSavedToken) {
    $tokenFile = Join-Path $PSScriptRoot 'worker-token.dat'
    $vmIdFile = Join-Path $PSScriptRoot 'vm-id.txt'
    if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf) -or
        -not (Test-Path -LiteralPath $vmIdFile -PathType Leaf)) {
        throw 'Saved Worker configuration is missing. Run install-worker-autostart.ps1 first.'
    }
    $secureToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim() | ConvertTo-SecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $env:AGENT_DESKTOP_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $env:AGENT_DESKTOP_VM_ID = (Get-Content -LiteralPath $vmIdFile -Raw).Trim()
}
if (-not $env:AGENT_DESKTOP_TOKEN) { throw 'Set AGENT_DESKTOP_TOKEN in the guest before starting the worker.' }
if (-not $env:AGENT_DESKTOP_VM_ID) { throw 'Set AGENT_DESKTOP_VM_ID to the VMId reported by the host script.' }
$actionReady = $false
. (Join-Path $PSScriptRoot 'python-command.ps1')
$python = Find-AgentDesktopPython
if ((Test-Path -LiteralPath (Join-Path $PSScriptRoot 'action-worker.py')) -and $python) {
    try {
        $pythonArgs = $python.Prefix
        & $python.Exe @pythonArgs -c 'import pyautogui, psutil, win32gui, win32security, win32ui, pywinauto, PIL, cv2, numpy' 2>$null
        $actionReady = $LASTEXITCODE -eq 0
    } catch { $actionReady = $false }
}
if ($actionReady) {
    $env:AGENT_DESKTOP_WORKER_PORT = [string]$Port
    & $python.Exe @pythonArgs (Join-Path $PSScriptRoot 'action-worker.py')
} else {
    & (Join-Path $PSScriptRoot 'worker.ps1') -Port $Port -VmId $env:AGENT_DESKTOP_VM_ID -Token $env:AGENT_DESKTOP_TOKEN
}
