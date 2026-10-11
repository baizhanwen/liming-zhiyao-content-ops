# Shipped backup/restore helpers; compatible with Windows PowerShell 5.1.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot "analyzer-instance-lock.ps1")

function Enter-LocalStateMaintenance([string]$ProjectRoot) {
    $locks = @()
    try {
        # Hold lifecycle locks until maintenance completes, including the pre-listen startup window.
        foreach ($purpose in @('maintenance', 'web', 'database-write', 'startup', 'supervisor', 'worker')) {
            $lock = Enter-AnalyzerInstanceLock $ProjectRoot $purpose
            if ($null -eq $lock) { throw "Another maintenance, web startup/setup or analyzer $purpose is running. Stop the project first." }
            $locks += $lock
        }
        return $locks
    } catch {
        Exit-LocalStateMaintenance $locks
        throw
    }
}

function Exit-LocalStateMaintenance($Locks) {
    for ($index = $Locks.Count - 1; $index -ge 0; $index -= 1) { Exit-AnalyzerInstanceLock $Locks[$index] }
}

function Assert-LocalStateStopped([string]$ProjectRoot) {
    $appPort = 3000
    $portPath = Join-Path $ProjectRoot ".local\app.port"
    if (Test-Path -LiteralPath $portPath) {
        $savedPort = 0
        if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $portPath).Trim(), [ref]$savedPort) -or $savedPort -lt 1 -or $savedPort -gt 65535) {
            throw "Invalid .local/app.port. Stop the project and repair the port record before maintenance."
        }
        $appPort = $savedPort
    }
    # Inspection failure must never mean 'stopped'.
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    if ($listeners | Where-Object LocalPort -eq $appPort) { throw "Run stop-local.bat before backup or restore; port $appPort is listening." }
    $prefix = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        if ($process.ProcessId -eq $PID) { continue }
        $command = [string]$process.CommandLine
        if ($command.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if (($process.Name -eq 'node.exe' -and $command -match '(?i)vinext|wrangler|workerd') -or
            ($process.Name -eq 'python.exe' -and $command -match '(?i)liming_analyzer') -or
            ($process.Name -in @('powershell.exe', 'pwsh.exe') -and $command -match '(?i)(run-analyzer-supervisor|start-analyzer-background|prepare-local-web)\.ps1')) {
            throw "A project web/analyzer/startup process is still running. Run stop-local.bat before maintenance."
        }
    }
    # A direct Python worker can use a relative command without the installation path.
    foreach ($purpose in @('startup', 'supervisor', 'worker')) {
        $probe = Enter-AnalyzerInstanceLock $ProjectRoot $purpose
        if ($null -eq $probe) { throw "The analyzer $purpose is running. Run stop-local.bat before maintenance." }
        Exit-AnalyzerInstanceLock $probe
    }
}

function Get-StateFiles([string]$Directory) {
    $root = Get-Item -Force -LiteralPath $Directory
    if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "State directories cannot contain filesystem links." }
    foreach ($entry in Get-ChildItem -Force -LiteralPath $Directory) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "State directories cannot contain filesystem links." }
        if ($entry.PSIsContainer) { Get-StateFiles $entry.FullName } else { $entry }
    }
}

function Assert-StateLayout([string[]]$Names) {
    if (-not ($Names | Where-Object { $_ -match '^state/v3/d1/.+\.sqlite$' })) { throw "Backup does not contain a local D1 database. No state was changed." }
}

function Get-StateFileHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Assert-ExtractedStateDatabases([string]$StatePath) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $candidates = @()
    $record = Join-Path $projectRoot '.local/node.path'
    if (Test-Path -LiteralPath $record) { $candidates += Join-Path ((Get-Content -Raw -LiteralPath $record).Trim()) 'node.exe' }
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs/node.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe' }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $node = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $node) { throw 'Database validation requires Node.js 22.13 or newer. Run setup-local.bat before restore; no state was changed.' }
    $previousAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $node --no-warnings (Join-Path $PSScriptRoot 'verify-state-databases.mjs') $StatePath 2>&1)
        $validationExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousAction }
    if ($validationExit -ne 0) { throw "Database validation failed; no state was changed. $($output -join ' ')" }
    $output | ForEach-Object { Write-Host $_ }
}

