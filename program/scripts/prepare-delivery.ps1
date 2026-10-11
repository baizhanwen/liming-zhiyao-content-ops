param(
    [Parameter(Mandatory = $true)][string]$CustomerName,
    [ValidateSet("starter", "team", "scale")][string]$PlanCode = "team",
    [ValidateSet("include", "exclude")][string]$AuthorizedKnowledge = "include",
    [string]$DestinationRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$safeName = ($CustomerName.Trim() -replace '[^\p{L}\p{N}._-]+', '-') -replace '^-+|-+$', ''
if (-not $safeName) { throw "CustomerName must contain letters or numbers." }

$plans = @{
    starter = [ordered]@{
        name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5Z+656GA5Y2P5L2c54mI")); videoAnalysis = $false; wechatImages = $false; insights = $false
        projectQuota = 3; memberQuota = 10; monthlyAnalysisQuota = 0; monthlyModelCallQuota = 100
        storageQuotaBytes = 0; retentionDays = 90; failedJobAlertThreshold = 1
    }
    team = [ordered]@{
        name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5pm66IO955Sf5Lqn54mI")); videoAnalysis = $true; wechatImages = $false; insights = $false
        projectQuota = 20; memberQuota = 50; monthlyAnalysisQuota = 500; monthlyModelCallQuota = 2000
        storageQuotaBytes = 20 * 1024 * 1024 * 1024; retentionDays = 365; failedJobAlertThreshold = 3
    }
    scale = [ordered]@{
        name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5YWo5Yqf6IO957uP6JCl54mI")); videoAnalysis = $true; wechatImages = $false; insights = $true
        projectQuota = 100; memberQuota = 250; monthlyAnalysisQuota = 5000; monthlyModelCallQuota = 20000
        storageQuotaBytes = 200 * 1024 * 1024 * 1024; retentionDays = 730; failedJobAlertThreshold = 10
    }
}
$selectedPlan = $plans[$PlanCode]
$includeAuthorizedKnowledge = $AuthorizedKnowledge -eq "include"

$portPath = Join-Path $projectRoot ".local\app.port"
$appPort = 3000
if (Test-Path -LiteralPath $portPath) {
    [void][int]::TryParse((Get-Content -Raw -Encoding ASCII -LiteralPath $portPath).Trim(), [ref]$appPort)
}
if (Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue) {
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
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

# Delivery packages are assembled from a runtime allowlist. This keeps future
# developer notes, tests, caches, and internal tooling out of customer ZIPs by
# default instead of relying on somebody remembering to add a new exclusion.
$allowedTopLevelDirectories = @(
    "app", "components", "db", "drizzle", "lib", "public", "resources", "scripts",
    "services", "tools", "worker"
)
$allowedTopLevelFiles = @(
    ".dev.vars.example", "factory-reset.bat", "next-env.d.ts", "package.json", "package-lock.json",
    "postcss.config.mjs", "setup-local.bat", "start-lan.bat", "start-local.bat", "stop-local.bat",
    "tsconfig.json", "vite.config.ts", "wrangler.local.jsonc"
)
$excludedDirectories = @(
    "drizzle\meta",
    "services\analyzer\.ruff_cache", "services\analyzer\.venv", "services\analyzer\liming_zhiyao_analyzer.egg-info",
    "services\analyzer\model-cache", "services\analyzer\tests"
)
$excludedFiles = @(
    "db\schema.ts",
    "resources\authorized\dbskill\SOURCE.md", "resources\delivery\DELIVERY-GUIDE.txt",
    "scripts\verify-delivery.mjs", "scripts\test-lan-runtime.mjs", "scripts\lan-browser-checks.mjs", "scripts\lan-worker-check.py",
    "scripts\test-lan-identity-runtime.mjs",
    "scripts\test-model-budget-runtime.mjs",
    "scripts\test-startup-recovery-runtime.mjs",
    "scripts\test-ecommerce-browser.mjs", "scripts\test-ecommerce-model.mjs", "scripts\ecommerce-test-model.mjs",
    "scripts\verify-ecommerce-upgrade.mjs", "scripts\verify-analyzer-delivery.ps1",
    "scripts\start-analyzer.ps1", "services\analyzer\README.md", "services\analyzer\uv.lock", "tools\README.md"
)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ascii = [System.Text.Encoding]::ASCII

function Remove-PackagePath([string]$RelativePath) {
    $root = [System.IO.Path]::GetFullPath($packageRoot).TrimEnd('\') + '\'
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
    $sourcePrefix = $projectRoot.TrimEnd('\') + '\'
    $sourceFiles = @(
        $allowedTopLevelFiles | ForEach-Object {
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
        $relative = $_.FullName.Substring($sourcePrefix.Length)
        $segments = $relative.Split('\')
        $topLevelName = $segments[0]
        if ($segments.Length -eq 1) {
            if ($allowedTopLevelFiles -notcontains $relative) { return }
        } elseif ($allowedTopLevelDirectories -notcontains $topLevelName) {
            return
        }
        if ($excludedFiles -contains $relative -or $relative -eq "scripts\prepare-delivery.ps1" -or $relative -eq "scripts\prune-delivery-dependencies.mjs") { return }
        if ($relative -match '(^|\\)(__pycache__|\.pytest_cache)(\\|$)' -or $relative.EndsWith('.pyc', [StringComparison]::OrdinalIgnoreCase)) { return }
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

    if (-not $selectedPlan.videoAnalysis) {
        # The lock helper also protects web setup, migrations and backup/restore.
        # Keep it in every plan even when all video-analysis features are removed.
        @(
            "app\analysis", "app\api\analysis-jobs", "app\api\analyzer", "app\api\internal", "app\api\video-library", "app\api\videos",
            "components\AnalysisDetail.tsx", "components\AnalysisWorkspace.tsx", "components\VideoLibraryWorkspace.tsx", "components\useAnalysisProfile.ts",
            "lib\analysis-jobs.ts", "lib\analysis-profile.ts", "lib\analysis-worker.ts", "lib\analyzer-readiness.ts", "lib\douyin-cookie-snapshot.ts",
            "lib\douyin-url.ts", "lib\r2-response.ts", "lib\service-auth.ts", "lib\video-library.ts", "services\analyzer",
            "scripts\install-python311.ps1", "scripts\install-vcredist.ps1", "scripts\install-ffmpeg.ps1", "scripts\refresh-douyin-cookies.ps1", "scripts\start-analyzer.ps1", "scripts\start-analyzer-background.ps1", "scripts\run-analyzer-supervisor.ps1", "scripts\analyzer-media-runtime.ps1", "scripts\check-analyzer.ps1", "scripts\repair-analyzer-models.ps1",
            "tools\refresh-douyin-cookies.bat", "tools\install-cookie-export-extension.bat", "tools\setup-analyzer.bat", "tools\start-analyzer.bat", "tools\check-analyzer.bat", "tools\repair-analyzer-models.bat", "tools\repair-analyzer-ocr.bat"
        ) | ForEach-Object { Remove-PackagePath $_ }
        # The core dashboard survives when video analysis is excluded. Its
        # active-job count must not import the removed analysis state machine.
        Replace-PackageText "app\api\dashboard\route.ts" '(?m)^import \{ ACTIVE_ANALYSIS_STATUSES_SQL \} from "\.\./\.\./\.\./lib/analysis-jobs";\r?\n' "const ACTIVE_ANALYSIS_STATUSES_SQL = `"NULL`";`r`n"
        Replace-PackageText "scripts\open-local.ps1" '(?m)^\s*& "\$PSScriptRoot\\start-analyzer-background\.ps1" -BaseUrl \$Url\r?\n' ''
        Replace-PackageText "scripts\open-lan.ps1" '(?m)^\s*& "\$PSScriptRoot\\start-analyzer-background\.ps1" -BaseUrl \$HealthUrl\r?\n' ''
        Replace-PackageText "start-local.bat" 'The browser and video analyzer will start automatically when ready\.' 'The browser will open automatically when ready.'
        Replace-PackageText "scripts\start-lan.ps1" 'The browser and video analyzer will start automatically\.' 'The browser will open automatically.'
        Replace-PackageText "setup-local.bat" ' Video analysis is installed separately with tools\\setup-analyzer\.bat\.' ''
    }

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

    if (-not $selectedPlan.insights) {
        @(
            "app\insights", "app\api\analytics", "app\api\performance", "app\api\reports",
            "components\InsightsWorkspace.tsx", "components\EChart.tsx", "lib\performance-analytics.ts"
        ) | ForEach-Object { Remove-PackagePath $_ }
    }

    if (-not $includeAuthorizedKnowledge) {
        Remove-PackagePath "resources\authorized"
        $emptyMethodology = @"
export const AUTHORIZED_METHODOLOGY_SOURCE = {
  name: "利明智耀授权方法库",
  revision: "",
  integratedAt: "",
} as const;

export const AUTHORIZED_METHODOLOGY_ENABLED = false;
export const CONTENT_CREATION_METHODOLOGY = "";
export const TOPIC_CREATION_METHODOLOGY = "";
"@
        [System.IO.File]::WriteAllText((Join-Path $packageRoot "lib\authorized-content-methodology.ts"), ($emptyMethodology.TrimEnd() -replace "`r?`n", "`r`n") + "`r`n", $utf8NoBom)
        # The ecommerce starter pack is adapted from the authorized catalog.
        # Excluding that catalog must also physically remove these adaptations.
        $emptyEcommerceCatalog = @'
import type { ComponentInput } from "./contracts";
type Card = Omit<ComponentInput, "organizationId" | "projectId" | "id" | "revision">;
export const ECOMMERCE_STARTER_VERSION = "excluded";
export const ECOMMERCE_STARTER_CARDS: { key: string; card: Card; methods: { id: string; version: string; source: { document: string; revision: string } }[] }[] = [];
'@
        [System.IO.File]::WriteAllText((Join-Path $packageRoot "lib\ecommerce\starter-catalog.ts"), ($emptyEcommerceCatalog.TrimEnd() -replace "`r?`n", "`r`n") + "`r`n", $utf8NoBom)
        Replace-PackageText "services\analyzer\liming_analyzer\providers.py" '当前分析方法已获授权并参考利明智耀授权方法库。' '当前分析使用通用的短视频结构化分析规则。'
    } else {
        $legacyMethodPath = Join-Path $packageRoot "resources\authorized\dbskill"
        $brandedMethodPath = Join-Path $packageRoot "resources\authorized\liming-zhiyao"
        if (Test-Path -LiteralPath $legacyMethodPath) {
            Move-Item -LiteralPath $legacyMethodPath -Destination $brandedMethodPath
        }
        Replace-PackageText "scripts\sync-authorized-knowledge.mjs" 'resources/authorized/dbskill/atoms\.jsonl' 'resources/authorized/liming-zhiyao/atoms.jsonl'
        Replace-PackageText "resources\authorized\liming-zhiyao\atoms.jsonl" '"dbs-' '"liming-method-'
    }

    # A clean commercial database never contains the historical import IDs.
    # Keep migration compatibility in the development tree, but do not expose
    # upstream implementation labels in customer-readable source packages.
    Replace-PackageText "lib\authorized-knowledge.ts" 'library\. `dbskill` and `dbs-\*` were import-time implementation names and' 'library. Legacy import identifiers were internal implementation details and'
    Replace-PackageText "lib\authorized-knowledge.ts" 'export const LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = \["dbskill"\] as const;' 'export const LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = [] as const;'
    Replace-PackageText "lib\authorized-knowledge.ts" '(?m)^\s*if \(normalizedTag\.startsWith\("dbs-"\)\).*\r?\n' ''
    Replace-PackageText "scripts\sync-authorized-knowledge.mjs" 'const LEGACY_SOURCE_IDS = \["dbskill"\];' 'const LEGACY_SOURCE_IDS = [];'
    Replace-PackageText "scripts\sync-authorized-knowledge.mjs" '(?m)^\s*if \(normalizedTag\.startsWith\("dbs-"\)\).*\r?\n' ''

    & node (Join-Path $projectRoot "scripts\prune-delivery-dependencies.mjs") $packageRoot $featureVideo $featureWechat $featureInsights
    if ($LASTEXITCODE -ne 0) { throw "Delivery dependency pruning failed with exit code $LASTEXITCODE." }

    $setupCodeBytes = New-Object byte[] 18
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($setupCodeBytes)
    $setupCode = ([Convert]::ToBase64String($setupCodeBytes)).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
    $setupHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $setupCodeHash = [BitConverter]::ToString($setupHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($setupCode))).Replace('-', '').ToLowerInvariant()
    } finally {
        $setupHasher.Dispose()
    }

    $deliveryVars = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot ".dev.vars.example")
    $deliveryVars = $deliveryVars -replace '(?m)^LOCAL_DEV_AUTH=.*$', 'LOCAL_DEV_AUTH=0'
    $deliveryVars = $deliveryVars -replace '(?m)^DELIVERY_MODE=.*$', 'DELIVERY_MODE=1'
    $deliveryVars = $deliveryVars -replace '(?m)^FIRST_RUN_SETUP_CODE=.*$', 'FIRST_RUN_SETUP_CODE='
    $deliveryVars = $deliveryVars -replace '(?m)^FIRST_RUN_SETUP_CODE_HASH=.*$', "FIRST_RUN_SETUP_CODE_HASH=$setupCodeHash"
    $serviceTokenBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($serviceTokenBytes)
    $serviceToken = [BitConverter]::ToString($serviceTokenBytes).Replace('-', '').ToLowerInvariant()
    $deliveryVars = $deliveryVars -replace '(?m)^ANALYZER_SERVICE_TOKEN=.*$', "ANALYZER_SERVICE_TOKEN=$serviceToken"
    $deliveryVars = $deliveryVars -replace '(?m)^(CONTENT_MODEL_API_KEY|ANALYZER_LLM_API_KEY)=.*$', '$1='
    $commercialVars = ($deliveryVars.TrimEnd() -replace "`r?`n", "`r`n") + "`r`n"
    foreach ($varsName in @(".dev.vars", ".dev.vars.example")) {
        [System.IO.File]::WriteAllText((Join-Path $packageRoot $varsName), $commercialVars, $utf8NoBom)
    }

    $guideSource = Join-Path $projectRoot "resources\delivery\DELIVERY-GUIDE.txt"
    Copy-Item -LiteralPath $guideSource -Destination (Join-Path $packageRoot "DELIVERY-GUIDE.txt")
    $includedFeatures = @("客户项目与成员协作", "选题、内容生产、内部审核与发布", "品牌知识库")
    if ($includeAuthorizedKnowledge) { $includedFeatures += "利明智耀授权方法库（4,176 条方法原子）" }
    if ($selectedPlan.videoAnalysis) { $includedFeatures += "视频分析、素材中心与对标内容库" }
    if ($selectedPlan.wechatImages) { $includedFeatures += "公众号图片生成" }
    if ($selectedPlan.insights) { $includedFeatures += "数据复盘与报告" }
    $featureLines = @($includedFeatures | ForEach-Object { "- $_" })
    $guideAppendix = (@(
        "", "八、授权商业套餐", "套餐：$($selectedPlan.name) ($PlanCode)",
        "本交付包仅包含以下已授权模块："
    ) + $featureLines + @(
        "未授权模块不会进入 ZIP，客户管理员无法在系统内切换套餐；升级时需由利明智耀重新生成已授权交付包。"
    )) -join "`r`n"
    Add-Content -LiteralPath (Join-Path $packageRoot "DELIVERY-GUIDE.txt") -Value $guideAppendix -Encoding UTF8

    $credential = @(
        "Liming Zhiyao AI - delivery credential",
        "Customer: $CustomerName",
        "Licensed plan: $($selectedPlan.name) ($PlanCode)",
        "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
        "One-time setup code: $setupCode",
        "",
        "Send this credential separately from the software package.",
        "Delete it after the customer's first administrator is created."
    ) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $destination "delivery-credential.txt"), $credential + "`r`n", $utf8NoBom)

    $buildId = "$PlanCode-$timestamp"
    $licenseNotice = @(
        "利明智耀 AI 本地商业版授权提示",
        "================================",
        "授权客户：$CustomerName",
        "授权套餐：$($selectedPlan.name) ($PlanCode)",
        "交付构建号：$buildId",
        "",
        "本交付包仅供上述客户在已签署合同的组织范围内安装和使用。",
        "未经书面授权，不得对外转售、转授权、公开上传、发布派生交付包或删除本授权提示。",
        "本地源码交付不包含技术性 DRM；本提示用于标明授权范围，不替代双方签署的软件授权和服务合同，合同约定优先。"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $packageRoot "LICENSE-NOTICE.txt"), $licenseNotice + "`r`n", $utf8NoBom)

    $manifest = @{
        customer = $CustomerName
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
            name = "Liming Zhiyao authorized method library"
            importSupported = $true
        }
        sourceVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $packageRoot "package.json") | ConvertFrom-Json).version
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $packageRoot "delivery-manifest.json"), $manifest + "`r`n", $utf8NoBom)

    # Remove parent folders left empty by plan-specific pruning so customers
    # only see directories that contain part of their licensed program.
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
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive -CompressionLevel Optimal
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText("$archive.sha256", "$archiveHash  $([System.IO.Path]::GetFileName($archive))`r`n", $ascii)
    Write-Host "[OK] Verified candidate delivery package created:" -ForegroundColor Green
    Write-Host $archive
    Write-Host "[LICENSE] $($selectedPlan.name) ($PlanCode); unlicensed modules were removed from the ZIP."
    Write-Host "[METHOD LIBRARY] $AuthorizedKnowledge; import and export remain available to administrators."
    Write-Host "[SECURITY] Send delivery-credential.txt separately from the package."
} catch {
    $resolvedDeliveryRoot = [System.IO.Path]::GetFullPath($deliveryRoot).TrimEnd('\') + '\'
    $resolvedDestination = [System.IO.Path]::GetFullPath($destination)
    if ($resolvedDestination.StartsWith($resolvedDeliveryRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedDestination)) {
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
