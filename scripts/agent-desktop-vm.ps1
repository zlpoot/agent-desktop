param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$VhdPath,
    [string]$IsoPath,
    [string]$NewVhdPath,
    [string]$SwitchName,
    [int]$DiskSizeGB = 64,
    [int]$WorkerPort = 8765,
    [switch]$OpenConsole
)

$ErrorActionPreference = 'Stop'
if ($IsoPath -and -not (Test-Path -LiteralPath $IsoPath -PathType Leaf)) {
    throw "ISO file not found: $IsoPath. Replace the example with the absolute path to a real Windows installation ISO."
}
if ($VhdPath -and -not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
    throw "VHDX file not found: $VhdPath"
}
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V PowerShell management module is unavailable on this host.'
}
try { $null = @(Get-VM -ErrorAction Stop) }
catch { throw 'This account cannot manage Hyper-V. Run in an administrator PowerShell session or sign in again after joining Hyper-V Administrators.' }

$vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
if (-not $vm) {
    if (-not $SwitchName) {
        $defaultSwitch = Get-VMSwitch -ErrorAction Stop | Where-Object Name -eq 'Default Switch' | Select-Object -First 1
        if (-not $defaultSwitch) { throw 'Default Switch was not found. Specify a host-reachable switch with -SwitchName.' }
        $SwitchName = $defaultSwitch.Name
    }
    if ([bool]$VhdPath -eq [bool]$IsoPath) {
        throw 'To create a VM, specify either a bootable Windows VHDX with -VhdPath or a Windows installation ISO with -IsoPath.'
    }
    if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
        throw "Virtual switch not found: $SwitchName"
    }
    if ($VhdPath) {
        $disk = (Resolve-Path -LiteralPath $VhdPath).Path
        if ([IO.Path]::GetExtension($disk) -ne '.vhdx') { throw 'VhdPath must refer to a VHDX file.' }
        $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $disk -SwitchName $SwitchName
    } else {
        $iso = (Resolve-Path -LiteralPath $IsoPath).Path
        if ([IO.Path]::GetExtension($iso) -ne '.iso') { throw 'IsoPath must refer to an ISO file.' }
        if (-not $NewVhdPath -or -not [IO.Path]::IsPathRooted($NewVhdPath) -or
            [IO.Path]::GetExtension($NewVhdPath) -ne '.vhdx') {
            throw 'When using an ISO, provide an absolute new VHDX path with -NewVhdPath.'
        }
        if (Test-Path -LiteralPath $NewVhdPath) { throw "Target VHDX already exists: $NewVhdPath" }
        if ($DiskSizeGB -lt 48) { throw 'The Windows guest disk must be at least 48 GB.' }
        $diskDirectory = Split-Path -Path $NewVhdPath -Parent
        if (-not (Test-Path -LiteralPath $diskDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $diskDirectory -Force | Out-Null
        }
        $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4GB `
            -NewVHDPath $NewVhdPath -NewVHDSizeBytes ([long]$DiskSizeGB * 1GB) -SwitchName $SwitchName
        $dvd = Add-VMDvdDrive -VMName $Name -Path $iso -Passthru
        Set-VMFirmware -VMName $Name -FirstBootDevice $dvd
    }
    Set-VMProcessor -VMName $Name -Count 2
    Set-VMMemory -VMName $Name -DynamicMemoryEnabled $true -MinimumBytes 4GB -MaximumBytes 8GB
    Set-VM -Name $Name -AutomaticCheckpointsEnabled $false
    Set-VMFirmware -VMName $Name -EnableSecureBoot On
    Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
    Enable-VMTPM -VMName $Name
}
if ($vm.State -ne 'Running') { Start-VM -Name $Name | Out-Null }
$vm = Get-VM -Name $Name
if ($OpenConsole) { Start-Process -FilePath 'vmconnect.exe' -ArgumentList @('localhost', $Name) }
$addresses = @(Get-VMNetworkAdapter -VMName $Name | Select-Object -ExpandProperty IPAddresses)
$ipv4 = $addresses | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' } | Select-Object -First 1
[PSCustomObject]@{
    VMName = $vm.Name
    VMId = $vm.Id.ToString()
    State = $vm.State.ToString()
    WorkerUrl = if ($ipv4) { "http://${ipv4}:$WorkerPort" } else { $null }
    Note = if ($ipv4) { 'Start the worker in an interactive guest session, then use this address.' } else { 'No guest IPv4 yet. Open the VM console, finish Windows setup and login, then retry.' }
}
