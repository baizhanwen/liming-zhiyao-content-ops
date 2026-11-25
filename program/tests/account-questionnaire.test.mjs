import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function setup(t) {
  const f = runtimeFixture(t);
  const owner = await f.initialize();
  f.identity.userId = owner.userId;
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(projectId, owner.organizationId, "问卷测试", "测试账号", owner.userId, owner.userId, now, now);
  f.runtime.getProjectAccess = async () => ({ organizationRole: "admin", projectRole: null });
  f.runtime.canWriteProjectAccess = () => true;
  const scope = { organizationId: owner.organizationId, projectId };
  const query = new URLSearchParams(scope);
  function request(data, method = "POST") {
    return new Request("http://localhost/knowledge?" + query, { method, body: JSON.stringify({ ...scope, ...data }) });
  }
  const knowledge = f.load("app/api/knowledge/route.ts");
  const edit = f.load("app/api/knowledge/[itemId]/route.ts").PATCH;
  const confirm = f.load("app/api/knowledge/[itemId]/confirm/route.ts").POST;
  const strategies = f.load("app/api/strategies/route.ts");
  const activate = f.load("app/api/strategies/[strategyId]/activate/route.ts").POST;
  return { f, scope, query, request, knowledge, edit, confirm, strategies, activate };
}

test("内部材料不能确认，匿名版本只投影允许公开的内容，原始答案保留在管理表单", async t => {
  const { f, request, knowledge, edit, confirm, query } = await setup(t);
  const raw = "受访者王某的家庭地址";
  const original = { kind: "experience", answers: { title: raw, answer0: raw, source: raw, nature: raw, usage: raw, publication: "只供内部参考" } };
  const create = await knowledge.POST(request({ form: original }));
  assert.equal(create.status, 201);
  const { item } = await create.json();
  const params = { params: Promise.resolve({ itemId: item.id }) };
  const revision = { expectedVersion: item.current_version, expectedUpdatedAt: item.updated_at };
  assert.equal((await confirm(request(revision), params)).status, 409);
  assert.equal((await edit(request({ ...revision, title: "测试正文", category: "other", sourceType: "manual", body: "普通编辑不能绕过资料范围约束。" }, "PATCH"), params)).status, 400);
  const form = { ...original, answers: { ...original.answers, publication: "匿名后可公开", publicSummary: "一名受访者分享了晚课后的生活。" } };
  const edited = await edit(request({ form, ...revision }, "PATCH"), params);
  assert.equal(edited.status, 201);
  const updated = (await edited.json()).item;
  assert.equal((await confirm(request({ expectedVersion: updated.current_version, expectedUpdatedAt: updated.updated_at }), params)).status, 200);
  const publicList = await (await knowledge.GET(new Request("http://localhost/knowledge?" + query))).json();
  assert.equal(publicList.items[0].status, "confirmed");
  assert.ok(publicList.items[0].body.includes(form.answers.publicSummary));
  assert.ok(!JSON.stringify(publicList).includes(raw));
  const manage = await (await knowledge.GET(new Request("http://localhost/knowledge?" + query + "&questionnaire=1"))).json();
  assert.equal(manage.items[0].form.answers.answer0, raw);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM knowledge_item_versions WHERE item_id=?").get(item.id).n, 2);
});

test("八种素材各自可成条，账号可只保存发布身份", async t => {
  const { f, knowledge, request } = await setup(t);
  const { materialTypes } = f.load("lib/account-questionnaire.ts");
  const create = form => knowledge.POST(request({ form }));
  const profile = await create({ kind: "profile", answers: { accountName: "校园日记", subject: "个人" } });
  assert.equal(profile.status, 201);
  for (const kind of Object.keys(materialTypes)) {
    const response = await create({ kind, answers: { answer0: "这是一条材料示例", publication: "可以公开" } });
    assert.equal(response.status, 201);
    assert.match((await response.json()).item.body, /这是一条材料示例/);
  }
  assert.equal((await create({ kind: "case", answers: { answer0: "匿名案例", publication: "匿名后可公开" } })).status, 400);
  assert.equal((await create({ kind: "review", answers: { answer0: "一项实测", publication: "可以公开", metric: "3 秒" } })).status, 400);
});

test("学生 Vlog 策略由三题建档，启用后默认目标、受众和表达习惯进入写稿策略", async t => {
  const { f, strategies, activate, request, scope, query } = await setup(t);
  const form = { audience: "同经历的人", audienceDetail: "刚下晚自习的大学生", themes: "校园、夜跑", formats: "生活 Vlog、氛围", goal: "陪伴或共鸣", presentation: "字幕日记", deliverables: "字幕、镜头或选段顺序", ending: "自然结束" };
  const res = await strategies.POST(request({ form }));
  assert.equal(res.status, 201);
  const { strategy } = await res.json();
  assert.deepEqual(strategy.pain_points, []);
  assert.equal(strategy.status, "draft");
  const listed = await (await strategies.GET(new Request("http://localhost/strategies?" + query))).json();
  assert.deepEqual(listed.strategies[0].form, form);
  const activated = await activate(request({ expectedVersion: strategy.version, expectedUpdatedAt: strategy.updated_at }), { params: Promise.resolve({ strategyId: strategy.id }) });
  assert.equal(activated.status, 200);
  const core = await f.load("lib/content-strategy-policy.ts").readCoreContentStrategy(f.db, scope);
  assert.deepEqual(core.defaultObjectives, ["陪伴或共鸣"]);
  assert.match(core.targetAudience, /刚下晚自习的大学生/);
  assert.match(core.styleNotes, /字幕日记/);
  assert.match(core.styleNotes, /自然结束/);
});

test("只读取已确认账号资料当前版的公开边界，历史资料、私有经历与其他空间均隔离", async t => {
  const { f, scope, knowledge, edit, confirm, request } = await setup(t);
  const { readAccountDisclosureBoundaries } = f.load("lib/account-questionnaire.ts");
  const read = () => readAccountDisclosureBoundaries(f.db, scope);
  const form = { kind: "profile", answers: { accountName: "学生账号", subject: "个人", background: "未选用的个人经历", boundary: "室友只用化名" } };
  const make = await knowledge.POST(request({ form }));
  const item = (await make.json()).item;
  const params = { params: Promise.resolve({ itemId: item.id }) };
  const revision = item => ({ expectedVersion: item.current_version, expectedUpdatedAt: item.updated_at });
  assert.deepEqual(await read(), []);
  const confirmed = await confirm(request(revision(item)), params);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await read(), ["室友只用化名"]);
  assert.deepEqual(await readAccountDisclosureBoundaries(f.db, { ...scope, projectId: "另一个空间" }), []);
  form.answers.boundary = "室友只录原声";
  const revised = await edit(request({ form, ...revision((await confirmed.json()).item) }, "PATCH"), params);
  assert.equal(revised.status, 201);
  assert.deepEqual(await read(), []);
  const approved = await confirm(request(revision((await revised.json()).item)), params);
  assert.equal(approved.status, 200);
  assert.deepEqual(await read(), ["室友只录原声"]);
  const old = await knowledge.POST(request({ title: "旧版的账号资料", category: "brand_story", body: "这是旧版没有问卷标记的有效知识。", sourceType: "manual" }));
  const oldItem = (await old.json()).item;
  await confirm(request(revision(oldItem)), { params: Promise.resolve({ itemId: oldItem.id }) });
  assert.deepEqual(await read(), ["室友只录原声"]);
});
