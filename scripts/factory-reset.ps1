$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$portPath = Join-Path $projectRoot ".local\app.port"
$appPort = 3000
if (Test-Path -LiteralPath $portPath) { [void][int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$appPort) }
if (Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Stop the local project before factory reset."
}

$confirmation = Read-Host "This resets the active local companies, members, projects, media and settings after creating a recovery backup. Type FACTORY RESET"
if ($confirmation -cne "FACTORY RESET") { throw "Factory reset cancelled." }

if (Test-Path -LiteralPath ".wrangler\state") {
    & "$PSScriptRoot\backup-local.ps1"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$statePath = Join-Path $projectRoot ".wrangler\state"
$rollbackPath = Join-Path $projectRoot ".wrangler\state-before-factory-reset-$timestamp"
if (Test-Path -LiteralPath $statePath) { Move-Item -LiteralPath $statePath -Destination $rollbackPath }

foreach ($path in @(".local\douyin-cookies.txt", ".local\analyzer.pid", ".local\app.port")) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}
$localLogsPath = Join-Path $projectRoot ".local\logs"
if (Test-Path -LiteralPath $localLogsPath) {
    Remove-Item -LiteralPath $localLogsPath -Recurse -Force
}

$env:CI = "1"
& npm.cmd run db:local:migrate
Remove-Item Env:CI -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Recurse -Force }
    if (Test-Path -LiteralPath $rollbackPath) { Move-Item -LiteralPath $rollbackPath -Destination $statePath }
    throw "Database recreation failed; the previous state was restored."
}
Write-Host "[OK] Factory reset completed. The next commercial start will open first-run setup." -ForegroundColor Green
Write-Host "Rollback state: $rollbackPath"
