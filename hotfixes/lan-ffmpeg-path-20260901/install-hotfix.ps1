param([string]$ApplicationRoot = "")

$ErrorActionPreference = "Stop"
$patchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadRoot = Join-Path $patchRoot "payload"

function Test-ApplicationRoot([string]$Path) {
    if (-not $Path) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Path "start-lan.bat") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path "scripts") -PathType Container)
}

if (-not $ApplicationRoot) {
    $candidates = @($patchRoot, (Split-Path -Parent $patchRoot))
    $ApplicationRoot = $candidates | Where-Object { Test-ApplicationRoot $_ } | Select-Object -First 1
}
if (-not $ApplicationRoot) {
    $ApplicationRoot = (Read-Host "Paste the LimingZhiyao application folder path").Trim().Trim('"')
}
if (-not (Test-ApplicationRoot $ApplicationRoot)) {
    Write-Host "[ERROR] This is not the LimingZhiyao application folder: $ApplicationRoot"
    Write-Host "        Select the folder that contains start-lan.bat and the scripts folder."
    exit 2
}

$ApplicationRoot = [IO.Path]::GetFullPath($ApplicationRoot)
$required = @(
    "scripts\analyzer-media-runtime.ps1",
    "scripts\start-analyzer-background.ps1",
    "scripts\run-analyzer-supervisor.ps1",
    "scripts\start-analyzer.ps1",
    "scripts\check-analyzer.ps1"
)
foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot $relativePath) -PathType Leaf)) {
        Write-Host "[ERROR] The hotfix payload is incomplete: $relativePath"
        exit 2
    }
}

$pidPath = Join-Path $ApplicationRoot ".local\analyzer.pid"
if (Test-Path -LiteralPath $pidPath) {
    $savedId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId)
    if ($savedId -gt 0 -and (Get-Process -Id $savedId -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] The video analyzer is still running."
        Write-Host "        Run stop-local.bat, then apply this hotfix again."
        exit 3
    }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $ApplicationRoot ".local\hotfix-backups\lan-ffmpeg-path-$timestamp"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

foreach ($relativePath in $required) {
    $source = Join-Path $payloadRoot $relativePath
    $destination = Join-Path $ApplicationRoot $relativePath
    $backup = Join-Path $backupRoot $relativePath
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$startup = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ApplicationRoot "scripts\start-analyzer-background.ps1")
$resolver = Join-Path $ApplicationRoot "scripts\analyzer-media-runtime.ps1"
if ($startup -notmatch "Import-AnalyzerMediaRuntime" -or -not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    Write-Host "[ERROR] Hotfix verification failed. Original files are backed up at:"
    Write-Host "        $backupRoot"
    exit 4
}

Write-Host "[OK] LAN analyzer FFmpeg path hotfix V2 installed."
Write-Host "     Application: $ApplicationRoot"
Write-Host "     Backup:      $backupRoot"
Write-Host "[NEXT] Run start-lan.bat, then retry the failed analysis jobs."
exit 0
