param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name,
    [Parameter(Mandatory)][guid]$VmId,
    [Parameter(Mandatory)][string]$CredentialPath,
    [Parameter(Mandatory)][ValidateSet('testbench-phone','desktop-file')][string]$Kind,
    [string]$Expected = '',
    [string]$FileName = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Kind -eq 'testbench-phone' -and $Expected -notmatch '^1\d{10}$') { throw 'Invalid expected phone.' }
if ($Kind -eq 'desktop-file' -and ($FileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.txt$' -or $FileName.Contains('..'))) {
    throw 'Invalid desktop filename.'
}
$vm = Get-VM -Name $Name -ErrorAction Stop
if ($vm.Id -ne $VmId -or $vm.State -ne 'Running') { throw 'Configured VM identity or state does not match.' }
if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { throw 'Guest Oracle credential is not installed.' }
$credential = Import-Clixml -LiteralPath $CredentialPath
if ($credential -isnot [pscredential]) { throw 'Guest Oracle credential is invalid.' }
$session = New-PSSession -VMName $Name -Credential $credential -ErrorAction Stop
try {
    if ($Kind -eq 'testbench-phone') {
        $result = Invoke-Command -Session $session -ArgumentList $Expected -ScriptBlock {
            param([string]$Phone)
            $script = 'C:\AgentDesktop\testbench\verify.ps1'
            if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'TestBench Oracle is not installed.' }
            $lines = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Task task1 -Expected $Phone
            $exitCode = $LASTEXITCODE
            if ($exitCode -notin @(0,1)) { throw "TestBench Oracle exited $exitCode." }
            if (-not $lines) { throw 'TestBench Oracle returned no result.' }
            $parsed = ($lines -join [Environment]::NewLine) | ConvertFrom-Json
            if ($parsed.pass -isnot [bool]) { throw 'TestBench Oracle verdict is missing.' }
            $parsed
        }
    } else {
        $result = Invoke-Command -Session $session -ArgumentList $FileName -ScriptBlock {
            param([string]$Leaf)
            if ($Leaf -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.txt$' -or $Leaf.Contains('..')) {
                throw 'Invalid desktop filename.'
            }
            $desktop = [Environment]::GetFolderPath('Desktop')
            if (-not $desktop) { throw 'Guest Desktop path is unavailable.' }
            $path = Join-Path $desktop $Leaf
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                [pscustomobject]@{ path=$path; exists=$false }
            } else {
                $file = Get-Item -LiteralPath $path -ErrorAction Stop
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Guest desktop file cannot be a reparse point.'
                }
                if ($file.Length -gt 262144) { throw 'Guest desktop file exceeds the Oracle read limit.' }
                $hash = Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop
                [pscustomobject]@{
                    path=$path; exists=$true; size=$file.Length;
                    mtimeUtc=$file.LastWriteTimeUtc.ToString('o');
                    sha256=$hash.Hash.ToLowerInvariant();
                    text=[IO.File]::ReadAllText($path)
                }
            }
        }
    }
    $result | ConvertTo-Json -Depth 12 -Compress
} finally {
    Remove-PSSession -Session $session
}
