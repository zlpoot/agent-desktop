param(
  [ValidateSet('task1','task2','task3','shop-search','shop-cart','shop-order','shop-paid','state')][string]$Task = 'state',
  [string]$Expected = '', [string]$Sku = '', [int]$Quantity = 1, [string]$Recipient = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$meta = Get-Content -LiteralPath (Join-Path $root '..\.artifacts\testbench\session.json') -Raw | ConvertFrom-Json
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $meta.pipe, [System.IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(3000)
  $writer = New-Object System.IO.StreamWriter($pipe, [Text.Encoding]::UTF8, 1024, $true)
  $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
  $criterion = if ($Task -in @('shop-cart','shop-order','shop-paid')) { "$Sku,$Quantity,$Recipient" } else { $Expected }
  $writer.WriteLine("$($meta.secret)|$Task|$criterion")
  $response = $reader.ReadLine()
  if (-not $response) { throw 'TestBench 未返回验证结果' }
  $result = $response | ConvertFrom-Json
  $result | ConvertTo-Json -Depth 10
  if ($Task -ne 'state' -and -not $result.pass) { exit 1 }
} finally { $pipe.Dispose() }
