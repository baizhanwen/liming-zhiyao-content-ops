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

test("topic citations only use tenant-owned analyses or confirmed knowledge", async () => {
  const topics = await readFile(new URL("../app/api/topics/route.ts", import.meta.url), "utf8");
  assert.match(topics, /getProjectAccess/);
  assert.match(topics, /v\.organization_id = a\.organization_id AND v\.project_id = a\.project_id/);
  assert.match(topics, /k\.status = 'confirmed'/);
  assert.match(topics, /CONFIRMED_KNOWLEDGE_REQUIRED/);
  assert.match(topics, /topic_citations/);
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

test("content input helpers reject malformed lists and protect management roles", async () => {
  const helpers = await import("../lib/content-ops.ts");
  assert.deepEqual(helpers.cleanStringList([" 痛点一 ", "", 3]), ["痛点一"]);
  assert.equal(helpers.cleanStringList("痛点一"), null);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "admin", projectRole: null }), true);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "member", projectRole: "planner" }), true);
  assert.equal(helpers.canManageProjectKnowledge({ organizationRole: "member", projectRole: "creator" }), false);
});
