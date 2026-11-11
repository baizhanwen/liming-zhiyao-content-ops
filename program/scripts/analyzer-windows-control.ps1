param([ValidateSet('status', 'start', 'stop')][string]$Action = 'status', [string]$BaseUrl = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'analyzer-instance-lock.ps1')
. (Join-Path $PSScriptRoot 'analyzer-windows-identity.ps1')

function Read-AnalyzerControlConfiguration([string]$ProjectRoot) {
    $values = @{}
    $varsPath = Join-Path $ProjectRoot '.dev.vars'
    if (Test-Path -LiteralPath $varsPath) {
        Get-Content -Encoding UTF8 -LiteralPath $varsPath | ForEach-Object {
            if ($_ -match '^\s*(ANALYZER_[A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
                $name = $matches[1]; $value = $matches[2]
                if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
                $values[$name] = $value
            }
        }
    }
    return $values
}

function Resolve-AnalyzerControlUrl([string]$ProjectRoot, [string]$RequestedUrl, $Configuration) {
    if (-not $RequestedUrl) {
        $portPath = Join-Path $ProjectRoot '.local\app.port'
        $port = 0
        if ((Test-Path -LiteralPath $portPath) -and [int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$port) -and $port -ge 1 -and $port -le 65535) { $RequestedUrl = "http://127.0.0.1:$port" }
        elseif ($Configuration['ANALYZER_BASE_URL']) { $RequestedUrl = $Configuration['ANALYZER_BASE_URL'] }
    }
    $url = $null
    if (-not [uri]::TryCreate($RequestedUrl, [UriKind]::Absolute, [ref]$url) -or $url.Scheme -notin @('http', 'https') -or $url.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1') -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/') { throw 'The analyzer needs this installation''s actual local web address.' }
    return $RequestedUrl.TrimEnd('/')
}

function Test-AnalyzerControlHeartbeat([string]$Url, $Configuration, [datetime]$NotBefore = [datetime]::MinValue) {
    if (-not $Configuration['ANALYZER_SERVICE_TOKEN'] -or -not $Configuration['ANALYZER_WORKER_ID']) { return $false }
    try {
        $status = Invoke-RestMethod -Method Get -Uri "$Url/api/internal/analyzer/status?workerId=$([Uri]::EscapeDataString($Configuration['ANALYZER_WORKER_ID']))" -Headers @{ Authorization = "Bearer $($Configuration['ANALYZER_SERVICE_TOKEN'])" } -TimeoutSec 2
        return [bool]$status.online -and $status.lastSeenAt -and [DateTimeOffset]::Parse([string]$status.lastSeenAt).UtcDateTime -ge $NotBefore
    } catch { return $false }
}

