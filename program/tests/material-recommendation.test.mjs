import assert from "node:assert/strict";
import test from "node:test";
import { materialFeedbackPrompt, recommendMaterials, scoreMaterialCandidate } from "../lib/material-recommendation.ts";

const context = {
  topic: "中小企业老板必须懂的 AI 智能体与知识库",
  audience: "中小企业老板 管理者",
  structure: "数字清单开场，五个概念，结尾总结",
  conversion: "建立专业认知，引导咨询和收藏",
};

function candidate(id, title, overrides = {}) {
  return {
    id,
    title,
    tags: ["企业AI", "老板"],
    analysisText: "开场用数字清单形成钩子，正文分步骤解释智能体和知识库，结尾引导收藏与咨询。",
    directPerformance: {},
    feedback: { usageCount: 0, approvedCount: 0, changesRequestedCount: 0, manualRevisionCount: 0, commentCount: 0, publishedCount: 0, performance: {} },
    ...overrides,
  };
}

test("material recommendation scores topic, audience, structure, conversion and outcome separately", () => {
  const scored = scoreMaterialCandidate(candidate("a", "老板必须懂的五个 AI 概念", {
    directPerformance: { views: 100_000, saves: 2_000 },
    feedback: { usageCount: 2, approvedCount: 2, changesRequestedCount: 0, manualRevisionCount: 0, commentCount: 0, publishedCount: 1, performance: { views: 30_000, leads: 12 } },
  }), context);
  assert.ok(scored.score > 0);
  assert.ok(scored.scores.topic > 0);
  assert.ok(scored.scores.audience > 0);
  assert.ok(scored.scores.structure > 0);
  assert.ok(scored.scores.conversion > 0);
  assert.ok(scored.scores.performance > 0);
  assert.ok(scored.scores.feedback > 0);
  assert.equal(scored.hasOutcomeData, true);
  assert.ok(scored.reasons.some((reason) => reason.includes("真实")));
});

test("material recommendation returns three to five defaults and keeps the rest adjustable", () => {
  const candidates = [1, 2, 3, 4, 5, 6].map((id) => candidate(String(id), `企业 AI 概念 ${id}`));
  const result = recommendMaterials(candidates, context);
  assert.ok(result.recommendedIds.length >= 3);
  assert.ok(result.recommendedIds.length <= 5);
  assert.equal(result.entries.length, 6);
  assert.equal(result.entries.filter((entry) => entry.recommended).length, result.recommendedIds.length);
});

test("feedback prompt exposes review and publication signals without claiming causality", () => {
  const prompt = materialFeedbackPrompt({ usageCount: 3, approvedCount: 2, changesRequestedCount: 1, manualRevisionCount: 2, commentCount: 4, publishedCount: 1, performance: { views: 1234, leads: 8 } });
  assert.match(prompt, /审核通过 2 次/);
  assert.match(prompt, /退回修改 1 次/);
  assert.match(prompt, /不代表.*因果关系/);
});
