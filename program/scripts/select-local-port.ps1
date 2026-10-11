param([switch]$BindAll)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDirectory = Join-Path $projectRoot ".local"
$portPath = Join-Path $localDirectory "app.port"
. (Join-Path $PSScriptRoot 'local-web-identity.ps1')

function Test-PortBindable([int]$Port) {
    $address = if ($BindAll) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new($address, $Port)
        $listener.ExclusiveAddressUse = $true
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

$candidates = @($recordedPort, 3000, 3100, 3200, 5173) | Where-Object { $_ -ge 1 -and $_ -le 65535 } | Select-Object -Unique
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
# Reuse the current installation before looking for a free port. An unhealthy
# owned listener must be stopped, rather than starting a second database writer.
foreach ($candidate in $candidates) {
    if (Test-LocalWebListener $projectRoot $candidate $listeners) {
        if (-not (Test-LocalWebHealth $projectRoot $candidate)) { throw "This installation is already listening on port $candidate but is unhealthy. Run stop-local.bat before restarting." }
        New-Item -ItemType Directory -Force -Path $localDirectory | Out-Null
        Set-Content -LiteralPath $portPath -Encoding ASCII -Value $candidate
        Write-Output $candidate
        exit 0
    }
}
foreach ($candidate in $candidates) {
    if (Test-PortBindable $candidate) {
        New-Item -ItemType Directory -Force -Path $localDirectory | Out-Null
        Set-Content -LiteralPath $portPath -Encoding ASCII -Value $candidate
        Write-Output $candidate
        exit 0
    }
}

throw "No usable local application port was found. Tried: $($candidates -join ', ')."
