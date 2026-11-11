import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { enqueueBenchmarkVideoAnalysisMemoryEventsWithDb } from "../lib/benchmark-memory-events.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE video_analyses (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, video_id TEXT NOT NULL, schema_version TEXT NOT NULL, created_at TEXT NOT NULL, report_json TEXT NOT NULL);
    CREATE TABLE video_library_entries (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, source_video_id TEXT NOT NULL);
    CREATE TABLE project_video_references (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, library_entry_id TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE project_memory_events (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, event_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, dedupe_key TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, operation_summary_json TEXT NOT NULL, attempt_count INTEGER NOT NULL, error_code TEXT, error_message TEXT, model_provider TEXT, model_name TEXT, prompt_version TEXT, created_by TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_memory_event_dedupe ON project_memory_events (organization_id, project_id, dedupe_key);
  `);
  const prepare = (sql) => {
    let values = [];
    const statement = {
      bind(...nextValues) { values = nextValues; return statement; },
      first() { return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null); },
      all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...values) }); },
      run() { const result = sqlite.prepare(sql).run(...values); return Promise.resolve({ meta: { changes: Number(result.changes ?? 0) } }); },
    };
    return statement;
  };
  return { sqlite, db: { prepare } };
}
const passedReport = JSON.stringify({ analysis_meta: { quality_audit: { status: "passed", acceptance_passed: true, completion_status: "complete" } } });

test("video analysis memory events go only to active benchmark reference projects", async () => {
  const { sqlite, db } = database();
  sqlite.prepare("INSERT INTO video_analyses VALUES (?, ?, ?, ?, ?, ?, ?)").run("analysis-1", "org-1", "source-project", "video-1", "analysis.v8", "2026-08-26T01:00:00Z", passedReport);
  sqlite.prepare("INSERT INTO video_library_entries VALUES (?, ?, ?)").run("entry-1", "org-1", "video-1");
  const insertReference = sqlite.prepare("INSERT INTO project_video_references VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertReference.run("ref-a", "org-1", "client-a", "entry-1", "benchmark", "active", "user-a", "2026-08-26T02:00:00Z");
  insertReference.run("ref-b", "org-1", "client-b", "entry-1", "benchmark", "active", "user-b", "2026-08-26T02:01:00Z");
  insertReference.run("ref-analysis", "org-1", "client-c", "entry-1", "analysis", "active", "user-c", "2026-08-26T02:02:00Z");
  insertReference.run("ref-revoked", "org-1", "client-d", "entry-1", "benchmark", "revoked", "user-d", "2026-08-26T02:03:00Z");

  const first = await enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(db, { organizationId: "org-1", analysisId: "analysis-1" });
  assert.deepEqual(first, { analysisId: "analysis-1", created: 2, references: 2 });
  assert.deepEqual(sqlite.prepare("SELECT project_id, created_by FROM project_memory_events ORDER BY project_id").all().map((row) => [row.project_id, row.created_by]), [["client-a", "user-a"], ["client-b", "user-b"]]);

  const repeated = await enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(db, { organizationId: "org-1", analysisId: "analysis-1" });
  assert.deepEqual(repeated, { analysisId: "analysis-1", created: 0, references: 2 });
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_events").get().count), 2);
  sqlite.close();
});

test("adding an analyzed library entry backfills only the selected client project", async () => {
  const { sqlite, db } = database();
  sqlite.prepare("INSERT INTO video_analyses VALUES (?, ?, ?, ?, ?, ?, ?)").run("analysis-old", "org-1", "source-project", "video-1", "analysis.v7", "2026-08-25T01:00:00Z", passedReport);
  sqlite.prepare("INSERT INTO video_analyses VALUES (?, ?, ?, ?, ?, ?, ?)").run("analysis-new", "org-1", "source-project", "video-1", "analysis.v8", "2026-08-26T01:00:00Z", passedReport);
  sqlite.prepare("INSERT INTO video_library_entries VALUES (?, ?, ?)").run("entry-1", "org-1", "video-1");
  sqlite.prepare("INSERT INTO project_video_references VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("ref-a", "org-1", "client-a", "entry-1", "benchmark", "active", "user-a", "2026-08-26T02:00:00Z");
  sqlite.prepare("INSERT INTO project_video_references VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("ref-b", "org-1", "client-b", "entry-1", "benchmark", "active", "user-b", "2026-08-26T02:01:00Z");

  const result = await enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(db, { organizationId: "org-1", libraryEntryId: "entry-1", targetProjectId: "client-b" });
  assert.deepEqual(result, { analysisId: "analysis-new", created: 1, references: 1 });
  const event = sqlite.prepare("SELECT project_id, source_id, payload_json FROM project_memory_events").get();
  assert.equal(event.project_id, "client-b");
  assert.equal(event.source_id, "analysis-new");
  assert.equal(JSON.parse(event.payload_json).benchmarkReferenceId, "ref-b");
  sqlite.close();
});

test("partial, malformed and unknown-version reports do not enqueue benchmark memory", async () => {
  const { sqlite, db } = database();
  sqlite.prepare("INSERT INTO video_library_entries VALUES (?, ?, ?)").run("entry-1", "org-1", "video-1");
  sqlite.prepare("INSERT INTO project_video_references VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("ref-a", "org-1", "client-a", "entry-1", "benchmark", "active", "user-a", "2026-08-26");
  for (const [index, schema, report] of [[1, "analysis.v9", "{}"], [2, "analysis.v9", "invalid"], [3, "analysis.future", passedReport], [4, "analysis.v10", passedReport]]) {
    const id = `rejected-${index}`;
    sqlite.prepare("INSERT INTO video_analyses VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, "org-1", "source-project", "video-1", schema, "2026-08-26", report);
    assert.equal((await enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(db, { organizationId: "org-1", analysisId: id })).created, 0);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_memory_events").get().count, 0);
  sqlite.close();
});
