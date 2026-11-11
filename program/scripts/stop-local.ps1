param([switch]$CheckOnly)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$portPath = Join-Path $projectRoot ".local\app.port"
$appPort = 3000
if (Test-Path -LiteralPath $portPath) {
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$appPort)
    if ($appPort -le 0) { $appPort = 3000 }
}

function Get-ListenerProcessIds {
    try {
        return @(
            Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
    }
    catch {
        $netstatLines = netstat -ano | Select-String -Pattern "^\s*TCP\s+\S+:$appPort\s+\S+\s+LISTENING\s+(\d+)\s*$"
        return @($netstatLines | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } | Select-Object -Unique)
    }
}

function Get-ProcessRecord([int]$processId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
}

function Stop-AnalyzerProcess {
    # run-analyzer-supervisor.ps1 and legacy workers are inspected by the same
    # native-handle controller used in Settings; no analyzer PID is killed here.
    $controller = Join-Path $PSScriptRoot 'analyzer-windows-control.ps1'
    if (-not (Test-Path -LiteralPath $controller)) { return } # Plans without video analysis.
    $action = if ($CheckOnly) { 'status' } else { 'stop' }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controller -Action $action
    if ($LASTEXITCODE -ne 0) { throw 'The verified local analyzer could not be stopped. Review its environment status.' }
}

$listenerIds = @(Get-ListenerProcessIds)
if ($listenerIds.Count -eq 0) {
    Stop-AnalyzerProcess
    Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
    Write-Host "[Liming Zhiyao] The local web app is already stopped."
    exit 0
}

foreach ($listenerId in $listenerIds) {
    $listener = Get-ProcessRecord $listenerId
    $commandLine = [string]$listener.CommandLine
    $expectedModules = Join-Path $projectRoot "node_modules"
    if ($listener.Name -ne "node.exe" -or
        $commandLine.IndexOf($expectedModules, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $commandLine -notmatch '(?i)vinext.+dev') {
        Write-Error "Port $appPort belongs to another program. It was not stopped."
    }

    $targetId = [int]$listener.ProcessId
    $current = $listener
    for ($depth = 0; $depth -lt 8 -and $current.ParentProcessId; $depth += 1) {
        try { $parent = Get-ProcessRecord ([int]$current.ParentProcessId) }
        catch { break }
        $parentCommand = [string]$parent.CommandLine
        if ($parentCommand -match '(?i)start-(local|lan)\.bat') {
            $targetId = [int]$parent.ProcessId
            break
        }
        if ($parentCommand -match '(?i)npm-cli\.js.+run dev') {
            $targetId = [int]$parent.ProcessId
        }
        $current = $parent
    }

    if ($CheckOnly) {
        Write-Host "[Liming Zhiyao] Verified the local web app process on port $appPort."
        continue
    }

    Write-Host "[Liming Zhiyao] Stopping the local web app on port $appPort..."
    & taskkill.exe /PID $targetId /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "taskkill failed with exit code $LASTEXITCODE" }
}

Stop-AnalyzerProcess
if ($CheckOnly) { exit 0 }

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if (@(Get-ListenerProcessIds).Count -eq 0) {
        Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
        Write-Host "[Liming Zhiyao] The local web app has stopped and port $appPort is free."
        exit 0
    }
}

throw "Port $appPort is still occupied after stopping the verified project process."
