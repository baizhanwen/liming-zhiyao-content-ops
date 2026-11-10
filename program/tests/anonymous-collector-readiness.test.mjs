import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixture({ runtime = {}, worker = {}, quotaAllowed = true } = {}) {
  const now = new Date().toISOString();
  const environment = {
    ANALYZER_SERVICE_TOKEN: "synthetic-service-token",
    ANALYZER_LLM_API_KEY: "synthetic-model-key",
    ANALYZER_LLM_BASE_URL: "https://model.example.invalid/v1",
    ANALYZER_LLM_MODEL: "synthetic-model",
    ANALYZER_LLM_PROVIDER: "synthetic-provider",
    ...runtime,
  };
  const presence = {
    last_seen_at: now,
    browser_auth_status: "disabled",
    browser_auth_browser: null,
    browser_auth_checked_at: now,
    browser_auth_message: "使用 Skill Collect 独立匿名 Chromium 采集，无需个人浏览器登录态或 Cookie。",
    ...worker,
  };
  const quotaChecks = [];
  const mocked = new Map([
    ["cloudflare:workers", { env: environment }],
    [path.join(root, "lib/model-settings.ts"), { readEffectiveModelRuntime: async () => environment }],
    [path.join(root, "db/runtime.ts"), {
      getD1: () => ({ prepare: () => ({ first: async () => presence }) }),
      getMediaBucket: () => { throw new Error("anonymous readiness must not read stored Cookies"); },
    }],
    [path.join(root, "lib/operations.ts"), {
      checkOrganizationQuota: async (organizationId, userId, resource) => {
        quotaChecks.push({ organizationId, userId, resource });
        return { allowed: quotaAllowed, current: 10, limit: 10 };
      },
    }],
  ]);
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (mocked.has(filename)) return mocked.get(filename);
    if (cache.has(filename)) return cache.get(filename);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const loadedModule = { exports: {} };
    new Function("require", "module", "exports", source)((specifier) => {
      if (mocked.has(specifier)) return mocked.get(specifier);
      if (!specifier.startsWith(".")) throw new Error(`Unexpected dependency: ${specifier}`);
      return load(path.resolve(path.dirname(filename), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`));
    }, loadedModule, loadedModule.exports);
    cache.set(filename, loadedModule.exports);
    return loadedModule.exports;
  }
  return { load, quotaChecks };
}

test("a live anonymous worker accepts public links without personal browser login or Cookies", async () => {
  for (const browserAuthStatus of ["disabled", "not_logged_in", "unavailable", "unknown"]) {
    const f = fixture({ worker: { browser_auth_status: browserAuthStatus } });
    const { readAnalyzerReadiness, analyzerReadinessError } = f.load("lib/analyzer-readiness.ts");
    const readiness = await readAnalyzerReadiness("organization-1");
    assert.equal(readiness.publicLinkAuthenticationMode, "anonymous");
    assert.equal(readiness.publicLinkCookieConfigured, false);
    assert.equal(readiness.cookieUpdatedAt, null);
    assert.equal(analyzerReadinessError(readiness, true), null);
    assert.equal(await f.load("lib/analysis-submission-availability.ts").checkNewAnalysisAvailability({
      organizationId: "organization-1", userId: "user-1", requiresBrowser: true,
    }), null);
    assert.deepEqual(f.quotaChecks, [{ organizationId: "organization-1", userId: "user-1", resource: "analyses" }]);
  }
});

test("anonymous collection preserves service credential, model and heartbeat preflight", async () => {
  for (const [options, code] of [
    [{ runtime: { ANALYZER_SERVICE_TOKEN: "" } }, "ANALYZER_CREDENTIAL_REQUIRED"],
    [{ runtime: { ANALYZER_LLM_API_KEY: "" } }, "ANALYZER_MODEL_REQUIRED"],
    [{ worker: { last_seen_at: new Date(Date.now() - 60_000).toISOString() } }, "ANALYZER_OFFLINE"],
  ]) {
    const f = fixture(options);
    const result = await f.load("lib/analysis-submission-availability.ts").checkNewAnalysisAvailability({
      organizationId: "organization-1", userId: "user-1", requiresBrowser: true,
    });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, code);
    assert.deepEqual(f.quotaChecks, []);
  }
});

test("anonymous collection still enforces organization analysis quotas", async () => {
  const f = fixture({ quotaAllowed: false });
  const result = await f.load("lib/analysis-submission-availability.ts").checkNewAnalysisAvailability({
    organizationId: "organization-1", userId: "user-1", requiresBrowser: true,
  });
  assert.equal(result.status, 429);
  assert.equal((await result.json()).error.code, "ANALYSIS_QUOTA_EXCEEDED");
});
