param(
  [ValidateSet('warehouse','shopping')][string]$Scenario = 'warehouse',
  [ValidateSet('normal','ui-changed','slow-network','popup','uia-missing','action-failure','customer-save-rejected')][string]$Mode = 'normal',
  [int]$Seed = 1,
    [ValidateSet('张三','李四')][string]$Customer = '张三',
    [ValidateSet('home','customer')][string]$StartView = 'home',
    [string]$InitialPhone = ''
)
$ErrorActionPreference = 'Stop'
if ($InitialPhone -and $InitialPhone -notmatch '^1\d{10}$') { throw 'InitialPhone must be an 11-digit mobile number.' }
if ($Scenario -eq 'shopping' -and $Mode -in @('popup','uia-missing','customer-save-rejected')) {
  throw "模拟商城不支持 $Mode 模式；可用 normal、ui-changed、slow-network、action-failure。"
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$session = [guid]::NewGuid().ToString('N')
$secret = [guid]::NewGuid().ToString('N')
$exe = & (Join-Path $root 'build.ps1') -Output (Join-Path $root "..\.artifacts\testbench\WindowsAgentTestBench-$session.exe")
$exe = @($exe)[-1]
$meta = Join-Path $root '..\.artifacts\testbench\session.json'
$process = Start-Process -FilePath $exe -ArgumentList @("--scenario=$Scenario", "--mode=$Mode", "--seed=$Seed", "--customer=$Customer", "--view=$StartView", "--phone=$InitialPhone", "--pipe=windows-agent-testbench-$session", "--secret=$secret") -WindowStyle Normal -PassThru
@{ pipe = "windows-agent-testbench-$session"; secret = $secret; scenario = $Scenario; mode = $Mode; seed = $Seed; customer = $Customer; processId = $process.Id } | ConvertTo-Json | Set-Content -LiteralPath $meta -Encoding UTF8
Write-Output "TestBench 已启动；场景=$Scenario；模式=$Mode；随机种子=$Seed；测试会话=$meta"
