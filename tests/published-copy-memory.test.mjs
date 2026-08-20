import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("published copy analyzer learns length, hook, CTA, tone, and monetization", async () => {
  const memory = await import("../lib/published-copy.ts");
  const analysis = memory.analyzePublishedCopy("为什么很多企业的 AI 项目总是落不了地？\n\n第一，先定义业务问题。第二，明确验收标准。\n\n需要方案可以私信我预约企业 AI 诊断。");
  assert.equal(analysis.hookType, "question");
  assert.equal(analysis.ctaType, "private_message");
  assert.ok(analysis.characterCount > 20);
  assert.ok(analysis.paragraphCount >= 3);
  assert.ok(analysis.monetizationTypes.includes("private_message"));
  assert.ok(analysis.monetizationTypes.includes("consultation"));
  assert.ok(analysis.toneTags.includes("方法型"));
});

test("historical copy retrieval stays inside supplied project records and ranks relevant titles", async () => {
  const memory = await import("../lib/published-copy.ts");
  const record = (id, title, body) => ({ id, title, body, platform: "douyin", content_format: "spoken_script", source_type: "manual", published_at: null, external_url: null, character_count: body.length, paragraph_count: 1, monetization_types_json: "[]", monetization_detail: null, analysis_json: JSON.stringify(memory.analyzePublishedCopy(body)), performance_json: "{}", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  const matches = memory.selectRelevantPublishedCopies([
    record("sales", "销售团队管理", "如何建立销售流程"),
    record("ai", "企业 AI 落地", "老板如何判断智能体和工作流"),
  ], "中小企业老板如何做 AI 落地和智能体", 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.id, "ai");
});

test("brand expression profile weights proven hooks, CTA and character range", async () => {
  const memory = await import("../lib/published-copy.ts");
  const record = (id, title, body, performance) => ({ id, title, body, platform: "douyin", content_format: "spoken_script", source_type: "manual", published_at: null, external_url: null, character_count: memory.countCopyCharacters(body), paragraph_count: 2, monetization_types_json: JSON.stringify(["consultation"]), monetization_detail: null, analysis_json: JSON.stringify(memory.analyzePublishedCopy(body, ["consultation"])), performance_json: JSON.stringify(performance), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  const profile = memory.buildPublishedCopyProfile([
    record("a", "高转化对比稿", "企业做 AI 不是先买工具，而是先找业务场景。\n\n需要方案可以预约咨询。", { views: 10000, saves: 500, leads: 60, conversions: 12 }),
    record("b", "普通问题稿", "为什么很多企业 AI 项目落不了地？\n\n需要方案可以预约咨询。", { views: 8000, saves: 40, leads: 3, conversions: 0 }),
    record("c", "另一篇对比稿", "不是模型越大越好，而是业务闭环越清楚越好。\n\n需要方案可以预约咨询。", { views: 12000, saves: 420, leads: 42, conversions: 8 }),
  ]);
  assert.equal(profile.performanceSampleSize, 3);
  assert.equal(profile.confidence, "medium");
  assert.equal(profile.bestHookType.value, "contrast");
  assert.equal(profile.bestCtaType.value, "consultation");
  assert.equal(profile.bestMonetizationType.value, "consultation");
  assert.equal(profile.topPerformers[0].id, "a");
  assert.ok(profile.topPerformers[0].score > profile.topPerformers[1].score);
  assert.ok(profile.suggestedMinCharacters > 0);
  assert.ok(profile.suggestedMaxCharacters >= profile.suggestedMinCharacters);
});

test("historical style application objectively checks use and rejects copied passages", async () => {
  const memory = await import("../lib/published-copy.ts");
  const record = (id, body, performance) => ({ id, title: `样本 ${id}`, body, platform: "douyin", content_format: "spoken_script", source_type: "manual", published_at: null, external_url: null, character_count: memory.countCopyCharacters(body), paragraph_count: memory.analyzePublishedCopy(body).paragraphCount, monetization_types_json: JSON.stringify(["consultation"]), monetization_detail: null, analysis_json: JSON.stringify(memory.analyzePublishedCopy(body, ["consultation"])), performance_json: JSON.stringify(performance), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  const records = [
    record("a", "为什么企业 AI 总是落不了地？\n\n第一，先找真实场景。\n\n第二，再明确验收标准。\n\n需要方案可以预约咨询。", { views: 10000, saves: 500, leads: 60, conversions: 12 }),
    record("b", "为什么老板买了很多工具还是没结果？\n\n第一，整理业务资料。\n\n第二，固定团队流程。\n\n需要方案可以预约咨询。", { views: 9000, saves: 420, leads: 40, conversions: 8 }),
    record("c", "为什么智能体演示很好，真正使用却很难？\n\n第一，定义任务边界。\n\n第二，设置人工审核。\n\n需要方案可以预约咨询。", { views: 8000, saves: 350, leads: 35, conversions: 7 }),
  ];
  const profile = memory.buildPublishedCopyProfile(records);
  const originalDraft = "为什么企业部署智能体容易半途而废？\n\n第一，选择每天重复发生的业务任务。\n\n第二，写清负责人和交付标准。\n\n需要方案可以预约咨询。";
  const application = memory.validateHistoricalStyleApplication(originalDraft, profile, records, records.map((item) => item.id));
  assert.equal(application.status, "passed");
  assert.equal(application.originality.passed, true);
  assert.ok(application.matchedChecks >= 3);
  assert.equal(application.sourceIds.length, 3);

  const copied = memory.validateHistoricalStyleApplication(records[0].body, profile, records, ["a"]);
  assert.equal(copied.status, "rewrite");
  assert.equal(copied.originality.passed, false);
  assert.ok(copied.originality.longestSharedCharacters >= 18);
});

test("brand knowledge workspace exposes history memory, batch import and generation traces it", async () => {
  const [schema, migration, workspace, batchImport, recordUpdate, historyApi, generation, publication, production, contentWorkspace] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0016_published_copy_memory.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/KnowledgeWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/published-copy/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/published-copy/[recordId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/published-copy/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/publications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/content-production.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /publishedCopyRecords/);
  assert.match(migration, /published_copy_records/);
  assert.match(workspace, /历史发布文案/);
  assert.match(workspace, /保存并分析文案/);
  assert.match(workspace, /生成新文案时自动检索最多 5 篇/);
  assert.match(workspace, /PublishedCopyBatchImport/);
  assert.match(workspace, /高表现表达画像/);
  assert.match(workspace, /PublishedCopyPerformanceEditor/);
  assert.match(workspace, /按效果表现/);
  assert.match(batchImport, /publishedCopyImportRowSchema/);
  assert.match(batchImport, /与当前项目中已有文案重复/);
  assert.match(recordUpdate, /published_copy\.performance_updated/);
  assert.match(recordUpdate, /updatePublishedCopyPerformanceSchema/);
  assert.match(historyApi, /publication_metric_snapshots latest/);
  assert.match(historyApi, /performance_score/);
  assert.match(generation, /selectRelevantPublishedCopies/);
  assert.match(generation, /publication_metric_snapshots latest/);
  assert.match(generation, /HISTORICAL_COPY_CITATION_REQUIRED/);
  assert.match(generation, /HISTORICAL_STYLE_VALIDATION_FAILED/);
  assert.match(generation, /validateHistoricalStyleApplication/);
  assert.match(publication, /ON CONFLICT\(publication_id\) DO UPDATE/);
  assert.match(production, /historical_copy/);
  assert.match(contentWorkspace, /历史文案应用报告/);
  assert.match(contentWorkspace, /原创重复检测通过/);
});
