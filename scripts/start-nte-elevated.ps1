param([Parameter(Mandatory = $true)][string]$TaskId)

if ($TaskId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  exit 2
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
try {
  $process = Start-Process -FilePath $nodePath -Verb RunAs -WindowStyle Hidden `
    -WorkingDirectory $projectRoot -ArgumentList @('--import', 'tsx', 'src/nte-web-runner.ts', $TaskId) `
    -Wait -PassThru
  exit $process.ExitCode
} catch {
  Write-Error $_
  exit 1
}
