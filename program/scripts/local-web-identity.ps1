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
        if ($response.StatusCode -ne 200) { return $false }
    } catch { return $false }
    $identityScript = Join-Path $ProjectRoot 'scripts\local-runtime-identity.mjs'
    if (-not (Test-Path -LiteralPath $identityScript)) { throw 'Runtime version checker is missing. Reinstall the complete update.' }
    $expected = (& node $identityScript --source-id $ProjectRoot).Trim()
    if ($LASTEXITCODE -ne 0 -or $expected -notmatch '^[a-f0-9]{64}$') { throw 'Cannot verify the running app version.' }
    try { $health = $response.Content | ConvertFrom-Json } catch { return $false }
    if ($health.localRuntimeSourceId -ne $expected) { throw 'This installation is still running an older version. Wait for tasks to finish, run stop-local.bat, then start-local.bat again.' }
    return $true
}

if ($CheckHealth) {
    if (Test-LocalWebHealth (Split-Path -Parent $PSScriptRoot) $HealthPort) { exit 0 }
    exit 1
}
