import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

const source = "企业在2027年要让AI增长7.1%，我们会先把每次测试的过程记录下来，然后逐项核对结果，最后才决定怎样调整。";
const rewritten = "面向2027年AI增长7.1%的目标，我们先留下每轮测试的过程记录，核验各项结果以后，再据此安排后续调整。";
const audit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };
class RequestError extends Error { constructor(message, code) { super(message); this.code = code; } }

async function fixture(t, onCall = () => {}) {
  let calls = 0;
  const f = await contentGenerationFixture(t, [], undefined, { modelAdapter: {
    ModelConfigurationError: class extends Error {}, ModelRequestError: RequestError,
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async input => {
      const payload = JSON.parse(input.user); await onCall(f, ++calls, payload);
      return { content: JSON.stringify(payload.task === "audit_micro_homomorphic_script" ? audit : { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewritten })) }),
        provider: "fixture", model: "fixture", latencyMs: 1, raw: { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } };
    },
  } });
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  const workspaceId = f.seed("script_rewrite_workspaces", { title: "Concurrent synthetic", source_type: "pasted", source_label: "Synthetic", source_text: source, source_hash: "synthetic", source_character_count: source.length });
  const sourceVersionId = f.seed("script_rewrite_versions", { workspace_id: workspaceId, version: 1, variant: "source", text: source });
  const params = { params: Promise.resolve({ rewriteId: workspaceId }) };
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => f.identity.sessionRevoked ? null : { authSubject: f.identity.userId } });
  const route = f.load("app/api/script-rewrites/[rewriteId]/route.ts"), generate = f.load("app/api/script-rewrites/[rewriteId]/generate/route.ts");
  const request = (body, method) => new Request("http://localhost/api/script-rewrites/synthetic", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId: "project", ...body }) });
  return { ...f, organizationId, workspaceId, sourceVersionId, callCount: () => calls,
    save: text => route.PATCH(request({ text, parentVersionId: sourceVersionId }, "PATCH"), params),
    generate: () => generate.POST(request({ variants: ["light_rewrite"] }, "POST"), params) };
}

test("manual and model saves can interleave without overwriting either result", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.generate(), f.save(`人工并发稿：${source}`), f.generate(), f.save(`第二份人工稿：${source}`)]);
  assert.deepEqual(results.map(r => r.status), [201, 201, 201, 201]);
  const rows = f.sqlite.prepare("SELECT version,variant FROM script_rewrite_versions ORDER BY version").all();
  assert.deepEqual(rows.map(r => r.version), [1, 2, 3, 4, 5]);
  assert.equal(rows.filter(r => r.variant === "manual").length, 2);
  assert.equal(rows.filter(r => r.variant === "light_rewrite").length, 2);
});

