$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
$localDirectory = Join-Path $projectRoot ".local"
$logDirectory = Join-Path $localDirectory "logs"
$pidPath = Join-Path $localDirectory "analyzer.pid"
$errorPath = Join-Path $localDirectory "analyzer-start-error.txt"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue

function Write-AnalyzerStartError([string]$Message) {
    Set-Content -LiteralPath $errorPath -Encoding UTF8 -Value $Message
    Write-Host "[NOTICE] $Message"
}

if (-not (Test-Path -LiteralPath $python)) {
    Write-AnalyzerStartError "Video analyzer is not installed. Run setup-analyzer.bat once."
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".dev.vars"))) {
    Write-AnalyzerStartError "Local configuration is missing. Run setup-local.bat first."
    exit 2
}

if (Test-Path -LiteralPath $pidPath) {
    $savedId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId)
    if ($savedId -gt 0) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedId" -ErrorAction SilentlyContinue
        if ($existing -and $existing.Name -eq "python.exe" -and
            ([string]$existing.CommandLine).IndexOf($python, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            ([string]$existing.CommandLine) -match '(?i)-m\s+liming_analyzer') {
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

Get-Content -Encoding UTF8 -LiteralPath (Join-Path $projectRoot ".dev.vars") | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $name = $matches[1]
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path "Env:$name" -Value $value
    }
}

$required = @(
    "ANALYZER_SERVICE_TOKEN", "ANALYZER_BASE_URL", "ANALYZER_WORKER_ID",
    "ANALYZER_LLM_API_KEY", "ANALYZER_LLM_BASE_URL", "ANALYZER_LLM_MODEL", "ANALYZER_LLM_PROVIDER"
)
$missing = @($required | Where-Object { -not (Get-Item -Path "Env:$_" -ErrorAction SilentlyContinue).Value })
if ($missing.Count -gt 0) {
    Write-AnalyzerStartError "Video analyzer configuration is incomplete: $($missing -join ', ')"
    exit 2
}

$env:PYTHONUNBUFFERED = "1"
$stdoutPath = Join-Path $logDirectory "analyzer.log"
$stderrPath = Join-Path $logDirectory "analyzer-error.log"
$process = Start-Process -FilePath $python -ArgumentList @("-m", "liming_analyzer", "--idle-seconds", "4") `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
Set-Content -LiteralPath $pidPath -Encoding ASCII -Value $process.Id
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $detail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -Tail 8 -LiteralPath $stderrPath) -join " " } else { "No error log was written." }
    Write-AnalyzerStartError "Video analyzer could not start. $detail"
    exit 1
}

exit 0
