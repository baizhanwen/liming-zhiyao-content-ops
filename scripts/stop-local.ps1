param([switch]$CheckOnly)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-ListenerProcessIds {
    try {
        return @(
            Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
    }
    catch {
        $netstatLines = netstat -ano | Select-String -Pattern '^\s*TCP\s+\S+:3000\s+\S+\s+LISTENING\s+(\d+)\s*$'
        return @($netstatLines | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } | Select-Object -Unique)
    }
}

function Get-ProcessRecord([int]$processId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
}

function Stop-AnalyzerProcess {
    $pidPath = Join-Path $projectRoot ".local\analyzer.pid"
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    $savedId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId)
    if ($savedId -le 0) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return
    }
    try { $analyzer = Get-ProcessRecord $savedId }
    catch {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return
    }
    $expectedPython = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
    $commandLine = [string]$analyzer.CommandLine
    if ($analyzer.Name -ne "python.exe" -or
        $commandLine.IndexOf($expectedPython, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $commandLine -notmatch '(?i)-m\s+liming_analyzer') {
        Write-Error "The saved analyzer PID belongs to another program. It was not stopped."
    }
    if ($CheckOnly) {
        Write-Host "[Liming Zhiyao] Verified the background video analyzer process."
        return
    }
    Write-Host "[Liming Zhiyao] Stopping the background video analyzer..."
    & taskkill.exe /PID $savedId /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "taskkill failed for the video analyzer with exit code $LASTEXITCODE" }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

$listenerIds = @(Get-ListenerProcessIds)
if ($listenerIds.Count -eq 0) {
    Stop-AnalyzerProcess
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
        Write-Error "Port 3000 belongs to another program. It was not stopped."
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
        Write-Host "[Liming Zhiyao] Verified the local web app process on port 3000."
        continue
    }

    Write-Host "[Liming Zhiyao] Stopping the local web app on port 3000..."
    & taskkill.exe /PID $targetId /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "taskkill failed with exit code $LASTEXITCODE" }
}

Stop-AnalyzerProcess
if ($CheckOnly) { exit 0 }

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if (@(Get-ListenerProcessIds).Count -eq 0) {
        Write-Host "[Liming Zhiyao] The local web app has stopped and port 3000 is free."
        exit 0
    }
}

throw "Port 3000 is still occupied after stopping the verified project process."
