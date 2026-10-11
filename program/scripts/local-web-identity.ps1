param([switch]$CheckHealth, [int]$HealthPort = 0)
$ErrorActionPreference = 'Stop'
# Shared installation identity check. A 200 health response alone does not identify a database.
function Test-LocalWebListener([string]$ProjectRoot, [ValidateRange(1, 65535)][int]$Port, $Listeners = $null) {
    if ($null -eq $Listeners) { $Listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) }
    $portListeners = @($Listeners | Where-Object LocalPort -eq $Port)
    if ($portListeners.Count -eq 0) { return $false }
    $expectedModules = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'node_modules')).TrimEnd('\') + '\'
    foreach ($listener in $portListeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
        $command = [string]$process.CommandLine
        if ($null -eq $process -or $process.Name -ne 'node.exe' -or
            $command.IndexOf($expectedModules, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $command -notmatch '(?i)vinext.+\bdev\b') { return $false }
    }
    return $true
}

function Test-LocalWebHealth([string]$ProjectRoot, [ValidateRange(1, 65535)][int]$Port) {
    # Inspection failures propagate; they must not be interpreted as an owned app.
    if (-not (Test-LocalWebListener $ProjectRoot $Port)) { return $false }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:${Port}/api/health" -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

if ($CheckHealth) {
    if (Test-LocalWebHealth (Split-Path -Parent $PSScriptRoot) $HealthPort) { exit 0 }
    exit 1
}
