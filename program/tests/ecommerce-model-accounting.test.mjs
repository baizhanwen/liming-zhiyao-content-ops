import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function fixture(t, options = {}) {
  const f = await ecommerceGenerationFixture(t, options), adapter = f.load("lib/model-adapter.ts");
  f.mock("lib/model-adapter.ts", { ...adapter, invokeContentModel: async input => {
    const response = await adapter.invokeContentModel(input);
    return { ...response, ...(options.invalidJson ? { content: "synthetic invalid JSON" } : {}), raw: options.unknown ? undefined : { usage: options.usage ?? { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } };
  } });
  return f;
}
const calls = f => f.sqlite.prepare("SELECT * FROM model_calls ORDER BY rowid").all();
function requestRecord(row) { return JSON.parse(row.output_json).modelRequests[0]; }
function noVersion(f) { assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n, 0); assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks").get().current_version, 0); }
function injectAtReservation(f, mutate) {
  const prepare = f.db.prepare; let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql), execute = statement.execute;
    statement.execute = () => { if (!changed && sql.includes("UPDATE ecommerce_generation_runs SET call_count")) { changed = true; mutate(); } return execute(); };
    return statement;
  };
}

test("ecommerce preserves tokens for plan, draft and independent review", async t => {
  const f = await fixture(t), response = await f.generate(); assert.equal(response.status, 201, await response.clone().text());
  const records = calls(f).map(requestRecord); assert.deepEqual(records.map(r => r.step), ["plan", "draft", "review"]);
  assert.ok(records.every(r => r.usageKnown && r.inputTokens === 3 && r.outputTokens === 4 && r.totalTokens === 7));
  assert.equal(records.reduce((n, r) => n + r.totalTokens, 0), 21);
});
test("invalid ecommerce JSON preserves received usage and refuses a draft", async t => {
  const f = await fixture(t, { invalidJson: true }), response = await f.generate(); assert.equal(response.status, 502); assert.equal(f.calls.length, 1); noVersion(f);
  const row = calls(f)[0]; assert.equal(row.status, "failed"); assert.equal(row.error_code, "MODEL_INVALID_JSON"); assert.equal(requestRecord(row).totalTokens, 7);
});
test("ecommerce unknown provider usage is explicit and never treated as zero", async t => {
  const f = await fixture(t, { unknown: true }); assert.equal((await f.generate()).status, 201);
  for (const row of calls(f)) { const r = requestRecord(row); assert.equal(r.usageKnown, false); assert.equal(r.totalTokens, null); assert.equal(r.inputTokens, null); assert.equal(r.outputTokens, null); }
});
test("ecommerce accepts alternate supplier input/output fields", async t => {
  const f = await fixture(t, { usage: { input_tokens: 2, output_tokens: 5 } }); assert.equal((await f.generate()).status, 201);
  assert.ok(calls(f).map(requestRecord).every(r => r.usageKnown && r.inputTokens === 2 && r.outputTokens === 5 && r.totalTokens === null));
});
test("ecommerce invalid negative/string usage stays unknown", async t => {
  const f = await fixture(t, { usage: { prompt_tokens: -3, completion_tokens: "4", total_tokens: -7 } }); assert.equal((await f.generate()).status, 201);
  assert.ok(calls(f).map(requestRecord).every(r => !r.usageKnown && r.inputTokens === null && r.outputTokens === null && r.totalTokens === null));
});
for (const change of ["membership", "user", "organization", "project"]) test(`ecommerce ${change} revoked during first response stops further paid calls`, async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage !== "plan") return;
    if (change === "membership") f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run();
    if (change === "user") f.sqlite.prepare("UPDATE users SET status='disabled'").run();
    if (change === "organization") f.sqlite.prepare("UPDATE organizations SET status='inactive'").run();
    if (change === "project") f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='commerce-project'").run();
  } });
  const response = await f.generate(); assert.equal(response.status, 403, await response.clone().text()); assert.equal(f.calls.length, 1); noVersion(f); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7);
});
test("revoked employee assignment stops ecommerce after the first charged response", async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.sqlite.prepare("UPDATE project_members SET status='inactive'").run(); } });
  f.sqlite.prepare("UPDATE organization_members SET role='employee'").run(); f.identity.role = "employee"; f.seed("project_members", { user_id: f.identity.userId, role: "member", status: "active" });
  assert.equal((await f.generate()).status, 403); assert.equal(f.calls.length, 1); noVersion(f); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7);
});
test("ecommerce expired session refuses first output and retains charged usage", async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.identity.signedIn = false; } });
  const response = await f.generate(); assert.ok([401, 403].includes(response.status)); assert.equal(f.calls.length, 1); noVersion(f); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7);
});
for (const change of ["membership", "user", "organization", "project"]) test(`ecommerce ${change} changes within reservation sends no request and holds no slot`, async t => {
  const f = await fixture(t); injectAtReservation(f, () => {
    if (change === "membership") f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run();
    if (change === "user") f.sqlite.prepare("UPDATE users SET status='disabled'").run();
    if (change === "organization") f.sqlite.prepare("UPDATE organizations SET status='inactive'").run();
    if (change === "project") f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='commerce-project'").run();
  });
  assert.equal((await f.generate()).status, 403); assert.equal(f.calls.length, 0); assert.equal(calls(f).length, 0); assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs").get().call_count, 0); noVersion(f);
});
test("lowering company limit inside ecommerce reservation cannot use its stale quota", async t => {
  const f = await fixture(t); injectAtReservation(f, () => f.sqlite.prepare("UPDATE organization_settings SET monthly_model_call_quota=0").run());
  assert.equal((await f.generate()).status, 429); assert.equal(f.calls.length, 0); assert.equal(calls(f).length, 0); assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs").get().call_count, 0); noVersion(f);
});
test("company quota lowered after one response prevents a second ecommerce request", async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.sqlite.prepare("UPDATE organization_settings SET monthly_model_call_quota=1").run(); } });
  assert.equal((await f.generate()).status, 429); assert.equal(f.calls.length, 1); assert.equal(calls(f).length, 1); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7); noVersion(f);
});
test("ecommerce paused while provider responds retains usage and stops subsequent calls", async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.sqlite.prepare("UPDATE ecommerce_project_settings SET enabled=0").run(); } });
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 1); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7); noVersion(f);
});
for (const change of ["archive", "revision"]) test(`ecommerce task ${change} during first response prevents later requests`, async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.sqlite.prepare(change === "archive" ? "UPDATE ecommerce_tasks SET status='archived'" : "UPDATE ecommerce_tasks SET revision=revision+1").run(); } });
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 1); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7); noVersion(f);
});
test("cancelled ecommerce run retains its received tokens without changing the cancellation", async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage === "plan") f.sqlite.prepare("UPDATE ecommerce_generation_runs SET status='failed',error_code='RUN_CANCELLED',completed_at='2026-01-01T00:00:00Z'").run(); } });
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 1); noVersion(f); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7);
  const run = f.sqlite.prepare("SELECT error_code,completed_at FROM ecommerce_generation_runs").get(); assert.equal(run.error_code, "RUN_CANCELLED"); assert.equal(run.completed_at, "2026-01-01T00:00:00Z");
});
for (const recoveryCode of ["ECOMMERCE_CALL_RECOVERED", "WEB_PROCESS_INTERRUPTED"]) test(`late ecommerce ${recoveryCode} receipt augments usage without reviving the call or run`, async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage !== "plan") return;
    f.sqlite.prepare("UPDATE ecommerce_generation_runs SET status='failed',error_code='RUN_RECOVERED',completed_at='2026-01-01T00:00:00Z'").run();
    f.sqlite.prepare("UPDATE model_calls SET status='failed',error_code=?,output_json='{\"keep\":\"recovery\"}',completed_at='2026-01-01T00:00:00Z'").run(recoveryCode);
  } });
  assert.equal((await f.generate()).status, 409); const row = calls(f)[0]; assert.equal(row.status, "failed"); assert.equal(row.error_code, recoveryCode); assert.equal(row.completed_at, "2026-01-01T00:00:00Z");
  assert.equal(JSON.parse(row.output_json).keep, "recovery"); assert.equal(requestRecord(row).totalTokens, 7); assert.equal(f.calls.length, 1); noVersion(f);
});
test("supplier failure records explicit unknown consumption and releases ecommerce capacity", async t => {
  const f = await fixture(t, { onCall: () => { throw new Error("synthetic supplier offline"); } });
  assert.equal((await f.generate()).status, 502); assert.equal(f.calls.length, 1); const row = calls(f)[0]; assert.equal(row.status, "failed"); assert.equal(requestRecord(row).usageKnown, false); assert.equal(requestRecord(row).totalTokens, null); noVersion(f);
});
test("revocation at ecommerce run creation leaves no run or successful start audit", async t => {
  const f = await fixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), execute = s.execute; s.execute = () => { if (sql.includes("INSERT INTO ecommerce_generation_runs")) f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run(); return execute(); }; return s; };
  assert.equal((await f.generate()).status, 403); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_generation_runs").get().n, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ecommerce.generation.started'").get().n, 0);
});
test("normal ecommerce keeps three charged requests and immutable output", async t => {
  const f = await fixture(t); assert.equal((await f.generate()).status, 201); assert.equal(f.calls.length, 3); assert.equal(calls(f).length, 3); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n, 1);
});

