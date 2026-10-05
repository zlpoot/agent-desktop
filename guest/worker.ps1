param(
    [int]$Port = 8765,
    [Parameter(Mandatory = $true)][string]$VmId,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$BindHost = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
if (-not $Token.Trim()) { throw 'Token must not be empty.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentDesktopDisplay {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
}
'@
$previousDpiContext = [AgentDesktopDisplay]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previousDpiContext -eq [IntPtr]::Zero) {
    throw 'Cannot enable per-monitor DPI awareness for desktop capture.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Send-Response {
    param($Stream, [int]$Status, [string]$ContentType, [byte[]]$Body)
    $reason = switch ($Status) { 200 { 'OK' } 401 { 'Unauthorized' } 404 { 'Not Found' } 405 { 'Method Not Allowed' } default { 'Service Unavailable' } }
    $head = "HTTP/1.1 $Status $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

$address = [Net.IPAddress]::Parse($BindHost)
$listener = [Net.Sockets.TcpListener]::new($address, $Port)
try {
    $listener.Start()
} catch {
    throw "Cannot listen on ${BindHost}:$Port. $($_.Exception.Message)"
}
$started = [DateTimeOffset]::UtcNow
Write-Host "Agent Desktop Worker $VmId listening on ${BindHost}:$Port"
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 5000
        $client.SendTimeout = 5000
        $stream = $client.GetStream()
        try {
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            $headers = @{}
            $headerLength = 0
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line.Length -eq 0) { break }
                $headerLength += $line.Length
                if ($headerLength -gt 8192) { throw 'Request headers too large.' }
                $separator = $line.IndexOf(':')
                if ($separator -gt 0) { $headers[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim() }
            }
            if ($headers['Authorization'] -cne "Bearer $Token") {
                Send-Response $stream 401 'text/plain' ([Text.Encoding]::UTF8.GetBytes('Unauthorized'))
                continue
            }
            $parts = $requestLine -split ' ', 3
            if ($parts.Length -lt 3) { throw 'Invalid HTTP request.' }
            if ($parts[0] -ne 'GET') {
                Send-Response $stream 405 'text/plain' ([Text.Encoding]::UTF8.GetBytes('D1 worker is observe-only'))
                continue
            }
            switch (($parts[1] -split '\?', 2)[0]) {
                '/state' {
                    $state = @{
                        vm_id = $VmId
                        host = $env:COMPUTERNAME
                        uptime_seconds = [int]([DateTimeOffset]::UtcNow - $started).TotalSeconds
                        desktop = $env:SESSIONNAME
                    } | ConvertTo-Json -Compress
                    Send-Response $stream 200 'application/json' ([Text.Encoding]::UTF8.GetBytes($state))
                }
                '/frame' {
                    $bounds = [System.Drawing.Rectangle]::new(
                        [AgentDesktopDisplay]::GetSystemMetrics(76),
                        [AgentDesktopDisplay]::GetSystemMetrics(77),
                        [AgentDesktopDisplay]::GetSystemMetrics(78),
                        [AgentDesktopDisplay]::GetSystemMetrics(79))
                    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'No interactive desktop is available.' }
                    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
                    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                    $imageStream = New-Object System.IO.MemoryStream
                    try {
                        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
                        $bitmap.Save($imageStream, [System.Drawing.Imaging.ImageFormat]::Png)
                        Send-Response $stream 200 'image/png' $imageStream.ToArray()
                    } finally {
                        $imageStream.Dispose()
                        $graphics.Dispose()
                        $bitmap.Dispose()
                    }
                }
                default {
                    Send-Response $stream 404 'text/plain' ([Text.Encoding]::UTF8.GetBytes('Not found'))
                }
            }
        } catch {
            try { Send-Response $stream 503 'text/plain' ([Text.Encoding]::UTF8.GetBytes("Desktop capture failed: $($_.Exception.Message)")) } catch {}
        } finally {
            if ($reader) { $reader.Dispose() }
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
