$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Get-Content -Encoding UTF8 -LiteralPath ".dev.vars" | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $name = $matches[1]
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path "Env:$name" -Value $value
    }
}

. (Join-Path $PSScriptRoot "analyzer-media-runtime.ps1")
$null = Import-AnalyzerMediaRuntime $projectRoot

. (Join-Path $PSScriptRoot "analyzer-source-runtime.ps1")
$sourceDirectory = Set-AnalyzerSourceRuntime $projectRoot
Write-Host "[Liming Zhiyao] Loading analyzer source from $sourceDirectory"

& "services\analyzer\.venv\Scripts\python.exe" -m liming_analyzer
exit $LASTEXITCODE
