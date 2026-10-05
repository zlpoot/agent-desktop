param([string]$Output = "")
$ErrorActionPreference = 'Stop'
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
& $compiler /nologo /codepage:65001 /target:winexe "/out:$Output" $baseRef /reference:System.Xaml.dll /reference:System.Web.Extensions.dll $coreRef $frameworkRef (Join-Path $root 'Program.cs') (Join-Path $root 'Shopping.cs')
if ($LASTEXITCODE -ne 0) { throw "TestBench 编译失败，退出码 $LASTEXITCODE" }
Write-Output $Output
