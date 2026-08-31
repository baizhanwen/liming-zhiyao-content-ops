import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { upsertProjectVideoReference } from "../lib/video-reference-state.ts";
import { transitionProjectMemory } from "../lib/project-memory-state.ts";
import { extractVideoKnowledgeAtomsFromReport } from "../lib/video-knowledge-atom-state.ts";

function createD1TestDatabase(schema) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const prepare = (sql) => {
    let values = [];
    const statement = {
      bind(...nextValues) {
        values = nextValues;
        return statement;
      },
      first() {
        return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null);
      },
      all() {
        return Promise.resolve({ results: sqlite.prepare(sql).all(...values) });
      },
      run() {
        const result = sqlite.prepare(sql).run(...values);
        return Promise.resolve({ meta: { changes: Number(result.changes ?? 0) } });
      },
    };
    return statement;
  };
  return {
    sqlite,
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("revoked project references are reactivated atomically without duplicates", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_video_references (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, library_entry_id TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT, revoke_reason TEXT, UNIQUE(project_id, library_entry_id, purpose));");
  sqlite.prepare("INSERT INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, status, created_by, created_at, revoked_by, revoked_at, revoke_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ref-1", "org-1", "project-1", "entry-1", "benchmark", "revoked", "creator-1", "2026-08-21T00:00:00Z", "user-1", "2026-08-21T01:00:00Z", "manual");

  const restored = await upsertProjectVideoReference(db, { organizationId: "org-1", projectId: "project-1", libraryEntryId: "entry-1", purpose: "benchmark", userId: "user-2", now: "2026-08-21T02:00:00Z" });
  assert.deepEqual(restored, { id: "ref-1", action: "reactivated" });
  assert.deepEqual({ ...sqlite.prepare("SELECT id, status, revoked_by, revoked_at, revoke_reason FROM project_video_references").get() }, { id: "ref-1", status: "active", revoked_by: null, revoked_at: null, revoke_reason: null });

  const repeated = await upsertProjectVideoReference(db, { organizationId: "org-1", projectId: "project-1", libraryEntryId: "entry-1", purpose: "benchmark", userId: "user-2", now: "2026-08-21T03:00:00Z" });
  assert.deepEqual(repeated, { id: "ref-1", action: "already_active" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_video_references").get().count, 1);
  sqlite.close();
});

test("memory rejection only accepts candidates and reports the persisted state", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_memory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, category TEXT, status TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT, updated_at TEXT NOT NULL);");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("candidate-1", "org-1", "project-1", "audience", "target_audience", "candidate", "2026-08-21T00:00:00Z");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("confirmed-1", "org-1", "project-1", "tone", "client_preference", "confirmed", "2026-08-21T00:00:00Z");

  const rejected = await transitionProjectMemory({ db, memoryId: "candidate-1", organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "reject", now: "2026-08-21T02:00:00Z" });
  assert.deepEqual(rejected, { ok: true, status: "rejected" });
  assert.deepEqual({ ...sqlite.prepare("SELECT status, rejected_by, rejected_at FROM project_memory_items WHERE id = ?").get("candidate-1") }, { status: "rejected", rejected_by: "user-1", rejected_at: "2026-08-21T02:00:00Z" });

  const confirmedReject = await transitionProjectMemory({ db, memoryId: "confirmed-1", organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "reject", now: "2026-08-21T03:00:00Z" });
  assert.deepEqual(confirmedReject, { ok: false, reason: "not_actionable" });
  assert.equal(sqlite.prepare("SELECT status FROM project_memory_items WHERE id = ?").get("confirmed-1").status, "confirmed");
  sqlite.close();
});

test("confirming a candidate supersedes the prior confirmed revision and records both writes", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_memory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, category TEXT, status TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT, updated_at TEXT NOT NULL);");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("old-1", "org-1", "project-1", "audience", "target_audience", "confirmed", "2026-08-21T00:00:00Z");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("candidate-1", "org-1", "project-1", "audience", "target_audience", "candidate", "2026-08-21T01:00:00Z");

  const result = await transitionProjectMemory({ db, memoryId: "candidate-1", organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "confirm", now: "2026-08-21T02:00:00Z" });
  assert.deepEqual(result, { ok: true, status: "confirmed" });
  assert.deepEqual({ ...sqlite.prepare("SELECT status, superseded_by FROM project_memory_items WHERE id = ?").get("old-1") }, { status: "superseded", superseded_by: "candidate-1" });
  assert.equal(sqlite.prepare("SELECT status, confirmed_by FROM project_memory_items WHERE id = ?").get("candidate-1").status, "confirmed");
  sqlite.close();
});

test("knowledge atom replacement links each old atom to a real new atom inside one batch", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE video_knowledge_atoms (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, library_entry_id TEXT NOT NULL, analysis_id TEXT NOT NULL, atom_key TEXT NOT NULL, atom_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, structured_json TEXT NOT NULL, source_locator_json TEXT NOT NULL, confidence INTEGER, report_hash TEXT NOT NULL, extractor_version TEXT NOT NULL, status TEXT NOT NULL, superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(analysis_id, atom_key));");
  const first = await extractVideoKnowledgeAtomsFromReport(db, { organizationId: "org-1", libraryEntryId: "entry-1", analysisId: "analysis-1", report: { summary: "first summary", confidence: 80 }, reportHash: "hash-1", extractorVersion: "atoms.test", now: "2026-08-21T00:00:00Z" });
  assert.equal(first.status, "completed");
  const old = sqlite.prepare("SELECT id FROM video_knowledge_atoms WHERE status = 'active'").get();
  const second = await extractVideoKnowledgeAtomsFromReport(db, { organizationId: "org-1", libraryEntryId: "entry-1", analysisId: "analysis-2", report: { summary: "second summary", confidence: 90 }, reportHash: "hash-2", extractorVersion: "atoms.test", now: "2026-08-21T01:00:00Z" });
  assert.equal(second.status, "completed");
  const replacement = sqlite.prepare("SELECT id, status, superseded_by FROM video_knowledge_atoms WHERE analysis_id = 'analysis-2'").get();
  assert.equal(replacement.status, "active");
  assert.equal(sqlite.prepare("SELECT status, superseded_by FROM video_knowledge_atoms WHERE id = ?").get(old.id).status, "superseded");
  assert.equal(sqlite.prepare("SELECT superseded_by FROM video_knowledge_atoms WHERE id = ?").get(old.id).superseded_by, replacement.id);
  assert.equal(sqlite.prepare("SELECT id FROM video_knowledge_atoms WHERE id = ?").get(replacement.id).id, replacement.id);

  const noAtoms = await extractVideoKnowledgeAtomsFromReport(db, { organizationId: "org-1", libraryEntryId: "entry-1", analysisId: "analysis-3", report: {}, reportHash: "hash-3", extractorVersion: "atoms.test", now: "2026-08-21T02:00:00Z" });
  assert.equal(noAtoms.status, "unsupported");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM video_knowledge_atoms WHERE status = 'active'").get().count, 1);
  sqlite.close();
});
