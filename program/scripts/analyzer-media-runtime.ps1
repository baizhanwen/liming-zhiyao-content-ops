function Read-AnalyzerMediaPathFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return @() }

    # Newer PowerShell uses UTF-8 as its default while Windows PowerShell and
    # cmd.exe use the active ANSI code page. setup-analyzer.bat deliberately
    # writes this file for cmd.exe, so decode both formats without corrupting a
    # Chinese Windows profile path.
    try {
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $value = $strictUtf8.GetString($bytes)
    }
    catch [Text.DecoderFallbackException] {
        $codePage = [Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
        $value = [Text.Encoding]::GetEncoding($codePage).GetString($bytes)
    }
    return @($value.Trim() -split ";" | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
}

function Resolve-AnalyzerMediaExecutable(
    [string]$ConfiguredValue,
    [string]$ExecutableName,
    [string[]]$RecordedDirectories
) {
    if ($ConfiguredValue) {
        if (Test-Path -LiteralPath $ConfiguredValue -PathType Leaf) {
            return [IO.Path]::GetFullPath($ConfiguredValue)
        }
        $configuredCommand = Get-Command $ConfiguredValue -CommandType Application -ErrorAction SilentlyContinue
        if ($configuredCommand) { return $configuredCommand.Source }
        throw "$ExecutableName is configured as '$ConfiguredValue', but that executable does not exist."
    }
    foreach ($directory in $RecordedDirectories) {
        $candidate = Join-Path $directory "$ExecutableName.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    $command = Get-Command "$ExecutableName.exe" -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Import-AnalyzerMediaRuntime([string]$ProjectRoot) {
    $pathFile = Join-Path $ProjectRoot ".local\ffmpeg.path"
    $directories = @(Read-AnalyzerMediaPathFile $pathFile)
    $ffmpeg = Resolve-AnalyzerMediaExecutable $env:ANALYZER_FFMPEG "ffmpeg" $directories
    $ffprobe = Resolve-AnalyzerMediaExecutable $env:ANALYZER_FFPROBE "ffprobe" $directories
    if (-not $ffmpeg -or -not $ffprobe) {
        throw "FFmpeg or ffprobe is not available to the video analyzer. Run tools\setup-analyzer.bat to repair the media runtime."
    }
    # The video collector and third-party media helpers do not read the analyzer's
    # explicit variables. They discover FFmpeg through PATH, so restore the
    # resolved binary directories in this process before the Python worker is
    # launched. This is intentionally process-scoped and does not mutate the
    # customer's permanent Windows environment.
    $mediaDirectories = @(
        (Split-Path -Parent $ffmpeg),
        (Split-Path -Parent $ffprobe)
    ) | Select-Object -Unique
    $pathEntries = @($env:Path -split ";" | Where-Object { $_ })
    foreach ($directory in $mediaDirectories) {
        if (-not ($pathEntries | Where-Object { $_.TrimEnd("\").Equals($directory.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase) })) {
            $pathEntries = @($directory) + $pathEntries
        }
    }
    $env:Path = $pathEntries -join ";"
    $env:ANALYZER_FFMPEG = $ffmpeg
    $env:ANALYZER_FFPROBE = $ffprobe
    return [pscustomobject]@{ Ffmpeg = $ffmpeg; Ffprobe = $ffprobe }
}
