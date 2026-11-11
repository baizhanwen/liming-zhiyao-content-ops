param([string]$BaseUrl = '')
$ErrorActionPreference = 'Stop'
# Both BAT and the settings page manage run-analyzer-supervisor.ps1 through
# the same installation identity and process-creation-time checks.
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'analyzer-windows-control.ps1'), '-Action', 'start')
if ($BaseUrl) { $arguments += @('-BaseUrl', $BaseUrl) }
& powershell.exe @arguments
exit $LASTEXITCODE
