import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("delivery generator is UTF-8 BOM encoded for Windows PowerShell 5", () => {
  const bytes = readFileSync(new URL("../scripts/prepare-delivery.ps1", import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("delivery generator explicitly reads UTF-8 source files on Windows PowerShell 5", () => {
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.match(delivery, /Get-Content -Raw -Encoding UTF8 -LiteralPath \$target/);
  assert.match(delivery, /Get-Content -Raw -Encoding UTF8 -LiteralPath \(Join-Path \$projectRoot "\.dev\.vars\.example"\)/);
  assert.match(delivery, /Get-Content -Raw -Encoding UTF8 -LiteralPath \(Join-Path \$packageRoot "package\.json"\)/);
  assert.doesNotMatch(delivery, /\$content = Get-Content -Raw -LiteralPath \$target/);
});

test("source typecheck ignores generated delivery copies", () => {
  const tsconfig = JSON.parse(read("tsconfig.json"));
  assert.ok(tsconfig.exclude.includes("deliveries"));
});

test("full delivery disables localhost bypass and retains guarded legacy first-run setup", () => {
  const auth = read("lib/request-auth.ts");
  const firstRun = read("lib/first-run.ts");
  const route = read("app/api/first-run/route.ts");
  const form = read("components/FirstRunSetup.tsx");
  assert.match(auth, /DELIVERY_MODE/);
  assert.match(auth, /runtime\.DELIVERY_MODE\?\.trim\(\) === "1"/);
  assert.match(firstRun, /FIRST_RUN_SETUP_CODE_HASH/);
  assert.match(firstRun, /hashesEqual/);
  assert.match(firstRun, /SELECT 1 AS configured FROM organizations LIMIT 1/);
  assert.match(firstRun, /!organization && setupCompleted\?\.value !== "1"/);
  assert.match(firstRun, /installation\.initialized/);
  assert.match(route, /isLoopbackUrl\(request\.url\)/);
  assert.match(route, /FIRST_RUN_LOCAL_ONLY/);
  assert.match(form, /建立首家公司与管理员/);
});

test("full delivery revokes startup sessions and excludes private state", () => {
  const startup = read("scripts/prepare-login-startup.mjs");
  const startupSql = read("resources/delivery/revoke-startup-sessions.sql");
  const local = read("start-local.bat");
  const lan = read("scripts/start-lan.ps1");
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.match(startup, /revoke-startup-sessions\.sql/);
  assert.match(startupSql, /DELETE FROM local_sessions/);
  assert.match(startup, /DELIVERY_MODE/);
  assert.match(local, /prepare-local-web\.ps1/);
  assert.match(read("scripts/prepare-local-web.ps1"), /& \$node \$npmCli run auth:startup/);
  assert.match(lan, /prepare-local-web\.ps1/);
  assert.match(delivery, /allowedTopLevelDirectories/);
  assert.match(delivery, /allowedTopLevelFiles/);
  for (const runtimePath of ["app", "components", "drizzle", "lib", "public", "scripts", "worker"]) assert.match(delivery, new RegExp(`"${runtimePath}"`));
  for (const excludedFile of ["resources\\delivery\\DELIVERY-GUIDE.txt", "services\\analyzer\\README.md", "tools\\README.md"]) assert.match(delivery, new RegExp(excludedFile.replaceAll("\\", "\\\\")));
  assert.doesNotMatch(delivery, /allowedTopLevelFiles[\s\S]{0,800}"README\.md"/);
  assert.doesNotMatch(delivery, /allowedTopLevelDirectories[\s\S]{0,500}"\.openai"/);
  assert.doesNotMatch(delivery, /allowedTopLevelDirectories[\s\S]{0,500}"build"/);
  assert.doesNotMatch(delivery, /allowedTopLevelFiles[\s\S]{0,800}"next\.config\.ts"/);
  assert.match(delivery, /allowedTopLevelFiles[\s\S]{0,800}"next-env\.d\.ts"/);
  assert.match(delivery, /__pycache__/);
  assert.match(delivery, /const d1 =/);
  assert.match(delivery, /MEDIA/);
  assert.match(delivery, /Get-ChildItem -LiteralPath \$packageRoot -Directory -Recurse/);
  assert.match(delivery, /\$allowedTopLevelDirectories \| ForEach-Object/);
  assert.doesNotMatch(delivery, /Get-ChildItem -LiteralPath \$projectRoot -Recurse -Force -File/);
  assert.match(delivery, /LOCAL_DEV_AUTH=0/);
  assert.match(delivery, /DELIVERY_MODE=1/);
  assert.match(delivery, /FIRST_RUN_SETUP_CODE_HASH/);
  assert.match(delivery, /SHA256/);
  assert.match(delivery, /foreach \(\$varsName in @\("\.dev\.vars", "\.dev\.vars\.example"\)\)/);
  assert.match(delivery, /\$featureLines/);
  assert.match(delivery, /failedJobAlertThreshold/);
  assert.match(delivery, /API_KEY\|LOCAL_RUNTIME_TOKEN\|MODEL_SETTINGS_ENCRYPTION_KEY/);
  assert.match(delivery, /ZipFile\]::CreateFromDirectory\(\$packageRoot, \$archive/);
  assert.match(delivery, /scripts\\prepare-delivery\.ps1/);
});

test("full delivery fixes supported features and preserves legacy method readers", () => {
  const launcher = read("prepare-delivery.bat");
  const delivery = read("scripts/prepare-delivery.ps1");
  const parameters = delivery.slice(0, delivery.indexOf('$ErrorActionPreference'));
  const operationsRoute = read("app/api/operations/route.ts");
  const operationsUi = read("components/SystemOperations.tsx");
  assert.match(parameters, /\[CmdletBinding\(\)\]/);
  assert.match(parameters, /ValidateSet\("github"\)/);
  assert.doesNotMatch(parameters, /CustomerName|PlanCode|AuthorizedKnowledge/);
  assert.match(delivery, /\$PlanCode = "scale"/);
  assert.match(delivery, /name = "完整开发版"; videoAnalysis = \$true; wechatImages = \$false; insights = \$true/);
  assert.match(delivery, /\$includeAuthorizedKnowledge = \$true/);
  assert.doesNotMatch(launcher, /set \/p|PLAN_CODE|METHOD_LIBRARY_MODE|:commercial/);
  assert.match(launcher, /if not "%~1"==""/);
  assert.match(launcher, /exit \/b 2/);
  assert.match(delivery, /LICENSE-NOTICE\.txt/);
  assert.match(delivery, /buildId = \$buildId/);
  assert.match(delivery, /packageFormat = 2/);
  assert.match(delivery, /八、完整开发版/);
  assert.doesNotMatch(delivery, /LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = \[\]|const LEGACY_SOURCE_IDS = \[\]/);
  assert.doesNotMatch(delivery, /Remove-PackagePath "(?:resources\\authorized|app\\analysis|services\\analyzer|app\\insights)"/);
  assert.match(read("lib/authorized-knowledge.ts"), /LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = \["dbskill"\]/);
  assert.match(read("lib/authorized-knowledge.ts"), /normalizedTag\.startsWith\("dbs-"\)/);
  assert.match(read("scripts/sync-authorized-knowledge.mjs"), /const LEGACY_SOURCE_IDS = \["dbskill"\]/);
  assert.match(delivery, /app\\wechat-images\\design-preview/);
  assert.match(delivery, /components\\WechatPosterDesignPreview\.tsx/);
  assert.doesNotMatch(operationsRoute, /planCode: z\./);
  assert.doesNotMatch(operationsRoute, /UPDATE organization_settings SET plan_code = \?/);
  assert.doesNotMatch(operationsUi, /name="planCode"|升级套餐/);
  assert.match(operationsUi, /公司与运行版本/);
});

test("factory reset backs up before replacing local state", () => {
  const reset = read("scripts/factory-reset.ps1");
  assert.match(reset, /Type FACTORY RESET/);
  assert.match(reset, /backup-local\.ps1/);
  assert.ok(reset.indexOf("backup-local.ps1") < reset.indexOf("Move-Item -LiteralPath $statePath"));
  assert.match(reset, /state-before-factory-reset/);
  assert.match(reset, /db:local:migrate/);
});

test("full delivery retains the lifecycle locks required for setup and recovery", () => {
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.doesNotMatch(delivery, /Remove-PackagePath "scripts\\analyzer-instance-lock\.ps1"/);
  for (const name of ["run-web-guard.ps1", "run-migration-guard.ps1", "local-state-maintenance.ps1"]) {
    assert.match(read(`scripts/${name}`), /analyzer-instance-lock\.ps1/);
  }
  assert.doesNotMatch(delivery, /Remove-PackagePath "scripts\\local-web-identity\.ps1"/);
  for (const name of ["run-web-guard.ps1", "select-local-port.ps1", "start-lan.ps1"]) {
    assert.match(read(`scripts/${name}`), /local-web-identity\.ps1/);
  }
});


test("the only download edition includes methods without customer activation credentials", () => {
  const launcher = read("prepare-delivery.bat");
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.match(delivery, /distribution = \$Distribution/);
  assert.match(delivery, /activationRequired = \$false/);
  assert.match(delivery, /customer = \$null/);
  assert.match(delivery, /\$requireSetupCode = "0"/);
  assert.match(delivery, /FIRST_RUN_REQUIRE_SETUP_CODE=\$requireSetupCode/);
  assert.doesNotMatch(delivery, /\$credential\s*=|交付激活码.*WriteAllText/);
  assert.match(delivery, /\$buildId = "github-\$PlanCode-\$timestamp"/);
  assert.match(delivery, /included = \$includeAuthorizedKnowledge/);
  assert.match(delivery, /if \(\$methodAtomCount -eq 0\)/);
  assert.match(launcher, /-Distribution github/);
  assert.doesNotMatch(launcher, /-Distribution commercial|-CustomerName|-PlanCode|-AuthorizedKnowledge|set \/p/);
});

test("delivery includes only the reviewed environment plugin and preserves the Python lock", () => {
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.match(delivery, /\$allowedBuildFiles = @\("build\\analyzer-environment-plugin\.ts"\)/);
  assert.match(delivery, /\$allowedBuildFiles -cnotcontains \$relative/);
  assert.doesNotMatch(delivery, /"services\\analyzer\\uv\.lock"/);
  assert.match(delivery, /ReparsePoint/);
  assert.match(delivery, /\.dev\\\.vars/);
  const privatePatterns = [...delivery.matchAll(/\$relative -match '([^']+)'/g)].map(([, pattern]) => new RegExp(pattern.replace(/^\(\?i\)/, ""), "i"));
  for (const filename of ["services/analyzer/.env", "resources/.dev.vars", "app/data.sqlite", "services/analyzer/node_modules/cache.json", "services/analyzer/cookies.txt", "public/.local/debug.log"])
    assert.ok(privatePatterns.some(pattern => pattern.test(filename.replaceAll("/", "\\"))), filename);
  for (const filename of ["app/page.tsx", "services/analyzer/uv.lock", "resources/authorized/methods/atoms.jsonl", "build/analyzer-environment-plugin.ts"])
    assert.equal(privatePatterns.some(pattern => pattern.test(filename.replaceAll("/", "\\"))), false, filename);
});
