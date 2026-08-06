$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "The analyzer is not installed. Run setup-analyzer.bat first."
}

$browser = "edge"
Get-Content -Encoding UTF8 -LiteralPath ".dev.vars" | ForEach-Object {
    if ($_ -match '^\s*ANALYZER_YTDLP_COOKIES_FROM_BROWSER\s*=\s*(.*)\s*$') {
        $configured = $matches[1].Trim().Trim('"').Trim("'")
        if ($configured) { $browser = $configured }
    }
}

$browserName = ($browser -split ':', 2)[0].ToLowerInvariant()
$processName = switch ($browserName) {
    "edge" { "msedge" }
    "chrome" { "chrome" }
    "chromium" { "chromium" }
    "firefox" { "firefox" }
    "brave" { "brave" }
    default { $browserName }
}

if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "[ACTION] Save your browser work, then close every $browserName window."
    Write-Host "This is needed only while refreshing the cookie snapshot."
    Write-Host "The project page will reopen automatically after the refresh."
    Read-Host "Press Enter after the browser is fully closed"
}
if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
    throw "$browserName is still running in the background. End it in Task Manager, then run this file again."
}

& $python -m liming_analyzer.cookie_snapshot --browser $browser --output ".local\douyin-cookies.txt"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[OK] Cookie snapshot refreshed. Edge may stay open while videos are analyzed."
Write-Host "[NEXT] Press Ctrl+C in the old analyzer window, then run start-analyzer.bat once."
try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
        Start-Process "http://127.0.0.1:3000/analysis"
    }
} catch {}
