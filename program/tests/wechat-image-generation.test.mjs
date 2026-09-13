import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("WeChat image content parser enforces a complete structured poster", async () => {
  const generation = await import("../lib/wechat-image-generation.ts");
  const value = generation.parseWechatImageContent(JSON.stringify({
    eyebrow: "老板学 AI",
    title: "中小企业老板必须懂的 5 个 AI 概念",
    subtitle: "不需要会写代码，也能判断 AI 项目值不值得做",
    quote: "老板要懂的不是术语，而是每个概念对应的经营变量。",
    sections: [
      { heading: "大模型", body: "负责理解和生成内容，是多数 AI 应用的能力底座。" },
      { heading: "知识库", body: "把企业自己的资料接入模型，减少回答偏差和信息断层。" },
      { heading: "智能体", body: "让模型能够拆任务、调用工具并按照流程持续执行。" },
      { heading: "工作流", body: "把稳定步骤固化下来，让 AI 从演示走向可重复交付。" },
    ],
    conclusion: "先找高频、规则清楚、结果可检验的流程，再决定模型和工具。",
    cta: "先从一个真实业务流程开始",
    footer: "利明智耀 · 企业 AI 落地",
  }));
  assert.equal(value.sections.length, 4);
  assert.equal(value.title, "中小企业老板必须懂的 5 个 AI 概念");
  assert.throws(() => generation.parseWechatImageContent('{"title":"字段不完整"}'));
});

test("WeChat image parser repairs optional presentation fields and trims oversized copy", async () => {
  const generation = await import("../lib/wechat-image-generation.ts");
  const value = generation.parseWechatImageContent(JSON.stringify({
    title: "AI 项目为什么总是落不了地",
    subtitle: "从业务问题、流程和验收方式重新理解企业 AI 落地",
    quote: "先定义业务问题，再决定是否需要 AI。",
    sections: Array.from({ length: 4 }, (_, index) => ({ heading: `关键点 ${index + 1}`, body: "从真实业务流程出发，明确输入、输出、责任人和可以验证的结果。" })),
    conclusion: "小步验证，持续复盘，再逐步扩大应用范围。",
    cta: "这是一段明显超过原有三十六字符限制并且需要被系统自动压缩处理的行动引导文案，请立即收藏并转发给团队成员",
  }), { brandName: "利明智耀" });
  assert.equal(value.eyebrow, "主题知识图解");
  assert.equal(value.footer, "利明智耀");
  assert.ok(Array.from(value.cta).length <= 48);
});

test("poster engine selects structurally different layouts without another model call", async () => {
  const infographic = await import("../lib/wechat-infographic.ts");
  const listCandidates = infographic.templateCandidates("list", "3:4");
  const sequenceCandidates = infographic.templateCandidates("sequence", "16:9");
  const choices = infographic.templateChoicesForRatio("3:4");
  assert.equal(choices.length, 7);
  assert.equal(new Set(choices.map((item) => item.name)).size, 7);
  assert.ok(listCandidates.length > 0);
  assert.ok(sequenceCandidates.length > 0);
  assert.ok(listCandidates.every((item) => item.adaptive || item.structure === "list"));
  assert.ok(sequenceCandidates.every((item) => item.adaptive || item.structure === "sequence"));
  assert.deepEqual(choices.map((item) => item.label), ["经营决策路径", "双栏对照", "阶段系统", "四色矩阵", "环形要素", "分层金字塔", "营销漏斗"]);
  assert.equal(infographic.pickInfographicTemplate("quadrant", "3:4").name, "studio-operating-path");
});

test("WeChat image workspace uses project knowledge and exports locally", async () => {
  const [workspace, route, shell, manifest] = await Promise.all([
    readFile(new URL("../components/WechatImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/wechat-images/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(manifest, /"html-to-image"/);
  assert.doesNotMatch(manifest, /"@antv\/infographic"/);
  assert.match(workspace, /WechatPosterCanvas/);
  assert.match(workspace, /toPng\(posterRef\.current/);
  assert.match(workspace, /16:9/);
  assert.match(workspace, /4:3/);
  assert.match(workspace, /selectedRatio\.width/);
  assert.match(workspace, /换一个版式/);
  assert.match(workspace, /选择成熟版式/);
  assert.match(workspace, /不会增加 Token 消耗/);
  assert.match(workspace, /没有在服务器保存临时文件/);
  assert.match(workspace, /品牌知识自动继承/);
  assert.match(route, /k\.status = 'confirmed'/);
  assert.match(route, /content_strategies/);
  assert.match(route, /buildProjectGenerationContext/);
  assert.match(route, /assertProjectGenerationContext/);
  assert.match(route, /profile: "max"/);
  assert.doesNotMatch(route, /retrieveAuthorizedKnowledge|authorizedKnowledge|\.original\b/);
  assert.match(route, /INVALID_WECHAT_IMAGE_RATIO/);
  assert.match(route, /wechat_image\.generated/);
  assert.match(shell, /公众号图片/);
  assert.match(shell, /href: "\/wechat-images"/);
});
