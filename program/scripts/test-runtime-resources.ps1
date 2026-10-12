param([Parameter(Mandatory=$true)][int]$RootProcessId, [Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
$rootProcess = Get-Process -Id $RootProcessId
$entries = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
$owned = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$owned.Add($RootProcessId)
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($entry in $entries) {
        if ($owned.Contains([int]$entry.ParentProcessId) -and $owned.Add([int]$entry.ProcessId)) { $changed = $true }
    }
}
$samples = @()
$samplerIds = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$samplerIds.Add($PID)
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($entry in $entries) {
        if ($samplerIds.Contains([int]$entry.ParentProcessId) -and $samplerIds.Add([int]$entry.ProcessId)) { $changed = $true }
    }
}
foreach ($processId in $owned) {
    if ($samplerIds.Contains($processId)) { continue }
    try {
        $ownedProcess = Get-Process -Id $processId -ErrorAction Stop
        $samples += [ordered]@{
            pid=$processId; name=$ownedProcess.ProcessName
            workingSetMiB=[Math]::Round($ownedProcess.WorkingSet64/1MB,2)
            peakWorkingSetMiB=[Math]::Round($ownedProcess.PeakWorkingSet64/1MB,2)
            processorSeconds=[Math]::Round($ownedProcess.TotalProcessorTime.TotalSeconds,3)
        }
    } catch { }
}
$report = [ordered]@{
    synthetic=$true; sampledAt=(Get-Date).ToString('o'); rootPid=$RootProcessId
    rootStartedAt=$rootProcess.StartTime.ToUniversalTime().ToString('o')
    processes=$samples
    boundary='Owned test Node and descendant processes only; sampler excluded. Peak and CPU are cumulative since process start, including initialization and preceding synthetic scenarios. Working sets share pages and must not be added as unique physical memory; not a real production-load measurement.'
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputFile -Encoding UTF8
