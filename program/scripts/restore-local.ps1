$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$appPort = 3000
$portPath = Join-Path $projectRoot ".local\app.port"
if (Test-Path -LiteralPath $portPath) { [void][int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$appPort) }
$listener = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Stop the local server with Ctrl+C before restoring a backup." }
$backupRoot = Join-Path $projectRoot "backups"
$backups = @(Get-ChildItem -LiteralPath $backupRoot -Filter "liming-zhiyao-*.zip" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if (-not $backups.Count) { throw "No restorable backup was found in the backups directory." }
Write-Host "Available backups:"
for ($index = 0; $index -lt $backups.Count; $index += 1) { Write-Host "[$($index + 1)] $($backups[$index].Name)" }
$selection = Read-Host "Enter a backup number"
if ($selection -notmatch '^\d+$' -or [int]$selection -lt 1 -or [int]$selection -gt $backups.Count) { throw "The backup number is invalid." }
$selected = $backups[[int]$selection - 1]
$confirmation = Read-Host "Restore replaces the current local state. Type RESTORE to confirm"
if ($confirmation -cne "RESTORE") { throw "Restore cancelled." }

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "liming-zhiyao-restore-$timestamp"
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$staging = [System.IO.Path]::GetFullPath($staging)
if (-not $staging.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Restore staging must stay inside the temporary directory." }
Expand-Archive -LiteralPath $selected.FullName -DestinationPath $staging
if (-not (Test-Path -LiteralPath (Join-Path $staging "state")) -or -not (Test-Path -LiteralPath (Join-Path $staging "manifest.json"))) { Remove-Item -LiteralPath $staging -Recurse -Force; throw "The backup structure is invalid." }
$statePath = Join-Path $projectRoot ".wrangler\state"
$rollbackPath = Join-Path $projectRoot ".wrangler\state-before-restore-$timestamp"
$resolvedProject = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
$statePath = [System.IO.Path]::GetFullPath($statePath)
$rollbackPath = [System.IO.Path]::GetFullPath($rollbackPath)
if (-not $statePath.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase) -or -not $rollbackPath.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase)) { throw "Restore targets must stay inside this installation." }
if (Test-Path -LiteralPath $statePath) { Move-Item -LiteralPath $statePath -Destination $rollbackPath }
try { Move-Item -LiteralPath (Join-Path $staging "state") -Destination $statePath } catch { if (Test-Path -LiteralPath $rollbackPath) { Move-Item -LiteralPath $rollbackPath -Destination $statePath }; throw } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Restore completed. Previous state: $rollbackPath" -ForegroundColor Green