function Get-AnalyzerControlStatus([string]$ProjectRoot, [string]$Url, $Configuration) {
    $owners = @(Get-AnalyzerOwners $ProjectRoot)
    try {
        if ($owners.Count -eq 0) {
            # A status read must not temporarily take the worker mutex while a
            # startup is launching its owner. Serialize only the orphan check.
            $identityProbe = Enter-AnalyzerInstanceLock $ProjectRoot 'startup'
            if ($null -eq $identityProbe) { return @{ workerRunning = $false; processRunning = $true; restartRequired = $false; pid = $null; message = '本项目分析服务正在启动或停止，等待身份记录和心跳。' } }
            try {
                foreach ($purpose in @('supervisor', 'worker')) {
                    $probe = Enter-AnalyzerInstanceLock $ProjectRoot $purpose
                    if ($null -eq $probe) { return @{ workerRunning = $false; processRunning = $true; restartRequired = $true; pid = $null; message = '本项目已有分析实例，但缺少可验证的进程身份记录；未再启动第二个服务。请先退出旧版工作台后重新启动。' } }
                    Exit-AnalyzerInstanceLock $probe
                }
            } finally { Exit-AnalyzerInstanceLock $identityProbe }
            return @{ workerRunning = $false; processRunning = $false; restartRequired = $false; pid = $null; message = '本项目分析服务未运行。' }
        }
        $owner = $owners[0]
        $boundUrl = [string]$owner.record.baseUrl
        $urlPath = Join-Path $ProjectRoot '.local\analyzer.base-url'
        if (-not $boundUrl -and (Test-Path -LiteralPath $urlPath)) { $boundUrl = (Get-Content -Raw -LiteralPath $urlPath).Trim().TrimEnd('/') }
        if (-not $boundUrl) { $boundUrl = $Url }
        $boundUrl = Resolve-AnalyzerControlUrl $ProjectRoot $boundUrl $Configuration
        $changed = -not $owner.record.sourceSignature -or $owner.record.sourceSignature -ne (Get-AnalyzerSourceSignature $ProjectRoot)
        $differentUrl = $boundUrl -ne $Url
        $online = Test-AnalyzerControlHeartbeat $boundUrl $Configuration
        $message = if ($differentUrl) { '分析服务仍连接升级前或另一端口的本项目页面；请等待当前任务结束，停止服务后重新启动。' }
            elseif ($changed) { '检测到运行中的旧版分析服务或源码已更新；请等待当前任务结束，停止服务后重新启动以加载新版。' }
            elseif ($online) { '本项目分析服务运行中，已收到真实心跳。' }
            else { '本项目分析进程仍在运行，但尚未收到有效心跳；请检查服务连接和运行日志。' }
        return @{ workerRunning = [bool]($online -and -not $differentUrl); processRunning = $true; restartRequired = [bool]($changed -or $differentUrl); pid = $owner.pid; message = $message }
    } finally { foreach ($owner in $owners) { $owner.native.Dispose() } }
}

