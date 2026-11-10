import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function legacyFixture(t) {
  const f = await ecommerceGenerationFixture(t);
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const original = f.sqlite.prepare("SELECT * FROM ecommerce_versions WHERE task_id=? AND version=1").get(f.task.id);
  const pack = JSON.parse(original.pack_json), snapshot = JSON.parse(original.input_snapshot_json);
  const methods = f.sqlite.prepare("SELECT c.id,c.kind,v.id AS version_id,v.body_json FROM ecommerce_components c JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version WHERE c.kind IN ('visual','sop') AND c.organization_id=? AND c.project_id=?").all(f.organizationId, f.projectId);
  for (const segment of pack.segments) segment.visual = `历史镜头：${segment.id}`;
  pack.filmingChecklist = ["历史拍摄清单，应留在原稿并在文案编辑时保留"];
  for (const method of methods) {
    const card = JSON.parse(method.body_json), segment = pack.segments.find(s => s.role === "evidence");
    segment.componentIds.push(method.id);
    pack.applications.push({ sourceType: "component", sourceId: method.id, used: true, sourceQuote: card.instruction, segmentIds: [segment.id], draftQuote: segment.visual, reason: "历史拍摄方法", notTransferred: "" });
    snapshot.sources.push({ id: method.id, type: "component", version: method.version_id, title: card.name, text: card.instruction });
  }
  const legacyId = f.seed("ecommerce_versions", { ...original, id: crypto.randomUUID(), version: 2, parent_version_id: original.id, run_id: null, mode: "manual", pack_json: JSON.stringify(pack), input_snapshot_json: JSON.stringify(snapshot), change_summary: "合成历史分镜稿兼容样本", prompt_version: "ecommerce-content.v3" });
  f.sqlite.prepare("UPDATE ecommerce_tasks SET current_version=2,status='draft' WHERE id=?").run(f.task.id);
  const params = { params: Promise.resolve({ taskId: f.task.id }) };
  return { ...f, pack, legacyId, params, legacyRaw: JSON.stringify(pack) };
}

test("copy-only generation needs no filming data or visual/SOP methods and sends only writing contracts", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_components SET status='revoked' WHERE kind IN ('visual','sop')").run();
  const brief = { ...f.brief, filming: [], filmingNotes: "LEGACY_FILMING_NOTE_MUST_NOT_REACH_MODEL" };
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify(brief), f.task.id);
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review"]);
  for (const call of f.calls) {
    const query = JSON.parse(call.input.user), context = call.payload.context;
    assert.equal("filming" in context.task.brief, false);
    assert.equal("filmingNotes" in context.task.brief, false);
    assert.doesNotMatch(JSON.stringify(query), /LEGACY_FILMING_NOTE_MUST_NOT_REACH_MODEL/);
    assert.deepEqual([...new Set(context.candidates.map(candidate => candidate.card.kind))].sort(), ["hook", "structure"]);
    assert.equal(context.candidates.some(candidate => "requiredFilming" in candidate.card), false);
    assert.doesNotMatch(JSON.stringify(query.outputSchema), /"visual"|"filmingChecklist"|"filmingFeasible"/);
  }
  const pack = (await response.json()).version.pack;
  assert.ok(pack.segments.every(segment => segment.visual === ""));
  assert.deepEqual(pack.filmingChecklist, []);
  assert.ok(pack.segments.some(segment => segment.script.length > 0));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls").get().n, 3);
});

test("historical shot fields and references can be edited and approved as copy without overwriting the source", async t => {
  const f = await legacyFixture(t), edited = structuredClone(f.pack);
  edited.title = "只修改文案标题，保留历史资料";
  const response = await f.route("tasks/[taskId]/versions").POST(f.request("POST", { revision: 1, baseVersion: 2, pack: edited, changeSummary: "文案标题修订" }), f.params);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = (await response.json()).version;
  assert.equal(saved.validation.ok, true, JSON.stringify(saved.validation));
  const persisted = JSON.parse(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(saved.id).pack_json);
  assert.deepEqual(persisted.segments, edited.segments);
  assert.deepEqual(persisted.filmingChecklist, f.pack.filmingChecklist);
  assert.equal(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(f.legacyId).pack_json, f.legacyRaw);
  const review = (action, confirmations) => f.route("tasks/[taskId]/review").POST(f.request("POST", { revision: 1, versionId: saved.id, action, confirmations }), f.params);
  assert.equal((await review("submit", [])).status, 200);
  assert.equal((await review("approve", ["facts"])).status, 400);
  assert.equal((await review("approve", ["facts", "destination"])).status, 200);
});

test("copy patch of a historical shot draft preserves other segments and excludes shot payloads", async t => {
  const f = await legacyFixture(t);
  const response = await f.generate({ baseVersion: 2, replace: "hook", idempotencyKey: "copy-patch-legacy" });
  assert.equal(response.status, 201, await response.clone().text());
  const pack = (await response.json()).version.pack;
  for (const segment of f.pack.segments.filter(segment => segment.role !== "hook")) assert.deepEqual(pack.segments.find(next => next.id === segment.id), segment);
  assert.deepEqual(pack.filmingChecklist, f.pack.filmingChecklist);
  assert.equal(pack.segments.find(segment => segment.role === "hook").visual, "");
  const patch = f.calls.find(call => call.stage === "patch");
  assert.equal("filmingChecklist" in patch.payload.base, false);
  assert.equal(patch.payload.base.segments.some(segment => "visual" in segment), false);
  assert.equal(patch.payload.base.applications.some(application => f.pack.applications.some(old => old.sourceType === "component" && old.sourceId === application.sourceId && old.reason === "历史拍摄方法")), false);
  const review = f.calls.at(-1);
  assert.equal(review.stage, "review");
  assert.equal(review.payload.draft.segments.some(segment => "visual" in segment), false);
  assert.equal(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(f.legacyId).pack_json, f.legacyRaw);
});

test("legacy shot compatibility never excuses foreign or invented factual attribution", async t => {
  const f = await legacyFixture(t), edited = structuredClone(f.pack);
  edited.segments.find(segment => segment.role === "evidence").evidenceIds.push("invented-foreign-evidence");
  const response = await f.route("tasks/[taskId]/versions").POST(f.request("POST", { revision: 1, baseVersion: 2, pack: edited, changeSummary: "错误来源必须留作待修正" }), f.params);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = (await response.json()).version;
  assert.equal(saved.validation.ok, false);
  assert.match(saved.validation.issues.join("；"), /不存在的来源.*invented-foreign-evidence/);
  const review = await f.route("tasks/[taskId]/review").POST(f.request("POST", { revision: 1, versionId: saved.id, action: "submit" }), f.params);
  assert.equal(review.status, 409);
});
