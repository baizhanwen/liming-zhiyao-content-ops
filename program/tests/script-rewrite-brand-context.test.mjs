import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function setup(t) {
  const f = runtimeFixture(t);
  const { organizationId, userId } = await f.initialize();
  const timestamp = "2026-11-21T00:00:00Z";
  function project() {
    const projectId = crypto.randomUUID();
    f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(projectId, organizationId, "不是品牌的空间名", "不是品牌的客户字段", userId, userId, timestamp, timestamp);
    return { organizationId, projectId };
  }
  const scope = project();
  function insert({ title = "品牌资料", category = "brand_story", body = "一段已确认的品牌说明", form = null, status = "confirmed", projectScope = scope, version = 1 }) {
    const id = crypto.randomUUID(), versionId = crypto.randomUUID();
    f.sqlite.prepare("INSERT INTO knowledge_items (id,organization_id,project_id,category,title,status,current_version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, projectScope.organizationId, projectScope.projectId, category, title, status, version, userId, userId, timestamp, timestamp);
    f.sqlite.prepare("INSERT INTO knowledge_item_versions (id,organization_id,project_id,item_id,version,body,source_type,created_by,created_at,form_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(versionId, projectScope.organizationId, projectScope.projectId, id, version, body, "manual", userId, timestamp, typeof form === "string" || !form ? form : JSON.stringify(form));
    return id;
  }
  const lib = f.load("lib/script-rewrite-brand.ts");
  function valid(stamp, current = scope) {
    const guard = lib.rewriteBrandGuard(current, stamp);
    return f.sqlite.prepare("SELECT " + guard.sql + " AS allowed").get(...guard.bindings).allowed === 1;
  }
  return { f, scope, project, insert, valid, read: (query = "") => lib.readRewriteBrandContext(f.db, scope, query) };
}

test("rewrite identity uses only this space’s confirmed public profile, without private form answers", async t => {
  const { scope, insert, project, read, valid } = await setup(t);
  const account = insert({ title: "青禾 · 账号资料", form: { kind: "profile", answers: { accountName: "青禾", subject: "门店或品牌", boundary: "不披露员工电话", sample: "外部样片并非品牌能力" } } });
  const product = insert({ category: "other", body: "产品名称：青禾剪辑台。可整理镜头。", form: { kind: "product", answers: { publication: "可以公开", usage: "事实依据" } }, version: 3 });
  const anonymous = insert({ title: "敏感标题", body: "敏感原话", form: { kind: "product", answers: { publication: "匿名后可公开", publicSummary: "只公开这一句", answer0: "敏感原话" } } });
  insert({ form: { kind: "product", answers: { publication: "只供内部参考", answer0: "内部填写" } } });
  insert({ form: { kind: "product", answers: { publication: "可以公开", usage: "仅参考风格" } } });
  insert({ form: { kind: "product", answers: { publication: "可以公开", nature: "待核对" } } });
  insert({ status: "draft", body: "品牌名称：未确认" });
  insert({ status: "archived", body: "品牌名称：已归档" });
  insert({ body: "品牌名称：另一空间", projectScope: project() });
  const result = await read("今天聊聊镜头整理。");
  assert.equal(result.organizationId, scope.organizationId);
  assert.equal(result.targetName, "青禾");
  assert.equal(result.targetSourceId, account);
  assert.deepEqual(new Set(result.sources.map(s => s.itemId)), new Set([product, account, anonymous]));
  assert.equal(result.sources.find(s => s.itemId === product).version, 3);
  assert.match(JSON.stringify(result.sources), /只公开这一句/);
  assert.doesNotMatch(JSON.stringify(result), /外部样片|敏感标题|敏感原话|内部填写|另一空间|未确认|已归档/);
  assert(valid(result.stamp));
});

test("legacy explicit names work; project labels, sample titles, externally attributed names and conflicting identities do not pick a target", async t => {
  const { f, insert, read, valid } = await setup(t);
  insert({ category: "other", title: "孤立品牌名", body: "选择企业全称作为发布名称需要先确认。" });
  insert({ category: "case_study", title: "访谈记录", body: "企业全称：外部企业" });
  insert({ category: "brand_voice", title: "示例", body: "品牌名称：示例名称" });
  const missing = await read();
  assert.equal(missing.targetName, null);
  assert(missing.missing.length);
  const definition = insert({ category: "other", body: "企业全称：青禾制作有限公司\n品牌简称：青禾制作\n官方表述：把拍摄过程讲清楚。" });
  assert(!valid(missing.stamp));
  const current = await read();
  assert.equal(current.targetName, "青禾制作");
  assert.equal(current.targetSourceId, definition);
  assert(valid(current.stamp));
  insert({ body: "品牌简称：禾田" });
  const ambiguous = await read();
  assert.equal(ambiguous.targetName, null);
  assert(!valid(current.stamp));
  f.sqlite.prepare("UPDATE knowledge_items SET deleted_at='2026-11-21' WHERE id=?").run(definition);
  assert(!valid(ambiguous.stamp));
  assert.equal((await read()).targetName, "禾田");
});

test("a saved snapshot guards the exact current version, scope and eligibility during the write", async t => {
  const { f, scope, project, insert, valid, read } = await setup(t);
  const empty = await read();
  assert(valid(empty.stamp));
  assert(!valid(empty.stamp, project()));
  assert(!valid("bad input", scope));
  const id = insert({ body: "品牌名称：青禾" });
  const selected = await read();
  insert({ body: "品牌名称：草稿", status: "draft" });
  assert(valid(selected.stamp));
  f.sqlite.prepare("UPDATE knowledge_items SET status='archived' WHERE id=?").run(id);
  assert(!valid(selected.stamp));
  f.sqlite.prepare("UPDATE knowledge_items SET status='confirmed', current_version=2 WHERE id=?").run(id);
  const v = f.sqlite.prepare("SELECT * FROM knowledge_item_versions WHERE item_id=?").get(id);
  f.sqlite.prepare("INSERT INTO knowledge_item_versions (id,organization_id,project_id,item_id,version,body,source_type,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), v.organization_id, v.project_id, v.item_id, 2, "品牌名称：青禾新版", v.source_type, v.created_by, v.created_at);
  assert(!valid(selected.stamp));
  assert.equal((await read()).targetName, "青禾新版");
});

test("relevant official product survives a crowded library, without truncating identity permissions or exposing malformed forms", async t => {
  const { insert, read, valid } = await setup(t);
  const boundary = "只可以说公开的资料，" + "不能公开联系人".repeat(185);
  const profile = insert({ form: { kind: "profile", answers: { accountName: "青禾", boundary, background: "背景信息".repeat(320) } } });
  for (let n = 0; n < 18; n++) insert({ title: "格式规范" + n, category: "brand_voice", body: "使用日常口语。" });
  insert({ title: "旧损坏表单", category: "brand_story", form: "invalid json" });
  const product = insert({ category: "other", title: "剪辑台", body: "产品名称 ： 青禾剪辑台。镜头剪辑时可以记录时间点。" });
  const result = await read("剪辑镜头怎样记录时间点");
  assert(result.sources.length <= 12);
  assert(result.sources.some(s => s.itemId === product));
  assert(result.sources.find(s => s.itemId === profile).excerpt.includes(boundary));
  assert(!result.sources.some(s => s.title === "旧损坏表单"));
  assert(result.stamp.length <= 4096);
  assert(valid(result.stamp));
});
