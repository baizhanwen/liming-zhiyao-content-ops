param([Parameter(Mandatory = $true)][string]$NodePath, [switch]$WebAlreadyLocked)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'analyzer-instance-lock.ps1')
$webLock = $null
$databaseLock = $null
try {
    if (-not $WebAlreadyLocked) {
        $webLock = Enter-AnalyzerInstanceLock $projectRoot 'web'
        if ($null -eq $webLock) { throw 'The web service or another startup is active. Stop the service before recovering interrupted work.' }
    }
    $databaseLock = Enter-AnalyzerInstanceLock $projectRoot 'database-write'
    if ($null -eq $databaseLock) { throw 'Backup, restore, reset or migration is active. Wait before preparing startup.' }
    & $NodePath (Join-Path $PSScriptRoot 'prepare-login-startup.mjs') --locked
    exit $LASTEXITCODE
} finally {
    Exit-AnalyzerInstanceLock $databaseLock
    Exit-AnalyzerInstanceLock $webLock
}
