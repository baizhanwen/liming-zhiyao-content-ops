param(
    [string]$Version = '22.23.2',
    # SHA256 refers to node-v<Version>-win-x64.zip, never the old MSI.
    [string]$Sha256 = '',
    [string]$NodePathFile = '',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:NodeInstallerRoot = Split-Path -Parent $PSScriptRoot
$script:PortableNodeVersion = '22.23.2'
# https://nodejs.org/download/release/v22.23.2/SHASUMS256.txt
$script:PortableNodeSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'

function Test-NodePathWithin([string]$Path, [string]$Parent) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    return [string]::Equals($full, $base, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NodeProjectPath([string]$Path) {
    if (-not (Test-NodePathWithin $Path $script:NodeInstallerRoot)) { throw 'Node runtime files must remain inside this installation.' }
    $current = [IO.Path]::GetFullPath($Path)
    while (Test-NodePathWithin $current $script:NodeInstallerRoot) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Node runtime paths cannot use symbolic links or junctions.' }
        }
        if ([string]::Equals($current.TrimEnd('\', '/'), $script:NodeInstallerRoot.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
}

function Read-NodePathRecord([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $bytes = [IO.File]::ReadAllBytes($Path)
    try { $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) }
    catch [Text.DecoderFallbackException] { $text = [Text.Encoding]::Default.GetString($bytes) }
    $text = $text.Trim().TrimStart([char]0xFEFF)
    if (-not $text -or $text -match '[\r\n]') { return $null }
    return $text
}

function Test-NodePublisher([string]$Path) {
    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $securityModule -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -FilePath $Path
    return $signature.Status -eq 'Valid' -and $signature.SignerCertificate -and
        $signature.SignerCertificate.Subject -match '(?i)(?:^|[, ])(?:CN|O)=OpenJS Foundation(?:,|$)'
}

function Test-NodeRuntime([string]$NodeExe, [string]$ExpectedVersion = '', [switch]$RequirePublisher) {
    if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { return $false }
    $npmPath = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
    $npmCli = Join-Path (Split-Path -Parent $NodeExe) 'node_modules\npm\bin\npm-cli.js'
    $policy = Join-Path $script:NodeInstallerRoot 'scripts\node-runtime-policy.mjs'
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf) -or -not (Test-Path -LiteralPath $npmCli -PathType Leaf) -or
        -not (Test-Path -LiteralPath $policy -PathType Leaf)) { return $false }
    try {
        if ($RequirePublisher -and -not (Test-NodePublisher $NodeExe)) { return $false }
        & $NodeExe $policy --check *> $null
        if ($LASTEXITCODE -ne 0) { return $false }
        if ($ExpectedVersion) {
            $actual = (& $NodeExe -p 'process.versions.node' 2>$null) -join ''
            if ($LASTEXITCODE -ne 0 -or $actual.Trim() -ne $ExpectedVersion) { return $false }
        }
        $npmVersion = (& $NodeExe $npmCli --version 2>$null) -join ''
        return $LASTEXITCODE -eq 0 -and $npmVersion.Trim() -match '^\d+\.\d+\.\d+(?:[-+].*)?$'
    } catch { return $false }
}

function Find-NodeRuntime([string]$PathFile, [switch]$OfflineCheck) {
    $cache = Join-Path $script:NodeInstallerRoot '.local\node-runtime'
    $candidates = New-Object System.Collections.Generic.List[string]
    $recorded = Read-NodePathRecord $PathFile
    if ($recorded -and [IO.Path]::IsPathRooted($recorded)) {
        try { $candidates.Add((Join-Path $recorded 'node.exe')) } catch { }
    }
    $candidates.Add((Join-Path $cache "node-v$script:PortableNodeVersion-win-x64\node.exe"))
    if (Test-Path -LiteralPath $cache -PathType Container) {
        Assert-NodeProjectPath $cache
        foreach ($folder in @(Get-ChildItem -LiteralPath $cache -Directory -Filter 'node-v*-win-x64' | Sort-Object Name)) { $candidates.Add((Join-Path $folder.FullName 'node.exe')) }
    }
    foreach ($parent in @($env:ProgramFiles, $env:LocalAppData)) {
        if ($parent) { $suffix = if ($parent -eq $env:ProgramFiles) { 'nodejs\node.exe' } else { 'Programs\nodejs\node.exe' }; $candidates.Add((Join-Path $parent $suffix)) }
    }
    foreach ($command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) { if ($command.Source) { $candidates.Add($command.Source) } }
    $seen = @{}
    foreach ($candidate in $candidates) {
        try { $candidate = [IO.Path]::GetFullPath($candidate) } catch { continue }
        if ($seen.ContainsKey($candidate)) { continue }; $seen[$candidate] = $true
        $portable = Test-NodePathWithin $candidate $cache
        # Copied records/PATH cannot depend on another installation's cache.
        if ($candidate -match '(?i)[\\/]\.local[\\/]node-runtime(?:[\\/]|$)' -and -not $portable) { continue }
        if ($portable) { Assert-NodeProjectPath $candidate }
        $expected = if ($portable -and $candidate -match '[\\/]node-v(\d+\.\d+\.\d+)-win-x64[\\/]node\.exe$') { $matches[1] } else { '' }
        if (Test-NodeRuntime $candidate -ExpectedVersion $expected -RequirePublisher:($portable -and -not $OfflineCheck)) { return $candidate }
    }
    return $null
}

function Save-NodePath([string]$NodeExe, [string]$PathFile) {
    Assert-NodeProjectPath $PathFile
    $parent = Split-Path -Parent $PathFile
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $pending = Join-Path $parent ('.node-path-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($pending, (Split-Path -Parent $NodeExe) + "`n", (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $pending -Destination $PathFile -Force
    } finally { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
}

function Get-NodeArchiveHash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { if ($null -ne $stream) { $stream.Dispose() }; $algorithm.Dispose() }
}

function Download-NodeArchive([string]$Uri, [string]$Destination) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -TimeoutSec 180 }
    catch {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $Uri -Destination $Destination -ErrorAction Stop
    }
}

