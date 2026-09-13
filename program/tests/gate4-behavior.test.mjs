import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMemoryCandidateWithDb } from "../lib/project-memory-candidate.ts";
import { transitionProjectMemory } from "../lib/project-memory-state.ts";
import { retrieveAuthorizedProjectKnowledge } from "../lib/project-knowledge-retrieval.ts";
import { serializeVideoKnowledgeAtom } from "../lib/video-knowledge-atom-source.ts";
import { createInspirationCardWithDb, serializeInspirationCard } from "../lib/project-inspiration-card.ts";
import { transitionInspirationCard } from "../lib/project-inspiration-card-state.ts";

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

test("editing project memory creates a new candidate revision with traceable evidence", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_memory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, value_json TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT, created_at TEXT); CREATE TABLE project_memory_evidence (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, memory_item_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, quote TEXT, relevance INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL);");
  const first = await createMemoryCandidateWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "target_audience", category: "target_audience", title: "目标人群", content: "制造业老板", sourceType: "manual", quote: "我们主要服务制造业老板" });
  const second = await createMemoryCandidateWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "target_audience", category: "target_audience", title: "目标人群（修订）", content: "有增长诉求的制造业老板", sourceType: "client_feedback", sourceId: "feedback-1", quote: "更准确地说，是有增长诉求的制造业老板" });
  assert.equal(first.revision, 1); assert.equal(second.revision, 2); assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_memory_evidence").get().count, 2);
  const rows = sqlite.prepare("SELECT revision, status, content FROM project_memory_items ORDER BY revision").all();
  assert.deepEqual(rows.map((row) => [row.revision, row.status, row.content]), [[1, "candidate", "制造业老板"], [2, "candidate", "有增长诉求的制造业老板"]]);
});

