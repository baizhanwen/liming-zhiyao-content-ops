import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("stage three persists content versions, prompt registry, calls, and citations", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const table of ["content_items", "content_versions", "content_citations", "prompt_templates", "model_calls"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /idx_content_versions_item_version/);
  assert.match(schema, /idx_prompt_templates_one_active/);
  assert.match(schema, /currentVersion: integer\("current_version"\)/);
});

test("production pack uses a strict Zod contract and traceable citations", async () => {
  const production = await import("../lib/content-production.ts");
  const pack = production.createProductionScaffold({ id: "topic-1", title: "客户为什么总在最后一步犹豫" });
  assert.equal(production.productionPackSchema.safeParse(pack).success, true);
  assert.equal(pack.citations[0].sourceId, "topic-1");
  assert.equal(production.productionPackSchema.safeParse({ ...pack, citations: [] }).success, false);
  assert.equal(production.productionPackSchema.safeParse({ ...pack, invented: true }).success, false);
  assert.equal(production.citationQuoteMatchesSource("智能体 = 能完成一类任务，需要明确边界。", "“智能体=能完成一类任务”"), true);
  assert.equal(production.citationQuoteMatchesSource("只有短句", "只有短句"), false);
  assert.equal(production.productionCitationSchema.safeParse({ sourceType: "knowledge", sourceId: "k-1", quote: "太短" }).success, false);
  assert.equal(production.citationQuoteMatchesSource("智能体需要明确边界", "智能体什么都能做"), false);
  assert.equal(production.citationQuoteMatchesSource("转化率是 1.5%", "转化率是 15%"), false);
  const longCitationSource = "企业做人工智能项目时，应该先确定具体业务场景、真实使用人员、执行流程和验收指标，再决定采用哪一种模型、工具与技术方案，避免先买工具再寻找用途。实施前还要确认数据来源、责任人员、验收周期和失败后的回退方案。";
  assert.equal(longCitationSource.length > 80, true);
  const bounded = production.normalizeGeneratedProductionPackTextBounds({
    ...pack,
    hashtags: ["#企业人工智能内容方法与业务流程优化实践经验".repeat(4)],
    adaptations: [{ platform: "抖音企业号短视频内容发布平台".repeat(6), copy: "适配文案" }],
    citations: [{ sourceType: "knowledge", sourceId: "k-long", quote: longCitationSource }],
  });
  const boundedResult = production.productionPackSchema.safeParse(bounded);
  assert.equal(boundedResult.success, true);
  assert.equal(boundedResult.data.citations[0].quote.length <= 80, true);
  assert.equal(boundedResult.data.hashtags[0].length <= 80, true);
  assert.equal(boundedResult.data.adaptations[0].platform.length <= 80, true);
  assert.equal(production.citationQuoteMatchesSource(longCitationSource, boundedResult.data.citations[0].quote), true);
  const invalidBound = { ...pack, hashtags: ["过长".repeat(41)] };
  assert.match(production.productionPackValidationIssue(production.productionPackSchema.safeParse(invalidBound).error, invalidBound), /hashtags\.0.*实际长度 82/);
  assert.equal(production.CONTENT_OUTPUT_SCHEMA.properties.citations.items.properties.quote.maxLength, 80);
  assert.equal(production.CONTENT_OUTPUT_SCHEMA.properties.hashtags.items.maxLength, 80);
  assert.equal(production.CONTENT_OUTPUT_SCHEMA.properties.adaptations.items.properties.platform.maxLength, 80);
  const usage = production.buildSourceUsageReport([
    { sourceType: "strategy", sourceId: "strategy-1" },
    { sourceType: "knowledge", sourceId: "knowledge-1" },
  ], [
    { sourceType: "strategy", sourceId: "strategy-1", quote: "面向中小企业老板提供可执行建议" },
    { sourceType: "knowledge", sourceId: "knowledge-1", quote: "企业人工智能应该先选择具体业务场景" },
  ], ["knowledge-1"]);
  assert.equal(usage.status, "verified");
  assert.equal(usage.groups.find((group) => group.key === "selected_knowledge")?.citedCount, 1);

  const partialBenchmarks = production.buildSourceUsageReport([
    { sourceType: "benchmark", sourceId: "benchmark-1" },
    { sourceType: "benchmark", sourceId: "benchmark-2" },
  ], [
    { sourceType: "benchmark", sourceId: "benchmark-1", quote: "先用具体问题建立开头的认知缺口" },
  ]);
  assert.equal(partialBenchmarks.status, "partial");
  assert.equal(partialBenchmarks.checks.find((check) => check.key === "benchmark")?.passed, false);
  assert.match(partialBenchmarks.checks.find((check) => check.key === "benchmark")?.detail ?? "", /选择 2 条.*只有 1 条/);
  const completeBenchmarks = production.buildSourceUsageReport([
    { sourceType: "benchmark", sourceId: "benchmark-1" },
    { sourceType: "benchmark", sourceId: "benchmark-2" },
  ], [
    { sourceType: "benchmark", sourceId: "benchmark-1", quote: "先用具体问题建立开头的认知缺口" },
    { sourceType: "benchmark", sourceId: "benchmark-2", quote: "使用反面案例提醒观众避开常见错误" },
  ]);
  assert.equal(completeBenchmarks.status, "verified");
  assert.match(production.CONTENT_SYSTEM_PROMPT, /每条输入 benchmark 都必须在 citations 中逐条引用/);
  assert.match(production.CONTENT_SYSTEM_PROMPT, /benchmarkMethods 必须与输入中的 benchmark 逐条对应且不得遗漏/);

  const layers = production.partitionContentPromptSources([
    { sourceType: "topic", sourceId: "topic-1", title: "选题任务", text: "待验证的选题假设" },
    { sourceType: "knowledge", sourceId: "fact-1", title: "企业事实", text: "真实产品资料" },
    { sourceType: "method_knowledge", sourceId: "method-1", title: "写作方法", text: "先确定核心主张" },
    { sourceType: "benchmark", sourceId: "example-1", title: "对标案例", text: "样本中的案例与数字" },
  ]);
  assert.deepEqual(layers.taskSources.map((source) => source.sourceId), ["topic-1"]);
  assert.deepEqual(layers.projectFacts.map((source) => source.sourceId), ["fact-1"]);
  assert.deepEqual(layers.methodology.map((source) => source.sourceId), ["method-1"]);
  assert.deepEqual(layers.referenceExamples.map((source) => source.sourceId), ["example-1"]);
});

