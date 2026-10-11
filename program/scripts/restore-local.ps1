param([string]$BackupPath = "", [switch]$AllowLegacyBackup)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "local-state-maintenance.ps1")
$maintenanceLocks = @(Enter-LocalStateMaintenance $projectRoot)
$staging = $null
try {
    Assert-LocalStateStopped $projectRoot
    if ($BackupPath) {
        $selected = Get-Item -LiteralPath $BackupPath -ErrorAction Stop
        if ($selected.PSIsContainer) { throw "Select a backup ZIP file." }
    } else {
        $backupRoot = Join-Path $projectRoot "backups"
        $backups = @(Get-ChildItem -LiteralPath $backupRoot -Filter "liming-zhiyao-*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        if (-not $backups.Count) { throw "No restorable backup was found in the backups directory." }
        Write-Host "Available backups:"
        for ($index = 0; $index -lt $backups.Count; $index += 1) { Write-Host "[$($index + 1)] $($backups[$index].Name)" }
        $selection = Read-Host "Enter a backup number"
        $number = 0
        if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $backups.Count) { throw "The backup number is invalid." }
        $selected = $backups[$number - 1]
    }
    $suffix = (Get-Date -Format "yyyyMMdd-HHmmss") + '-' + [Guid]::NewGuid().ToString('N')
    # Same-volume staging makes final directory moves renames, not partial copies.
    $stateParent = Join-Path $projectRoot ".wrangler"
    New-Item -ItemType Directory -Force -Path $stateParent | Out-Null
    # Keep the staging prefix short: Windows SQLite/PowerShell still encounter MAX_PATH.
    $staging = [IO.Path]::GetFullPath((Join-Path $stateParent ("r-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))))
    $statePath = [IO.Path]::GetFullPath((Join-Path $stateParent "state"))
    $rollbackPath = [IO.Path]::GetFullPath((Join-Path $stateParent "state-before-restore-$suffix"))
    $prefix = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
    foreach ($target in @($staging, $statePath, $rollbackPath)) {
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Restore targets must stay inside this installation." }
    }
    foreach ($target in @($projectRoot, $stateParent, $statePath)) {
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -Force -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Restore paths cannot be filesystem links." }
    }
    New-Item -ItemType Directory -Path $staging | Out-Null
    Expand-CheckedStateArchive $selected.FullName $staging -AllowLegacyBackup:$AllowLegacyBackup
    Write-Host "Verified backup: $($selected.FullName)"
    $confirmation = Read-Host "Restore replaces the current local state. Type RESTORE to confirm"
    if ($confirmation -cne "RESTORE") { throw "Restore cancelled." }
    Assert-LocalStateStopped $projectRoot
    if (Test-Path -LiteralPath $statePath) { Move-Item -LiteralPath $statePath -Destination $rollbackPath }
    try { Move-Item -LiteralPath (Join-Path $staging "state") -Destination $statePath }
    catch {
        if (Test-Path -LiteralPath $rollbackPath) { Move-Item -LiteralPath $rollbackPath -Destination $statePath }
        throw
    }
    Write-Host "Restore completed. Previous state: $rollbackPath" -ForegroundColor Green
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Exit-LocalStateMaintenance $maintenanceLocks
}
