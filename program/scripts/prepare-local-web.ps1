param([switch]$CheckDependenciesOnly)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$requiredWebDependencies = @("node_modules\wrangler\bin\wrangler.js", "node_modules\vinext\package.json")
$missingWebDependencies = @($requiredWebDependencies | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missingWebDependencies.Count -gt 0) {
    Write-Host "[ERROR] Web dependencies are missing or incomplete."
    Write-Host "        Run setup-local.bat once, wait for 'Web setup completed', then start again."
    Write-Host "        Missing: $($missingWebDependencies -join ', ')"
    exit 1
}
if (-not (Test-Path -LiteralPath ".dev.vars")) {
    Copy-Item -LiteralPath ".dev.vars.example" -Destination ".dev.vars"
    Write-Host "[Liming Zhiyao] Created the local .dev.vars configuration."
}
if ($CheckDependenciesOnly) { exit 0 }

Write-Host "[Liming Zhiyao] Checking database migrations..."
$previousCi = $env:CI
try {
    $env:CI = "1"
    & npm.cmd run db:local:migrate
    $migrationExitCode = $LASTEXITCODE
} finally {
    $env:CI = $previousCi
}
if ($migrationExitCode -ne 0) { exit $migrationExitCode }

Write-Host "[Liming Zhiyao] Preparing login sessions..."
& npm.cmd run auth:startup -- --guarded
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[Liming Zhiyao] Checking authorized content knowledge..."
& npm.cmd run knowledge:local:sync
exit $LASTEXITCODE
