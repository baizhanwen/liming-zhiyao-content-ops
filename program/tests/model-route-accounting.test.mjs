import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";
import { formatRewriteTokenUsage } from "../lib/script-rewrite.ts";

class RequestError extends Error { constructor(message, code) { super(message); this.code = code; } }
const source = "企业在2027年要让AI增长7.1%，我们会先把每次测试的过程记录下来，然后逐项核对结果，最后才决定怎样调整。";
const rewritten = "面向2027年AI增长7.1%的目标，我们先留下每轮测试的过程记录，核验各项结果以后，再据此安排后续调整。";
const audit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };

async function fixture(t, kind, { invalidFirst = false, invalidResponses = invalidFirst ? 1 : 0, limit = 1000, transportFailure = false, knownUsage = true } = {}) {
  const calls = [];
  const f = await contentGenerationFixture(t, [], undefined, { modelAdapter: {
    ModelConfigurationError: class extends Error {}, ModelRequestError: RequestError,
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async input => {
      calls.push(input);
      if (transportFailure) throw new RequestError("Synthetic timeout", "MODEL_TIMEOUT");
      let response = { angle: "建议先记录过程，再逐项核对结果" };
      if (kind === "rewrite") {
        const payload = JSON.parse(input.user);
        response = payload.task === "audit_micro_homomorphic_script" ? audit : { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewritten })) };
      } else if (kind === "wechat") {
        response = { title: "如何核对业务结果", subtitle: "先确定可核对的输入输出", quote: "明确业务问题，再决定处理流程。", sections: Array.from({ length: 4 }, (_, i) => ({ heading: `关键步骤 ${i + 1}`, body: "从真实业务流程出发，明确输入、输出、责任人和可以验证的结果。" })), conclusion: "小步验证，持续复盘，再逐步扩大应用范围。" };
      }
      return { content: calls.length <= invalidResponses ? "{" : JSON.stringify(response), provider: "fixture", model: "fixture", latencyMs: 1,
        raw: knownUsage ? { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } : {} };
    },
  } });
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  // Deliberately stale snapshots: atomic reservation must protect the final
  // budget slot even when simultaneous callers all passed preflight checks.
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, current: 0, limit }) });
  let route, params, payload, workspaceId;
  if (kind === "rewrite") {
    workspaceId = f.seed("script_rewrite_workspaces", { title: "Synthetic", source_type: "pasted", source_label: "Synthetic", source_text: source, source_hash: "synthetic", source_character_count: source.length });
    f.seed("script_rewrite_versions", { workspace_id: workspaceId, version: 1, variant: "source", text: source });
    route = f.load("app/api/script-rewrites/[rewriteId]/generate/route.ts");
    params = { params: Promise.resolve({ rewriteId: workspaceId }) }; payload = { variants: ["light_rewrite"] };
  } else if (kind === "wechat") {
    route = f.load("app/api/wechat-images/generate/route.ts"); payload = { topic: "如何核对业务结果", templateId: "method-warm", ratioId: "3:4" };
  } else {
    route = f.load("app/api/topics/generate/route.ts"); payload = { draft: { title: "如何核对工作结果" }, targets: ["angle"] };
  }
  const complete = () => route.POST(new Request("http://localhost/api/synthetic/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId: "project", ...payload }) }), params);
  const detail = () => f.load("app/api/script-rewrites/[rewriteId]/route.ts").GET(new Request(`http://localhost/api/script-rewrites/${workspaceId}?organizationId=${organizationId}&projectId=project`), params);
  return { ...f, complete, calls, detail };
}

for (const kind of ["topic", "rewrite", "wechat"]) {
  test(`${kind}: malformed response repair records every provider request and usage`, async t => {
    const f = await fixture(t, kind, { invalidFirst: true });
    const response = await f.complete(); assert.ok(response.ok, await response.clone().text());
    const rows = f.sqlite.prepare("SELECT * FROM model_calls ORDER BY created_at").all();
    assert.equal(rows.length, f.calls.length, "Automatic JSON repair was not separately counted");
    assert.ok(rows.length >= 2);
    const root = rows.find(row => !row.task_type.endsWith(".request"));
    const ledger = JSON.parse(root.output_json).modelRequests;
    assert.equal(ledger.length, 2); assert.ok(ledger.every(row => row.totalTokens === 20 && row.inputTokens === 12 && row.usageKnown));
    if (kind === "rewrite") assert.equal(f.sqlite.prepare("SELECT actual_total_tokens FROM script_rewrite_runs").get().actual_total_tokens, f.calls.length * 20, "Successful run did not include rejected-response tokens");
  });
  test(`${kind}: retry stops at the remaining monthly request slot`, async t => {
    const f = await fixture(t, kind, { invalidFirst: true, limit: 1 });
    const response = await f.complete();
    if (kind !== "rewrite") assert.equal(response.status, 429);
    else { const result = (await response.json()).results[0]; assert.equal(result.status, "failed"); assert.equal(result.error.code, "MODEL_QUOTA_EXCEEDED"); }
    assert.equal(f.calls.length, 1, "Repair exceeded remaining request budget");
    const rows = f.sqlite.prepare("SELECT * FROM model_calls").all(); assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed"); assert.equal(rows[0].error_code, "MODEL_QUOTA_EXCEEDED");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE variant != 'source'").get().n, 0);
  });
  test(`${kind}: three stale quota checks compete for one actual request slot`, async t => {
    const f = await fixture(t, kind, { limit: 1, transportFailure: true });
    await Promise.all([f.complete(), f.complete(), f.complete()]);
    assert.equal(f.calls.length, 1, "Concurrent quota preflight checks overspent the limit");
    const rows = f.sqlite.prepare("SELECT * FROM model_calls").all(); assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.equal(JSON.parse(rows[0].output_json).modelRequests[0].usageKnown, false);
  });
  test(`${kind}: successful replies without provider usage retain unknown tokens`, async t => {
    const f = await fixture(t, kind, { knownUsage: false }); await f.complete();
    for (const row of f.sqlite.prepare("SELECT output_json FROM model_calls").all()) {
      const requests = JSON.parse(row.output_json).modelRequests;
      assert.ok(requests.length > 0 && requests.every(request => !request.usageKnown && request.inputTokens === null && request.outputTokens === null && request.totalTokens === null));
    }
  });
  test(`${kind}: failed reservation never reaches the provider`, async t => {
    const f = await fixture(t, kind); const prepare = f.db.prepare;
    f.db.prepare = query => {
      if (/INSERT INTO model_calls/.test(query)) throw new Error("Synthetic D1 reservation write failure");
      return prepare(query);
    };
    await f.complete(); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
  });
  test(`${kind}: a lowered database quota overrides stale preflight capacity`, async t => {
    const f = await fixture(t);
    f.sqlite.prepare("UPDATE organization_settings SET monthly_model_call_quota=0").run();
    await f.complete(); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
  });
}

