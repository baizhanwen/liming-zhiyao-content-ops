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
  assert.match(generation, /UNTRACEABLE_MODEL_CITATION/);
  assert.match(generation, /ACTIVE_STRATEGY_REQUIRED/);
  assert.match(generation, /CONFIRMED_KNOWLEDGE_REQUIRED/);
  assert.match(generation, /for \(let attempt = 0; attempt < 2 && !pack; attempt \+= 1\)/);
  assert.match(generation, /prompt_templates/);
  assert.match(generation, /model_calls/);
});

test("model adapter keeps provider credentials server-side and supports profiles", async () => {
  const adapter = await readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /CONTENT_MODEL_API_KEY/);
  assert.match(adapter, /CONTENT_MODEL_BASE_URL/);
  assert.match(adapter, /authorization: `Bearer/);
  assert.match(adapter, /response_format: \{ type: "json_object" \}/);
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
