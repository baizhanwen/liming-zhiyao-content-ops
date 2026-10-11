param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'analyzer-instance-lock.ps1')
$databaseLock = Enter-AnalyzerInstanceLock $projectRoot 'database-write'
if ($null -eq $databaseLock) { throw 'Backup, restore, reset or another database migration is in progress. Wait for it to finish before migrating.' }
try {
    & $NodePath (Join-Path $PSScriptRoot 'run-local-migrations.mjs') --guarded
    exit $LASTEXITCODE
} finally { Exit-AnalyzerInstanceLock $databaseLock }
