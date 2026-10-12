param(
    [ValidateSet('standard', 'douyin')][string]$Kind,
    [string]$BatchId,
    [string]$ExpectedHash,
    [string]$ActorUserId,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'local-state-maintenance.ps1')
$maintenanceLocks = @(Enter-LocalStateMaintenance $projectRoot)
$partial = $null
try {
    Assert-LocalStateStopped $projectRoot
    $statePath = Join-Path $projectRoot '.wrangler\state'
    foreach ($target in @($projectRoot, (Join-Path $projectRoot '.wrangler'), $statePath)) {
        if (-not (Test-Path -LiteralPath $target -PathType Container) -or ((Get-Item -Force -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation/state paths are missing or filesystem links.' }
    }
    if ([bool]$Kind -ne [bool]$BatchId) { throw 'Provide both Kind and BatchId, or neither for preview.' }
    $nodeCandidates = @()
    $nodeRecord = Join-Path $projectRoot '.local/node.path'
    if (Test-Path -LiteralPath $nodeRecord) { $nodeCandidates += Join-Path ((Get-Content -Raw -LiteralPath $nodeRecord).Trim()) 'node.exe' }
    if ($env:ProgramFiles) { $nodeCandidates += Join-Path $env:ProgramFiles 'nodejs/node.exe' }
    if ($env:LOCALAPPDATA) { $nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe' }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
    $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $nodePath) { throw 'Node.js 22.13 or newer is required. Run setup-local.bat first.' }
    $tool = Join-Path $PSScriptRoot 'recover-performance-imports.mjs'
    $arguments = @('--no-warnings', $tool, $statePath, 'preview')
    if ($Kind) { $arguments += @($Kind, $BatchId) }
    if ($Apply) {
        if (-not $Kind -or $ExpectedHash -cnotmatch '^[a-f0-9]{64}$' -or -not $ActorUserId) { throw 'Apply requires Kind, BatchId, ExpectedHash from preview and ActorUserId.' }
        Assert-ExtractedStateDatabases $statePath
        $backupRoot = Join-Path $projectRoot 'backups'
        if ((Test-Path -LiteralPath $backupRoot) -and ((Get-Item -Force -LiteralPath $backupRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup directory cannot be a filesystem link.' }
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        $backup = Join-Path $backupRoot ('liming-zhiyao-import-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.zip')
        $partial = $backup + '.partial'
        Write-StateArchive $statePath $partial
        Assert-LocalStateStopped $projectRoot
        Move-Item -LiteralPath $partial -Destination $backup
        Write-Host "Recovery backup: $backup"
        $arguments = @('--no-warnings', $tool, $statePath, 'apply', $Kind, $BatchId, $ExpectedHash, $ActorUserId, $backup)
    }
    # Native stderr is diagnostic output, not an unhandled PowerShell exception.
    $ErrorActionPreference = 'Continue'
    & $nodePath @arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw 'Import recovery did not complete. Preserve the backup, review the error and preview again.' }
} finally {
    if ($partial -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
    Exit-LocalStateMaintenance $maintenanceLocks
}
