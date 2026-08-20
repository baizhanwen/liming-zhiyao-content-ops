$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDirectory = Join-Path $projectRoot ".local"
$python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"

Write-Host "============================================================"
Write-Host "Liming Zhiyao - Video Analyzer Diagnostic"
Write-Host "============================================================"

function Read-LogTail([string]$Path, [int]$Count = 18) {
    if (-not (Test-Path -LiteralPath $Path)) { return @("[missing]") }
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
    }
    catch [IO.IOException] {
        return @("[NOTICE] The analyzer is currently writing this log. Stop the local service to inspect the complete file.")
    }
    if ($bytes.Length -eq 0) { return @("[empty]") }
    $isUnicode = ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or
        (@($bytes | Select-Object -First ([Math]::Min(200, $bytes.Length)) | Where-Object { $_ -eq 0 }).Count -gt 10)
    $text = if ($isUnicode) { [Text.Encoding]::Unicode.GetString($bytes) } else { [Text.Encoding]::UTF8.GetString($bytes) }
    return @($text -split "\r?\n" | Where-Object { $_.Trim() } | Select-Object -Last $Count)
}

Write-Host ""
Write-Host "[1/7] Python environment"
if (Test-Path -LiteralPath $python) {
    & $python -c "import platform,sys; print(sys.version.split()[0] + ' / ' + platform.architecture()[0] + ' / ' + platform.machine())"
    & $python -m pip check
    & $python -c "from importlib.metadata import version; print('paddlepaddle=' + version('paddlepaddle') + ', paddleocr=' + version('paddleocr') + ', paddlex=' + version('paddlex'))"
    & $python -c "import torch,torchaudio,paddle,cv2; from paddleocr import PaddleOCR; print('[OK] torch, torchaudio, paddle, paddleocr and cv2 loaded')"
    if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] One or more native analyzer modules could not be loaded." }
} else {
    Write-Host "[ERROR] Analyzer Python environment is missing. Run tools\setup-analyzer.bat."
}

Write-Host ""
Write-Host "[2/7] Native runtime"
$vcInstalled = $false
foreach ($key in @("HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64")) {
    try {
        $runtime = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        if ($runtime.Installed -eq 1 -and $runtime.Major -ge 14) { $vcInstalled = $true }
    } catch {}
}
Write-Host $(if ($vcInstalled) { "[OK] Microsoft Visual C++ x64 runtime" } else { "[ERROR] Microsoft Visual C++ x64 runtime is missing" })
foreach ($command in @("ffmpeg", "ffprobe")) {
    $found = Get-Command $command -ErrorAction SilentlyContinue
    Write-Host $(if ($found) { "[OK] $command - $($found.Source)" } else { "[NOTICE] $command was not found on PATH" })
}