test("generation does not continue after its login session disappears", async t => {
  const f = await fixture(t, (runtime, call) => {
    if (call === 1) runtime.identity.sessionRevoked = true;
  });
  const response = await f.generate(), data = await response.json();
  assert.equal(data.results[0].error.code, "REWRITE_ACCESS_CHANGED");
  assert.equal(f.callCount(), 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE variant<>'source'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT actual_total_tokens FROM script_rewrite_runs").get().actual_total_tokens, 20);
});

test("project members can save, and removal stops the next model step", async t => {
  const f = await fixture(t, (runtime, call) => {
    if (call === 1) runtime.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(runtime.identity.userId);
  });
  f.sqlite.prepare("UPDATE organization_members SET role='member' WHERE user_id=?").run(f.identity.userId);
  f.seed("project_members", { user_id: f.identity.userId, role: "member", status: "active" });
  assert.equal((await f.save(`项目成员人工稿：${source}`)).status, 201);
  const response = await f.generate(), data = await response.json();
  assert.equal(data.results[0].status, "failed"); assert.equal(f.callCount(), 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE variant='light_rewrite'").get().n, 0);
});

test("permission removal immediately before model reservation cannot send or charge a request", async t => {
  const f = await fixture(t), prepare = f.db.prepare;
  let changed = false;
  f.db.prepare = query => {
    const statement = prepare(query), run = statement.run;
    statement.run = async () => {
      if (!changed && query.startsWith("INSERT INTO model_calls")) {
        changed = true; f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.identity.userId);
      }
      return run();
    };
    return statement;
  };
  const data = await (await f.generate()).json();
  assert.equal(data.results[0].error.code, "REWRITE_ACCESS_CHANGED");
  assert.equal(f.callCount(), 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
});

for (const mode of ["manual", "model"]) {
  test(`${mode} save rechecks membership inside the write transaction and leaves no partial success`, async t => {
    const f = await fixture(t), batch = f.db.batch;
    f.db.batch = async statements => {
      f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.identity.userId);
      return batch(statements);
    };
    const previous = f.sqlite.prepare("SELECT updated_at FROM script_rewrite_workspaces").get().updated_at;
    const response = mode === "manual" ? await f.save(`待保存人工稿：${source}`) : await f.generate();
    const data = await response.json();
    if (mode === "manual") assert.equal(response.status, 403);
    else { assert.equal(data.results[0].error.code, "REWRITE_SAVE_CONFLICT"); assert.equal(f.callCount(), 2); }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE variant<>'source'").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT updated_at FROM script_rewrite_workspaces").get().updated_at, previous);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action IN ('script_rewrite.generated','script_rewrite.manual_version_saved')").get().n, 0);
    if (mode === "model") {
      const run = f.sqlite.prepare("SELECT status,result_version_id,actual_total_tokens FROM script_rewrite_runs").get();
      assert.equal(run.status, "failed"); assert.equal(run.result_version_id, null); assert.equal(run.actual_total_tokens, 40);
    }
  });
  test(`${mode} database failure rolls back version and audit without erasing earlier drafts`, async t => {
    const f = await fixture(t);
    f.sqlite.exec(`CREATE TRIGGER refuse_rewrite_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = '${mode === "manual" ? "script_rewrite.manual_version_saved" : "script_rewrite.generated"}'
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
    const response = mode === "manual" ? await f.save(`失败时保留的人工稿：${source}`) : await f.generate();
    if (mode === "manual") assert.equal(response.status, 500);
    else { const data = await response.json(); assert.equal(data.results[0].status, "failed"); assert.equal(f.callCount(), 2); }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").get().n, 1);
    assert.equal(f.sqlite.prepare("SELECT text FROM script_rewrite_versions").get().text, source);
    if (mode === "model") assert.equal(f.sqlite.prepare("SELECT status FROM script_rewrite_runs").get().status, "failed");
  });
}

test("concurrent manual saves all retain separate immutable versions and matching audits", async t => {
  const f = await fixture(t);
  const bodies = Array.from({ length: 5 }, (_, i) => `人工稿${i}：${source}`);
  const responses = await Promise.all(bodies.map(text => f.save(text)));
  assert.deepEqual(responses.map(r => r.status), [201, 201, 201, 201, 201]);
  const data = await Promise.all(responses.map(r => r.json()));
  assert.deepEqual(data.map(r => r.version.version).sort(), [2, 3, 4, 5, 6]);
  const rows = f.sqlite.prepare("SELECT id,version,text FROM script_rewrite_versions WHERE variant='manual'").all();
  assert.deepEqual(new Set(rows.map(r => r.text)), new Set(bodies));
  for (const row of rows) {
    const log = f.sqlite.prepare("SELECT metadata_json FROM audit_logs WHERE target_id=? AND action='script_rewrite.manual_version_saved'").get(row.id);
    assert.equal(JSON.parse(log.metadata_json).version, row.version);
  }
});

test("concurrent generation keeps every paid result with independent run and version links", async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.generate(), f.generate(), f.generate()]);
  assert.deepEqual(responses.map(r => r.status), [201, 201, 201]);
  const data = await Promise.all(responses.map(r => r.json()));
  const rows = f.sqlite.prepare("SELECT id,version,run_id FROM script_rewrite_versions WHERE variant='light_rewrite'").all();
  assert.equal(rows.length, 3); assert.deepEqual(rows.map(r => r.version).sort(), [2, 3, 4]);
  assert.equal(f.callCount(), 6);
  for (const result of data.map(r => r.results[0])) {
    const run = f.sqlite.prepare("SELECT status,result_version_id FROM script_rewrite_runs WHERE id=?").get(result.runId);
    const version = f.sqlite.prepare("SELECT version FROM script_rewrite_versions WHERE id=?").get(run.result_version_id);
    assert.equal(run.status, "completed"); assert.equal(result.version, version.version);
  }
});

for (const [name, change] of [
  ["company membership revoked", f => f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.identity.userId)],
  ["user disabled", f => f.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.identity.userId)],
  ["project archived", f => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='project'").run()],
  ["workspace archived", f => f.sqlite.prepare("UPDATE script_rewrite_workspaces SET status='archived'").run()],
]) {
  test(`generation stops after ${name} while the provider is returning`, async t => {
    const f = await fixture(t, (runtime, call) => { if (call === 1) change(runtime); });
    const response = await f.generate(), data = await response.json();
    assert.equal(data.results[0].status, "failed", JSON.stringify(data));
    assert.equal(f.callCount(), 1, "A new audit request was sent after write access disappeared");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE variant<>'source'").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT status FROM script_rewrite_runs").get().status, "failed");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 1, "The already-dispatched request must remain counted");
  });
}
