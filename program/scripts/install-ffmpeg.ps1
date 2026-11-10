param(
    [string]$PathFile = "",
    [switch]$CheckOnly,
    [switch]$ProjectOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($ProjectOnly) {
    # The Settings-page installer uses a project-owned npm runtime. Keep the
    # existing manual winget setup below unchanged, including its PATH support.
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Prepare this project's Python environment before installing media tools."
    }
    & $python (Join-Path $PSScriptRoot "analyzer_local_runtime.py") install-media-tools
    exit $LASTEXITCODE
}

function Test-MediaBinary([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    & $Path -version *> $null
    return $LASTEXITCODE -eq 0
}

function New-MediaPair([string]$Ffmpeg, [string]$Ffprobe) {
    if (-not (Test-MediaBinary $Ffmpeg) -or -not (Test-MediaBinary $Ffprobe)) { return $null }
    return [pscustomobject]@{
        Ffmpeg = [IO.Path]::GetFullPath($Ffmpeg)
        Ffprobe = [IO.Path]::GetFullPath($Ffprobe)
    }
}

function Find-MediaPair {
    try {
        $ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction Stop
        $ffprobeCommand = Get-Command ffprobe.exe -ErrorAction Stop
        $pair = New-MediaPair $ffmpegCommand.Source $ffprobeCommand.Source
        if ($pair) { return $pair }
    } catch {}

    $linkDirectories = @(
        (Join-Path $env:LocalAppData "Microsoft\WinGet\Links"),
        (Join-Path $env:ProgramFiles "WinGet\Links")
    )
    foreach ($directory in $linkDirectories) {
        if (-not $directory) { continue }
        $pair = New-MediaPair (Join-Path $directory "ffmpeg.exe") (Join-Path $directory "ffprobe.exe")
        if ($pair) { return $pair }
    }

    $packageRoots = @(
        (Join-Path $env:LocalAppData "Microsoft\WinGet\Packages"),
        (Join-Path $env:ProgramFiles "WinGet\Packages")
    )
    foreach ($root in $packageRoots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $packageDirectories = Get-ChildItem -LiteralPath $root -Directory -Filter "Gyan.FFmpeg*" -ErrorAction SilentlyContinue
        foreach ($packageDirectory in $packageDirectories) {
            foreach ($ffmpeg in Get-ChildItem -LiteralPath $packageDirectory.FullName -Recurse -File -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue) {
                $pair = New-MediaPair $ffmpeg.FullName (Join-Path $ffmpeg.DirectoryName "ffprobe.exe")
                if ($pair) { return $pair }
            }
        }
    }
    return $null
}

function Save-MediaPath($Pair) {
    if (-not $PathFile) { return }
    $directories = @((Split-Path -Parent $Pair.Ffmpeg), (Split-Path -Parent $Pair.Ffprobe)) | Select-Object -Unique
    $fullPath = [IO.Path]::GetFullPath($PathFile)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    # setup-analyzer.bat reads this file with cmd.exe's `set /p`. Use the
    # active Windows code page so Chinese Windows profile paths are preserved.
    [IO.File]::WriteAllText($fullPath, ($directories -join ";"), [Text.Encoding]::Default)
}

function Add-MediaPathToUserEnvironment($Pair) {
    $directories = @((Split-Path -Parent $Pair.Ffmpeg), (Split-Path -Parent $Pair.Ffprobe)) | Select-Object -Unique
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    $changed = $false
    foreach ($directory in $directories) {
        $normalized = $directory.TrimEnd("\")
        if (-not ($entries | Where-Object { $_.TrimEnd("\").Equals($normalized, [StringComparison]::OrdinalIgnoreCase) })) {
            $entries += $directory
            $changed = $true
        }
    }
    if (-not $changed) { return }
    [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
    if (-not ("LimingZhiyao.NativeEnvironment" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace LimingZhiyao {
    public static class NativeEnvironment {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
    }
}
"@
    }
    $result = [UIntPtr]::Zero
    [void][LimingZhiyao.NativeEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result)
}

$pair = Find-MediaPair
if ($pair) {
    Save-MediaPath $pair
    if (-not $CheckOnly) { Add-MediaPathToUserEnvironment $pair }
    Write-Host "[OK] FFmpeg and ffprobe are ready."
    Write-Host "     $($pair.Ffmpeg)"
    exit 0
}

if ($CheckOnly) {
    throw "FFmpeg and ffprobe were not found or could not execute."
}

try {
    $winget = Get-Command winget.exe -ErrorAction Stop
} catch {
    throw "Windows Package Manager (winget) is required to install FFmpeg. Install or update 'App Installer' from Microsoft Store, then run this file again."
}

Write-Host "[Liming Zhiyao] Installing FFmpeg from the verified Windows Package Manager source..."
& $winget.Source install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
$wingetExitCode = $LASTEXITCODE

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = @($machinePath, $userPath, $env:Path) -join ";"
$pair = Find-MediaPair
if (-not $pair) {
    throw "winget returned exit code $wingetExitCode, and FFmpeg/ffprobe could not be verified after installation."
}

Save-MediaPath $pair
Add-MediaPathToUserEnvironment $pair
Write-Host "[OK] FFmpeg and ffprobe were installed and passed executable verification."
Write-Host "     $($pair.Ffmpeg)"
