$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "local-state-maintenance.ps1")
$maintenanceLocks = @(Enter-LocalStateMaintenance $projectRoot)
$partial = $null
try {
    Assert-LocalStateStopped $projectRoot
    $statePath = Join-Path $projectRoot ".wrangler\state"
    if (-not (Test-Path -LiteralPath $statePath -PathType Container)) { throw "Local state was not found. Run the project once before creating a backup." }
    $backupRoot = Join-Path $projectRoot "backups"
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $suffix = (Get-Date -Format "yyyyMMdd-HHmmss") + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $destination = Join-Path $backupRoot "liming-zhiyao-$suffix.zip"
    $partial = "$destination.partial"
    Write-StateArchive $statePath $partial
    Assert-LocalStateStopped $projectRoot
    Move-Item -LiteralPath $partial -Destination $destination
    Write-Host "Backup completed: $destination" -ForegroundColor Green
} finally {
    if ($partial -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
    Exit-LocalStateMaintenance $maintenanceLocks
}
