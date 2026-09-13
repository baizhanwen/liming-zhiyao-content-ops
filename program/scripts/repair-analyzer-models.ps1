param(
    [ValidateSet("all", "speech", "ocr")]
    [string]$Component = "all"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$varsPath = Join-Path $projectRoot ".dev.vars"
$cacheRoot = if ($env:PROGRAMDATA) {
    Join-Path $env:PROGRAMDATA "LimingZhiyao\model-cache"
} else {
    "C:\ProgramData\LimingZhiyao\model-cache"
}

if (Test-Path -LiteralPath $varsPath) {
    $configured = Get-Content -Encoding UTF8 -LiteralPath $varsPath | Where-Object {
        $_ -match '^\s*ANALYZER_MODEL_CACHE\s*=\s*(.+?)\s*$'
    } | Select-Object -Last 1
    if ($configured -and $configured -match '^\s*ANALYZER_MODEL_CACHE\s*=\s*(.+?)\s*$') {
        $value = $matches[1].Trim().Trim('"').Trim("'")
        if ($value) {
            $cacheRoot = if ([IO.Path]::IsPathRooted($value)) {
                $value
            } else {
                Join-Path $projectRoot $value
            }
        }
    }
}

$resolvedRoot = [IO.Path]::GetFullPath($cacheRoot).TrimEnd('\')
$allowed = @()
if ($Component -in @("all", "speech")) {
    $allowed += @(
        "modelscope\models\iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "modelscope\models\iic--speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "modelscope\models\iic--punc_ct-transformer_cn-en-common-vocab471067-large"
    )
}
if ($Component -in @("all", "ocr")) {
    $allowed += @(
        "paddlex\official_models\PP-OCRv5_mobile_det",
        "paddlex\official_models\PP-OCRv5_mobile_rec",
        "paddlex\locks\official_models\PP-OCRv5_mobile_det",
        "paddlex\locks\official_models\PP-OCRv5_mobile_rec"
    )
}

$removed = 0
foreach ($relative in $allowed) {
    $target = [IO.Path]::GetFullPath((Join-Path $resolvedRoot $relative))
    if (-not $target.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the analyzer model cache: $target"
    }
    if (-not (Test-Path -LiteralPath $target)) { continue }
    try {
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "[OK] Removed damaged model cache: $target" -ForegroundColor Green
        $removed++
    } catch {
        throw "Could not clear $target. Stop the local project, then run this tool again. $($_.Exception.Message)"
    }
}

if ($removed -eq 0) {
    Write-Host "[NOTICE] No matching cached model folders were found."
} else {
    Write-Host "[OK] Cleared $removed model cache folder(s)." -ForegroundColor Green
}
Write-Host "[NEXT] Start the project and retry the task. The analyzer will download clean model files automatically."
