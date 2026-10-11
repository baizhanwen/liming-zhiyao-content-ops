import { runtimeFixture } from "./runtime-fixture.mjs";
import * as production from "../../lib/content-production.ts";
import * as publishedCopy from "../../lib/published-copy.ts";
import * as citationRecovery from "../../lib/content-citation-recovery.ts";

export async function contentGenerationFixture(t, selected = [], respond, options = {}) {
  const f = runtimeFixture(t), installation = await f.initialize(); f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, projectId = "project", now = "2026-09-12T00:00:00.000Z";
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)); return row.id;
  };
  seed("projects", { id: projectId, name: "Project", client_name: "Account" });
  seed("projects", { id: "other", name: "Other", client_name: "Other" });
  seed("content_strategies", { id: "strategy", version: 1, name: "内容策略", status: "active", positioning: "内容策略继续指导创作方向与表达方式", target_audience: "大学生与初学者", style_notes: "口语化，避免夸大效果", persona: "PRIVATE_PERSONA", pain_points_json: '["PLANNING_PAIN"]', pillars_json: '["PLANNING_PILLAR"]', cadence: "PLANNING_CADENCE", conversion_path: "PLANNING_CONVERSION", topic_mix_json: '{"PLANNING_MIX":50}', objectives_json: '["教育"]' });
  for (const [id, project] of [["chosen", projectId], ["unselected", projectId], ["foreign", "other"]]) {
    seed("knowledge_items", { id, project_id: project, category: "case_study", title: id, status: "confirmed" });
    seed("knowledge_item_versions", { item_id: id, project_id: project, version: 1, body: `${id}品牌案例中实际发生的真实实验过程与结果。`, source_type: "manual" });
  }
  const topicId = seed("topic_ideas", { title: "如何清楚地交代一项任务", source_type: "manual", selected_knowledge_ids_json: JSON.stringify(selected) });
  // Simulate legacy auto-expanded citations, even when the user selected nothing.
  for (const id of ["chosen", "unselected"]) seed("topic_citations", { topic_id: topicId, citation_type: "knowledge", citation_id: id, quote: `${id}品牌案例中实际发生的真实实验过程与结果。` });
  const contentId = seed("content_items", { topic_id: topicId, title: "如何清楚地交代一项任务" });
  const base = { ...production.createProductionScaffold({ id: topicId, title: "如何清楚地交代一项任务" }), writingIntent: { kind: "tutorial", reason: "选题需要交代任务的具体步骤" }, fullScript: "交代一项任务时，先说明背景，再说清目标。比如请同事整理一份会议纪要，就要告诉他会议讨论了什么、纪要交给谁、哪些决定必须保留。最后约定交付时间和格式，双方复述一遍要求，才能减少来回修改。", shortScript: "交代任务时说明背景、目标和交付标准，再约定时间与格式。" };
  seed("content_versions", { content_item_id: contentId, version: 1, generation_mode: "scaffold", pack_json: JSON.stringify(base), full_script: base.fullScript, short_script: base.shortScript });
  f.runtime.getProjectAccess = async (_subject, org, project) => org === organizationId && project === projectId ? { organizationRole: "member", projectRole: "member" } : null;
  f.runtime.canWriteProjectAccess = Boolean;
  f.mock("lib/generation-freeze.mjs.ts", { isGenerationFrozen: () => false });
  f.mock("lib/content-production.ts", production);
  f.mock("lib/published-copy.ts", publishedCopy);
  f.mock("lib/content-citation-recovery.ts", citationRecovery);
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true }) });
  f.mock("lib/generation-context-sources.ts", { retrieveGenerationMethodologySources: async () => [], retrieveDefaultProjectGenerationSources: () => { throw new Error("Must not load automatic project context"); } });
  const calls = [], queries = [], prepare = f.db.prepare;
  f.db.prepare = query => { queries.push(query); return prepare(query); };
  f.mock("lib/model-adapter.ts", options.modelAdapter || {
    ModelConfigurationError: class extends Error {}, ModelRequestError: class extends Error { constructor(message, code) { super(message); this.code = code; } },
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async input => {
      calls.push(input);
      if (respond) return { content: JSON.stringify(respond(input, calls.length, base)), latencyMs: 1 };
      const prompt = JSON.parse(input.user.slice(input.user.indexOf("\n") + 1));
      const citations = [{ sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" }, { sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张" }, ...selected.map(id => ({ sourceType: "knowledge", sourceId: id, quote: `${id}品牌案例中实际发生的真实实验过程与结果。` }))];
      return { content: JSON.stringify({ ...base, citations }), latencyMs: 1 };
    },
  });
  const route = f.load("app/api/content-items/[contentId]/generate/route.ts");
  const request = overrides => new Request("http://localhost/api/content-items/test/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, ...overrides }) });
  return { ...f, calls, queries, seed, topicId, contentId, request, complete: (benchmarkEntryIds = [], overrides = {}) => route.POST(request({ benchmarkEntryIds, recommendedBenchmarkIds: [], ...overrides }), { params: Promise.resolve({ contentId }) }) };
}

