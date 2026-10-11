function Enter-AnalyzerInstanceLock([string]$ProjectRoot, [string]$Purpose, [int]$WaitMilliseconds = 0) {
    $canonical = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/').ToUpperInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Global\LimingZhiyao-$Purpose-$hash")
    try {
        try { $acquired = $mutex.WaitOne($WaitMilliseconds) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { $mutex.Dispose(); return $null }
        return $mutex
    }
    catch { $mutex.Dispose(); throw }
}

function Exit-AnalyzerInstanceLock($Mutex) {
    if ($null -ne $Mutex) {
        try { $Mutex.ReleaseMutex() }
        finally { $Mutex.Dispose() }
    }
}
