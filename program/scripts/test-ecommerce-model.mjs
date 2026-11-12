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
  fixture.mock("lib/model-settings.ts", { readEffectiveModelRuntime: async () => env });
  // Exercise the default UI path: confirmed product facts, no reference video,
  // no imported method cards, no explicit claim/evidence setup or core strategy.
  const product = await fixture.saveProduct({ name: "AI办公实操课（验收示例）", sku: "SYNTHETIC-METHODOLOGY-ONLY", status: "confirmed", publicData: {
    ...fixture.productInput.publicData, category: "课程与知识服务", specification: "录播课与练习资料", priceCents: 9858,
    audience: { user: "每周要做汇报、整理表格和写文案的AI初学上班族", buyer: "使用者本人", status: "hypothesis" },
    scenarios: "下班后准备第二天的汇报，有会议记录却不知道怎样用AI整理成能用的文件", purchaseConcerns: "担心买完只收藏，课里讲概念却不会用到自己的工作中",
    sellingPoints: "围绕真实办公任务练习，每节提交一个文件；提供可修改的练习素材和模板。",
    copyFacts: {
      content: "课程练习包括：把会议记录整理成汇报提纲，将提纲改成PPT页面文案，整理Excel表格，以及修改一版短视频文案。",
      usage: "第一节示范把一份会议记录整理成汇报提纲，再由学习者用自己的工作内容完成同类练习，保留可修改文件。",
      difference: "每节先演示一个具体任务，再布置同类作业；不以记住工具名称和概念作为完成标准。",
      delivery: "包含练习素材、可修改的PPT与表格模板、作业自查清单；商品详情可查看第一节演示和练习要求。",
      limitations: "需要准备电脑并亲手完成练习，不提供代做；不承诺收入、接单或固定节省时长。",
      speakerExperience: "",
    }, prohibited: "不编造亲历、学员效果、课程比较、耗时、收益和优惠。", claims: [],
  } });
  fixture.sqlite.prepare("DELETE FROM ecommerce_component_versions").run();
  fixture.sqlite.prepare("DELETE FROM ecommerce_components").run();
  fixture.sqlite.prepare("UPDATE content_strategies SET status='draft'").run();
  fixture.sqlite.prepare("UPDATE ecommerce_tasks SET product_id=?,product_version_id=?,brief_json=? WHERE id=?").run(product.id, product.versionId, JSON.stringify({ ...fixture.brief,
    referenceMode: "method", benchmark: null, caseIds: [], componentIds: [], claimId: "", evidenceIds: [],
    audience: { user: "每周要做汇报、整理表格和写文案的AI初学上班族", buyer: "使用者本人", status: "hypothesis" },
    barrier: "担心买完只收藏，课里讲概念却不会用到自己的工作中", scene: "下班后准备第二天的汇报", durationSec: 45,
    destination: "点击当前视频商品卡，查看第一节演示和练习要求", instructions: "写得有明确观点、具体细节和真实取舍，像给同事介绍一种能动手练的方法。不要编自己买过或试过，也不要套一层资料说明。", filming: [],
  }), fixture.task.id);
  fixture.mock("lib/model-adapter.ts", {
    ...adapter,
    invokeContentModel: async input => {
      const { stage } = JSON.parse(input.user);
      // Guard the same synthetic private-field sentinels used by API tests.
      assert.doesNotMatch(input.user, /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS|FORBIDDEN_PILLAR|FORBIDDEN_PERSONA|FORBIDDEN_DEFAULT_GOAL/);
      console.log(JSON.stringify({ stage, event: "started", provider: config.provider, model: config.model }));
      const output = await adapter.invokeContentModel(input, { config });
      stages.push({ stage, content: output.content, latencyMs: output.latencyMs });
      console.log(JSON.stringify({ stage, event: "received", latencyMs: output.latencyMs }));
      return output;
    },
  });
  const response = await fixture.generate({ idempotencyKey: "real-model-synthetic-smoke" });
  const body = await response.json();
  result = {
    syntheticOnly: true, realModel: true, businessAcceptance: false, mode: "method", referenceVideoRequired: false,
    provider: config.provider, model: config.model, status: response.status, body, stages,
    calls: fixture.sqlite.prepare("SELECT task_type,status,error_code FROM model_calls WHERE task_type LIKE 'ecommerce.%'").all(),
    versionCount: fixture.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n,
    ...(response.status === 201 ? { snapshot: JSON.parse(fixture.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions ORDER BY version DESC LIMIT 1").get().input_snapshot_json), validation: JSON.parse(fixture.sqlite.prepare("SELECT validation_json FROM ecommerce_versions ORDER BY version DESC LIMIT 1").get().validation_json) } : {}),
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
  if (result?.body?.version?.pack) writeFileSync(path.join(runDir, "generated-copy.txt"), `${result.body.version.pack.title}\n\n${result.body.version.pack.segments.map(segment => segment.script).join("\n\n")}\n`);
  console.log(JSON.stringify({ passed: result?.status === 201, status: result?.status, error: result?.error, runDir }));
}
