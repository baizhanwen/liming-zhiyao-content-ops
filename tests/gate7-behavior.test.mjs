import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildAnalyticsSnapshot } from "../lib/performance-analytics.ts";
import { createMemoryCandidateWithDb } from "../lib/project-memory-candidate.ts";
import { transitionProjectMemory } from "../lib/project-memory-state.ts";
import { retrieveAuthorizedProjectKnowledge } from "../lib/project-knowledge-retrieval.ts";
import { mapProjectContextSources } from "../lib/generation-source-utils.ts";

function createD1TestDatabase(schema) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const prepare = (sql) => {
    let values = [];
    const statement = {
      bind(...nextValues) { values = nextValues; return statement; },
      first() { return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null); },
      run() { const result = sqlite.prepare(sql).run(...values); return Promise.resolve({ meta: { changes: Number(result.changes ?? 0) } }); },
    };
    return statement;
  };
  return { sqlite, prepare, async batch(statements) { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
}

test("any candidate can be adopted and every adopted memory can feed generation", async () => {
  const base = { publication_id: "publication-1", content_item_id: "content-1", title: "高互动教程", platform: "douyin", external_url: null, published_at: "2026-07-01T00:00:00.000Z", genre: "教程", review_status: "已通过", likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0, homepage_visits: 0, average_watch_seconds: 8, completion_rate_bps: 4000 };
  const snapshot = buildAnalyticsSnapshot([
    { ...base, observed_at: "2026-07-31T12:00:00.000Z", views: 100 },
    { ...base, observed_at: "2026-08-01T12:00:00.000Z", views: 200, likes: 20, comments: 5, shares: 5, saves: 5, followers_gained: -1 },
  ], "2026-08-01", "2026-08-01");
  assert.equal(snapshot.summary.views, 100);
  assert.equal(snapshot.diagnostics.rules.length, 7);

  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_memory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, value_json TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, created_by TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT, updated_at TEXT, created_at TEXT); CREATE TABLE project_memory_evidence (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, memory_item_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, quote TEXT, relevance INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL);");
  const unverified = await createMemoryCandidateWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "single_period_guess", title: "单期教程表现", content: "教程在本周期互动较好。", sourceType: "performance_report", sourceId: "report-only", quote: "本周期互动较好" });
  assert.deepEqual(await transitionProjectMemory({ db, memoryId: unverified.id, organizationId: "org-1", projectId: "project-1", userId: "admin-1", action: "confirm", now: "2026-08-23T00:00:00Z" }), { ok: true, status: "confirmed" });
  const singleVideo = await createMemoryCandidateWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "single_video_hook", title: "单条视频的问题式开场", content: "该对标视频的问题式开场可作为待人工判断的结构经验。", sourceType: "video_analysis", sourceId: "analysis-1", quote: "用问题式开场吸引目标受众" });
  assert.deepEqual(await transitionProjectMemory({ db, memoryId: singleVideo.id, organizationId: "org-1", projectId: "project-1", userId: "admin-1", action: "confirm", now: "2026-08-23T01:00:00Z" }), { ok: true, status: "confirmed" });
  const candidate = await createMemoryCandidateWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "validated_tutorial_engagement", title: "教程体裁互动更稳定", content: "教程体裁连续两个周期的互动质量较好，可继续复用问题开场和步骤拆解。", sourceType: "performance_report", sourceId: "report-2", evidence: [{ sourceType: "performance_report", sourceId: "report-1", quote: "第一周期教程互动较好" }, { sourceType: "performance_report", sourceId: "report-2", quote: "第二周期教程互动仍然较好" }] });
  assert.equal(sqlite.prepare("SELECT status, source_type, source_id FROM project_memory_items WHERE id = ?").get(candidate.id).status, "candidate");
  assert.deepEqual(await transitionProjectMemory({ db, memoryId: candidate.id, organizationId: "org-1", projectId: "project-1", userId: "admin-1", action: "confirm", now: "2026-08-24T00:00:00Z" }), { ok: true, status: "confirmed" });

  const stored = sqlite.prepare("SELECT id, organization_id, project_id, title, content, status, source_type, source_id, revision, content_hash FROM project_memory_items WHERE id = ?").get(candidate.id);
  const authorized = retrieveAuthorizedProjectKnowledge({
    rows: [{ sourceType: "memory", sourceId: stored.id, organizationId: stored.organization_id, projectId: stored.project_id, title: stored.title, text: stored.content, status: stored.status, revision: stored.revision, contentHash: stored.content_hash, originSourceType: stored.source_type, originSourceId: stored.source_id, feedbackReuse: true }],
    organizationId: "org-1",
    projectId: "project-1",
    query: "互动 分发",
    now: "2026-08-24T01:00:00Z",
  });
  const sources = mapProjectContextSources(authorized, "org-1", "project-1");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceId, candidate.id);
  assert.equal(sources[0].feedbackReuse, true);
  sqlite.close();
});
