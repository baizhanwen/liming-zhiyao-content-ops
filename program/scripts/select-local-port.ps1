param([switch]$BindAll)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDirectory = Join-Path $projectRoot ".local"
$portPath = Join-Path $localDirectory "app.port"

function Test-AppHealth([int]$Port) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:${Port}/api/health" -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch { return $false }
}

function Test-PortBindable([int]$Port) {
    $address = if ($BindAll) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new($address, $Port)
        $listener.Start()
        return $true
    }
    catch { return $false }
    finally { if ($listener) { $listener.Stop() } }
}

$recordedPort = 0
if (Test-Path -LiteralPath $portPath) {
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$recordedPort)
}

$candidates = @($recordedPort, 3000, 3100, 3200, 5173) | Where-Object { $_ -gt 0 } | Select-Object -Unique
foreach ($candidate in $candidates) {
    if ((Test-AppHealth $candidate) -or (Test-PortBindable $candidate)) {
        New-Item -ItemType Directory -Force -Path $localDirectory | Out-Null
        Set-Content -LiteralPath $portPath -Encoding ASCII -Value $candidate
        Write-Output $candidate
        exit 0
    }
}

throw "No usable local application port was found. Tried: $($candidates -join ', ')."