test("revocation within request completion keeps its tokens but refuses success", async t => {
  const f = await fixture(t), prepare = f.db.prepare; let injected = false;
  f.db.prepare = sql => { const s = prepare(sql), execute = s.execute; s.execute = () => { if (!injected && sql.includes("UPDATE model_calls SET status='completed'")) { injected = true; f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run(); } return execute(); }; return s; };
  assert.equal((await f.generate()).status, 403); assert.equal(f.calls.length, 1); assert.equal(calls(f)[0].status, "failed"); assert.equal(requestRecord(calls(f)[0]).totalTokens, 7); noVersion(f);
});
test("ecommerce final version transaction denies revoked actor and leaves original task unchanged", async t => {
  const f = await fixture(t), before = f.sqlite.prepare("SELECT * FROM ecommerce_tasks").get(), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), execute = s.execute; s.execute = () => { if (sql.includes("WITH expected AS") && sql.includes("UPDATE ecommerce_tasks SET current_version")) f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run(); return execute(); }; return s; };
  assert.equal((await f.generate()).status, 403); assert.equal(f.calls.length, 3); assert.deepEqual(f.sqlite.prepare("SELECT * FROM ecommerce_tasks").get(), before); noVersion(f);
  assert.equal(calls(f).map(requestRecord).reduce((n, r) => n + r.totalTokens, 0), 21); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ecommerce.version.created'").get().n, 0);
});
test("failure registering a request rolls back its run counter and sends no provider call", async t => {
  const f = await fixture(t); f.sqlite.exec("CREATE TRIGGER reject_fee BEFORE INSERT ON model_calls WHEN NEW.task_type LIKE 'ecommerce.%' BEGIN SELECT RAISE(ABORT,'synthetic registration failure'); END");
  assert.equal((await f.generate()).status, 500); assert.equal(f.calls.length, 0); assert.equal(calls(f).length, 0); assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs").get().call_count, 0); noVersion(f);
});
test("a one-time receipt write failure salvages received usage and stops the run", async t => {
  const f = await fixture(t), prepare = f.db.prepare; let injected = false;
  f.db.prepare = sql => { const s = prepare(sql), execute = s.execute; s.execute = () => { if (!injected && sql.includes("UPDATE model_calls SET output_json")) { injected = true; throw new Error("synthetic receipt failure"); } return execute(); }; return s; };
  assert.equal((await f.generate()).status, 502); assert.equal(f.calls.length, 1); const row = calls(f)[0]; assert.equal(row.status, "failed"); assert.equal(requestRecord(row).totalTokens, 7); noVersion(f);
});
test("task changed inside reservation does not spend another request slot", async t => {
  const f = await fixture(t); injectAtReservation(f, () => f.sqlite.prepare("UPDATE ecommerce_tasks SET revision=revision+1").run());
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 0); assert.equal(calls(f).length, 0); assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs").get().call_count, 0); noVersion(f);
});
for (const legacyOutput of ["synthetic damaged JSON", '"legacy scalar"', '["legacy array"]']) test(`recovered ecommerce preserves non-object legacy receipt: ${legacyOutput}`, async t => {
  const f = await fixture(t, { onCall: ({ stage, f }) => { if (stage !== "plan") return;
    f.sqlite.prepare("UPDATE ecommerce_generation_runs SET status='failed',error_code='RUN_RECOVERED'").run();
    f.sqlite.prepare("UPDATE model_calls SET status='failed',error_code='ECOMMERCE_CALL_RECOVERED',output_json=?").run(legacyOutput);
  } });
  assert.equal((await f.generate()).status, 409); const row = calls(f)[0]; assert.equal(row.status, "failed"); assert.equal(JSON.parse(row.output_json).legacyOutput, legacyOutput); assert.equal(requestRecord(row).totalTokens, 7); noVersion(f);
});
