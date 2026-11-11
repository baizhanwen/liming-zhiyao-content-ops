import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const capacityKeys = {
  project_quota: "projectQuota", member_quota: "memberQuota", monthly_analysis_quota: "monthlyAnalysisQuota",
  monthly_model_call_quota: "monthlyModelCallQuota", storage_quota_bytes: "storageQuotaBytes",
  retention_days: "retentionDays", failed_job_alert_threshold: "failedJobAlertThreshold",
};
function expectedCapacity(plan) {
  return { plan_code: "scale", ...Object.fromEntries(Object.entries(capacityKeys).map(([stored, preset]) => [stored, plan.quotas[preset]])) };
}

test("new organizations receive the complete development edition and its actual feature capacity", async t => {
  const f = runtimeFixture(t), { deliveryPlan } = f.load("lib/delivery-entitlements.ts");
  assert.equal(deliveryPlan.name, "完整开发版");
  assert.equal(deliveryPlan.code, "scale");
  assert.deepEqual(deliveryPlan.features, { videoAnalysis: true, wechatImages: false, insights: true });
  assert.equal(deliveryPlan.quotas.monthlyAnalysisQuota, 5000);
  const installation = await f.initialize();
  const capacity = await f.load("lib/operations.ts").getOrganizationCapacity(installation.organizationId, installation.userId);
  assert.deepEqual({ ...capacity }, expectedCapacity(deliveryPlan));
});

for (const deliveryMode of [true, false]) {
  test(`${deliveryMode ? "packaged full edition supplies effective capacity" : "source installation reads historical capacity"} without rewriting old settings`, async t => {
    const f = runtimeFixture(t), { deliveryPlan } = f.load("lib/delivery-entitlements.ts");
    f.mock("lib/delivery-entitlements.ts", { deliveryPlan: { ...deliveryPlan, deliveryMode } });
    const installation = await f.initialize();
    f.sqlite.prepare(`UPDATE organization_settings SET plan_code='starter', project_quota=2, member_quota=3,
      monthly_analysis_quota=0, monthly_model_call_quota=7, storage_quota_bytes=123456,
      retention_days=31, failed_job_alert_threshold=9, updated_at='2020-01-01', updated_by='legacy-admin'
      WHERE organization_id=?`).run(installation.organizationId);
    const before = f.sqlite.prepare("SELECT * FROM organization_settings WHERE organization_id=?").get(installation.organizationId);
    const writes = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
    const capacity = await f.load("lib/operations.ts").getOrganizationCapacity(installation.organizationId, installation.userId);
    const expected = deliveryMode ? expectedCapacity(deliveryPlan) : Object.fromEntries(["plan_code", ...Object.keys(capacityKeys)].map(key => [key, before[key]]));
    assert.deepEqual({ ...capacity }, expected);
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM organization_settings WHERE organization_id=?").get(installation.organizationId), before);
    assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, writes, "Reading effective capacity must not update historical configuration");
    const check = await f.load("lib/operations.ts").checkOrganizationQuota(installation.organizationId, installation.userId, "analyses");
    assert.equal(check.allowed, deliveryMode);
    assert.equal(check.limit, deliveryMode ? 5000 : 0);
  });
}

function windowsFixture(t) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "完整开发版 中文 目录-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  mkdirSync(path.join(temporary, "scripts"));
  return temporary;
}
function runPowerShell(script, env) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, ...env }, encoding: "utf8", input: "\r\n", timeout: 20_000,
  });
}

test("Windows full delivery launcher invokes only github and rejects obsolete choices before packaging", { skip: process.platform !== "win32" }, t => {
  const temporary = windowsFixture(t), launcher = path.join(temporary, "prepare-delivery.bat"), marker = path.join(temporary, "called.json");
  copyFileSync(path.join(root, "prepare-delivery.bat"), launcher);
  // Use the real launcher with an isolated packaging boundary: no build, model,
  // network, customer state, or global runtime is touched by this fixture.
  writeFileSync(path.join(temporary, "scripts/prepare-delivery.ps1"), '[CmdletBinding()] param([ValidateSet("github")][string]$Distribution)\n[IO.File]::WriteAllText($env:FULL_MARKER, (ConvertTo-Json -Compress @{distribution=$Distribution; argumentCount=$args.Count}))\n', "utf8");
  let result = runPowerShell("& $env:FULL_LAUNCHER; exit $LASTEXITCODE", { FULL_LAUNCHER: launcher, FULL_MARKER: marker });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { distribution: "github", argumentCount: 0 });
  rmSync(marker);
  result = runPowerShell("& $env:FULL_LAUNCHER --commercial; exit $LASTEXITCODE", { FULL_LAUNCHER: launcher, FULL_MARKER: marker });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(marker), false);
});

test("Windows packager rejects old plan and channel parameters before creating a destination", { skip: process.platform !== "win32" }, t => {
  const temporary = windowsFixture(t), script = path.join(temporary, "scripts/prepare-delivery.ps1"), destination = path.join(temporary, "output");
  copyFileSync(path.join(root, "scripts/prepare-delivery.ps1"), script);
  for (const parameters of ["-PlanCode starter", "-CustomerName customer", "-AuthorizedKnowledge exclude", "-Distribution commercial"]) {
    const result = runPowerShell(`& $env:FULL_SCRIPT -DestinationRoot $env:FULL_DESTINATION ${parameters}; if ($?) { exit 0 } else { exit 1 }`, { FULL_SCRIPT: script, FULL_DESTINATION: destination });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NamedParameterNotFound|ParameterArgumentValidationError/);
    assert.equal(existsSync(destination), false, parameters);
  }
});
