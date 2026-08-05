$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path "node_modules")) {
    Write-Host "[ERROR] Dependencies are missing. Run setup-local.bat first."
    exit 1
}
if (-not (Test-Path ".dev.vars")) {
    Copy-Item ".dev.vars.example" ".dev.vars"
}

try {
    $running = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
    if ($running.StatusCode -eq 200) {
        Write-Host "[ERROR] A local-only server is already using port 3000."
        Write-Host "Stop it with Ctrl+C, then run start-lan.bat again."
        exit 1
    }
} catch {}

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

Write-Host "[Liming Zhiyao] Checking database migrations..."
$env:CI = "1"
& npm.cmd run db:local:migrate
Remove-Item Env:CI -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:LAN_MODE = "1"
$env:LAN_ACCESS_ORIGIN = "http://${lanIp}:3000"
Write-Host ""
Write-Host "[Liming Zhiyao] LAN team mode is starting."
Write-Host "Host access:      http://127.0.0.1:3000"
Write-Host "Colleague access: $env:LAN_ACCESS_ORIGIN"
Write-Host "If Windows asks, allow Node.js on Private networks."
Write-Host "Keep this window open. Press Ctrl+C to stop the app."

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\open-lan.ps1", "-Url", $env:LAN_ACCESS_ORIGIN
)
& npm.cmd run dev
exit $LASTEXITCODE
