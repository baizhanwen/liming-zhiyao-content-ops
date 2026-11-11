[CmdletBinding()]
param(
    [ValidateSet("github")][string]$Distribution = "github",
    [string]$DestinationRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$Distribution = "github"

# One complete development distribution. The legacy scale code is retained only
# for existing entitlement readers; it is not a selectable package tier.
$PlanCode = "scale"
$safeName = "LimingZhiyao-Full-Windows"
$selectedPlan = [ordered]@{
    name = "完整开发版"; videoAnalysis = $true; wechatImages = $false; insights = $true
    projectQuota = 100; memberQuota = 250; monthlyAnalysisQuota = 5000; monthlyModelCallQuota = 20000
    storageQuotaBytes = 200 * 1024 * 1024 * 1024; retentionDays = 730; failedJobAlertThreshold = 10
}
$includeAuthorizedKnowledge = $true
$scriptPolicyPath = Join-Path $projectRoot 'resources\delivery\runtime-scripts.json'
$scriptPolicy = Get-Content -Raw -Encoding UTF8 -LiteralPath $scriptPolicyPath | ConvertFrom-Json
if ($scriptPolicy.version -ne 1) { throw 'Unsupported runtime script policy.' }
$approvedScriptNames = @($scriptPolicy.common) + @($scriptPolicy.videoAnalysis)
if (($approvedScriptNames | Sort-Object -Unique).Count -ne $approvedScriptNames.Count -or
    @($approvedScriptNames | Where-Object { $_ -cnotmatch '^[a-z0-9][a-z0-9_-]*\.(ps1|mjs|py)$' }).Count) { throw 'Invalid or duplicate runtime script policy entry.' }
$allowedScriptNames = @($scriptPolicy.common)
if ($selectedPlan.videoAnalysis) { $allowedScriptNames += @($scriptPolicy.videoAnalysis) }
foreach ($scriptName in $allowedScriptNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ('scripts\' + $scriptName)) -PathType Leaf)) { throw "Required runtime script is missing: $scriptName" }
}

$portPath = Join-Path $projectRoot ".local\app.port"
$appPort = 3000
if (Test-Path -LiteralPath $portPath) {
    [void][int]::TryParse((Get-Content -Raw -Encoding ASCII -LiteralPath $portPath).Trim(), [ref]$appPort)
}
if ((Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) -and
    (Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue)) {
    throw "Stop the local project before preparing a delivery package."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$deliveryRoot = if ($DestinationRoot) {
    [System.IO.Path]::GetFullPath($DestinationRoot)
} else {
    Join-Path $projectRoot "deliveries"
}
$destination = Join-Path $deliveryRoot "$safeName-$timestamp"
$packageRoot = Join-Path $destination "LimingZhiyao"
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath "$destination.zip")) {
    throw "The delivery destination already exists; no existing package will be overwritten."
}
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

# Runtime directories are copied with explicit exclusions; scripts additionally
# require individual approval so new development tools cannot ship by default.
$allowedTopLevelDirectories = @(
    "app", "components", "db", "drizzle", "lib", "public", "resources", "scripts",
    "services", "tools", "worker"
)
$allowedTopLevelFiles = @(
    ".dev.vars.example", "factory-reset.bat", "next-env.d.ts", "package.json", "package-lock.json",
    "postcss.config.mjs", "setup-local.bat", "start-lan.bat", "start-local.bat", "stop-local.bat",
    "tsconfig.json", "vite.config.ts", "wrangler.local.jsonc"
)
# Only this reviewed build-time runtime plugin is shipped. Sites deployment
# helpers and future build tools remain outside the package.
$allowedBuildFiles = @("build\analyzer-environment-plugin.ts")
$excludedDirectories = @(
    "drizzle\meta",
    "services\analyzer\.ruff_cache", "services\analyzer\.venv", "services\analyzer\liming_zhiyao_analyzer.egg-info",
    "services\analyzer\model-cache", "services\analyzer\tests", "services\analyzer\build",
    "services\analyzer\liming_analyzer\douyin_collector\node\node_modules"
)
$excludedFiles = @(
    "db\schema.ts",
    "resources\authorized\dbskill\SOURCE.md", "resources\delivery\DELIVERY-GUIDE.txt",
    "resources\delivery\runtime-scripts.json",
    "scripts\verify-delivery.mjs", "scripts\test-lan-runtime.mjs", "scripts\lan-browser-checks.mjs", "scripts\lan-worker-check.py",
    "scripts\test-lan-identity-runtime.mjs", "scripts\test-runtime-resources.ps1",
    "scripts\test-model-budget-runtime.mjs",
    "scripts\test-startup-recovery-runtime.mjs",
    "scripts\delivery-documentation.mjs", "scripts\test-delivery-documentation.mjs",
    "scripts\test-private-config-recovery.mjs",
    "scripts\test-ecommerce-browser.mjs", "scripts\test-ecommerce-model.mjs", "scripts\ecommerce-test-model.mjs",
    "scripts\verify-ecommerce-upgrade.mjs", "scripts\verify-analyzer-delivery.ps1",
    "scripts\start-analyzer.ps1", "services\analyzer\README.md", "tools\README.md"
)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ascii = [System.Text.Encoding]::ASCII

function Remove-PackagePath([string]$RelativePath) {
    $root = [System.IO.Path]::GetFullPath($packageRoot).TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
    $target = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $RelativePath))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the delivery package: $target"
    }
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Replace-PackageText([string]$RelativePath, [string]$Pattern, [string]$Replacement) {
    $target = Join-Path $packageRoot $RelativePath
    if (-not (Test-Path -LiteralPath $target)) { return }
    # Windows PowerShell 5 treats UTF-8 files without a BOM as the active ANSI
    # code page unless Encoding is explicit. Every shipped source file is UTF-8,
    # so an implicit read here would permanently corrupt Chinese text in the ZIP.
    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $target
    [System.IO.File]::WriteAllText($target, ($content -replace $Pattern, $Replacement), $utf8NoBom)
}

