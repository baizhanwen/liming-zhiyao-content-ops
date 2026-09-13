param(
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$BaseUrl
)

$ErrorActionPreference = "Continue"
$PSDefaultParameterValues["Out-File:Encoding"] = "utf8"
$localDirectory = Join-Path $ProjectRoot ".local"
$logDirectory = Join-Path $localDirectory "logs"
$statusPath = Join-Path $localDirectory "analyzer-start-error.txt"
$stdoutPath = Join-Path $logDirectory "analyzer.log"
$stderrPath = Join-Path $logDirectory "analyzer-error.log"
$supervisorLogPath = Join-Path $logDirectory "analyzer-supervisor.log"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location -LiteralPath $ProjectRoot

function Import-AnalyzerEnvironment {
    $varsPath = Join-Path $ProjectRoot ".dev.vars"
    if (-not (Test-Path -LiteralPath $varsPath)) {
        throw "Local configuration is missing. Run setup-local.bat first."
    }
    Remove-Item Env:ANALYZER_FFMPEG -ErrorAction SilentlyContinue
    Remove-Item Env:ANALYZER_FFPROBE -ErrorAction SilentlyContinue
    Get-Content -Encoding UTF8 -LiteralPath $varsPath | ForEach-Object {
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
    $env:ANALYZER_BASE_URL = $BaseUrl.TrimEnd('/')
    $env:PYTHONUNBUFFERED = "1"
    . (Join-Path $PSScriptRoot "analyzer-media-runtime.ps1")
    $null = Import-AnalyzerMediaRuntime $ProjectRoot
    . (Join-Path $PSScriptRoot "analyzer-source-runtime.ps1")
    return Set-AnalyzerSourceRuntime $ProjectRoot
}

$restartCount = 0
while ($true) {
    try {
        $sourceDirectory = Import-AnalyzerEnvironment
        Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
        Add-Content -LiteralPath $supervisorLogPath -Encoding UTF8 -Value "$(Get-Date -Format o) starting analyzer worker from $sourceDirectory"
        & $PythonPath -m liming_analyzer --idle-seconds 4 1>> $stdoutPath 2>> $stderrPath
        $exitCode = $LASTEXITCODE
    }
    catch {
        $exitCode = 20
        Add-Content -LiteralPath $stderrPath -Encoding UTF8 -Value $_.Exception.Message
    }

    if ($exitCode -eq 0) { exit 0 }
    $restartCount += 1
    $detail = if (Test-Path -LiteralPath $stderrPath) {
        ((Get-Content -Tail 6 -LiteralPath $stderrPath) -join " ").Trim()
    } else {
        "No error log was written."
    }
    $message = "Video analyzer exited with code $exitCode and will retry automatically. $detail"
    Set-Content -LiteralPath $statusPath -Encoding UTF8 -Value $message
    Add-Content -LiteralPath $supervisorLogPath -Encoding UTF8 -Value "$(Get-Date -Format o) $message"

    # Configuration/authentication failures need a slower retry so customers
    # can correct .dev.vars without producing a tight restart loop. Transient
    # crashes restart quickly and progressively back off up to 30 seconds.
    $delay = if ($exitCode -in 20, 21) { 15 } else { [Math]::Min(30, 2 + ($restartCount * 2)) }
    Start-Sleep -Seconds $delay
}
