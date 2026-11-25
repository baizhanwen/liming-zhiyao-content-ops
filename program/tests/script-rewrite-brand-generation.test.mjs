import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

const original = "这里是松石工作室。拍摄前，我们先把需要的画面记在纸上，再按地点排出顺序，出门前照着清单核对设备。";
const rewritten = "青禾工作室来聊聊拍前准备。先写下想拍的镜头，接着依地点先后排好，临出发时拿清单把设备逐样对一遍。";
const options = { mode: "current_brand", goal: "讲清拍摄准备", audience: "第一次拍摄的学生", scenario: "对镜头口播" };
const mapping = { paragraphId: "p-0001", role: "identity", before: "松石工作室", after: "青禾工作室", sourceId: "brand-profile", evidenceQuote: "发布名称：青禾工作室" };
const semanticAudit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };
const brandAudit = { brandAligned: true, attributionPreserved: true, factsSupported: true, issues: [], qualityNotes: ["开场明确，步骤清楚。"] };

async function expectResponse(promise, status) {
  const response = await promise;
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

async function setup(t, hook) {
  const calls = [];
  const f = await contentGenerationFixture(t, [], input => {
    const payload = JSON.parse(input.user);
    calls.push(payload);
    const override = hook?.(payload, f);
    if (override !== undefined) return override;
    switch (payload.task) {
      case "plan_brand_adaptation": return { mappings: [mapping], protectedParties: [], unresolved: [] };
      case "write_micro_homomorphic_script_batch": return { paragraphs: [{ paragraph_id: "p-0001", text: rewritten }] };
      case "audit_micro_homomorphic_script": return semanticAudit;
      case "audit_brand_adaptation": return brandAudit;
      case "repair_brand_adaptation": return { paragraphs: payload.paragraphs };
      default: throw Error("Unexpected synthetic model request: " + payload.task);
    }
  });
  const { organization_id: organizationId, id: projectId } = f.sqlite.prepare("SELECT id,organization_id FROM projects WHERE id='project'").get();
  const scope = { organizationId, projectId };
  const { projectWriteAccessCondition, projectWriteAccessBindings } = f.load("lib/project-write-access.ts");
  f.runtime.getProjectAccess = async (userId, org, project) => {
    const allowed = await f.db.prepare("SELECT 1 AS ok WHERE " + projectWriteAccessCondition).bind(...projectWriteAccessBindings({ userId, organizationId: org, projectId: project })).first();
    return allowed ? { organizationRole: "admin", projectRole: null } : null;
  };
  const request = (body, method = "POST") => new Request("http://localhost/rewrite?" + new URLSearchParams(scope), {
    method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify({ ...scope, ...body }),
  });
  const created = await expectResponse(f.load("app/api/script-rewrites/route.ts").POST(request({ title: "拍摄准备", sourceType: "pasted", sourceText: original })), 201);
  const rewriteId = created.workspace.id;
  const params = { params: Promise.resolve({ rewriteId }) };
  const item = f.load("app/api/script-rewrites/[rewriteId]/route.ts");
  const generate = f.load("app/api/script-rewrites/[rewriteId]/generate/route.ts");
  const draft = f.load("app/api/script-rewrites/[rewriteId]/draft/route.ts");
  const profile = (project = projectId) => {
    const id = project === projectId ? "brand-profile" : "other-profile";
    f.seed("knowledge_items", { id, project_id: project, title: "发布档案", category: "brand_story", status: "confirmed" });
    return f.seed("knowledge_item_versions", { item_id: id, project_id: project, version: 1, body: "发布名称：青禾工作室", source_type: "manual", form_json: JSON.stringify({ kind: "profile", answers: { accountName: project === projectId ? "青禾工作室" : "其他品牌", subject: "门店或品牌" } }) });
  };
  return { ...f, calls, profile, rewriteId, projectId, scope,
    detail: () => item.GET(request(null, "GET"), params), manual: (text, parentVersionId) => item.PATCH(request({ text, parentVersionId }, "PATCH"), params),
    generate: (overrides = {}) => generate.POST(request({ variants: ["light_rewrite"], adaptation: options, ...overrides }), params),
    toDraft: versionId => draft.POST(request({ versionId }), params),
    generated: () => f.sqlite.prepare("SELECT COUNT(*) AS n FROM script_rewrite_versions WHERE workspace_id=? AND variant='light_rewrite'").get(rewriteId).n };
}

test("brand rewrite stores grounded mappings, goals, versions and quality review through detail, manual edit and conversion", async t => {
  const f = await setup(t);
  const knowledgeVersion = f.profile();
  f.profile("other");
  const preview = await expectResponse(f.detail(), 200);
  assert.equal(preview.brandKnowledge.targetName, "青禾工作室");
  assert.deepEqual(preview.brandKnowledge.sources.map(s => s.itemId), ["brand-profile"]);
  const { results: [result] } = await expectResponse(f.generate({ adaptation: { ...options, brandStamp: preview.brandKnowledge.stamp } }), 201);
  assert.equal(result.status, "completed");
  assert.equal(f.generated(), 1);
  const detail = await expectResponse(f.detail(), 200);
  const version = detail.versions.find(v => v.id === result.versionId);
  assert.equal(detail.workspace.sourceText, original);
  assert.equal(version.text, rewritten);
  const saved = version.adaptation;
  assert.equal(saved.targetName, "青禾工作室");
  assert.equal(saved.goal, options.goal);
  assert.equal(saved.audience, options.audience);
  assert.equal(saved.scenario, options.scenario);
  assert.deepEqual(saved.mappings, [mapping]);
  assert.equal(saved.sources[0].versionId, knowledgeVersion);
  assert.deepEqual(saved.qualityNotes, brandAudit.qualityNotes);
  assert.deepEqual(detail.runs[0].adaptation, saved);
  assert.deepEqual(f.calls.map(call => call.task), ["plan_brand_adaptation", "write_micro_homomorphic_script_batch", "audit_micro_homomorphic_script", "audit_brand_adaptation"]);
  assert.match(f.calls[1].source_paragraphs[0].text, /青禾工作室/);
  assert.equal(f.calls[3].original, original);
  const editedText = rewritten + "最后把清单放进包里。";
  const { version: edit } = await expectResponse(f.manual(editedText, version.id), 201);
  assert.equal(edit.adaptation.inheritedFromVersionId, version.id);
  assert.deepEqual(edit.adaptation.qualityNotes, []);
  const { contentId } = await expectResponse(f.toDraft(edit.id), 201);
  const stored = f.sqlite.prepare("SELECT full_script, source_manifest_json FROM content_versions WHERE content_item_id=?").get(contentId);
  assert.equal(stored.full_script, editedText);
  const [origin] = JSON.parse(stored.source_manifest_json);
  assert.equal(origin.sourceId, edit.id);
  assert.deepEqual(origin.adaptation.sources, [{ itemId: "brand-profile", versionId: knowledgeVersion, version: 1 }]);
  assert.equal(origin.adaptation.inheritedFromVersionId, version.id);
  assert.equal((await expectResponse(f.toDraft(edit.id), 200)).contentId, contentId);
  f.sqlite.prepare("UPDATE knowledge_items SET status='archived' WHERE id=?").run(mapping.sourceId);
  assert.equal((await expectResponse(f.toDraft(version.id), 409)).error.code, "REWRITE_BRAND_CHANGED");
  const historical = (await expectResponse(f.detail(), 200)).versions.find(v => v.id === version.id);
  assert.equal(historical.adaptation.sources[0].versionId, knowledgeVersion);
});

test("missing brand, stale preview and revoked space access stop before a model invocation", async t => {
  const f = await setup(t);
  f.profile("other");
  assert.equal((await expectResponse(f.generate(), 409)).error.code, "REWRITE_BRAND_REQUIRED");
  const emptyPreview = (await expectResponse(f.detail(), 200)).brandKnowledge;
  f.profile();
  assert.equal((await expectResponse(f.generate({ adaptation: { ...options, brandStamp: emptyPreview.stamp } }), 409)).error.code, "REWRITE_BRAND_CHANGED");
  f.sqlite.prepare("UPDATE organization_members SET status='suspended' WHERE user_id=?").run(f.identity.userId);
  assert.equal((await expectResponse(f.generate(), 403)).error.code, "WRITE_ACCESS_REQUIRED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.generated(), 0);
});

test("revoking the confirmed evidence during the model request stops the run and blocks stale retry", async t => {
  const f = await setup(t, (payload, fixture) => {
    if (payload.task === "plan_brand_adaptation") fixture.sqlite.prepare("UPDATE knowledge_items SET status='archived' WHERE id='brand-profile'").run();
  });
  f.profile();
  const { results: [result] } = await expectResponse(f.generate(), 207);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "REWRITE_BRAND_CHANGED");
  assert.equal(f.generated(), 0);
  assert.equal(f.calls.length, 1);
  assert.equal((await expectResponse(f.generate({ retryOfRunId: result.runId, adaptation: { mode: "preserve" } }), 409)).error.code, "REWRITE_BRAND_CHANGED");
  assert.equal(f.calls.length, 1);
});

test("a second failed independent brand audit cannot write a candidate or create a draft", async t => {
  const f = await setup(t, payload => {
    if (payload.task === "audit_brand_adaptation") return { ...brandAudit, attributionPreserved: false, issues: ["候选稿混淆原作者与发布品牌。"] };
  });
  f.profile();
  const { results: [result] } = await expectResponse(f.generate(), 207);
  assert.equal(result.error.code, "REWRITE_BRAND_VALIDATION_FAILED");
  assert.equal(f.calls.filter(c => c.task === "audit_brand_adaptation").length, 2);
  assert.equal(f.generated(), 0);
  const detail = await expectResponse(f.detail(), 200);
  assert.equal(detail.runs[0].resultVersionId, null);
  assert.equal(detail.versions.length, 1);
  assert.equal((await expectResponse(f.toDraft(detail.versions[0].id), 404)).error.code, "REWRITE_VERSION_NOT_FOUND");
});

test("evidence revoked between the last check and the save transaction leaves the version, run and audit consistent", async t => {
  const f = await setup(t);
  f.profile();
  const inserts = new WeakSet();
  const prepare = f.db.prepare, batch = f.db.batch;
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (/INSERT INTO script_rewrite_versions\s/i.test(sql)) inserts.add(statement);
    return statement;
  };
  f.db.batch = statements => {
    if (statements.some(statement => inserts.has(statement))) {
      f.sqlite.prepare("UPDATE knowledge_items SET status='archived' WHERE id=?").run(mapping.sourceId);
    }
    return batch(statements);
  };
  const { results: [result] } = await expectResponse(f.generate(), 207);
  assert.equal(f.calls.at(-1).task, "audit_brand_adaptation");
  assert.equal(result.error.code, "REWRITE_BRAND_CHANGED");
  assert.equal(f.generated(), 0);
  const log = f.sqlite.prepare("SELECT * FROM audit_logs WHERE action='script_rewrite.generated' AND json_extract(metadata_json,'$.workspaceId')=?").get(f.rewriteId);
  assert.equal(log, undefined);
  const { runs } = await expectResponse(f.detail(), 200);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].resultVersionId, null);
});
