$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Stop the local server with Ctrl+C before creating a backup." }
if (-not (Test-Path -LiteralPath ".wrangler\state")) { throw "Local state was not found. Run the project once before creating a backup." }

$backupRoot = Join-Path $projectRoot "backups"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$destination = Join-Path $backupRoot "liming-zhiyao-$timestamp.zip"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "liming-zhiyao-backup-$timestamp"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
    Copy-Item -LiteralPath ".wrangler\state" -Destination (Join-Path $staging "state") -Recurse
    @{ createdAt = (Get-Date).ToString("o"); project = "liming-zhiyao"; formatVersion = 1 } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $staging "manifest.json")
    Compress-Archive -LiteralPath (Join-Path $staging "state"),(Join-Path $staging "manifest.json") -DestinationPath $destination -CompressionLevel Optimal
} finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Backup completed: $destination" -ForegroundColor Green
