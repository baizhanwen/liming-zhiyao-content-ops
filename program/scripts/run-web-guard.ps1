param([ValidateSet('start-local', 'setup-local')][string]$Entry = 'start-local')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'analyzer-instance-lock.ps1')
$webLock = Enter-AnalyzerInstanceLock $projectRoot 'web'
if ($null -eq $webLock) {
    # Opening an already running app must not revoke coworkers' sessions.
    if ($Entry -eq 'start-local') {
        $maintenanceProbe = Enter-AnalyzerInstanceLock $projectRoot 'maintenance'
        if ($null -ne $maintenanceProbe) {
            try {
                $port = 0
                $portPath = Join-Path $projectRoot '.local\app.port'
                if ((Test-Path -LiteralPath $portPath) -and [int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$port) -and $port -ge 1 -and $port -le 65535) {
                    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
                    $expectedModules = Join-Path $projectRoot 'node_modules'
                    foreach ($listener in $listeners) {
                        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
                        if ($process.Name -eq 'node.exe' -and ([string]$process.CommandLine).IndexOf($expectedModules, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $process.CommandLine -match '(?i)vinext.+dev') {
                            $url = "http://127.0.0.1:$port"
                            $health = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2
                            if ($health.StatusCode -eq 200) {
                                Write-Host "[Liming Zhiyao] The app is already running at $url"
                                Start-Process -FilePath $url
                                exit 0
                            }
                        }
                    }
                }
            } finally { Exit-AnalyzerInstanceLock $maintenanceProbe }
        }
    }
    throw 'Another startup, setup or maintenance operation is in progress. Wait for it to finish; use stop-local.bat before setup or restore.'
}
try {
    Set-Location -LiteralPath $projectRoot
    & (Join-Path $projectRoot "$Entry.bat") --guarded
    exit $LASTEXITCODE
} finally { Exit-AnalyzerInstanceLock $webLock }
