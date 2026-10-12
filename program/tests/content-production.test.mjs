import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("stage three schema versions knowledge, strategies, topics, and citations", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /knowledge_items/);
  assert.match(schema, /knowledge_item_versions/);
  assert.match(schema, /idx_knowledge_versions_item_version/);
  assert.match(schema, /content_strategies/);
  assert.match(schema, /idx_content_strategies_one_active/);
  assert.match(schema, /topic_ideas/);
  assert.match(schema, /topic_citations/);
});

test("knowledge stays draft until an authorized project manager confirms it", async () => {
  const [knowledge, confirm] = await Promise.all([
    readFile(new URL("../app/api/knowledge/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/knowledge/[itemId]/confirm/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(knowledge, /getProjectAccess/);
  assert.match(knowledge, /canWriteProjectAccess/);
  assert.match(knowledge, /'draft', 1/);
  assert.match(knowledge, /knowledge_item_versions/);
  assert.match(confirm, /canManageProjectKnowledge/);
  assert.match(confirm, /status = 'draft'/);
  assert.match(confirm, /confirmed_by = \?/);
});

test("strategy activation retires the prior version and records effective time", async () => {
  const activate = await readFile(new URL("../app/api/strategies/[strategyId]/activate/route.ts", import.meta.url), "utf8");
  assert.match(activate, /status = 'retired'/);
  assert.match(activate, /effective_to = \?/);
  assert.match(activate, /status = 'active'/);
  assert.match(activate, /effective_from = \?/);
  assert.match(activate, /canManageProjectKnowledge/);
});

test("company administrators can review every enterprise-space strategy from one view", async () => {
  const [strategies, projects, workspace, styles] = await Promise.all([
    readFile(new URL("../app/api/strategies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/KnowledgeWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(strategies, /scope === "organization"/);
  assert.match(strategies, /getOrganizationAccess/);
  assert.match(strategies, /organizationRole !== "admin"/);
  assert.match(strategies, /LEFT JOIN content_strategies/);
  assert.match(strategies, /p\.organization_id = \?/);
  assert.match(projects, /organizationRole: access\.organizationRole/);
  assert.match(workspace, /strategyScope/);
  assert.match(workspace, /全部企业空间/);
  assert.match(workspace, /进入空间管理/);
  assert.match(workspace, /organizationRole === "admin"/);
  assert.match(styles, /strategy-overview/);
  assert.match(styles, /strategy-space-group/);
});

test("brand knowledge supports a validated tenant-scoped XLSX bulk import into drafts", async () => {
  const [route, validator, workspace, xlsxParser, template] = await Promise.all([
    readFile(new URL("../app/api/knowledge/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/knowledge-import.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/KnowledgeWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/xlsx-table.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/templates/%E5%93%81%E7%89%8C%E7%9F%A5%E8%AF%86%E5%BA%93%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx", import.meta.url)),
  ]);
  assert.match(route, /getProjectAccess\(identity\.authSubject, organizationId, projectId\)/);
  assert.match(route, /canWriteProjectAccess\(access\)/);
  assert.match(route, /WHERE k\.organization_id = \? AND k\.project_id = \?/);
  assert.match(route, /'knowledge\.imported'/);
  assert.match(route, /'draft'/);
  assert.doesNotMatch(route, /status, current_version[\s\S]{0,300}'confirmed'/);
  assert.match(validator, /KNOWLEDGE_IMPORT_MAX_ROWS = 100/);
  assert.match(validator, /标题需为 2 至 120 个字符/);
  assert.match(validator, /非人工录入必须填写来源说明或链接/);
  assert.match(validator, /与本文件前面的知识重复/);
  assert.match(workspace, /readFirstWorksheet/);
  assert.match(workspace, /\/api\/knowledge\/import/);
  assert.match(workspace, /\/templates\/品牌知识库导入模板\.xlsx/);
  assert.match(workspace, /负责人确认后才会参与内容生成/);
  assert.match(xlsxParser, /openBoundedZip/);
  assert.equal(template.subarray(0, 2).toString("utf8"), "PK");
});

test("topic citations only use tenant-owned analyses or confirmed knowledge", async () => {
  const topics = await readFile(new URL("../app/api/topics/route.ts", import.meta.url), "utf8");
  assert.match(topics, /getProjectAccess/);
  assert.match(topics, /v\.organization_id = a\.organization_id AND v\.project_id = a\.project_id/);
  assert.match(topics, /k\.status = 'confirmed'/);
  assert.match(topics, /CONFIRMED_KNOWLEDGE_REQUIRED/);
  assert.match(topics, /topic_citations/);
});

test("new topics can cite multiple confirmed brand knowledge items", async () => {
  const [workspace, topics, generate, styles] = await Promise.all([
    readFile(new URL("../components/TopicWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/topics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/topics/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /selectedKnowledgeIds/);
  assert.match(workspace, /sourceKnowledgeItemIds/);
  assert.match(workspace, /可多选/);
  assert.doesNotMatch(workspace, /sourceKnowledgeItemIds: sourceVideoId \? \[\] : selectedKnowledgeIds/);
  assert.match(workspace, /只有勾选的知识参与补全/);
  assert.match(topics, /MAX_KNOWLEDGE_SOURCES/);
  assert.match(topics, /citations\.push\(\.\.\.sourceKnowledgeItemIds/);
  assert.match(topics, /citations: citationRecords/);
  assert.match(generate, /MAX_KNOWLEDGE_CONTEXT_CHARS/);
  assert.match(generate, /selectedKnowledge: knowledge\.map/);
  assert.doesNotMatch(generate, /if \(!sourceVideoId && sourceKnowledgeItemIds\.length\)/);
  assert.match(styles, /topic-knowledge-picker/);
});

test("analysis results and navigation expose the knowledge-to-topic workflow", async () => {
  const [detail, shell, knowledgePage, topicsPage] = await Promise.all([
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/knowledge/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/topics/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /从此分析创建选题/);
  assert.match(shell, /href: "\/knowledge"/);
  assert.match(shell, /href: "\/topics"/);
  assert.match(knowledgePage, /KnowledgeWorkspace/);
  assert.match(topicsPage, /TopicWorkspace/);
});

test("content input helpers reject malformed lists and allow assigned employees", async () => {
  const helpers = await import("../lib/content-ops.ts");
  assert.deepEqual(helpers.cleanStringList([" 痛点一 ", "", 3]), ["痛点一"]);
  assert.equal(helpers.cleanStringList("痛点一"), null);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "admin", projectRole: null }), true);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "member", projectRole: "member" }), true);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "member", projectRole: null }), false);
});

test("content lineage flows from analysis through production, publishing, and performance", async () => {
  const [topicsApi, contentApi, workflowApi, detail, topics, production, workflow, styles] = await Promise.all([
    readFile(new URL("../app/api/topics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/TopicWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/WorkflowWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(topicsApi, /spoken_script/);
  assert.match(topicsApi, /viral_points/);
  assert.match(contentApi, /inheritedCitations/);
  assert.match(contentApi, /topic_source_type/);
  assert.match(workflowApi, /citation_count/);
  assert.match(detail, /素材中心/);
  assert.match(detail, /对标内容库/);
  assert.match(topics, /moveTopicToProduction/);
  assert.match(production, /submitForReview/);
  assert.match(production, /提交审核/);
  assert.match(workflow, /workflow-lineage/);
  assert.match(workflow, /进入数据复盘/);
  assert.match(styles, /production-lineage/);
  assert.match(styles, /publication-next-step/);
});