function Expand-NodeArchive([string]$Archive, [string]$Destination, [string]$PackageName) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $expandedBytes = [long]0
        if ($zip.Entries.Count -gt 20000) { throw 'The Node archive contains too many files.' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $segments = @($name.TrimEnd('/') -split '/')
            $unixType = ([long]$entry.ExternalAttributes -shr 16) -band 0xF000
            if ($name.StartsWith('/') -or $name -match '[:<>"|?*\x00-\x1f]' -or $segments.Count -eq 0 -or
                $segments[0] -cne $PackageName -or $segments -contains '..' -or $segments -contains '.' -or
                $unixType -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0 -or -not $names.Add($name.TrimEnd('/'))) {
                throw 'The Node archive contains an unsafe or unexpected path.'
            }
            foreach ($segment in $segments) {
                if (-not $segment -or $segment -match '[. ]$' -or $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
                    throw 'The Node archive contains an invalid Windows file name.'
                }
            }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            if (-not (Test-NodePathWithin $target $Destination)) { throw 'The Node archive path escapes its extraction directory.' }
            $expandedBytes += $entry.Length
            if ($expandedBytes -gt 500MB) { throw 'The Node archive exceeds the extraction size limit.' }
        }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $target = Join-Path $Destination ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))
            if ($name.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
}

function Install-PortableNode([string]$ReleaseVersion, [string]$ReleaseSha256) {
    if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'The portable Node version must be a release version.' }
    if (-not $ReleaseSha256 -and $ReleaseVersion -eq $script:PortableNodeVersion) { $ReleaseSha256 = $script:PortableNodeSha256 }
    if ($ReleaseSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Provide the SHA256 of the official Windows x64 ZIP for this Node version; MSI hashes are not supported.' }
    $cache = Join-Path $script:NodeInstallerRoot '.local\node-runtime'
    Assert-NodeProjectPath $cache
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $lock = [IO.File]::Open((Join-Path $cache 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $temporary = Join-Path $cache ('.prepare-' + [guid]::NewGuid().ToString('N'))
    $backup = $null
    $target = Join-Path $cache "node-v$ReleaseVersion-win-x64"
    try {
        New-Item -ItemType Directory -Path $temporary | Out-Null
        $fileName = "node-v$ReleaseVersion-win-x64.zip"
        $archive = Join-Path $temporary $fileName
        $downloadUrl = "https://nodejs.org/dist/v$ReleaseVersion/$fileName"
        Write-Host '[Liming Zhiyao] Preparing a signed portable Node.js runtime inside this project...'
        Download-NodeArchive $downloadUrl $archive
        if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-Item -LiteralPath $archive).Length -gt 150MB -or
            (Get-NodeArchiveHash $archive) -ne $ReleaseSha256.ToLowerInvariant()) { throw 'The downloaded Node ZIP did not pass the official SHA256 check.' }
        Expand-NodeArchive $archive $temporary "node-v$ReleaseVersion-win-x64"
        $prepared = Join-Path $temporary "node-v$ReleaseVersion-win-x64"
        $node = Join-Path $prepared 'node.exe'
        if (-not (Test-NodePublisher $node)) { throw 'The portable Node executable did not pass the OpenJS publisher signature check.' }
        if (-not (Test-NodeRuntime $node -ExpectedVersion $ReleaseVersion)) { throw 'The portable Node version, architecture or npm could not be verified.' }
        Assert-NodeProjectPath $target
        if (Test-Path -LiteralPath $target) {
            $backup = Join-Path $cache ('.previous-' + [guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $target -Destination $backup
        }
        try { Move-Item -LiteralPath $prepared -Destination $target }
        catch {
            if ($backup -and -not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $backup -Destination $target }
            throw
        }
        return (Join-Path $target 'node.exe')
    } finally {
        try { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
        finally { $lock.Dispose() }
    }
}

function Invoke-NodeRuntimeSetup([string]$ReleaseVersion = '22.23.2', [string]$ReleaseSha256 = '', [string]$PathFile = '', [switch]$OnlyCheck) {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Liming Zhiyao requires 64-bit Windows.' }
    if (-not $PathFile) { $PathFile = Join-Path $script:NodeInstallerRoot '.local\node.path' }
    Assert-NodeProjectPath $PathFile
    $nodePath = Find-NodeRuntime $PathFile -OfflineCheck:$OnlyCheck
    if (-not $nodePath) {
        if ($OnlyCheck) { throw 'No compatible Windows x64 Node.js and npm were found. Run setup-local.bat to prepare this project runtime.' }
        $nodePath = Install-PortableNode $ReleaseVersion $ReleaseSha256
    }
    if (-not $OnlyCheck) { Save-NodePath $nodePath $PathFile }
    Write-Host '[OK] A compatible Node.js runtime and npm are ready for this project.'
    return $nodePath
}

if ($MyInvocation.InvocationName -ne '.') {
    try { $null = Invoke-NodeRuntimeSetup $Version $Sha256 $NodePathFile -OnlyCheck:$CheckOnly; exit 0 }
    catch { Write-Host '[ERROR] The project Node.js runtime could not be prepared. No global Node installation was changed.'; Write-Host $_.Exception.Message; exit 1 }
}
