param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$PythonEnvironment,
    [Parameter(Mandatory = $true)][string]$BaseUrl
)
$ErrorActionPreference = "Stop"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$PythonEnvironment = (Resolve-Path -LiteralPath $PythonEnvironment).Path
$venv = Join-Path $InstallRoot "services\analyzer\.venv"
New-Item -ItemType Directory -Path (Join-Path $venv "Scripts") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PythonEnvironment "Scripts\python.exe") -Destination (Join-Path $venv "Scripts\python.exe")
Copy-Item -LiteralPath (Join-Path $PythonEnvironment "pyvenv.cfg") -Destination (Join-Path $venv "pyvenv.cfg")
# Reuse installed test dependencies. This link exists only in the verifier's
# disposable installation, never in the customer package or original venv.
New-Item -ItemType Junction -Path (Join-Path $venv "Lib") -Value (Join-Path $PythonEnvironment "Lib") | Out-Null
$launcher = Join-Path $InstallRoot "scripts\start-analyzer-background.ps1"
$supervisorScript = Join-Path $InstallRoot "scripts\run-analyzer-supervisor.ps1"
$pidFile = Join-Path $InstallRoot ".local\analyzer.pid"
$launchers = @()

function Find-OwnedSupervisor {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $saved = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $saved" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq "powershell.exe" -and ([string]$candidate.CommandLine).IndexOf($supervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $owned = Get-Process -Id $saved
        $null = $owned.Handle # Hold the process identity before any termination.
        return $owned
    }
    return $null
}
function Start-TestLauncher {
    return Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$launcher`"", "-BaseUrl", "`"$BaseUrl`"") -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
}

try {
    $launchers = @(Start-TestLauncher; Start-TestLauncher)
    foreach ($launched in $launchers) {
        if (-not $launched.WaitForExit(45000)) { throw "Concurrent analyzer startup did not finish" }
        if ($launched.ExitCode -ne 0) { throw "Concurrent analyzer startup failed; see isolated analyzer logs" }
    }
    $owned = Find-OwnedSupervisor
    if ($null -eq $owned) { throw "No live analyzer supervisor" }
    $count = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
        ([string]$_.CommandLine).IndexOf($supervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }).Count
    if ($count -ne 1) { throw "Duplicate supervisors survived concurrent startup" }
    $workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($owned.Id)" | Where-Object { $_.Name -eq "python.exe" } | ForEach-Object {
        $worker = Get-Process -Id $_.ProcessId
        $null = $worker.Handle
        $worker
    })
    if ($workers.Count -ne 1) { throw "Expected exactly one Python worker below supervisor" }
    $owned.Kill()
    if (-not $owned.WaitForExit(5000)) { throw "Test supervisor did not exit" }
    foreach ($worker in $workers) {
        if (-not $worker.WaitForExit(10000)) { throw "Worker survived supervisor termination" }
    }
    # Directly verify that the worker lock was released; a recent heartbeat
    # alone would be too weak to prove the replacement worker actually started.
    . (Join-Path $InstallRoot "scripts\analyzer-instance-lock.ps1")
    $probe = Enter-AnalyzerInstanceLock $InstallRoot "worker" 5000
    if ($null -eq $probe) { throw "Dead worker retained installation ownership" }
    Exit-AnalyzerInstanceLock $probe
    $restart = Start-TestLauncher
    $launchers += $restart
    if (-not $restart.WaitForExit(45000) -or $restart.ExitCode -ne 0) { throw "Analyzer restart failed" }
    Start-Sleep -Seconds 3
    $replacement = Find-OwnedSupervisor
    if ($null -eq $replacement -or $replacement.Id -eq $owned.Id) { throw "Replacement supervisor did not start" }
    $probe = Enter-AnalyzerInstanceLock $InstallRoot "worker"
    if ($null -ne $probe) { Exit-AnalyzerInstanceLock $probe; throw "Replacement worker did not acquire execution ownership" }
    $replacement.Kill()
    $null = $replacement.WaitForExit(5000)
    $probe = Enter-AnalyzerInstanceLock $InstallRoot "worker" 5000
    if ($null -eq $probe) { throw "Replacement worker did not stop" }
    Exit-AnalyzerInstanceLock $probe
    # A stale online row from the previous worker must not make an invalid new
    # process appear ready. All configuration below is synthetic verifier data.
    $varsFile = Join-Path $InstallRoot ".dev.vars"
    $originalVars = [IO.File]::ReadAllText($varsFile)
    try {
        $invalidVars = $originalVars + [Environment]::NewLine + "ANALYZER_TIMEOUT_TASK_SECONDS=invalid" + [Environment]::NewLine
        [IO.File]::WriteAllText($varsFile, $invalidVars, (New-Object Text.UTF8Encoding($false)))
        $invalid = Start-TestLauncher
        $launchers += $invalid
        if (-not $invalid.WaitForExit(45000)) { throw "Invalid worker readiness check timed out" }
        if ($invalid.ExitCode -eq 0) { throw "Stale heartbeat incorrectly marked a failed new worker ready" }
    } finally {
        [IO.File]::WriteAllText($varsFile, $originalVars, (New-Object Text.UTF8Encoding($false)))
    }
    Write-Host "[PASS] Empty-queue analyzer startup, concurrent launch, supervisor crash and restart"
}
finally {
    foreach ($launched in $launchers) {
        if (-not $launched.HasExited) { $launched.Kill() }
    }
    $owned = Find-OwnedSupervisor
    if ($owned -and -not $owned.HasExited) { $owned.Kill(); $null = $owned.WaitForExit(5000) }
}
