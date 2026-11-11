$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
. (Join-Path $PSScriptRoot 'analyzer-instance-lock.ps1')
. (Join-Path $PSScriptRoot 'local-web-identity.ps1')
$webLock = Enter-AnalyzerInstanceLock $projectRoot 'web'
if ($null -eq $webLock) { throw 'Another startup, setup or maintenance operation is in progress. Stop the local server before starting LAN mode.' }
try {

. (Join-Path $PSScriptRoot 'install-node22.ps1')
$node = Find-NodeRuntime -PathFile (Join-Path $projectRoot '.local\node.path')
if (-not $node) { throw 'No compatible Windows x64 Node.js and npm were found. Run setup-local.bat.' }
$nodeHome = Split-Path -Parent $node
$npmCli = Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
$env:LMZY_NODE_HOME = $nodeHome
$env:Path = $nodeHome + ';' + $env:Path

& "$PSScriptRoot\prepare-local-web.ps1" -CheckDependenciesOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$recordedPort = 3000
$portPath = Join-Path $projectRoot ".local\app.port"
if (Test-Path -LiteralPath $portPath) {
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$recordedPort)
    if ($recordedPort -lt 1 -or $recordedPort -gt 65535) { $recordedPort = 3000 }
}
if (Test-LocalWebHealth $projectRoot $recordedPort) {
    Write-Host "[ERROR] This installation is already using port $recordedPort."
    Write-Host "Stop it with Ctrl+C, then run start-lan.bat again."
    exit 1
}

$appPort = [int](& "$PSScriptRoot\select-local-port.ps1" -BindAll)
$hostUrl = "http://127.0.0.1:$appPort"

function Test-PrivateLanAddress([string]$Address) {
    if ($Address -match '^10\.') { return $true }
    if ($Address -match '^192\.168\.') { return $true }
    if ($Address -match '^172\.(\d+)\.') {
        $secondOctet = [int]$Matches[1]
        return $secondOctet -ge 16 -and $secondOctet -le 31
    }
    return $false
}

$configuration = Get-NetIPConfiguration | Where-Object {
    $privateAddress = $_.IPv4Address | Where-Object { Test-PrivateLanAddress $_.IPAddress }
    $_.IPv4DefaultGateway -and $privateAddress -and $_.NetAdapter.Status -eq "Up" -and
        $_.InterfaceDescription -notmatch 'Meta|Tunnel|Virtual|Hyper-V|WSL|Wintun'
} | Sort-Object @{ Expression = { if ($_.InterfaceAlias -match 'WLAN|Wi-Fi|Ethernet') { 0 } else { 1 } } } | Select-Object -First 1
$lanIp = ($configuration.IPv4Address | Where-Object { Test-PrivateLanAddress $_.IPAddress } | Select-Object -First 1).IPAddress
if (-not $lanIp) {
    Write-Host "[ERROR] No active LAN IPv4 address was found. Connect to the office Wi-Fi or network cable first."
    exit 1
}

$env:LAN_MODE = "1"
$env:LAN_ACCESS_ORIGIN = "http://${lanIp}:$appPort"
$env:ANALYZER_BASE_URL = $hostUrl
& "$PSScriptRoot\prepare-local-web.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""
Write-Host "[Liming Zhiyao] LAN team mode is starting."
Write-Host "Host access:      $hostUrl"
Write-Host "Colleague access: $env:LAN_ACCESS_ORIGIN"
if ($appPort -ne 3000) { Write-Host "[NOTICE] This installation uses port $appPort. Always use the address shown above." }
Write-Host "If Windows asks, allow Node.js on Private networks."
Write-Host "The browser and video analyzer will start automatically."
Write-Host "Keep this window open. Press Ctrl+C or run stop-local.bat to stop everything."

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\open-lan.ps1`"", "-Url", $env:LAN_ACCESS_ORIGIN, "-HealthUrl", $hostUrl
)
& $node $npmCli run dev -- --hostname 0.0.0.0 --port $appPort
exit $LASTEXITCODE
} finally { Exit-AnalyzerInstanceLock $webLock }
