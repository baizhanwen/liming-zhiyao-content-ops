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

test("commercial delivery disables localhost bypass and provides guarded first-run setup", () => {
  const auth = read("lib/request-auth.ts");
  const firstRun = read("lib/first-run.ts");
  const route = read("app/api/first-run/route.ts");
  const form = read("components/FirstRunSetup.tsx");
  assert.match(auth, /DELIVERY_MODE/);
  assert.match(auth, /runtime\.DELIVERY_MODE\?\.trim\(\) === "1"/);
  assert.match(firstRun, /FIRST_RUN_SETUP_CODE_HASH/);
  assert.match(firstRun, /hashesEqual/);
  assert.match(firstRun, /SELECT 1 AS configured FROM organizations LIMIT 1/);
  assert.match(firstRun, /!organization \|\| setupCompleted\?\.value !== "1"/);
  assert.match(firstRun, /installation\.initialized/);
  assert.match(route, /isLoopbackUrl\(request\.url\)/);
  assert.match(route, /FIRST_RUN_LOCAL_ONLY/);
  assert.match(form, /建立首家公司与管理员/);
});

test("commercial startup revokes sessions and delivery generation excludes private state", () => {
  const startup = read("scripts/prepare-login-startup.mjs");
  const startupSql = read("resources/delivery/revoke-startup-sessions.sql");
  const local = read("start-local.bat");
  const lan = read("scripts/start-lan.ps1");
  const delivery = read("scripts/prepare-delivery.ps1");
  assert.match(startup, /revoke-startup-sessions\.sql/);
  assert.match(startupSql, /DELETE FROM local_sessions/);
  assert.match(startup, /DELIVERY_MODE/);
  assert.match(local, /npm run auth:startup/);
  assert.match(lan, /npm\.cmd run auth:startup/);
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
  assert.match(delivery, /CONTENT_MODEL_API_KEY\|ANALYZER_LLM_API_KEY/);
  assert.match(delivery, /Compress-Archive -LiteralPath \$packageRoot/);
  assert.match(delivery, /scripts\\prepare-delivery\.ps1/);
});

test("delivery plan is chosen before packaging and unlicensed programs are physically removed", () => {
  const launcher = read("prepare-delivery.bat");
  const delivery = read("scripts/prepare-delivery.ps1");
  const operationsRoute = read("app/api/operations/route.ts");
  const operationsUi = read("components/SystemOperations.tsx");
  assert.match(launcher, /PLAN_CODE=starter/);
  assert.match(launcher, /PLAN_CODE=team/);
  assert.match(launcher, /PLAN_CODE=scale/);
  assert.match(launcher, /METHOD_LIBRARY_MODE=include/);
  assert.match(launcher, /METHOD_LIBRARY_MODE=exclude/);
  assert.match(delivery, /ValidateSet\("starter", "team", "scale"\)/);
  assert.match(delivery, /ValidateSet\("include", "exclude"\)/);
  assert.match(delivery, /Remove-PackagePath "resources\\authorized"/);
  assert.match(delivery, /authorizedKnowledge/);
  assert.match(delivery, /LICENSE-NOTICE\.txt/);
  assert.match(delivery, /buildId = \$buildId/);
  assert.match(delivery, /packageFormat = 2/);
  assert.match(delivery, /LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = \[\] as const/);
  assert.match(delivery, /const LEGACY_SOURCE_IDS = \[\]/);
  assert.match(delivery, /八、授权商业套餐/);
  assert.match(delivery, /Remove-PackagePath/);
  for (const path of ["app\\analysis", "services\\analyzer", "app\\wechat-images", "app\\insights"]) assert.match(delivery, new RegExp(path.replaceAll("\\", "\\\\")));
  assert.match(delivery, /install-cookie-export-extension\.bat/);
  assert.match(delivery, /lib\\delivery-entitlements\.ts/);
  assert.match(delivery, /unlicensed modules were removed/);
  assert.match(delivery, /app\\wechat-images\\design-preview/);
  assert.match(delivery, /components\\WechatPosterDesignPreview\.tsx/);
  assert.doesNotMatch(operationsRoute, /planCode: z\./);
  assert.doesNotMatch(operationsRoute, /UPDATE organization_settings SET plan_code = \?/);
  assert.doesNotMatch(operationsUi, /name="planCode"/);
  assert.match(operationsUi, /授权由交付包固定/);
});

test("factory reset backs up before replacing local state", () => {
  const reset = read("scripts/factory-reset.ps1");
  assert.match(reset, /Type FACTORY RESET/);
  assert.match(reset, /backup-local\.ps1/);
  assert.ok(reset.indexOf("backup-local.ps1") < reset.indexOf("Move-Item -LiteralPath $statePath"));
  assert.match(reset, /state-before-factory-reset/);
  assert.match(reset, /db:local:migrate/);
});
