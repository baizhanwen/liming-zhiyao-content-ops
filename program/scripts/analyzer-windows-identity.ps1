# Shared ownership checks for both the BAT launcher and the settings-page bridge.
# A process handle pins the inspected instance; a reused PID is never terminated.
function Initialize-AnalyzerProcessApi {
    if ('LimingAnalyzer.OwnedProcess' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace LimingAnalyzer {
    public sealed class OwnedProcess : IDisposable {
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        IntPtr handle;
        public string CreationTime { get; private set; }
        public string ImagePath { get; private set; }
        public bool Running { get { return handle != IntPtr.Zero && WaitForSingleObject(handle, 0) == 258; } }
        public OwnedProcess(int pid) {
            handle = OpenProcess(0x1000 | 0x100000 | 0x0001, false, pid);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                CreationTime = created.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var path = new StringBuilder(32768); int length = path.Capacity;
                if (!QueryFullProcessImageName(handle, 0, path, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                ImagePath = path.ToString();
            } catch { Dispose(); throw; }
        }
        public void Stop() {
            if (Running && !TerminateProcess(handle, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(handle, 10000) != 0) throw new InvalidOperationException("The verified analyzer process did not stop.");
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
}
'@
}

function Get-AnalyzerSourceSignature([string]$ProjectRoot) {
    $source = Join-Path $ProjectRoot 'services\analyzer\liming_analyzer'
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $lines = @(Get-ChildItem -LiteralPath $source -Filter '*.py' -File -Recurse | Sort-Object FullName | ForEach-Object {
            $relative = $_.FullName.Substring($source.Length).Replace('\', '/')
            $digest = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            "$relative=$digest"
        })
        if ($lines.Count -eq 0) { throw 'Analyzer source is missing from this installation.' }
        return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Read-AnalyzerOwnerRecords([string]$ProjectRoot) {
    $local = Join-Path $ProjectRoot '.local'
    $seen = @{}
    $ownerPath = Join-Path $local 'analyzer-windows.json'
    if (Test-Path -LiteralPath $ownerPath) {
        try {
            $record = Get-Content -Raw -Encoding UTF8 -LiteralPath $ownerPath | ConvertFrom-Json
            if ([int]$record.pid -gt 0) {
                $seen[[int]$record.pid] = $true
                if ([string]::Equals([IO.Path]::GetFullPath([string]$record.project), [IO.Path]::GetFullPath($ProjectRoot), [StringComparison]::OrdinalIgnoreCase)) { $record }
            }
        } catch { }
    }
    $pidPath = Join-Path $local 'analyzer.pid'
    if (Test-Path -LiteralPath $pidPath) {
        $savedId = 0
        if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$savedId) -and $savedId -gt 0 -and -not $seen.ContainsKey($savedId)) {
            $seen[$savedId] = $true
            [pscustomobject]@{ pid = $savedId; creationTime = ''; sourceSignature = ''; project = $ProjectRoot; legacy = $true }
        }
    }
    $legacyPath = Join-Path $local 'analyzer-local.json'
    if (Test-Path -LiteralPath $legacyPath) {
        try {
            $record = Get-Content -Raw -Encoding UTF8 -LiteralPath $legacyPath | ConvertFrom-Json
            if ([int]$record.pid -gt 0 -and -not $seen.ContainsKey([int]$record.pid) -and
                [string]::Equals([IO.Path]::GetFullPath([string]$record.project), [IO.Path]::GetFullPath($ProjectRoot), [StringComparison]::OrdinalIgnoreCase)) {
                [pscustomobject]@{ pid = [int]$record.pid; creationTime = ''; sourceSignature = ''; project = $ProjectRoot; legacy = $true }
            }
        } catch { }
    }
}

function Get-AnalyzerOwnedProcess([string]$ProjectRoot, $Record, $TrustedParent = $null) {
    $native = $null
    try {
        Initialize-AnalyzerProcessApi
        $native = New-Object LimingAnalyzer.OwnedProcess ([int]$Record.pid)
        if (-not $native.Running) { return $null }
        if ($Record.creationTime -and [string]$Record.creationTime -ne $native.CreationTime) { return $null }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction Stop
        if (-not $process -or -not $process.CreationDate -or -not $process.ExecutablePath) { return $null }
        # CIM dates have microsecond precision, while GetProcessTimes has 100 ns.
        $created = ([datetime]$process.CreationDate).ToUniversalTime().ToFileTimeUtc()
        if ([Math]::Abs($created - [long]$native.CreationTime) -ge 10) { return $null }
        if (-not [string]::Equals([string]$process.ExecutablePath, $native.ImagePath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $supervisor = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'scripts\run-analyzer-supervisor.ps1'))
        $python = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'services\analyzer\.venv\Scripts\python.exe'))
        $command = [string]$process.CommandLine
        $supervisorArgument = '(?i)(?:^|\s)-File\s+(?:"' + [regex]::Escape($supervisor) + '"|' + [regex]::Escape($supervisor) + '(?=\s|$))'
        $pythonCommand = '(?i)^\s*(?:"' + [regex]::Escape($python) + '"|' + [regex]::Escape($python) + '(?=\s|$))\s+.*?-m\s+liming_analyzer(?:\s|$)'
        $kind = if ($process.Name -in @('powershell.exe', 'pwsh.exe') -and $command -match $supervisorArgument) { 'supervisor' }
            elseif ($process.Name -in @('python.exe', 'pythonw.exe') -and $command -match $pythonCommand) { 'worker' } else { '' }
        # A Windows venv redirector can launch the base Python as one additional
        # process. Its verified live parent and creation time establish ownership
        # even when argv[0] names that base interpreter rather than the venv.
        if (-not $kind -and $null -ne $TrustedParent -and $TrustedParent.native.Running -and
            [int]$process.ParentProcessId -eq $TrustedParent.pid -and [long]$native.CreationTime -ge [long]$TrustedParent.creationTime -and
            $process.Name -in @('python.exe', 'pythonw.exe') -and $command -match '(?i)(?:^|\s)-m\s+liming_analyzer(?:\s|$)') { $kind = 'worker' }
        if (-not $kind -or -not $native.Running) { return $null }
        $result = [pscustomobject]@{ pid = [int]$Record.pid; kind = $kind; creationTime = $native.CreationTime; native = $native; record = $Record }
        $native = $null
        return $result
    } catch { return $null }
    finally { if ($null -ne $native) { $native.Dispose() } }
}

function Get-AnalyzerOwners([string]$ProjectRoot) {
    $seen = @{}
    foreach ($record in @(Read-AnalyzerOwnerRecords $ProjectRoot)) {
        $owned = Get-AnalyzerOwnedProcess $ProjectRoot $record
        if ($null -ne $owned) {
            if ($seen.ContainsKey($owned.pid)) { $owned.native.Dispose(); continue }
            $seen[$owned.pid] = $true
            if ($owned.kind -eq 'worker') {
                try {
                    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($owned.pid)" -ErrorAction Stop)) {
                        if ($seen.ContainsKey([int]$child.ProcessId)) { continue }
                        $childOwner = Get-AnalyzerOwnedProcess $ProjectRoot ([pscustomobject]@{ pid = [int]$child.ProcessId; creationTime = ''; project = $ProjectRoot }) $owned
                        if ($null -ne $childOwner) { $seen[$childOwner.pid] = $true; $childOwner }
                    }
                } catch { }
            }
            $owned
        }
    }
}

function Write-AnalyzerOwnerRecord([string]$ProjectRoot, $Owner, [string]$BaseUrl, [string]$Signature) {
    $local = Join-Path $ProjectRoot '.local'
    New-Item -ItemType Directory -Force -Path $local | Out-Null
    $record = @{ pid = $Owner.pid; creationTime = $Owner.creationTime; project = [IO.Path]::GetFullPath($ProjectRoot); kind = $Owner.kind; sourceSignature = $Signature; baseUrl = $BaseUrl }
    $pending = Join-Path $local ('.analyzer-owner-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($pending, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $pending -Destination (Join-Path $local 'analyzer-windows.json') -Force
    } finally { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
    Set-Content -LiteralPath (Join-Path $local 'analyzer.pid') -Encoding ASCII -Value $Owner.pid
    Set-Content -LiteralPath (Join-Path $local 'analyzer.base-url') -Encoding ASCII -Value $BaseUrl
}

function Remove-AnalyzerOwnerRecords([string]$ProjectRoot) {
    foreach ($name in @('analyzer-windows.json', 'analyzer.pid', 'analyzer.base-url', 'analyzer-local.json')) {
        Remove-Item -LiteralPath (Join-Path (Join-Path $ProjectRoot '.local') $name) -Force -ErrorAction SilentlyContinue
    }
}