function Invoke-AnalyzerWindowsControl([string]$RequestedAction, [string]$RequestedUrl = '') {
    $script:controlPhase = 'read_configuration'
    $configuration = Read-AnalyzerControlConfiguration $projectRoot
    $script:controlPhase = 'resolve_url'
    $url = Resolve-AnalyzerControlUrl $projectRoot $RequestedUrl $configuration
    if ($RequestedAction -eq 'status') { return @{ code = 0; result = (Get-AnalyzerControlStatus $projectRoot $url $configuration) } }
    $script:controlPhase = 'startup_lock'
    $startupLock = Enter-AnalyzerInstanceLock $projectRoot 'startup' 30000
    if ($null -eq $startupLock) { return @{ code = 1; result = @{ workerRunning = $false; processRunning = $false; message = '另一个分析服务启停操作仍在执行，请等待完成。' } } }
    try {
        if ($RequestedAction -eq 'stop') {
            $owners = @(Get-AnalyzerOwners $projectRoot)
            try { foreach ($owner in $owners) { $owner.native.Stop() } }
            finally { foreach ($owner in $owners) { $owner.native.Dispose() } }
            # A real worker watches its supervisor handle and closes its Job
            # Object on supervisor exit, including native processing children.
            foreach ($purpose in @('supervisor', 'worker')) {
                $ownerLock = Enter-AnalyzerInstanceLock $projectRoot $purpose 10000
                if ($null -eq $ownerLock) { return @{ code = 1; result = @{ workerRunning = $false; processRunning = $true; message = '本项目分析进程仍在退出或缺少可验证的身份，未删除记录或终止其他进程；请稍后重新检查。' } } }
                Exit-AnalyzerInstanceLock $ownerLock
            }
            Remove-AnalyzerOwnerRecords $projectRoot
            return @{ code = 0; result = @{ workerRunning = $false; processRunning = $false; restartRequired = $false; message = '本项目分析服务已停止。' } }
        }
        $script:controlPhase = 'check_existing'
        $current = Get-AnalyzerControlStatus $projectRoot $url $configuration
        if ($current.processRunning) {
            if (-not $current.workerRunning -and -not $current.restartRequired) {
                for ($attempt = 0; $attempt -lt 5 -and -not $current.workerRunning; $attempt += 1) { Start-Sleep -Seconds 1; $current = Get-AnalyzerControlStatus $projectRoot $url $configuration }
            }
            $current.alreadyRunning = $true
            return @{ code = $(if ($current.workerRunning -or $current.restartRequired) { 0 } else { 1 }); result = $current }
        }
        $python = Join-Path $projectRoot 'services\analyzer\.venv\Scripts\python.exe'
        $supervisor = Join-Path $PSScriptRoot 'run-analyzer-supervisor.ps1'
        if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $supervisor)) { throw 'The analyzer runtime is not installed; prepare the current project environment first.' }
        foreach ($name in @('ANALYZER_SERVICE_TOKEN', 'ANALYZER_WORKER_ID')) { if (-not $configuration[$name]) { throw "The local analyzer configuration is incomplete: $name" } }
        Remove-AnalyzerOwnerRecords $projectRoot
        New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot '.local\logs') | Out-Null
        $launchStartedAt = (Get-Date).ToUniversalTime()
        $script:controlPhase = 'source_signature'
        $signature = Get-AnalyzerSourceSignature $projectRoot
        $script:controlPhase = 'launch_supervisor'
        $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"", '-PythonPath', "`"$python`"", '-ProjectRoot', "`"$projectRoot`"", '-BaseUrl', "`"$url`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
        $script:controlPhase = 'verify_owner'
        $owner = $null
        for ($identityAttempt = 0; $identityAttempt -lt 10 -and $null -eq $owner; $identityAttempt += 1) {
            $owner = Get-AnalyzerOwnedProcess $projectRoot ([pscustomobject]@{ pid = $process.Id; creationTime = ''; project = $projectRoot })
            if ($null -eq $owner) { Start-Sleep -Milliseconds 100 }
        }
        if ($null -eq $owner) { throw 'The newly launched analyzer supervisor could not be verified; inspect the startup log.' }
        $script:controlPhase = 'persist_owner'
        try { Write-AnalyzerOwnerRecord $projectRoot $owner $url $signature }
        finally { $owner.native.Dispose() }
        $script:controlPhase = 'await_heartbeat'
        for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
            Start-Sleep -Seconds 1
            $process.Refresh()
            if ($process.HasExited) { break }
            if (Test-AnalyzerControlHeartbeat $url $configuration $launchStartedAt) {
                $state = Get-AnalyzerControlStatus $projectRoot $url $configuration
                $state.started = $true
                return @{ code = 0; result = $state }
            }
        }
        $state = Get-AnalyzerControlStatus $projectRoot $url $configuration
        $state.started = $false
        $state.message = if ($process.HasExited) { '分析服务启动进程已退出，尚未取得有效心跳。请查看启动和运行日志；退出不等于模型配置错误。' } else { '分析服务仍在启动或重试连接，尚未取得有效心跳。没有另启第二个服务，请稍后重新检查。' }
        return @{ code = 1; result = $state }
    } finally { Exit-AnalyzerInstanceLock $startupLock }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $answer = Invoke-AnalyzerWindowsControl $Action $BaseUrl
        $answer.result | ConvertTo-Json -Depth 8 -Compress
        exit $answer.code
    } catch {
        $codeFile = [IO.Path]::GetFileName([string]$_.InvocationInfo.ScriptName)
        $diagnostic = @{ phase = [string]$script:controlPhase; type = $_.Exception.GetType().FullName; file = $(if ($codeFile -in @('analyzer-windows-control.ps1', 'analyzer-windows-identity.ps1', 'analyzer-instance-lock.ps1')) { $codeFile } else { '<external>' }); line = $_.InvocationInfo.ScriptLineNumber; hresult = $_.Exception.HResult }
        # Only bounded code locations and exception types cross this boundary.
        # Exception messages, source lines, paths and configuration stay private.
        [Console]::Error.WriteLine(('Analyzer control failure: ' + ($diagnostic | ConvertTo-Json -Compress)))
        $detail = [string]$_.Exception.Message
        $safeMessage = if ($detail -match '^(The analyzer |The local analyzer |The newly launched analyzer |The verified analyzer |Analyzer source )') { $detail } else { '本项目分析服务控制未完成，请查看环境管理日志并检查安装和服务配置。' }
        @{ workerRunning = $false; processRunning = $false; message = $safeMessage } | ConvertTo-Json -Compress
        exit 1
    }
}
