param(
    [string]$Name = 'AgentDesktop',
    [string]$GuestPath = 'C:\AgentDesktop\testbench'
)
$ErrorActionPreference = 'Stop'
if ($GuestPath -notmatch '^[A-Za-z]:\\') { throw 'GuestPath must be an absolute Windows path.' }
$vm = Get-VM -Name $Name -ErrorAction Stop
if ($vm.State -ne 'Running') { throw "VM must be running: $Name" }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = & (Join-Path $root 'testbench\build.ps1') -Output (Join-Path $root '.artifacts\testbench\P1-Guest-TestBench.exe')
$exe = @($exe)[-1]
foreach ($file in @(
    @{ Source = $exe; Name = 'WindowsAgentTestBench.exe' },
    @{ Source = (Join-Path $root 'testbench\verify.ps1'); Name = 'verify.ps1' },
    @{ Source = (Join-Path $root 'testbench\start-guest.ps1'); Name = 'start-guest.ps1' }
)) {
    Copy-VMFile -Name $Name -SourcePath $file.Source `
        -DestinationPath (Join-Path $GuestPath $file.Name) -FileSource Host -CreateFullPath -Force -ErrorAction Stop
}
[pscustomobject]@{VMName=$vm.Name; GuestPath=$GuestPath;
    Files='WindowsAgentTestBench.exe, verify.ps1, start-guest.ps1'}
