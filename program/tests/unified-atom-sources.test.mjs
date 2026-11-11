import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

// Generated offline by the production Python unified pipeline with synthetic
// source material and canned responses; no external provider is called here.
const produced = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v11.json", import.meta.url), "utf8"));

test("actual Python v11 output passes the shared TypeScript gate and carries finding provenance into atoms", async t => {
  const f = runtimeFixture(t), owner = await f.initialize(), now = new Date().toISOString();
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", produced).accepted, true);
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES('atom-project',?,'Synthetic','Synthetic',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,created_by,updated_by,created_at,updated_at) VALUES('atom-video',?,'atom-project','upload','upload',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO video_library_entries(id,organization_id,source_video_id,created_by,updated_by,created_at,updated_at) VALUES('atom-entry',?,'atom-video',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, now, now);
  const reportJson = JSON.stringify(produced);
  f.sqlite.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES('atom-analysis',?,'atom-project','atom-video','analysis.v11',?,?,?,?)")
    .run(owner.organizationId, reportJson, owner.userId, now, now);
  const result = await f.load("lib/video-knowledge-atoms.ts").extractVideoKnowledgeAtoms({ organizationId: owner.organizationId, videoId: "atom-video", analysisId: "atom-analysis", schemaVersion: "analysis.v11", reportJson });
  assert.equal(result.status, "completed");
  const rows = f.sqlite.prepare("SELECT content,source_locator_json FROM video_knowledge_atoms WHERE status='active'").all(); assert.ok(rows.length > 0);
  const registry = new Map(produced.content_analysis.evidence_registry.map(row => [row.id, row]));
  const findings = produced.unified_report.sections.flatMap(section => section.findings);
  let linkedCount = 0;
  for (const row of rows) {
    const matched = findings.filter(finding => row.content.includes(finding.text));
    if (!matched.length) continue; // Existing deterministic hook compatibility remains unchanged.
    linkedCount++;
    const locator = JSON.parse(row.source_locator_json);
    assert.equal(locator.version, "unified-finding-source.v1");
    assert.deepEqual(locator.finding_ids, matched.map(finding => finding.id));
    assert.deepEqual(locator.evidence_ids, [...new Set(matched.flatMap(finding => finding.evidence_ids))]);
    assert.ok(locator.evidence_ids.length);
    for (const source of locator.sources) {
      const original = registry.get(source.id); assert.ok(original);
      assert.deepEqual(source, { id: original.id, source: original.source, start_ms: original.start_ms, end_ms: original.end_ms, asset_ref: original.asset_ref });
    }
  }
  assert.ok(linkedCount > 0, "The production compatibility projection must resolve to actual unified findings");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
});
