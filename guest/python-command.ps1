function Find-AgentDesktopPython {
    foreach ($name in @('py', 'python')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { continue }
        $prefix = if ($name -eq 'py') { @('-3') } else { @() }
        try {
            & $command.Source @prefix -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' *> $null
            if ($LASTEXITCODE -eq 0) {
                return [PSCustomObject]@{ Exe = $command.Source; Prefix = $prefix }
            }
        } catch { continue }
    }
    return $null
}