test("failed rewrite records tokens from both invalid replies without counting them twice", async t => {
  const f = await fixture(t, "rewrite", { invalidResponses: 2 });
  const response = await f.complete(); assert.equal((await response.json()).results[0].status, "failed");
  assert.equal(f.calls.length, 2); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 2);
  assert.equal(f.sqlite.prepare("SELECT actual_total_tokens FROM script_rewrite_runs").get().actual_total_tokens, 40);
});

for (const transportFailure of [false, true]) test(`rewrite detail exposes unknown usage without presenting zero consumption (${transportFailure})`, async t => {
  const f = await fixture(t, "rewrite", { knownUsage: false, transportFailure }); await f.complete();
  const detail = await (await f.detail()).json(); assert.equal(detail.runs[0].unknownRequestCount, f.calls.length);
  const text = formatRewriteTokenUsage(detail.runs[0].actualTotalTokens, detail.runs[0].unknownRequestCount);
  assert.match(text, /用量未知/); assert.doesNotMatch(text, /0 Token/);
  f.sqlite.prepare("UPDATE script_rewrite_runs SET validation_json='{}'").run();
  const legacy = await (await f.detail()).json(); assert.equal(legacy.runs[0].unknownRequestCount, null);
  assert.match(formatRewriteTokenUsage(0, legacy.runs[0].unknownRequestCount), /用量未确认/);
});
