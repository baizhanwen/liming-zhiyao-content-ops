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

        $recordedDirectories = @(Read-AnalyzerMediaPathFile (Join-Path $ProjectRoot ".local\node.path"))
        $node = Resolve-AnalyzerMediaExecutable "" "node" $recordedDirectories
        if (-not $node) {
            throw "Node.js is missing from the video collector. Run tools\setup-analyzer.bat."
        }
        & $node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(process.arch === 'x64' && (major > 22 || (major === 22 && minor >= 13)) ? 0 : 1)"
        if ($LASTEXITCODE -ne 0) { throw "The video collector requires 64-bit Node.js 22.13 or newer." }

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