Write-Host ""
Write-Host "[3/7] Analyzer configuration"
$values = @{}
$varsPath = Join-Path $projectRoot ".dev.vars"
if (Test-Path -LiteralPath $varsPath) {
    Get-Content -Encoding UTF8 -LiteralPath $varsPath | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { $values[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") }
    }
}
$required = @("ANALYZER_SERVICE_TOKEN", "ANALYZER_BASE_URL", "ANALYZER_WORKER_ID", "ANALYZER_LLM_API_KEY", "ANALYZER_LLM_BASE_URL", "ANALYZER_LLM_MODEL", "ANALYZER_LLM_PROVIDER")
foreach ($name in $required) {
    $value = [string]$values[$name]
    $display = if (-not $value) { "MISSING" } elseif ($name -match 'TOKEN|API_KEY') { "configured ($($value.Length) chars)" } else { $value }
    Write-Host "$name=$display"
}
$modelSource = [string]$values["ANALYZER_PADDLE_MODEL_SOURCE"]
if (-not $modelSource) { $modelSource = "bos (default)" }
Write-Host "ANALYZER_PADDLE_MODEL_SOURCE=$modelSource"
$modelCache = [string]$values["ANALYZER_MODEL_CACHE"]
if (-not $modelCache) {
    $modelCache = if ($env:PROGRAMDATA) {
        Join-Path $env:PROGRAMDATA "LimingZhiyao\model-cache"
    } else {
        "C:\ProgramData\LimingZhiyao\model-cache"
    }
}
Write-Host "ANALYZER_MODEL_CACHE=$modelCache"
$detectionModel = [string]$values["ANALYZER_PADDLE_OCR_DETECTION_MODEL"]
if (-not $detectionModel) { $detectionModel = "PP-OCRv5_mobile_det" }
$recognitionModel = [string]$values["ANALYZER_PADDLE_OCR_RECOGNITION_MODEL"]
if (-not $recognitionModel) { $recognitionModel = "PP-OCRv5_mobile_rec" }
foreach ($modelName in @($detectionModel, $recognitionModel)) {
    $inferencePath = Join-Path $modelCache "paddlex\official_models\$modelName\inference.json"
    if (Test-Path -LiteralPath $inferencePath) {
        $length = (Get-Item -LiteralPath $inferencePath).Length
        Write-Host $(if ($length -gt 0) { "[OK] $modelName inference.json ($length bytes)" } else { "[ERROR] $modelName inference.json is empty" })
    } else {
        Write-Host "[NOTICE] $modelName inference.json is not present yet"
    }
}

Write-Host ""
Write-Host "[4/7] Web application"
$portPath = Join-Path $localDirectory "app.port"
$appPort = if (Test-Path -LiteralPath $portPath) { (Get-Content -Raw -LiteralPath $portPath).Trim() } else { "" }
if ($appPort) {
    Write-Host "Recorded port: $appPort"
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$appPort/api/health" -TimeoutSec 3
        Write-Host "[OK] Web health returned HTTP $($health.StatusCode)"
    } catch { Write-Host "[ERROR] Web health failed: $($_.Exception.Message)" }
} else { Write-Host "[ERROR] .local\app.port is missing. Start the web application first." }

Write-Host ""
Write-Host "[5/7] Supervisor process"
$pidPath = Join-Path $localDirectory "analyzer.pid"
if (Test-Path -LiteralPath $pidPath) {
    $savedId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedId" -ErrorAction SilentlyContinue
    $expectedSupervisor = Join-Path $projectRoot "scripts\run-analyzer-supervisor.ps1"
    $isSupervisor = $process -and $process.Name -eq "powershell.exe" -and
        ([string]$process.CommandLine).IndexOf($expectedSupervisor, [StringComparison]::OrdinalIgnoreCase) -ge 0
    Write-Host $(if ($isSupervisor) { "[OK] Verified analyzer supervisor PID $savedId" } elseif ($process) { "[ERROR] Saved analyzer PID belongs to another program" } else { "[ERROR] Saved supervisor PID $savedId is not running" })
} else { Write-Host "[ERROR] Analyzer PID file is missing." }
if ($appPort -and $values["ANALYZER_SERVICE_TOKEN"] -and $values["ANALYZER_WORKER_ID"]) {
    try {
        $workerId = [Uri]::EscapeDataString([string]$values["ANALYZER_WORKER_ID"])
        $headers = @{ Authorization = "Bearer $($values['ANALYZER_SERVICE_TOKEN'])" }
        $status = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$appPort/api/internal/analyzer/status?workerId=$workerId" -Headers $headers -TimeoutSec 3
        Write-Host $(if ($status.online) { "[OK] Analyzer worker heartbeat is live ($($status.lastSeenAt))" } else { "[ERROR] Analyzer supervisor exists but the worker heartbeat is offline" })
    }
    catch { Write-Host "[ERROR] Analyzer heartbeat check failed: $($_.Exception.Message)" }
}

Write-Host ""
Write-Host "[6/7] Startup status"
$statusPath = Join-Path $localDirectory "analyzer-start-error.txt"
if (Test-Path -LiteralPath $statusPath) {
    Read-LogTail $statusPath 8 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "[OK] No analyzer startup error is recorded."
}

Write-Host ""
Write-Host "[7/7] Recent analyzer errors"
$errorLog = Join-Path $localDirectory "logs\analyzer-error.log"
Read-LogTail $errorLog | ForEach-Object { Write-Host $_ }

Write-Host ""
Write-Host "Copy this entire diagnostic output when requesting support. Secret values are not printed."
