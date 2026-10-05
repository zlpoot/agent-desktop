param(
    [ValidateSet('warehouse','shopping')][string]$Scenario = 'warehouse',
    [ValidateSet('normal','ui-changed','slow-network','popup','uia-missing','action-failure','customer-save-rejected')][string]$Mode = 'normal',
    [ValidateSet('张三','李四')][string]$Customer = '张三',
    [ValidateSet('home','customer')][string]$StartView = 'customer',
    [string]$InitialPhone = '13711112222'
)
$ErrorActionPreference = 'Stop'
if ($InitialPhone -and $InitialPhone -notmatch '^1\d{10}$') { throw 'InitialPhone must be an 11-digit mobile number.' }
$exe = Join-Path $PSScriptRoot 'WindowsAgentTestBench.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "TestBench executable not found: $exe" }
$session = [guid]::NewGuid().ToString('N')
$secret = [guid]::NewGuid().ToString('N')
$metaDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.artifacts\testbench'))
New-Item -ItemType Directory -Force -Path $metaDir | Out-Null
$process = Start-Process -FilePath $exe -ArgumentList @(
    "--scenario=$Scenario", "--mode=$Mode", '--seed=1', "--customer=$Customer",
    "--view=$StartView", "--phone=$InitialPhone", "--pipe=windows-agent-testbench-$session",
    "--secret=$secret") -WindowStyle Normal -PassThru
@{pipe="windows-agent-testbench-$session";secret=$secret;scenario=$Scenario;
    mode=$Mode;customer=$Customer;processId=$process.Id} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $metaDir 'session.json') -Encoding UTF8
[pscustomobject]@{ProcessId=$process.Id;Mode=$Mode;Customer=$Customer;
    InitialPhone=$InitialPhone;Oracle='C:\AgentDesktop\testbench\verify.ps1 -Task state'}
