param([string]$BaseUrl = "")
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
$supervisor = Join-Path $PSScriptRoot "run-analyzer-supervisor.ps1"
$localDirectory = Join-Path $projectRoot ".local"
$logDirectory = Join-Path $localDirectory "logs"
$pidPath = Join-Path $localDirectory "analyzer.pid"
$baseUrlPath = Join-Path $localDirectory "analyzer.base-url"
$errorPath = Join-Path $localDirectory "analyzer-start-error.txt"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Write-AnalyzerStartError([string]$Message) {
    Set-Content -LiteralPath $errorPath -Encoding UTF8 -Value $Message
    Write-Host "[NOTICE] $Message"
}

if (-not (Test-Path -LiteralPath $python)) {
    Write-AnalyzerStartError "Video analyzer is not installed. Run tools\setup-analyzer.bat once."
    exit 2
}
if (-not (Test-Path -LiteralPath $supervisor)) {
    Write-AnalyzerStartError "Video analyzer supervisor is missing. Reinstall the latest delivery update."
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".dev.vars"))) {
    Write-AnalyzerStartError "Local configuration is missing. Run setup-local.bat first."
    exit 2
}

# The application configuration is authoritative. Do not inherit stale or
# concatenated ANALYZER_FFMPEG/ANALYZER_FFPROBE values from the host account.
Remove-Item Env:ANALYZER_FFMPEG -ErrorAction SilentlyContinue
Remove-Item Env:ANALYZER_FFPROBE -ErrorAction SilentlyContinue
Get-Content -Encoding UTF8 -LiteralPath (Join-Path $projectRoot ".dev.vars") | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $name = $matches[1]
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, [EnvironmentVariableTarget]::Process)
    }
}
if ($BaseUrl) { $env:ANALYZER_BASE_URL = $BaseUrl.TrimEnd('/') }

try {
    . (Join-Path $PSScriptRoot "analyzer-media-runtime.ps1")
    $mediaRuntime = Import-AnalyzerMediaRuntime $projectRoot
    . (Join-Path $PSScriptRoot "analyzer-collector-runtime.ps1")
    $collectorRuntime = Import-AnalyzerCollectorRuntime $projectRoot -AllowUnavailable
}
catch {
    Write-AnalyzerStartError $_.Exception.Message
    exit 2
}

$required = @(
    "ANALYZER_SERVICE_TOKEN", "ANALYZER_BASE_URL", "ANALYZER_WORKER_ID"
)
$missing = @($required | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, [EnvironmentVariableTarget]::Process))
})
if ($missing.Count -gt 0) {
    Write-AnalyzerStartError "Video analyzer configuration is incomplete: $($missing -join ', ')"
    exit 2
}
# Cloud models can be saved in the Settings page. The worker retrieves the
# organization-scoped model configuration only after it claims a valid job.
$requestedBaseUrl = $env:ANALYZER_BASE_URL.TrimEnd('/')
$statusUrl = "$requestedBaseUrl/api/internal/analyzer/status?workerId=$([Uri]::EscapeDataString($env:ANALYZER_WORKER_ID))"
$statusHeaders = @{ Authorization = "Bearer $($env:ANALYZER_SERVICE_TOKEN)" }

function Test-AnalyzerHeartbeat([datetime]$NotBefore = [datetime]::MinValue) {
    try {
        $status = Invoke-RestMethod -Method Get -Uri $statusUrl -Headers $statusHeaders -TimeoutSec 2
        return [bool]$status.online -and $status.lastSeenAt -and
            [DateTimeOffset]::Parse([string]$status.lastSeenAt).UtcDateTime -ge $NotBefore
    }
    catch { return $false }
}

function Read-AnalyzerStartDetail {
    if (Test-Path -LiteralPath $errorPath) {
        return ((Get-Content -Tail 8 -LiteralPath $errorPath) -join " ").Trim()
    }
    $stderrPath = Join-Path $logDirectory "analyzer-error.log"
    if (Test-Path -LiteralPath $stderrPath) {
        return ((Get-Content -Tail 8 -LiteralPath $stderrPath) -join " ").Trim()
    }
    return "No analyzer heartbeat was received."
}

. (Join-Path $PSScriptRoot "analyzer-instance-lock.ps1")
$startupLock = Enter-AnalyzerInstanceLock $projectRoot "startup" 30000
if ($null -eq $startupLock) {
    Write-AnalyzerStartError "Another analyzer startup is still in progress. Please wait and try again."
    exit 1
}
try {
if (Test-Path -LiteralPath $pidPath) {
    $savedId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId)
    if ($savedId -gt 0) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedId" -ErrorAction SilentlyContinue
        $commandLine = if ($existing) { [string]$existing.CommandLine } else { "" }
        $isSupervisor = $existing -and $existing.Name -eq "powershell.exe" -and
            $commandLine.IndexOf($supervisor, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isLegacyWorker = $existing -and $existing.Name -eq "python.exe" -and
            $commandLine.IndexOf($python, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine -match '(?i)-m\s+liming_analyzer'
        if ($isSupervisor -or $isLegacyWorker) {
            $activeBaseUrl = if (Test-Path -LiteralPath $baseUrlPath) {
                (Get-Content -Raw -LiteralPath $baseUrlPath).Trim().TrimEnd('/')
            } else {
                ""
            }
            if ($activeBaseUrl -eq $requestedBaseUrl) {
                for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
                    if (Test-AnalyzerHeartbeat) { exit 0 }
                    Start-Sleep -Seconds 1
                }
                Write-AnalyzerStartError "The analyzer supervisor exists but no live worker heartbeat was received. $(Read-AnalyzerStartDetail)"
                exit 1
            }

            Write-Host "[Liming Zhiyao] The local app address changed. Restarting the video analyzer..."
            & taskkill.exe /PID $savedId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-AnalyzerStartError "The previous video analyzer could not be restarted safely. Run stop-local.bat, then start the app again."
                exit 1
            }
        }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $baseUrlPath -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
$launchStartedAt = (Get-Date).ToUniversalTime()
$process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "`"$supervisor`"",
    "-PythonPath", "`"$python`"",
    "-ProjectRoot", "`"$projectRoot`"",
    "-BaseUrl", "`"$requestedBaseUrl`""
) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Encoding ASCII -Value $process.Id
Set-Content -LiteralPath $baseUrlPath -Encoding ASCII -Value $requestedBaseUrl
for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
    Start-Sleep -Seconds 1
    $process.Refresh()
    if ($process.HasExited) { break }
    if (Test-AnalyzerHeartbeat $launchStartedAt) { exit 0 }
}
if ($process.HasExited) {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $baseUrlPath -Force -ErrorAction SilentlyContinue
    Write-AnalyzerStartError "Video analyzer could not start. $(Read-AnalyzerStartDetail)"
    exit 1
}

& taskkill.exe /PID $process.Id /T /F | Out-Null
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $baseUrlPath -Force -ErrorAction SilentlyContinue
Write-AnalyzerStartError "The video analyzer process started but did not report a live heartbeat within 15 seconds. $(Read-AnalyzerStartDetail)"
exit 1
}
finally { Exit-AnalyzerInstanceLock $startupLock }
