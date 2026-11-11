import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { analysisReportFixture, contentAnalysisFixture } from "./helpers/content-analysis-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  const owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = new Date().toISOString();
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, project_id: "quality-project", created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: "quality-project", name: "Synthetic", client_name: "Synthetic" });
  const videoId = seed("videos", { platform: "upload", source_type: "upload" });
  const entryId = seed("video_library_entries", { source_video_id: videoId });
  seed("project_video_references", { library_entry_id: entryId, purpose: "benchmark", status: "active" });
  const jobId = seed("analysis_jobs", { video_id: videoId, source_type: "upload", source_ref: "synthetic-source", idempotency_key: crypto.randomUUID(), status: "analyzing", lease_owner: "test-worker", lease_expires_at: new Date(Date.now() + 300_000).toISOString(), version: 0 });
  const complete = (schema, report) => f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(new Request("http://localhost/complete", { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify({ workerId: "test-worker", resultKey: "quality:test-result", version: 0, analysis: { schemaVersion: schema, report, confidence: 80 } }) }), { params: Promise.resolve({ jobId }) });
  return { ...f, jobId, complete };
}

for (const schema of ["analysis.v7", "analysis.v8", "analysis.v9", "analysis.v10"]) test(`${schema} completion accepts its valid audit and remains idempotent`, async t => {
  const f = await fixture(t), report = analysisReportFixture(); report.analysis_meta.contract_version = schema;
  const response = await f.complete(schema, report); assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).job.status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM video_knowledge_atoms").get().count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM project_memory_events").get().count, 1);
  assert.equal((await (await f.complete(schema, report)).json()).idempotent, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM video_analyses").get().count, 1);
});

for (const [label, schema, body] of [
  ["missing audit", "analysis.v9", { summary: "保留这份部分报告" }],
  ["unknown contract", "analysis.future", analysisReportFixture()],
  ["missing structured report", "analysis.v10", { summary: "原文字段保留", analysis_meta: analysisReportFixture().analysis_meta }],
  ["partial structured module", "analysis.v10", (() => { const content = contentAnalysisFixture(); content.status = "partial"; content.module_status.visual.status = "not_acquired"; content.module_status.visual.reason = "not_acquired"; return analysisReportFixture(content); })()],
]) test(`${label} saves a partial report without creating atoms or benchmark memory`, async t => {
  const f = await fixture(t), response = await f.complete(schema, body); assert.equal(response.status, 200);
  assert.equal((await response.json()).job.status, "partial");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM video_knowledge_atoms").get().count, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM project_memory_events").get().count, 0);
  assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT report_json FROM video_analyses").get().report_json), body);
  assert.equal((await (await f.complete(schema, body)).json()).idempotent, true);
});

test("migration quality uses the same v8/v9/v10 rules and leaves legacy report bodies untouched", t => {
  const f = runtimeFixture(t), { importedAnalysisState } = f.load("lib/material-analysis-state.ts");
  const now = new Date().toISOString();
  for (const schema of ["analysis.v8", "analysis.v9", "analysis.v10"]) {
    const report = analysisReportFixture(); report.analysis_meta.contract_version = schema;
    const row = { schema_version: schema, report_json: JSON.stringify(report), created_at: now }, before = row.report_json;
    assert.equal(importedAnalysisState([row], now).jobStatus, "completed");
    assert.equal(row.report_json, before);
    assert.equal(importedAnalysisState([{ ...row, report_json: "{}" }], now).jobStatus, "partial");
  }
  assert.equal(importedAnalysisState([{ schema_version: "analysis.v1", report_json: '{"legacy":true}' }], now).jobStatus, "completed");
  assert.equal(importedAnalysisState([{ schema_version: "analysis.unknown", report_json: '{}' }], now).jobStatus, "partial");
});
