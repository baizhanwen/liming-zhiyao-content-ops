// Deterministic synthetic model server for the browser integration test.
// Exercises the real HTTP adapter, recording, validation and persistence.
// This is not evidence of real-model writing quality or real SKU performance.
export function createEcommerceTestModel() {
  const calls = [];
  let gate = null;
  const fields = { claim: "claimIds", evidence: "evidenceIds", component: "componentIds", knowledge: "knowledgeIds", case: "caseIds" };
  function applications(pack, context) {
    return context.sources.map(source => {
      const segments = pack.segments.filter(s => s[fields[source.type]].includes(source.id));
      return {
        sourceId: source.id, sourceType: source.type, used: segments.length > 0,
        sourceQuote: segments.length ? source.text.split("\n")[0] : "",
        segmentIds: segments.map(s => s.id), draftQuote: segments[0]?.script ?? "",
        reason: segments.length ? "用于本段说明已确认规格及文案结构" : "本次只讲容量规格，不采用此方法",
        notTransferred: source.type === "case" ? "不迁移原作者身份、经历与经营结果" : "",
      };
    });
  }
  return {
    calls,
    holdNext() {
      let release, entered;
      const wait = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      gate = { wait, entered };
      return { release, started };
    },
    async respond(request) {
      if (new URL(request.url).origin !== "https://model.example.invalid") return new Response("External access disabled in synthetic test", { status: 502 });
      const input = await request.json();
      const { stage, payload } = JSON.parse(input.messages.find(m => m.role === "user").content);
      const c = payload.context, claim = c.product.claim, evidence = c.evidence[0];
      const fact = c.product.specification || claim.statement;
      calls.push({ stage, payload });
      if (gate) { const held = gate; gate = null; held.entered(); await held.wait; }
      let result;
      if (stage === "plan") {
        result = {
          choices: [...new Set(c.candidates.map(candidate => candidate.card.kind))].map(kind => ({ kind, componentId: c.candidates.find(x => x.card.kind === kind).id, reason: "符合本次规格说明与文案目标" })),
          outline: [{ id: "h", role: "hook", purpose: "引出使用场景", durationSec: 10 }, { id: "e", role: "evidence", purpose: "展示容量规格", durationSec: 10 }, { id: "c", role: "cta", purpose: "查看商品卡", durationSec: 10 }],
          target: c.task.brief.target, strategyConflict: "",
        };
      } else if (stage === "review") {
        result = { supported: true, issues: [], claimChecks: payload.draft.segments.filter(s => s.claimIds.length || s.evidenceIds.length).map(s => ({ segmentId: s.id, statement: s.script, supported: true, sourceIds: [claim.id, evidence.id], reason: "仅使用已确认规格，没有新增效果承诺" })), targetMatches: true, strategyConflict: "" };
      } else if (stage === "patch") {
        const pack = structuredClone(payload.base);
        for (const segment of pack.segments) if (segment.role === payload.operation) {
          segment.script = segment.role === "hook" ? "桌面喝水该选什么杯子？先从看清商品规格开始。" : segment.role === "evidence" ? `这款合成验收杯${fact}，对照规格资料看清标注，再考虑自己的使用需要。` : "打开当前商品卡核对规格，再决定是否适合你的日常使用。";
        }
        result = { segments: pack.segments.filter(s => s.role === payload.operation), applications: applications(pack, c) };
      } else if (stage === "draft" || stage === "repair") {
        const chosen = Object.fromEntries((payload.plan?.choices ?? []).map(x => [x.kind, x.componentId]));
        if (!chosen.hook) for (const candidate of c.candidates) chosen[candidate.card.kind] ??= candidate.id;
        const common = { knowledgeIds: [], caseIds: [] };
        result = {
          title: "合成验收杯的容量说明", target: c.task.brief.target,
          segments: [
            { ...common, id: "h", role: "hook", script: "桌面喝水选杯子，先把规格看明白，再看看是否符合日常需要。", durationSec: 10, componentIds: [chosen.hook, chosen.structure].filter(Boolean), claimIds: [], evidenceIds: [], caseIds: c.cases.map(reference => reference.id) },
            { ...common, id: "e", role: "evidence", script: `这款合成验收杯${fact}，可以对照规格资料核对，只介绍已经确认的信息。`, durationSec: 10, componentIds: [], claimIds: [claim.id], evidenceIds: [evidence.id] },
            { ...common, id: "c", role: "cta", script: "想继续了解，可以打开当前商品卡查看规格，结合自己的使用需要再决定。", durationSec: 10, componentIds: [], claimIds: [], evidenceIds: [] },
          ], applications: [], pendingConfirmations: [],
        };
        result.applications = applications(result, c);
      } else throw new Error(`Unexpected ecommerce stage: ${stage}`);
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
    },
  };
}
