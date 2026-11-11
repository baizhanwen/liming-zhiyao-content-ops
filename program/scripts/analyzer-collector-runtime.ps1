function Import-AnalyzerCollectorRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [switch]$SkipDependencyCheck,
        [switch]$AllowUnavailable
    )

    # Keep this checkout's browser cache separate from the host or another
    # project's PLAYWRIGHT_BROWSERS_PATH. Anonymous contexts remain task-local.
    $env:PLAYWRIGHT_BROWSERS_PATH = [IO.Path]::GetFullPath((Join-Path $ProjectRoot ".local\collector-browsers"))

    try {
        $nodeDirectory = Join-Path $ProjectRoot "services\analyzer\liming_analyzer\douyin_collector\node"
        $script = Join-Path $nodeDirectory "capture-douyin.mjs"
        foreach ($name in @("capture-douyin.mjs", "package.json", "package-lock.json")) {
            if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory $name) -PathType Leaf)) {
                throw "The video collector source is incomplete. Reinstall the complete update."
            }
        }

        . (Join-Path $PSScriptRoot 'install-node22.ps1')
        $selectorRoot = $script:NodeInstallerRoot
        try {
            # The requested installation owns its record, portable cache and policy.
            $script:NodeInstallerRoot = [IO.Path]::GetFullPath($ProjectRoot)
            $node = Find-NodeRuntime -PathFile (Join-Path $ProjectRoot '.local\node.path')
        } finally { $script:NodeInstallerRoot = $selectorRoot }
        if (-not $node) {
            throw "No compatible Windows x64 Node.js and npm were found for collection. Run setup-local.bat."
        }

        $runtimeDirectory = Split-Path -Parent $node
        $npm = Join-Path $runtimeDirectory "npm.cmd"
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
            throw "npm is missing beside Node.js. Run tools\setup-analyzer.bat."
        }
        $remaining = @($env:Path -split ";" | Where-Object {
            $_ -and -not [string]::Equals($_.TrimEnd("\"), $runtimeDirectory.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)
        })
        $env:Path = (@($runtimeDirectory) + $remaining) -join ";"

        if (-not $SkipDependencyCheck) {
            $runtimeReport = & $node $script --check-runtime
            $runtimeExitCode = $LASTEXITCODE
            try { $report = ($runtimeReport -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch { $report = $null }
            $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $nodeDirectory "package.json") | ConvertFrom-Json
            if ($runtimeExitCode -ne 0 -or -not $report.ok -or $report.playwright_version -ne $manifest.dependencies.'@playwright/test') {
                throw "The video collector or its Chromium browser is missing. Run tools\setup-analyzer.bat."
            }
        }
        return [pscustomobject]@{
            Node = $node; Npm = $npm; Directory = $nodeDirectory
            Script = $script; BrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
        }
    }
    catch {
        if (-not $AllowUnavailable) { throw }
        Write-Warning "Public-link collection is unavailable: $($_.Exception.Message) Uploaded video analysis remains available."
        return $null
    }
}