try {
    $sourcePrefix = $projectRoot.TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
    $sourceFiles = @(
        (@($allowedTopLevelFiles) + @($allowedBuildFiles)) | ForEach-Object {
            $sourceFile = Join-Path $projectRoot $_
            if (Test-Path -LiteralPath $sourceFile -PathType Leaf) { Get-Item -LiteralPath $sourceFile }
        }
        $allowedTopLevelDirectories | ForEach-Object {
            $sourceDirectory = Join-Path $projectRoot $_
            if (Test-Path -LiteralPath $sourceDirectory -PathType Container) {
                # Runtime caches (notably Python package downloads) can change
                # while a clean package is assembled. They are excluded below;
                # a transient missing cache entry must not abort the delivery.
                Get-ChildItem -LiteralPath $sourceDirectory -Recurse -Force -File -ErrorAction SilentlyContinue
            }
        }
    )
    $sourceFiles | ForEach-Object {
        $relative = $_.FullName.Substring($sourcePrefix.Length).Replace('/', '\')
        $segments = $relative.Split('\')
        $topLevelName = $segments[0]
        if ($segments.Length -eq 1) {
            if ($allowedTopLevelFiles -notcontains $relative) { return }
        } elseif ($allowedTopLevelDirectories -notcontains $topLevelName -and $allowedBuildFiles -cnotcontains $relative) {
            return
        }
        if ($topLevelName -eq 'scripts' -and ($segments.Length -ne 2 -or $allowedScriptNames -cnotcontains $segments[1])) { return }
        if ($excludedFiles -contains $relative -or $relative -eq "scripts\prepare-delivery.ps1" -or $relative -eq "scripts\prune-delivery-dependencies.mjs") { return }
        # Never collect local state or secrets even if a runtime folder contains
        # an untracked development artifact. Only the root example is allowed;
        # sanitized configuration is generated below from that template.
        if ($relative -match '(^|\\)(\.git|\.local|\.wrangler|node_modules|\.venv|__pycache__|\.pytest_cache|\.ruff_cache|model-cache)(\\|$)' -or
            $relative -match '(?i)\.(sqlite(?:3)?(?:-wal|-shm)?|db|pyc|log)$' -or
            $relative -match '(?i)(^|\\)(?:cookies?(?:[._-][^\\]*)?\.(?:txt|json)|cookies?|delivery-credential\.txt)$' -or
            ($relative -ne '.dev.vars.example' -and $relative -match '(?i)(^|\\)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$')) { return }
        if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime files must not be links: $relative" }
        foreach ($excluded in $excludedDirectories) {
            if ($relative -eq $excluded -or $relative.StartsWith("$excluded\", [StringComparison]::OrdinalIgnoreCase)) {
                return
            }
        }
        $target = Join-Path $packageRoot $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $target
    }

    $featureVideo = ([string]$selectedPlan.videoAnalysis).ToLowerInvariant()
    $featureWechat = ([string]$selectedPlan.wechatImages).ToLowerInvariant()
    $featureInsights = ([string]$selectedPlan.insights).ToLowerInvariant()
    $entitlement = @"
export const deliveryPlan = {
  deliveryMode: true,
  code: "$PlanCode",
  name: "$($selectedPlan.name)",
  features: {
    videoAnalysis: $featureVideo,
    wechatImages: $featureWechat,
    insights: $featureInsights,
  },
  quotas: {
    projectQuota: $($selectedPlan.projectQuota),
    memberQuota: $($selectedPlan.memberQuota),
    monthlyAnalysisQuota: $($selectedPlan.monthlyAnalysisQuota),
    monthlyModelCallQuota: $($selectedPlan.monthlyModelCallQuota),
    storageQuotaBytes: $($selectedPlan.storageQuotaBytes),
    retentionDays: $($selectedPlan.retentionDays),
    failedJobAlertThreshold: $($selectedPlan.failedJobAlertThreshold),
  },
} as const;

export type DeliveryFeature = keyof typeof deliveryPlan.features;

export function deliveryFeatureEnabled(feature: DeliveryFeature) {
  return deliveryPlan.features[feature];
}
"@
    [System.IO.File]::WriteAllText((Join-Path $packageRoot "lib\delivery-entitlements.ts"), ($entitlement.TrimEnd() -replace "`r?`n", "`r`n") + "`r`n", $utf8NoBom)

    # Local customer installations do not use Sites deployment metadata or the
    # build-only Sites packaging plugin. Keep only the two local binding names.
    Replace-PackageText "vite.config.ts" '(?m)^import hostingConfig from "\./\.openai/hosting\.json";\r?\n' ''
    Replace-PackageText "vite.config.ts" '(?m)^import \{ sites \} from "\./build/sites-vite-plugin";\r?\n' ''
    Replace-PackageText "vite.config.ts" '(?m)^const \{ d1, r2 \} = hostingConfig;\r?$' "const d1 = `"DB`";`r`nconst r2 = `"MEDIA`";"
    Replace-PackageText "vite.config.ts" '(?m)^\s+sites\(\),\r?\n' ''

    if (-not $selectedPlan.wechatImages) {
        @(
            "app\wechat-images", "app\api\wechat-images", "components\WechatImageWorkspace.tsx", "components\WechatPosterCanvas.tsx",
            "components\WechatPosterDesignPreview.tsx", "lib\wechat-image-generation.ts", "lib\wechat-infographic.ts", "lib\poster-visual-quality.ts"
        ) | ForEach-Object { Remove-PackagePath $_ }
    }

    # Internal visual QA pages are useful while developing templates but are
    # not part of the licensed customer product.
    @(
        "app\wechat-images\design-preview",
        "components\WechatPosterDesignPreview.tsx"
    ) | ForEach-Object { Remove-PackagePath $_ }

    $legacyMethodPath = Join-Path $packageRoot "resources\authorized\dbskill"
    $brandedMethodPath = Join-Path $packageRoot "resources\authorized\liming-zhiyao"
    if (Test-Path -LiteralPath $legacyMethodPath) {
        Move-Item -LiteralPath $legacyMethodPath -Destination $brandedMethodPath
    }
    Replace-PackageText "scripts\sync-authorized-knowledge.mjs" 'resources/authorized/dbskill/atoms\.jsonl' 'resources/authorized/liming-zhiyao/atoms.jsonl'
    Replace-PackageText "resources\authorized\liming-zhiyao\atoms.jsonl" '"dbs-' '"liming-method-'

    # Preserve legacy source/tag readers so upgrading an older installation
    # retains its existing method references. Branding only affects new assets.

    & node (Join-Path $projectRoot "scripts\prune-delivery-dependencies.mjs") $packageRoot $featureVideo $featureWechat $featureInsights
    if ($LASTEXITCODE -ne 0) { throw "Delivery dependency pruning failed with exit code $LASTEXITCODE." }

    $deliveryVars = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot ".dev.vars.example")
    $deliveryVars = $deliveryVars -replace '(?m)^LOCAL_DEV_AUTH=.*$', 'LOCAL_DEV_AUTH=0'
    $deliveryVars = $deliveryVars -replace '(?m)^DELIVERY_MODE=.*$', 'DELIVERY_MODE=1'
    $requireSetupCode = "0"
    if ($deliveryVars -match '(?m)^FIRST_RUN_REQUIRE_SETUP_CODE=') {
        $deliveryVars = $deliveryVars -replace '(?m)^FIRST_RUN_REQUIRE_SETUP_CODE=.*$', "FIRST_RUN_REQUIRE_SETUP_CODE=$requireSetupCode"
    } else { $deliveryVars += "`r`nFIRST_RUN_REQUIRE_SETUP_CODE=$requireSetupCode`r`n" }
    $deliveryVars = $deliveryVars -replace '(?m)^FIRST_RUN_SETUP_CODE=.*$', 'FIRST_RUN_SETUP_CODE='
    $deliveryVars = $deliveryVars -replace '(?m)^FIRST_RUN_SETUP_CODE_HASH=.*$', 'FIRST_RUN_SETUP_CODE_HASH='
    $deliveryVars = $deliveryVars -replace '(?m)^ANALYZER_SERVICE_TOKEN=.*$', 'ANALYZER_SERVICE_TOKEN='
    $deliveryVars = $deliveryVars -replace '(?m)^([A-Z][A-Z0-9_]*API_KEY|LOCAL_RUNTIME_TOKEN|MODEL_SETTINGS_ENCRYPTION_KEY)=.*$', '$1='
    $deliveryVars = $deliveryVars -replace '(?m)^TRUST_FORWARDED_IDENTITY=.*$', 'TRUST_FORWARDED_IDENTITY=0'
    $sanitizedVars = ($deliveryVars.TrimEnd() -replace "`r?`n", "`r`n") + "`r`n"
    foreach ($varsName in @(".dev.vars", ".dev.vars.example")) {
        [System.IO.File]::WriteAllText((Join-Path $packageRoot $varsName), $sanitizedVars, $utf8NoBom)
    }

    $guideSource = Join-Path $projectRoot "resources\delivery\DELIVERY-GUIDE.txt"
    Copy-Item -LiteralPath $guideSource -Destination (Join-Path $packageRoot "DELIVERY-GUIDE.txt")
    # Only reviewed customer documentation is copied; internal audit reports and
    # other future docs remain outside the runtime directory allowlist.
    foreach ($document in @("docs\产品使用手册.html", "docs\产品使用手册.md", "docs\operations\备份恢复与升级操作.md", "docs\电商素材使用说明.md", "docs\releases\full-v20261111.7.md")) {
        $documentTarget = Join-Path $packageRoot $document
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $documentTarget) | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectRoot $document) -Destination $documentTarget
    }
    $methodAtomCount = 0
    if ($includeAuthorizedKnowledge) {
        $methodAtomsPath = Join-Path $packageRoot "resources\authorized\liming-zhiyao\atoms.jsonl"
        if (-not (Test-Path -LiteralPath $methodAtomsPath -PathType Leaf)) { throw "The included method library is missing." }
        $methodAtomCount = @(Get-Content -Encoding UTF8 -LiteralPath $methodAtomsPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
        if ($methodAtomCount -eq 0) { throw "The included method library must not be empty." }
    }
    $includedFeatures = @("客户项目与成员协作", "选题、内容生产、内部审核与发布", "品牌知识库")
    if ($includeAuthorizedKnowledge) { $includedFeatures += "利明智耀授权方法库（$methodAtomCount 条方法原子）" }
    if ($selectedPlan.videoAnalysis) { $includedFeatures += "视频分析、素材中心与对标内容库" }
    if ($selectedPlan.wechatImages) { $includedFeatures += "公众号图片生成" }
    if ($selectedPlan.insights) { $includedFeatures += "数据复盘与报告" }
    $featureLines = @($includedFeatures | ForEach-Object { "- $_" })
    $guideAppendix = (@("", "八、完整开发版", "本下载包固定包含方法库及当前开发版功能：") + $featureLines + @(
        "无需交付激活码。首次在主机浏览器创建公司与管理员，之后在系统设置配置自己的模型和分析环境。",
        "每个安装目录首次启动自动生成独立的内部通信密钥；下载包不包含开发者密钥或业务资料。",
        "本下载包只提供完整开发版；升级前按备份恢复与升级说明保存旧数据及配置。"
    )) -join "`r`n"
    Add-Content -LiteralPath (Join-Path $packageRoot "DELIVERY-GUIDE.txt") -Value $guideAppendix -Encoding UTF8

    $buildId = "github-$PlanCode-$timestamp"
    $licenseNotice = @(
        "利明智耀 AI · 完整开发版",
        "================================",
        "交付构建号：$buildId",
        "此下载包不绑定客户，无需激活码，包含当前开发版功能和内置方法库。",
        "模型服务由使用者在系统设置中自行配置；内部通信密钥在每次独立安装的首次启动生成。"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $packageRoot "LICENSE-NOTICE.txt"), $licenseNotice + "`r`n", $utf8NoBom)

    $manifest = @{
        distribution = $Distribution
        activationRequired = $false
        customer = $null
        buildId = $buildId
        generatedAt = (Get-Date).ToString("o")
        deliveryMode = 1
        packageFormat = 2
        license = @{
            code = $PlanCode
            name = $selectedPlan.name
            features = @{ videoAnalysis = $selectedPlan.videoAnalysis; wechatImages = $selectedPlan.wechatImages; insights = $selectedPlan.insights }
            quotas = @{ projectQuota = $selectedPlan.projectQuota; memberQuota = $selectedPlan.memberQuota; monthlyAnalysisQuota = $selectedPlan.monthlyAnalysisQuota; monthlyModelCallQuota = $selectedPlan.monthlyModelCallQuota; storageQuotaBytes = $selectedPlan.storageQuotaBytes; retentionDays = $selectedPlan.retentionDays; failedJobAlertThreshold = $selectedPlan.failedJobAlertThreshold }
        }
        authorizedKnowledge = @{
            included = $includeAuthorizedKnowledge
            atomCount = $methodAtomCount
            name = "Liming Zhiyao authorized method library"
            importSupported = $true
        }
        sourceVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $packageRoot "package.json") | ConvertFrom-Json).version
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $packageRoot "delivery-manifest.json"), $manifest + "`r`n", $utf8NoBom)

    # Remove empty runtime directories after excluding unsupported/internal pages.
    Get-ChildItem -LiteralPath $packageRoot -Directory -Recurse | Sort-Object FullName -Descending | ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }

    # cmd.exe can fail to resolve :labels when a batch file has Unix-only LF
    # line endings. Normalize every shipped entry point after all package edits.
    Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object { $_.Extension -in @(".bat", ".cmd") } | ForEach-Object {
        $batchContent = [System.IO.File]::ReadAllText($_.FullName)
        $batchContent = [Text.RegularExpressions.Regex]::Replace($batchContent, "\r?\n", "`r`n")
        [System.IO.File]::WriteAllText($_.FullName, $batchContent, $ascii)
    }

    if ($selectedPlan.videoAnalysis) {
        $acceptanceSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("ZG9jc1xvcGVyYXRpb25zXOWxgOWfn+e9keinhumikeWIhuaekOmqjOaUtua4heWNlS5tZA=="))
        Copy-Item -LiteralPath (Join-Path $projectRoot $acceptanceSource) -Destination (Join-Path $packageRoot "LAN-ACCEPTANCE.md")
    }
    Write-Host "[VERIFY] Installing and testing the final customer package in an isolated directory..."
    & node (Join-Path $projectRoot "scripts\verify-delivery.mjs") $packageRoot
    if ($LASTEXITCODE -ne 0) { throw "Customer package verification failed. No delivery ZIP was created." }

    $archive = "$destination.zip"
    # ZipFile preserves dotfiles on Unix as well as Windows. Compress-Archive
    # skips .dev.vars on Unix and would silently produce an unusable package.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText("$archive.sha256", "$archiveHash  $([System.IO.Path]::GetFileName($archive))`r`n", $ascii)
    Write-Host "[OK] Verified candidate delivery package created:" -ForegroundColor Green
    Write-Host $archive
    Write-Host "[EDITION] 完整开发版; all supported development modules and the method library are included."
    Write-Host "[METHOD LIBRARY] included; import and export remain available to administrators."
} catch {
    $resolvedDeliveryRoot = [System.IO.Path]::GetFullPath($deliveryRoot).TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
    $resolvedDestination = [System.IO.Path]::GetFullPath($destination)
    if ($resolvedDestination.StartsWith($resolvedDeliveryRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedDestination)) {
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
