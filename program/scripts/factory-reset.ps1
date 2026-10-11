$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'local-state-maintenance.ps1')
$maintenanceLocks = @(Enter-LocalStateMaintenance $projectRoot)
try {
    Assert-LocalStateStopped $projectRoot
    $prefix = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $statePath = [IO.Path]::GetFullPath((Join-Path $projectRoot '.wrangler\state'))
    $rollbackPath = [IO.Path]::GetFullPath((Join-Path $projectRoot ".wrangler\state-before-factory-reset-$suffix"))
    $failedStatePath = [IO.Path]::GetFullPath((Join-Path $projectRoot ".wrangler\state-failed-factory-reset-$suffix"))
    $localRollback = [IO.Path]::GetFullPath((Join-Path $projectRoot "backups\private-reset-$suffix"))
    $localPaths = @('.local\douyin-cookies.txt', '.local\analyzer.pid', '.local\analyzer.base-url', '.local\app.port', '.local\logs')
    foreach ($target in @($statePath, $rollbackPath, $failedStatePath, $localRollback) + @($localPaths | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $projectRoot $_)) })) {
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Factory reset targets must stay inside this installation.' }
    }
    foreach ($target in @($projectRoot, (Join-Path $projectRoot '.wrangler'), (Join-Path $projectRoot '.local'), (Join-Path $projectRoot 'backups'), $statePath) + @($localPaths | ForEach-Object { Join-Path $projectRoot $_ })) {
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -Force -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Factory reset paths cannot be filesystem links.' }
    }
    $confirmation = Read-Host 'This resets the active local companies, members, projects, media and settings after creating a recovery backup. Type FACTORY RESET'
    if ($confirmation -cne 'FACTORY RESET') { throw 'Factory reset cancelled.' }
    if (Test-Path -LiteralPath $statePath) { & "$PSScriptRoot\backup-local.ps1" }
    Assert-LocalStateStopped $projectRoot
    if (Test-Path -LiteralPath $statePath) { Move-Item -LiteralPath $statePath -Destination $rollbackPath }
    $previousCi = $env:CI
    try {
        $env:CI = '1'
        & npm.cmd run db:local:migrate -- --guarded
        if ($LASTEXITCODE -ne 0) { throw "Database recreation exited with code $LASTEXITCODE." }

        # Keep private runtime files for recovery; cleanup is part of the reset transaction.
        foreach ($relative in $localPaths) {
            $source = Join-Path $projectRoot $relative
            if (Test-Path -LiteralPath $source) {
                $destination = Join-Path $localRollback $relative
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Move-Item -LiteralPath $source -Destination $destination
            }
        }
    } catch {
        $failureReason = $_.Exception.Message
        # Preserve the failed new database as evidence; never delete a business directory.
        if (Test-Path -LiteralPath $statePath) { Move-Item -LiteralPath $statePath -Destination $failedStatePath }
        if (Test-Path -LiteralPath $rollbackPath) { Move-Item -LiteralPath $rollbackPath -Destination $statePath }
        foreach ($relative in $localPaths) {
            $saved = Join-Path $localRollback $relative
            if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination (Join-Path $projectRoot $relative) }
        }
        throw "Factory reset failed ($failureReason); previous state restored and local configuration retained."
    } finally { $env:CI = $previousCi }

    Write-Host '[OK] Factory reset completed. The next commercial start will open first-run setup.' -ForegroundColor Green
    Write-Host "Rollback state: $rollbackPath"
    Write-Host "Private runtime rollback (cookies/logs): $localRollback"
} finally { Exit-LocalStateMaintenance $maintenanceLocks }