test("confirming a revised project memory supersedes the prior confirmed revision", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_memory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, category TEXT, status TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT, updated_at TEXT NOT NULL);");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("memory-old", "org-1", "project-1", "positioning", "confirmed_decision", "confirmed", "2026-08-21T00:00:00Z");
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("memory-new", "org-1", "project-1", "positioning", "confirmed_decision", "candidate", "2026-08-21T01:00:00Z");
  const result = await transitionProjectMemory({ db, memoryId: "memory-new", organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "confirm", now: "2026-08-21T02:00:00Z" });
  assert.deepEqual(result, { ok: true, status: "confirmed" });
  assert.deepEqual({ ...sqlite.prepare("SELECT status, superseded_by FROM project_memory_items WHERE id = ?").get("memory-old") }, { status: "superseded", superseded_by: "memory-new" });
});
test("unified project knowledge retrieval enforces scope, status and expiry before ranking", () => {
  const rows = [
    { sourceType: "memory", sourceId: "memory-hard", organizationId: "org-1", projectId: "project-1", title: "硬事实", text: "制造业客户需要增长方案", status: "confirmed", kind: "hard", revision: 2, contentHash: "hash-2" },
    { sourceType: "memory", sourceId: "memory-draft", organizationId: "org-1", projectId: "project-1", title: "草稿", text: "增长草稿", status: "candidate", kind: "hard" },
    { sourceType: "memory", sourceId: "memory-expired", organizationId: "org-1", projectId: "project-1", title: "过期", text: "增长过期", status: "confirmed", kind: "soft", expiresAt: "2026-08-20T00:00:00Z" },
    { sourceType: "knowledge", sourceId: "knowledge-1", organizationId: "org-1", projectId: "project-1", title: "品牌知识", text: "增长内容要有证据", status: "confirmed" },
    { sourceType: "knowledge", sourceId: "knowledge-draft", organizationId: "org-1", projectId: "project-1", title: "未确认", text: "增长不能检索", status: "draft" },
    { sourceType: "video_atom", sourceId: "atom-foreign", organizationId: "org-2", projectId: "project-1", title: "其他公司", text: "增长", status: "active" },
  ];
  const result = retrieveAuthorizedProjectKnowledge({ rows, organizationId: "org-1", projectId: "project-1", query: "增长", now: "2026-08-21T00:00:00Z", limit: 10, maxCharacters: 4000 });
  assert.deepEqual(result.map((item) => item.sourceId), ["memory-hard", "knowledge-1"]);
  assert.deepEqual(result.map((item) => item.rank), [1, 2]);
  assert.ok(result.every((item) => item.text.length <= 4000));
});
test("video knowledge atom source IDs reverse to scoped analysis evidence", () => {
  const atom = serializeVideoKnowledgeAtom({
    id: "atom-1",
    atom_key: "hook-1",
    atom_type: "hook",
    title: "问题开场",
    content: "先指出客户最担心的损失。",
    structured_json: '{"start_sec":12,"end_sec":18}',
    source_locator_json: '{"quote":"客户最担心的损失","segment":2}',
    confidence: 92,
    report_hash: "report-hash",
    extractor_version: "extractor-v1",
    status: "active",
    superseded_by: null,
    analysis_id: "analysis-1",
    analysis_created_at: "2026-08-21T00:00:00Z",
    video_id: "video-1",
    project_id: "project-1",
    created_at: "2026-08-21T00:01:00Z",
    updated_at: "2026-08-21T00:01:00Z",
  });
  assert.deepEqual(atom.sourceLocator, { quote: "客户最担心的损失", segment: 2 });
  assert.deepEqual(atom.structured, { start_sec: 12, end_sec: 18 });
  assert.deepEqual(atom.source, { type: "video_analysis", analysisId: "analysis-1", videoId: "video-1", projectId: "project-1", analyzedAt: "2026-08-21T00:00:00Z" });
  assert.equal(atom.confidence, 92);
});
test("inspiration cards keep evidence and supersede only the confirmed prior revision", async () => {
  const { sqlite, ...db } = createD1TestDatabase("CREATE TABLE project_inspiration_cards (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, canonical_key TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, core_insight TEXT NOT NULL, applicable_scenarios_json TEXT NOT NULL, excluded_scenarios_json TEXT NOT NULL, evidence_json TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, tags_json TEXT NOT NULL, confidence INTEGER, content_hash TEXT NOT NULL, created_by TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
  const first = await createInspirationCardWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "series-angle", title: "系列角度", coreInsight: "把复杂问题拆成一组可连续验证的小实验。", applicableScenarios: ["连续栏目"], excludedScenarios: ["没有证据的断言"], evidence: [{ sourceType: "video_atom", sourceId: "atom-1", quote: "先做小实验" }], sourceType: "video_atom", sourceId: "atom-1", tags: ["实验"], confidence: 88 });
  const second = await createInspirationCardWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", canonicalKey: "series-angle", title: "系列角度修订", coreInsight: "把复杂问题拆成连续小实验，并为每集保留验证依据。", sourceType: "manual" });
  assert.equal(first.version, 1); assert.equal(second.version, 2); assert.notEqual(first.contentHash, second.contentHash);
  const confirmed = await transitionInspirationCard({ db, cardId: first.id, organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "confirm", now: "2026-08-21T02:00:00Z" });
  assert.deepEqual(confirmed, { ok: true, status: "confirmed" });
  const revised = await transitionInspirationCard({ db, cardId: second.id, organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "confirm", now: "2026-08-21T03:00:00Z" });
  assert.deepEqual(revised, { ok: true, status: "confirmed" });
  assert.deepEqual(sqlite.prepare("SELECT status, superseded_by FROM project_inspiration_cards ORDER BY version").all().map((row) => ({ ...row })), [{ status: "superseded", superseded_by: second.id }, { status: "confirmed", superseded_by: null }]);
  const row = sqlite.prepare("SELECT * FROM project_inspiration_cards WHERE id = ?").get(first.id);
  assert.deepEqual(serializeInspirationCard(row).evidence, [{ sourceType: "video_atom", sourceId: "atom-1", quote: "先做小实验" }]);
  assert.deepEqual(await transitionInspirationCard({ db, cardId: first.id, organizationId: "org-1", projectId: "project-1", userId: "user-1", action: "reject", now: "2026-08-21T04:00:00Z" }), { ok: false, reason: "not_actionable" });
});
