import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFixture } from "../tests/helpers/runtime-fixture.mjs";
import { ecommerceGenerationFixture } from "../tests/helpers/ecommerce-generation-fixture.mjs";

// Explicit, bounded real-provider smoke check. Uses synthetic in-memory data,
// never opens business storage, and never prints or persists credentials.
// It incurs up to five configured-model calls; excluded from npm test.
if (!process.argv.includes("--run-real-model")) throw new Error("Pass --run-real-model to call the configured provider with synthetic product data.");
const root = fileURLToPath(new URL("..", import.meta.url));
const runDir = path.join(root, ".local", `ec-model-${Date.now().toString(36)}`);
mkdirSync(runDir, { recursive: true });
const allowed = new Set(["CONTENT_MODEL_API_KEY", "CONTENT_MODEL_BASE_URL", "CONTENT_MODEL_NAME", "CONTENT_MODEL_PROVIDER", "CONTENT_MODEL_ALLOWED_PROVIDERS", "CONTENT_MODEL_ALLOWED_MODELS", "ANALYZER_LLM_API_KEY", "ANALYZER_LLM_BASE_URL", "ANALYZER_LLM_MODEL", "ANALYZER_LLM_PROVIDER"]);
const env = {};
for (const line of readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (!match || !allowed.has(match[1])) continue;
  const raw = match[2];
  env[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, "");
}
const cleanups = [], t = { after: callback => cleanups.push(callback) }, stages = [];
let result;
try {
  const adapterFixture = runtimeFixture(t);
  adapterFixture.mockModule("cloudflare:workers", { env });
  const adapter = adapterFixture.load("lib/model-adapter.ts"), config = adapter.readContentModelConfig("max");
  const fixture = await ecommerceGenerationFixture(t);
  fixture.mock("lib/model-adapter.ts", {
    ...adapter,
    invokeContentModel: async input => {
      const { stage } = JSON.parse(input.user);
      // Guard the same synthetic private-field sentinels used by API tests.
      assert.doesNotMatch(input.user, /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS|FORBIDDEN_PILLAR|FORBIDDEN_PERSONA|FORBIDDEN_DEFAULT_GOAL/);
      console.log(JSON.stringify({ stage, event: "started", provider: config.provider, model: config.model }));
      const output = await adapter.invokeContentModel(input);
      stages.push({ stage, content: output.content, latencyMs: output.latencyMs });
      console.log(JSON.stringify({ stage, event: "received", latencyMs: output.latencyMs }));
      return output;
    },
  });
  const response = await fixture.generate({ idempotencyKey: "real-model-synthetic-smoke" });
  const body = await response.json();
  result = {
    syntheticOnly: true, realModel: true, businessAcceptance: false,
    provider: config.provider, model: config.model, status: response.status, body, stages,
    calls: fixture.sqlite.prepare("SELECT task_type,status,error_code FROM model_calls WHERE task_type LIKE 'ecommerce.%'").all(),
    versionCount: fixture.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n,
  };
  if (response.status !== 201) process.exitCode = 1;
} catch (error) {
  // Record only known high-level adapter errors; do not dump configuration or
  // arbitrary provider exception messages which may contain credentials.
  result = { syntheticOnly: true, realModel: true, businessAcceptance: false, error: error.code ?? error.name, stages };
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result?.status === 201, status: result?.status, error: result?.error, runDir }));
}
