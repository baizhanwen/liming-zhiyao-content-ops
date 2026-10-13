import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

async function fixture(t) {
  const f = await contentGenerationFixture(t);
  const scope = { organizationId: f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id, projectId: "project" };
  const context = { params: Promise.resolve({ contentId: f.contentId }) };
  const item = () => f.sqlite.prepare("SELECT * FROM content_items WHERE id=?").get(f.contentId);
  const pack = () => JSON.parse(f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=?").get(f.contentId, item().current_version).pack_json);
  const request = (body, method = "POST") => new Request("http://localhost/api/content-items/test", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...scope, ...body }) });
  const transition = (toStatus, extra = {}) => f.load("app/api/content-items/[contentId]/transition/route.ts").POST(request({ expectedVersion: item().current_version, toStatus, ...extra }), context);
  const save = (extra = {}) => f.load("app/api/content-items/[contentId]/route.ts").PATCH(request({ expectedVersion: item().current_version, pack: pack(), ...extra }, "PATCH"), context);
  const publish = (extra = {}) => f.load("app/api/content-items/[contentId]/publications/route.ts").POST(request({ expectedVersion: item().current_version, platform: "douyin", status: "published", externalUrl: "https://example.invalid/video", ...extra }), context);
  assert.equal((await f.complete()).status, 200);
  return { ...f, scope, item, pack, transition, save, publish };
}

// Execute another real route after the first request builds its transaction,
// but before D1 commits it; this exercises the actual snapshot race.
function interleave(f, pattern, action) {
  const prepare = f.db.prepare, batch = f.db.batch;
  f.db.prepare = sql => { const statement = prepare(sql),bind=statement.bind; statement.auditSql=sql;statement.bind=(...values)=>{statement.auditValues=values;return bind(...values);};return statement; };
  let injected = false;
  f.db.batch = async statements => {
    if (!injected && statements.some(s => pattern.test((s.auditSql || "")+JSON.stringify(s.auditValues||[])))) {
      injected = true;
      await action();
    }
    return batch(statements);
  };
}

for (const mode of ["manual", "ai"]) for (const state of ["internal_review", "publish_ready"]) {
  test(`${mode} revision from ${state} invalidates old approval and can be reviewed again`, async t => {
    const f = await fixture(t);
    assert.equal((await f.transition("internal_review")).status, 200);
    if (state === "publish_ready") assert.equal((await f.transition("publish_ready")).status, 200);
    const oldReview = f.sqlite.prepare("SELECT * FROM content_reviews WHERE content_item_id=?").get(f.contentId);
    const revised = mode === "ai" ? await f.complete([], { expectedVersion: 2 }) : await f.save();
    assert.equal(revised.status, 200, await revised.clone().text());
    assert.equal((await revised.json()).item.status, "internal_revision");
    assert.equal(f.item().current_version, 3);
    assert.equal(f.item().status, "internal_revision");
    assert.equal(f.sqlite.prepare("SELECT decision FROM content_reviews WHERE id=?").get(oldReview.id).decision, state === "internal_review" ? "cancelled" : "approved");
    assert.equal((await f.publish()).status, 409);
    assert.equal((await f.transition("internal_review")).status, 200);
    assert.equal((await f.transition("publish_ready")).status, 200);
    const response = await f.publish();
    assert.equal(response.status, 200, await response.clone().text());
    const publication = (await response.json()).publication;
    assert.notEqual(publication.content_version_id, oldReview.content_version_id);
    assert.equal(f.sqlite.prepare("SELECT content_version_id FROM content_reviews WHERE round=2 AND content_item_id=?").get(f.contentId).content_version_id, publication.content_version_id);
    assert.equal((await f.save()).status, 409);
    assert.equal((await f.complete()).status, 409);
  });
}

test("a misleading publish-ready state never substitutes for approval of the current version", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE content_items SET status='publish_ready' WHERE id=?").run(f.contentId);
  const response = await f.publish();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "CURRENT_VERSION_APPROVAL_REQUIRED");
  assert.equal((await f.transition("published")).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM publication_records").get().n, 0);
});

test("stale page versions reject editing, generation, approval and publication before side effects", async t => {
  const f = await fixture(t), calls = f.calls.length;
  for (const response of [await f.save({ expectedVersion: 1 }), await f.complete([], { expectedVersion: 1 }), await f.transition("internal_review", { expectedVersion: 1 }), await f.publish({ expectedVersion: 1 })]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "CONTENT_VERSION_CONFLICT");
  }
  assert.equal(f.calls.length, calls);
  assert.equal(f.item().current_version, 2);
});

test("concurrent manual save makes generation return 409 without phantom citations or audit", async t => {
  const f = await fixture(t);
  const otherScript = f.pack().fullScript + "这是另一位同事保存的修改，需要完整保留。";
  interleave(f, /^INSERT INTO content_versions/, async () => {
    assert.equal((await f.save({ pack: { ...f.pack(), fullScript: otherScript } })).status, 200);
  });
  const response = await f.complete();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, "CONTENT_VERSION_CONFLICT");
  assert.equal(f.pack().fullScript, otherScript);
  assert.equal(f.item().current_version, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_versions WHERE content_item_id=?").get(f.contentId).n, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='content.generated'").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls WHERE task_type='content_draft' ORDER BY created_at DESC LIMIT 1").get().status, "failed");
});

test("a generation result arriving after approval cannot replace the approved version", async t => {
  const f = await fixture(t);
  assert.equal((await f.transition("internal_review")).status, 200);
  interleave(f, /^INSERT INTO content_versions/, async () => { assert.equal((await f.transition("publish_ready")).status, 200); });
  assert.equal((await f.complete()).status, 409);
  assert.equal(f.item().status, "publish_ready");
  assert.equal(f.item().current_version, 2);
  assert.equal((await f.publish()).status, 200);
});

test("a stale approval cannot decide an obsolete review or add a false state audit", async t => {
  const f = await fixture(t);
  assert.equal((await f.transition("internal_review")).status, 200);
  interleave(f, /content\.status\.changed/, async () => { assert.equal((await f.save()).status, 200); });
  assert.equal((await f.transition("publish_ready")).status, 409);
  assert.equal(f.item().status, "internal_revision");
  assert.equal(f.sqlite.prepare("SELECT decision FROM content_reviews WHERE content_item_id=?").get(f.contentId).decision, "cancelled");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='content.status.changed'").get().n, 1);
});

test("a publish request racing with a new draft writes no publication or historical copy", async t => {
  const f = await fixture(t);
  await f.transition("internal_review"); await f.transition("publish_ready");
  interleave(f, /content\.publication\.saved/, async () => { assert.equal((await f.save()).status, 200); });
  assert.equal((await f.publish()).status, 409);
  assert.equal(f.item().status, "internal_revision");
  for (const table of ["publication_records", "published_copy_records"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test("failure in the final audit rolls back the version, status and review cancellation together", async t => {
  const f = await fixture(t);
  await f.transition("internal_review");
  f.sqlite.exec("CREATE TRIGGER reject_version_audit BEFORE INSERT ON audit_logs WHEN NEW.action='content.version.created' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
  assert.equal((await f.save()).status, 500);
  assert.equal(f.item().current_version, 2);
  assert.equal(f.item().status, "internal_review");
  assert.equal(f.sqlite.prepare("SELECT decision FROM content_reviews WHERE content_item_id=?").get(f.contentId).decision, "pending");
});
