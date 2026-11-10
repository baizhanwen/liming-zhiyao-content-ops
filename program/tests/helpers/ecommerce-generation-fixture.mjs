import { ecommerceFixture } from "./ecommerce-fixture.mjs";

export async function ecommerceGenerationFixture(t, options = {}) {
  const f = await ecommerceFixture(t); await f.enable(); const initial = await f.saveProduct();
  const evidenceResponse = await f.route("evidence").POST(f.request("POST", { productId: initial.id, title: "合成旋盖演示", kind: "demonstration", body: "合成杯采用旋盖。演示旋开与旋紧动作。", sourceLocator: "合成测试资料，不代表真实商品", status: "confirmed" }));
  const evidenceId = (await evidenceResponse.json()).evidence.id;
  const product = await f.saveProduct({ id: initial.id, revision: 1, status: "confirmed", publicData: { ...f.productInput.publicData, claims: [{ id: "rotation", kind: "demonstration", statement: "合成杯采用旋盖", allowedExpression: "合成杯采用旋盖", evidenceIds: [evidenceId], status: "confirmed" }] } });
  f.seed("content_strategies", { id: "commerce-strategy", name: "测试策略", version: 1, status: "active", positioning: "日常商品使用演示", target_audience: "日常使用者", style_notes: "自然口语", pain_points_json: "[]", topic_mix_json: "{}", cadence: "", conversion_path: "", pillars_json: '["FORBIDDEN_PILLAR"]', persona: "FORBIDDEN_PERSONA", objectives_json: '["FORBIDDEN_DEFAULT_GOAL"]' });
  const componentIds = [];
  for (const kind of ["hook", "visual", "structure", "sop"]) {
    const r = await f.route("components").POST(f.request("POST", { name: `合成${kind}`, kind, instruction: ["hook", "structure"].includes(kind) ? "按已确认的场景和证据组织文案" : "按已确认的场景和证据组织镜头", problem: "展示旋盖操作", platforms: ["douyin"], targets: ["product_click"], inputContract: "商品事实与旋盖证据", outputContract: ["hook", "structure"].includes(kind) ? "文案与来源说明" : "镜头与拍摄说明", sourceLocator: "synthetic fixture", sourceVersion: "1", authorization: "合成测试", status: "confirmed" }));
    if (r.status !== 201) throw new Error(await r.text()); componentIds.push((await r.json()).component.id);
  }
  const brief = { referenceMode: "method", audience: { user: "日常使用者", buyer: "日常购买者", status: "confirmed" }, scene: "日常喝水", barrier: "不清楚盖子如何打开", claimId: "rotation", evidenceIds: [evidenceId], platform: "douyin", target: "product_click", destination: "当前商品卡查看规格", filming: ["product", "hands"], durationSec: 30 };
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
      const currentClaimId = c.product.claim.id, currentEvidenceId = c.evidence[0].id;
      const simpleProduct = currentClaimId.startsWith("product-claim:");
      const simpleFact = c.product.specification || `${c.product.name}属于${c.product.category}`;
      const evidenceCopy = simpleProduct ? `已确认的商品信息是：${simpleFact}。选购前请结合自己的使用需要，再核对详细资料。` : "合成杯采用旋盖，可以旋开与旋紧。先核对这一使用方式，再看看是否适合自己。";
      calls.push({ stage, payload, input });
      if (options.onCall) await options.onCall({ stage, payload, f, calls });
      let result;
      if (stage === "plan") result = {
        choices: c.candidates.map(x => ({ kind: x.card.kind, componentId: x.id, reason: "符合本次演示条件" })),
        outline: [{ id: "h", role: "hook", purpose: "提出使用问题", durationSec: 10 }, { id: "e", role: "evidence", purpose: "演示旋盖", durationSec: 10 }, { id: "c", role: "cta", purpose: "查看商品卡", durationSec: 10 }], target: "product_click", strategyConflict: "",
      };
      else if (stage === "review") result = { supported: true, issues: [], claimChecks: payload.draft.segments.filter(s => s.claimIds.length).map(s => ({ segmentId: s.id, statement: s.script, supported: true, sourceIds: [currentClaimId, currentEvidenceId], reason: "仅采用旋盖事实和演示证据" })), targetMatches: true, strategyConflict: "" };
      else if (stage === "patch") {
        const pack = structuredClone(payload.base);
        for (const s of pack.segments) if (s.role === payload.operation) s.script = s.role === "hook" ? "先看盖子怎么打开，选杯子之前把使用方式看明白。" : s.role === "cta" ? "打开当前商品卡查看规格，确认适合自己的日常使用场景。" : simpleProduct ? evidenceCopy : "合成杯采用旋盖，可以旋开与旋紧。选杯子前先确认这种使用方式是否适合自己。";
        setApplications(pack, c);
        result = { segments: pack.segments.filter(s => s.role === payload.operation), applications: pack.applications };
      } else {
        const byKind = Object.fromEntries(c.candidates.map(x => [x.card.kind, x.id]));
        const common = { knowledgeIds: [], caseIds: [] };
        result = { title: "合成旋盖演示", target: "product_click", segments: [
          { ...common, id: "h", role: "hook", script: simpleProduct ? "了解一款商品之前，先从已经确认的商品信息开始，看看是否符合自己的日常需要。" : "选杯子时，不清楚盖子怎么打开，可以先了解它的使用方式。", durationSec: 10, componentIds: [byKind.hook, byKind.structure].filter(Boolean), claimIds: [], evidenceIds: [], caseIds: c.cases.map(reference => reference.id) },
          { ...common, id: "e", role: "evidence", script: evidenceCopy, durationSec: 10, componentIds: [], claimIds: [currentClaimId], evidenceIds: [currentEvidenceId] },
          { ...common, id: "c", role: "cta", script: "需要了解具体规格，可以打开当前商品卡，看看是否适合自己。", durationSec: 10, componentIds: [], claimIds: [], evidenceIds: [] },
        ], applications: [], pendingConfirmations: [] };
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
