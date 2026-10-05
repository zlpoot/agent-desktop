param([switch]$SkipPackages)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'python-command.ps1'
. $helper
$python = Find-AgentDesktopPython
if (-not $python) {
    throw 'No usable Python 3.11+ runtime found. Install Python in the guest, reopen PowerShell, then rerun this script.'
}
$pythonArgs = $python.Prefix
if (-not $SkipPackages) {
    # Build 312 omits the MFC DLL required by win32ui; keep the known working wheel.
    & $python.Exe @pythonArgs -m pip install --upgrade pyautogui 'pywin32==311' pywinauto psutil pillow opencv-python numpy
    if ($LASTEXITCODE -ne 0) { throw 'Guest Python package installation failed.' }
}
& $python.Exe @pythonArgs -c 'import pyautogui, psutil, win32gui, win32security, win32ui, pywinauto, PIL, cv2, numpy'
if ($LASTEXITCODE -ne 0) { throw 'Guest action dependencies are incomplete.' }
Write-Host 'Agent Desktop action dependencies ready'
Write-Host 'Restart the AgentDesktop Worker scheduled task to enable action RPC.'
