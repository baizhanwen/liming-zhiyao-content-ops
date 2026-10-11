import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

class RequestError extends Error { constructor(message, code) { super(message); this.code = code; } }
async function fixture(t, kind, change = () => {}) {
  let f;
  const respond = (input, _count, base) => {
    const prompt = JSON.parse(input.user.slice(input.user.indexOf("\n") + 1));
    const result = { ...base, citations: [{ sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" }, { sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张" }] };
    change(f); return result;
  };
  f = await contentGenerationFixture(t, [], kind === "content" ? respond : undefined, kind === "content" ? {} : { modelAdapter: {
    ModelConfigurationError: class extends Error {}, ModelRequestError: RequestError,
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async () => {
      f.calls.push({}); change(f);
      const result = kind === "topic" ? { angle: "建议先记录过程，再逐项核对结果" } : { title: "如何核对业务结果", subtitle: "先确定可核对的输入输出", quote: "明确业务问题，再决定处理流程。", sections: Array.from({ length: 4 }, (_, i) => ({ heading: `关键步骤 ${i + 1}`, body: "从真实业务流程出发，明确输入、输出、责任人和可以验证的结果。" })), conclusion: "小步验证，持续复盘，再逐步扩大应用范围。" };
      return { content: JSON.stringify(result), provider: "fixture", model: "fixture", latencyMs: 1, raw: { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } };
    },
  } });
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  const route = kind === "content" ? null : f.load(kind === "topic" ? "app/api/topics/generate/route.ts" : "app/api/wechat-images/generate/route.ts");
  const complete = kind === "content" ? f.complete : () => route.POST(f.request(kind === "topic" ? { draft: { title: "如何核对工作结果" }, targets: ["angle"] } : { topic: "如何核对业务结果", templateId: "method-warm", ratioId: "3:4" }));
  const save = () => f.load("app/api/content-items/[contentId]/route.ts").PATCH(f.request({ pack: JSON.parse(f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=1").get(f.contentId).pack_json), expectedVersion: 1 }), { params: Promise.resolve({ contentId: f.contentId }) });
  return { ...f, complete, save, organizationId };
}

const changes = [
  ["membership revoked", f => f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.identity.userId)],
  ["user disabled", f => f.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.identity.userId)],
  ["project archived", f => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='project'").run()],
  ["company disabled", f => f.sqlite.prepare("UPDATE organizations SET status='inactive'").run()],
  ["request identity changed", f => { f.identity.userId = "expired-session"; }],
];
for (const kind of ["content", "topic", "wechat"]) {
  test(`${kind}: an unchanged caller still receives a valid model result`, async t => {
    const f = await fixture(t, kind), response = await f.complete(); assert.equal(response.status, 200, await response.clone().text());
  });
  for (const [name, change] of changes) {
    test(`${kind}: ${name} during provider response refuses the result and preserves spend`, async t => {
      const f = await fixture(t, kind, change), response = await f.complete();
      assert.equal(response.status, 403, await response.clone().text()); assert.equal((await response.json()).error.code, "PROJECT_WRITE_ACCESS_CHANGED");
      assert.equal(f.calls.length, 1, "No further repair request is authorized");
      const receipt = f.sqlite.prepare("SELECT status,error_code,output_json FROM model_calls").get();
      assert.equal(receipt.status, "failed"); assert.equal(receipt.error_code, "PROJECT_WRITE_ACCESS_CHANGED");
      assert.equal(JSON.parse(receipt.output_json).modelRequests.length, 1);
      assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_versions WHERE content_item_id=?").get(f.contentId).n, 1);
    });
  }
  test(`${kind}: permission removed at reservation prevents the outbound request and quota receipt`, async t => {
    const f = await fixture(t, kind), prepare = f.db.prepare;
    let changed = false;
    f.db.prepare = query => {
      const statement = prepare(query), run = statement.run;
      statement.run = async () => {
        if (!changed && query.startsWith("INSERT INTO model_calls")) { changed = true; changes[0][1](f); }
        return run();
      };
      return statement;
    };
    const response = await f.complete(); assert.equal(response.status, 403, await response.clone().text());
    assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
  });
  test(`${kind}: removing an employee's project assignment denies the late result`, async t => {
    const f = await fixture(t, kind, row => row.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(row.identity.userId));
    f.sqlite.prepare("UPDATE organization_members SET role='employee' WHERE user_id=?").run(f.identity.userId);
    f.seed("project_members", { user_id: f.identity.userId, role: "editor", status: "active" });
    const response = await f.complete(); assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(f.calls.length, 1);
  });
}

for (const kind of ["topic", "wechat"]) {
  test(`${kind}: revocation inside completion leaves no successful receipt or audit`, async t => {
    const f = await fixture(t, kind), prepare = f.db.prepare, batch = f.db.batch;
    f.db.prepare = query => { const statement = prepare(query); statement.auditSql = query; return statement; };
    f.db.batch = async statements => {
      if (statements[0].auditSql?.startsWith("UPDATE model_calls SET status = 'completed'")) changes[0][1](f);
      return batch(statements);
    };
    const response = await f.complete(); assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error.code, "PROJECT_WRITE_ACCESS_CHANGED");
    assert.equal(f.sqlite.prepare("SELECT status FROM model_calls").get().status, "failed");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action IN ('topic.fields_generated','wechat_image.generated')").get().n, 0);
  });
}

for (const kind of ["manual", "model"]) {
  test(`${kind}: revocation inside the final transaction leaves no version, citation, success audit or review cancellation`, async t => {
    const f = await fixture(t, "content"), prepare = f.db.prepare, batch = f.db.batch;
    const versionId = f.sqlite.prepare("SELECT id FROM content_versions WHERE content_item_id=? AND version=1").get(f.contentId).id;
    f.seed("content_reviews", { content_item_id: f.contentId, content_version_id: versionId, review_stage: "internal", round: 1, decision: "pending", requested_by: f.identity.userId, requested_at: "2026-10-11T00:00:00.000Z" });
    f.db.prepare = query => { const statement = prepare(query); statement.auditSql = query; return statement; };
    f.db.batch = async statements => {
      if (statements[0].auditSql?.startsWith("INSERT INTO content_versions")) changes[0][1](f);
      return batch(statements);
    };
    const previous = f.sqlite.prepare("SELECT * FROM content_items WHERE id=?").get(f.contentId);
    const response = kind === "manual" ? await f.save() : await f.complete();
    assert.equal(response.status, 403, await response.clone().text());
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM content_items WHERE id=?").get(f.contentId), previous);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_versions WHERE content_item_id=?").get(f.contentId).n, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action IN ('content.version.created','content.generated')").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_citations").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT decision FROM content_reviews WHERE content_item_id=?").get(f.contentId).decision, "pending");
  });
}