function Write-StateArchive([string]$StatePath, [string]$Destination) {
    $files = @(Get-StateFiles $StatePath)
    $prefix = [IO.Path]::GetFullPath($StatePath).TrimEnd('\') + '\'
    $inventory = @()
    $archive = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            $name = 'state/' + $file.FullName.Substring($prefix.Length).Replace('\', '/')
            # Exclusive reads reject files still held by database writers.
            $input = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
            try {
                $hash = [Security.Cryptography.SHA256]::Create()
                try { $digest = [BitConverter]::ToString($hash.ComputeHash($input)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
                $input.Position = 0
                $entry = $archive.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose() }
                $inventory += [ordered]@{ path = $name; size = $input.Length; sha256 = $digest }
            } finally { $input.Dispose() }
        }
        Assert-StateLayout @($inventory | ForEach-Object { $_.path })
        $manifest = [ordered]@{ project = 'liming-zhiyao'; formatVersion = 2; createdAt = (Get-Date).ToString('o'); files = $inventory }
        $writer = New-Object IO.StreamWriter($archive.CreateEntry('manifest.json').Open(), (New-Object Text.UTF8Encoding($false)))
        try { $writer.Write(($manifest | ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
    } finally { $archive.Dispose() }
}

function Expand-CheckedStateArchive([string]$ArchivePath, [string]$Staging, [switch]$AllowLegacyBackup) {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $names = @{}
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name -ne 'manifest.json' -and $name -notmatch '^state/') { throw "Unexpected archive entry: $name" }
            if ($name -match '(^/|:|(^|/)\.\.?(/|$)|[<>"|?*]|[ .](/|$))' -or $names.ContainsKey($name.TrimEnd('/'))) { throw "Unsafe or duplicate archive entry: $name" }
            $names[$name.TrimEnd('/')] = $entry
        }
        if (-not $names.ContainsKey('manifest.json')) { throw "Backup manifest is missing." }
        $reader = New-Object IO.StreamReader($names['manifest.json'].Open(), [Text.Encoding]::UTF8)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($manifest.project -ne 'liming-zhiyao' -or $manifest.formatVersion -notin @(1, 2)) { throw "Unsupported backup project or format version." }
        $fileEntries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') -and $_.FullName -ne 'manifest.json' })
        Assert-StateLayout @($fileEntries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $inventory = @{}
        if ($manifest.formatVersion -eq 1) {
            if (-not $AllowLegacyBackup) { throw "Legacy backup has no file hashes. Validate it in an isolated installation first, then use -AllowLegacyBackup explicitly." }
            Write-Warning "Legacy backup: file integrity cannot be verified from its manifest."
        } else {
            foreach ($record in $manifest.files) {
                if (-not $record.path -or $inventory.ContainsKey([string]$record.path) -or $record.sha256 -notmatch '^[a-f0-9]{64}$' -or $record.size -lt 0) { throw "Invalid backup file inventory." }
                $inventory[[string]$record.path] = $record
            }
            if ($inventory.Count -ne $fileEntries.Count) { throw "Backup file count does not match its manifest." }
        }
        $prefix = [IO.Path]::GetFullPath($Staging).TrimEnd('\') + '\'
        foreach ($entry in $fileEntries) {
            $name = $entry.FullName.Replace('\', '/')
            $destination = [IO.Path]::GetFullPath((Join-Path $Staging $name))
            if (-not $destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escapes the staging directory." }
            if ($manifest.formatVersion -eq 2 -and (-not $inventory.ContainsKey($name) -or $inventory[$name].size -ne $entry.Length)) { throw "Backup inventory/size mismatch: $name" }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            $input = $entry.Open()
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            if ($manifest.formatVersion -eq 2 -and (Get-StateFileHash $destination) -ne $inventory[$name].sha256) { throw "Backup checksum mismatch: $name" }
        }
    } finally { $archive.Dispose() }
}