test("video analysis reference text carries bounded structured findings, scripts, and time-coded evidence", async () => {
  const production = await import("../lib/content-production.ts");
  const report = {
    summary: "这条视频用具体工作场景解释抽象方法。",
    hook: "先抛出老板最常遇到的问题。",
    structure: [{ stage: "开场", role: "建立认知缺口" }, { stage: "正文", role: "用三步法拆解" }],
    audience: "正在尝试使用 AI 的中小企业管理者",
    hook_analysis: ["问题开场在前五秒交代观看理由"],
    visual: [{ scene: "办公室近景", visual_role: "建立真实工作语境" }],
    language: ["短句为主，先结论后解释"],
    highlights: ["把抽象概念转成日常管理动作"],
    cta_analysis: {
      detected: true,
      summary: "结尾给出明确的评论互动指令。",
      items: [{ type: "评论互动", placement: "结尾", quote: "评论区说说你最想改造哪个环节。", target_action: "评论", conversion_path: "评论互动→后续私信", strength: "中", recommendation: "补充评论后可获得的具体价值。" }],
    },
    evidence: [
      { start_ms: 19_000, end_ms: 21_000, source: "asr", text: "先别急着买工具，先找到重复工作。", confidence: 0.96 },
      { start_ms: 22_000, source: "ocr", text: "第一步：找重复环节", confidence: 92 },
      { start_ms: 25_000, source: "vision", text: "人物指向白板上的三步流程", confidence: 88 },
      { start_ms: 41_000, source: "asr", text: "评论区说说你最想改造哪个环节。", confidence: 0.94 },
    ],
    transcript: { segments: [{ start_ms: 19_000, end_ms: 21_000, text: "先别急着买工具，先找到重复工作。", source: "asr" }] },
    keyframes: [{ timestamp_ms: 28_000, ocr_text: "先流程，后工具", source: "keyframe" }],
    insight_evidence: [
      { section: "highlights", item_index: 0, evidence_text: "先别急着买工具，先找到重复工作。" },
      { section: "visual", item_index: 0, evidence_text: "人物指向白板上的三步流程" },
      { section: "cta_analysis", item_index: 0, evidence_text: "评论区说说你最想改造哪个环节。" },
    ],
    spoken_script_set: {
      corrected_original: {
        status: "completed",
        text: "先别急着买工具。先找到业务里每天都在重复的工作。",
        paragraphs: ["不应重复采用的候选段落"],
        source_segment_ids: ["segment-1"],
        provenance: { mapping_repairs: 99 },
        validation: { passed: true, source_segment_coverage_percent: 100 },
      },
    },
    analysis_meta: {
      processing_mode: "segmented",
      duration_minutes: 1.2,
      analyzed_segments: 12,
      source_segments: 12,
      transcript_coverage_percent: 100,
      evidence_coverage_percent: 95,
      visual_extraction: { kept_count: 8, target_count: 10, scene_count: 6, visual_understanding: { observation_count: 5 } },
    },
    ignored_payload: "不应进入已识别结构".repeat(10_000),
  };
  const text = production.analysisReportSourceText(JSON.stringify(report));
  assert.ok(text.length <= production.ANALYSIS_REPORT_SOURCE_TEXT_LIMIT);
  for (const expected of ["【开头抓手】", "【内容结构】", "阶段：开场", "【目标受众】", "【CTA 分析】", "CTA 明细", "目标动作：评论", "【视觉分析】", "【语言分析】", "【经校正原版口播】", "【分析覆盖摘要】", "关键帧：8/10", "【带时间码的 ASR／OCR／关键帧证据】", "【结论与证据绑定】"]) assert.match(text, new RegExp(expected));
  assert.match(text, /\[00:19–00:21\].*ASR.*先别急着买工具/);
  assert.match(text, /\[00:22\].*OCR.*第一步：找重复环节/);
  assert.match(text, /\[00:25\].*关键帧\/视觉.*人物指向白板/);
  assert.match(text, /\[00:28\].*关键帧\/视觉.*先流程，后工具/);
  assert.match(text, /亮点\[1\] ← \[00:19–00:21\] ASR/);
  assert.match(text, /CTA 分析\[1\] ← \[00:41\] ASR/);
  assert.match(text, /状态：completed.*验收：通过.*来源片段覆盖：100%/s);
  assert.doesNotMatch(text, /mapping_repairs|source_segment_ids|ignored_payload|不应进入已识别结构/);
  assert.equal(text.match(/先别急着买工具，先找到重复工作。/g)?.length, 1);

  const saturated = production.analysisReportSourceText(JSON.stringify({
    ...report,
    ...Object.fromEntries(["summary", "hook", "structure", "audience", "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve", "conversion_design", "cta_analysis", "visual", "language", "highlights", "risks", "recommendations"].map((key) => [key, [`${key}完整分析`.repeat(1_000)]])),
    spoken_script_set: { corrected_original: { status: "completed", text: "完整口播".repeat(2_000), validation: { passed: true } } },
  }));
  assert.ok(saturated.length <= production.ANALYSIS_REPORT_SOURCE_TEXT_LIMIT);
  assert.match(saturated, /【带时间码的 ASR／OCR／关键帧证据】/);
  assert.match(saturated, /【结论与证据绑定】/);
});

