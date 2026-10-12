param([string]$Output = "")
$ErrorActionPreference = 'Stop'
# A Low-built EXE starts Low even when launched by a normal Medium user.
# Fail before producing an unusable Hidden Desktop artifact in a sandbox.
$groups = & "$env:WINDIR\System32\whoami.exe" /groups /fo csv /nh
if ($LASTEXITCODE -ne 0) { throw '无法确认构建进程完整性级别。' }
$integrity = @($groups | ConvertFrom-Csv -Header Name,Type,Sid,Attributes | Where-Object { $_.Sid -match '^S-1-16-[0-9]+$' })
if ($integrity.Count -ne 1 -or [int]($integrity[0].Sid.Split('-')[-1]) -lt 8192) {
    throw 'TestBench 须在普通 Medium 用户会话或更高完整性会话中构建；不能在 Low 沙箱内构建。'
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Output) { $Output = Join-Path $root '..\.artifacts\testbench\WindowsAgentTestBench.exe' }
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) { throw "缺少 .NET Framework C# 编译器：$compiler" }
$wpf = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$coreRef = '/reference:' + (Join-Path $wpf 'PresentationCore.dll')
$frameworkRef = '/reference:' + (Join-Path $wpf 'PresentationFramework.dll')
$baseRef = '/reference:' + (Join-Path $wpf 'WindowsBase.dll')
& $compiler /nologo /codepage:65001 /target:winexe "/out:$Output" $baseRef /reference:System.Xaml.dll /reference:System.Web.Extensions.dll $coreRef $frameworkRef (Join-Path $root 'Program.cs') (Join-Path $root 'Shopping.cs') (Join-Path $root 'TaskChannel.cs') (Join-Path $root 'RegistryFence.cs')
if ($LASTEXITCODE -ne 0) { throw "TestBench 编译失败，退出码 $LASTEXITCODE" }
# Only the just-compiled artifact; no recursive directory/DACL or runtime changes.
& "$env:WINDIR\System32\icacls.exe" $Output /setintegritylevel M /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'TestBench 产物 Medium 完整性标签设置失败；不得用于启动。' }
Write-Output $Output
