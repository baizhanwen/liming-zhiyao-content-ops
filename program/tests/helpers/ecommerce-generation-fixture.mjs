import { ecommerceFixture } from "./ecommerce-fixture.mjs";

export async function ecommerceGenerationFixture(t, options = {}) {
  const f = await ecommerceFixture(t); await f.enable(); const initial = await f.saveProduct();
  const evidenceResponse = await f.route("evidence").POST(f.request("POST", { productId: initial.id, title: "合成旋盖演示", kind: "demonstration", body: "合成杯采用旋盖。演示旋开与旋紧动作。", sourceLocator: "合成测试资料，不代表真实商品", status: "confirmed" }));
  const evidenceId = (await evidenceResponse.json()).evidence.id;
  const product = await f.saveProduct({ id: initial.id, revision: 1, status: "confirmed", publicData: { ...f.productInput.publicData, claims: [{ id: "rotation", kind: "demonstration", statement: "合成杯采用旋盖", allowedExpression: "合成杯采用旋盖", evidenceIds: [evidenceId], status: "confirmed" }] } });
  f.seed("content_strategies", { id: "commerce-strategy", name: "测试策略", version: 1, status: "active", positioning: "日常商品使用演示", target_audience: "日常使用者", style_notes: "自然口语", pain_points_json: "[]", topic_mix_json: "{}", cadence: "", conversion_path: "", pillars_json: '["FORBIDDEN_PILLAR"]', persona: "FORBIDDEN_PERSONA", objectives_json: '["FORBIDDEN_DEFAULT_GOAL"]' });
  const componentIds = [];
  for (const kind of ["hook", "visual", "structure", "sop"]) {
    const r = await f.route("components").POST(f.request("POST", { name: `合成${kind}`, kind, instruction: "按已确认的场景和证据组织表达与镜头", problem: "展示旋盖操作", platforms: ["douyin"], targets: ["product_click"], inputContract: "商品事实与旋盖证据", outputContract: "口播和镜头", sourceLocator: "synthetic fixture", sourceVersion: "1", authorization: "合成测试", status: "confirmed" }));
    if (r.status !== 201) throw new Error(await r.text()); componentIds.push((await r.json()).component.id);
  }
  const brief = { audience: { user: "日常使用者", buyer: "日常购买者", status: "confirmed" }, scene: "日常喝水", barrier: "不清楚盖子如何打开", claimId: "rotation", evidenceIds: [evidenceId], platform: "douyin", target: "product_click", destination: "当前商品卡查看规格", filming: ["product", "hands"], durationSec: 30 };
  const taskResponse = await f.route("tasks").POST(f.request("POST", { title: "合成旋盖商品演示", productId: product.id, productVersionId: product.versionId, brief }));
  if (taskResponse.status !== 201) throw new Error(await taskResponse.text());
  const task = (await taskResponse.json()).task, calls = [];
  f.mock("lib/generation-freeze.mjs.ts", { isGenerationFrozen: () => options.frozen === true });
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit: 10000 }) });
  let lastPack;
  f.mock("lib/model-adapter.ts", {
    ModelConfigurationError: class extends Error {},
    readContentModelConfig: () => ({ provider: "synthetic", model: "synthetic", profile: "max" }),
    invokeContentModel: async input => {
      const query = JSON.parse(input.user), { stage, payload } = query, c = payload.context;
      calls.push({ stage, payload, input });
      if (options.onCall) await options.onCall({ stage, payload, f, calls });
      let result;
      if (stage === "plan") result = {
        choices: c.candidates.map(x => ({ kind: x.card.kind, componentId: x.id, reason: "符合本次演示条件" })),
        outline: [{ id: "h", role: "hook", purpose: "提出使用问题", durationSec: 10 }, { id: "e", role: "evidence", purpose: "演示旋盖", durationSec: 10 }, { id: "c", role: "cta", purpose: "查看商品卡", durationSec: 10 }], target: "product_click", strategyConflict: "",
      };
      else if (stage === "review") result = { supported: true, issues: [], claimChecks: payload.draft.segments.filter(s => s.claimIds.length).map(s => ({ segmentId: s.id, statement: s.script, supported: true, sourceIds: ["rotation", evidenceId], reason: "仅采用旋盖事实和演示证据" })), targetMatches: true, filmingFeasible: true, strategyConflict: "" };
      else if (stage === "patch") {
        const pack = structuredClone(payload.base);
        for (const s of pack.segments) if (s.role === payload.operation) s.script = s.role === "hook" ? "先看盖子怎么打开，选杯子之前把使用方式看明白。" : s.role === "cta" ? "打开当前商品卡查看规格，确认适合自己的日常使用场景。" : "合成杯采用旋盖，跟着镜头看清旋开与旋紧的操作。";
        setApplications(pack, c);
        result = { segments: pack.segments.filter(s => s.role === payload.operation), applications: pack.applications };
      } else {
        const byKind = Object.fromEntries(c.candidates.map(x => [x.card.kind, x.id]));
        const common = { knowledgeIds: [], caseIds: [] };
        result = { title: "合成旋盖演示", target: "product_click", segments: [
          { ...common, id: "h", role: "hook", script: "选杯子时，不清楚盖子怎么打开，可以先看看使用动作。", visual: "展示杯子及杯盖", durationSec: 10, componentIds: [byKind.hook, byKind.structure], claimIds: [], evidenceIds: [] },
          { ...common, id: "e", role: "evidence", script: "合成杯采用旋盖，镜头展示旋开与旋紧动作，实际操作看得更清楚。", visual: "按证据展示手部旋开旋紧动作", durationSec: 10, componentIds: [byKind.visual, byKind.sop], claimIds: ["rotation"], evidenceIds: [evidenceId] },
          { ...common, id: "c", role: "cta", script: "需要了解具体规格，可以打开当前商品卡，看看是否适合自己。", visual: "展示商品卡入口", durationSec: 10, componentIds: [], claimIds: [], evidenceIds: [] },
        ], applications: [], filmingChecklist: ["准备本商品和手部旋盖镜头"], pendingConfirmations: [] };
        setApplications(result, c); lastPack = result;
      }
      if (options.respond) result = await options.respond({ stage, payload, result, f, calls });
      return { content: JSON.stringify(result), latencyMs: 1, provider: "synthetic", model: "synthetic", profile: "max" };
    },
  });
  const generate = (overrides = {}) => f.route("tasks/[taskId]/generate").POST(f.request("POST", { revision: 1, baseVersion: 0, idempotencyKey: "run-one", ...overrides }), { params: Promise.resolve({ taskId: task.id }) });
  return { ...f, calls, task, product, evidenceId, componentIds, brief, generate, lastPack: () => lastPack };
}

function setApplications(pack, context) {
  const fields = { claim: "claimIds", evidence: "evidenceIds", component: "componentIds", knowledge: "knowledgeIds", case: "caseIds" };
  pack.applications = context.sources.map(source => {
    const segments = pack.segments.filter(s => s[fields[source.type]].includes(source.id));
    return { sourceId: source.id, sourceType: source.type, used: segments.length > 0, sourceQuote: segments.length ? source.text.split("\n")[0] : "", segmentIds: segments.map(s => s.id), draftQuote: segments[0]?.script ?? "", reason: segments.length ? "用于当前功能段，依据来自已确认资料" : "与本次单一卖点无关，未采用", notTransferred: source.type === "case" ? "不迁移原作者身份与销量" : "" };
  });
}