test("content APIs enforce tenant access, immutable versions, and optimistic writes", async () => {
  const [collection, version, generation] = await Promise.all([
    readFile(new URL("../app/api/content-items/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /getProjectAccess/);
  assert.match(collection, /createProductionScaffold/);
  assert.match(collection, /content_citations/);
  assert.match(version, /current_version = \?/);
  assert.match(version, /CONTENT_VERSION_CONFLICT/);
  assert.match(version, /INVALID_CONTENT_CITATION/);
  assert.match(generation, /productionPackSchema\.safeParse/);
  assert.match(generation, /normalizeGeneratedProductionPackTextBounds/);
  assert.match(generation, /productionPackValidationIssue/);
  assert.match(generation, /模型响应不是完整 JSON 对象/);
  assert.match(generation, /UNTRACEABLE_MODEL_CITATION/);
  assert.match(generation, /ACTIVE_STRATEGY_REQUIRED/);
  assert.match(generation, /CONFIRMED_KNOWLEDGE_REQUIRED/);
  assert.match(generation, /SELECTED_KNOWLEDGE_CITATION_REQUIRED/);
  assert.match(generation, /buildSourceUsageReport/);
  assert.match(generation, /selectAuthorizedMethodologyPlan/);
  assert.match(generation, /methodologyPlan: methodologyPlan\.snapshot/);
  assert.match(generation, /METHODOLOGY_PLAN_CITATION_REQUIRED/);
  assert.match(generation, /systemMethodology: true/);
  assert.match(generation, /for \(let attempt = 0; attempt < 2 && !pack; attempt \+= 1\)/);
  assert.match(generation, /prompt_templates/);
  assert.match(generation, /model_calls/);
  assert.match(generation, /COALESCE\(v\.title, v\.source_url/);
  assert.doesNotMatch(generation, /v\.filename/);
});

test("model adapter keeps provider credentials server-side and supports profiles", async () => {
  const adapter = await readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /CONTENT_MODEL_API_KEY/);
  assert.match(adapter, /CONTENT_MODEL_BASE_URL/);
  assert.match(adapter, /authorization: `Bearer/);
  assert.match(adapter, /requestBody\.response_format = \{ type: "json_object" \}/);
  assert.match(adapter, /input\.nativeJson !== false/);
  assert.doesNotMatch(adapter, /NEXT_PUBLIC/);
});

test("content production is a real routed workspace rather than a dashboard anchor", async () => {
  const [shell, page, workspace] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/content/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /href: "\/content"/);
  assert.match(page, /ContentProductionWorkspace/);
  assert.match(workspace, /AI 生成新版本/);
  assert.match(workspace, /保存为新版本/);
  assert.match(workspace, /事实引用/);
});
