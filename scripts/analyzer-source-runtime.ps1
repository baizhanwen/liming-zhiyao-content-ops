function Set-AnalyzerSourceRuntime {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $sourceDirectory = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "services\analyzer"))
    $entrypoint = Join-Path $sourceDirectory "liming_analyzer\__main__.py"
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
        throw "Analyzer source is missing from this delivery. Reinstall the complete update."
    }
    # pip installs a copy into site-packages. Always prefer the source shipped
    # beside this launcher so a hotfix cannot silently run an older package.
    $separator = [IO.Path]::PathSeparator
    $remaining = @($env:PYTHONPATH -split [regex]::Escape([string]$separator) | Where-Object {
        $_ -and -not [string]::Equals($_, $sourceDirectory, [StringComparison]::OrdinalIgnoreCase)
    })
    $env:PYTHONPATH = (@($sourceDirectory) + $remaining) -join $separator
    return $sourceDirectory
}
