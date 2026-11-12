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
      const duration = c.task.brief.durationSec;
      const firstSeconds = Math.min(6, duration - 2), lastSeconds = Math.min(6, duration - firstSeconds - 1);
      const segmentSeconds = { h: firstSeconds, e: duration - firstSeconds - lastSeconds, c: lastSeconds };
      calls.push({ stage, payload });
      if (gate) { const held = gate; gate = null; held.entered(); await held.wait; }
      let result;
      if (stage === "plan") {
        const methods = payload.generationGuide.copyMethodology.methodCandidates;
        const framework = methods.frameworks[0], beats = framework?.beats ?? [];
        const factSource = payload.generationGuide.factRegister.find(source => source.sourceId === evidence.id)
          ?? payload.generationGuide.factRegister[0];
        result = {
          methodSelection: c.task.brief.referenceMode === "benchmark" ? null : { hookId: methods.hooks[0].id, frameworkId: framework.id, supplementFrameworkId: "", reason: "合成合同测试：用具体喝水场景和容量细节回应这次选杯子的顾虑。" },
          sellingPointFocus: "把桌面喝水时关心的容量讲清楚，帮助观众判断这一具体规格。",
          factPlan: [{ sourceKey: factSource.sourceKey, sourceQuote: factSource.text.includes(fact) ? fact : factSource.text.split("\n")[0], buyerMeaning: "容量是本次选择杯子时需要比较的具体信息，不扩展为使用效果。" }],
          choices: [...new Set(c.candidates.map(candidate => candidate.card.kind))].map(kind => ({ kind, componentId: c.candidates.find(x => x.card.kind === kind).id, reason: "符合本次规格说明与文案目标" })),
          outline: [{ id: "h", role: "hook", purpose: "引出桌面喝水时需要选容量的问题", methodBeats: beats.slice(0, 1), durationSec: segmentSeconds.h }, { id: "e", role: "evidence", purpose: "用本商品容量回应这次选择问题", methodBeats: beats.slice(1, -1), durationSec: segmentSeconds.e }, { id: "c", role: "cta", purpose: "到指定商品卡继续了解规格", methodBeats: beats.slice(-1), durationSec: segmentSeconds.c }],
          copyDirection: {
            hook: "从桌面喝水选杯子的具体问题切入，提醒先看清规格。",
            bridge: "把选杯子的顾虑承接到本次唯一重点：已确认的容量规格。",
            proof: `只用当前商品资料中的${fact}回应规格问题，不推断使用效果。`,
            cta: `引导到${c.task.brief.destination}，让观众核对规格后再决定。`,
            referenceAdaptation: c.cases.length ? "保留参考视频先说明规格、再引导核对的推进顺序；重写句式，不迁移作者身份、经历与经营结果。" : "",
          },
          target: c.task.brief.target, strategyConflict: "",
        };
      } else if (stage === "review") {
        result = { editorialReview: { verdict: "usable", summary: "合成合同测试：逐项返回可定位的正文片段，不代表真实模型写作质量。", missingFacts: [], checks: ["hook", "decision_value", "concrete_detail", "spoken_voice", "method_execution", "action_reason"].map(criterion => {
          const segment = payload.draft.segments[criterion === "hook" ? 0 : criterion === "action_reason" ? payload.draft.segments.length - 1 : 1];
          return { criterion, passed: true, segmentIds: [segment.id], quote: segment.script, reason: "合成合同测试：本段围绕同一使用场景，以容量信息推进选择；只验证校对回执和正文定位。" };
        }) }, supported: true, issues: [], claimChecks: payload.draft.segments.filter(s => s.claimIds.length || s.evidenceIds.length).map(s => ({ segmentId: s.id, statement: s.script, supported: true, sourceIds: [claim.id, evidence.id], reason: "仅使用已确认规格，没有新增效果承诺" })), targetMatches: true, strategyConflict: "", qualityChecks: { hookFulfilled: true, singleFocus: true, spokenNatural: true, ctaClear: true, referenceAdapted: true } };
      } else if (stage === "patch") {
        const pack = structuredClone(payload.base);
        for (const segment of pack.segments) if (segment.role === payload.operation) {
          segment.script = segment.role === "hook" ? "桌面喝水该选什么杯子？先想清楚自己需要多大容量。" : segment.role === "evidence" ? `这款合成验收杯${fact}，容量是这次选择要看的具体信息。按自己的喝水习惯来挑，决定起来更有方向。` : "打开当前商品卡查看容量规格，按你的桌面喝水需要来挑选。";
        }
        result = { segments: pack.segments.filter(s => s.role === payload.operation), applications: applications(pack, c) };
      } else if (stage === "draft" || stage === "repair") {
        const chosen = Object.fromEntries((payload.plan?.choices ?? []).map(x => [x.kind, x.componentId]));
        if (!chosen.hook) for (const candidate of c.candidates) chosen[candidate.card.kind] ??= candidate.id;
        const common = { knowledgeIds: [], caseIds: [] };
        result = {
          title: "合成验收杯的容量说明", target: c.task.brief.target,
          segments: [
            { ...common, id: "h", role: "hook", script: "桌面喝水选杯子，别只看外形，容量也要放进这次选择里。", durationSec: segmentSeconds.h, componentIds: [chosen.hook, chosen.structure].filter(Boolean), claimIds: [], evidenceIds: [], caseIds: c.cases.map(reference => reference.id) },
            { ...common, id: "e", role: "evidence", script: `这款合成验收杯${fact}。放在办公桌上日常喝水，先从容量这个具体信息出发，再结合自己的喝水习惯来选。`, durationSec: segmentSeconds.e, componentIds: [], claimIds: [claim.id], evidenceIds: [evidence.id] },
            { ...common, id: "c", role: "cta", script: "想把容量看清楚，打开当前商品卡查看规格，再按你的桌面喝水需要来挑选。", durationSec: segmentSeconds.c, componentIds: [], claimIds: [], evidenceIds: [] },
          ], applications: [], pendingConfirmations: [],
        };
        result.applications = applications(result, c);
      } else throw new Error(`Unexpected ecommerce stage: ${stage}`);
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
    },
  };
}
