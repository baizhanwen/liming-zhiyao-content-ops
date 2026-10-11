import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  normalizeProjectAssistantConfidence,
  ProjectAssistantInvalidResponseError,
  parseProjectAssistantChatResponse,
} from "../lib/project-assistant-contract.ts";
import {
  applyProjectMemoryOperationsWithDb,
  claimProjectMemoryEventWithDb,
  enqueueProjectMemoryEventWithDb,
  isProjectMemoryConfidenceRepairSummary,
  readProjectMemoryConfidenceRepairCandidatesWithDb,
  readProjectMemoryExtractionContextWithDb,
  requeueProjectMemoryConfidenceRepairCandidatesWithDb,
} from "../lib/project-memory-events.ts";
import {
  createProjectAssistantConversationWithDb,
  listProjectAssistantConversationsWithDb,
  questionRequestsProjectAssistantRecommendations,
  readProjectAssistantMessagesWithDb,
  runProjectAssistantConversationWithDb,
} from "../lib/project-assistant-conversation.ts";
import { readProjectAssistantBenchmarkStatusWithDb } from "../lib/project-assistant-benchmarks.ts";
import { saveProjectAssistantRecommendationsWithDb } from "../lib/project-assistant-cards.ts";
import { collapseProjectMemoryListItems } from "../lib/project-memory-list.ts";
import { areProjectMemoriesEquivalent } from "../lib/project-memory-similarity.ts";
import { transitionProjectMemory } from "../lib/project-memory-state.ts";

const SCHEMA = String.raw`
CREATE TABLE content_strategies (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  version INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  positioning TEXT, target_audience TEXT, style_notes TEXT, objectives_json TEXT,
  pillars_json TEXT, persona TEXT, cadence TEXT
);
CREATE TABLE topic_ideas (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  title TEXT NOT NULL, angle TEXT, source_type TEXT NOT NULL, source_ref TEXT,
  pillar TEXT, audience TEXT, objective TEXT, hook TEXT, rationale TEXT, priority INTEGER,
  selected_knowledge_ids_json TEXT NOT NULL, source_manifest_json TEXT NOT NULL,
  missing_context_json TEXT NOT NULL, risk_notes_json TEXT NOT NULL, status TEXT NOT NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE topic_citations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topic_ideas(id), citation_type TEXT NOT NULL,
  citation_id TEXT NOT NULL, quote TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(topic_id, citation_type, citation_id)
);
CREATE TABLE project_memory_events (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  event_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT,
  dedupe_key TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL, operation_summary_json TEXT NOT NULL, attempt_count INTEGER NOT NULL,
  error_code TEXT, error_message TEXT, model_provider TEXT, model_name TEXT,
  prompt_version TEXT, created_by TEXT NOT NULL, processed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_memory_event_dedupe ON project_memory_events (organization_id, project_id, dedupe_key);
CREATE TABLE project_memory_items (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL, value_json TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT, revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL, created_by TEXT NOT NULL, confirmed_by TEXT,
  confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT, superseded_by TEXT,
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_memory_revision ON project_memory_items (organization_id, project_id, canonical_key, revision);
CREATE TABLE project_memory_evidence (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  memory_item_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  quote TEXT, relevance INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
  actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL, metadata_json TEXT, ip_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE project_assistant_conversations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE project_assistant_messages (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  content TEXT NOT NULL, suggestions_json TEXT NOT NULL, citations_json TEXT NOT NULL,
  memory_operations_json TEXT NOT NULL, model_provider TEXT, model_name TEXT,
  prompt_version TEXT, error_code TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE project_inspiration_cards (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, core_insight TEXT NOT NULL, applicable_scenarios_json TEXT NOT NULL,
  excluded_scenarios_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT, tags_json TEXT NOT NULL,
  confidence INTEGER, content_hash TEXT NOT NULL, created_by TEXT NOT NULL,
  confirmed_by TEXT, confirmed_at TEXT, rejected_by TEXT, rejected_at TEXT,
  superseded_by TEXT, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_card_revision ON project_inspiration_cards (organization_id, project_id, canonical_key, version);
CREATE TABLE project_inspiration_card_sources (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  card_id TEXT NOT NULL, conversation_id TEXT, message_id TEXT, memory_item_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_card_source_unique ON project_inspiration_card_sources (card_id, message_id, memory_item_id);
CREATE TABLE videos (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  title TEXT, source_url TEXT, author_name TEXT, deleted_at TEXT
);
CREATE TABLE video_library_entries (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, source_video_id TEXT NOT NULL
);
CREATE TABLE project_video_references (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  library_entry_id TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE video_analyses (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  video_id TEXT NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE video_metric_snapshots (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, video_id TEXT NOT NULL,
  plays INTEGER, likes INTEGER, comments INTEGER, favorites INTEGER, shares INTEGER,
  collected_at TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

function createD1TestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  sqlite.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE organization_members(user_id TEXT,organization_id TEXT,role TEXT,status TEXT);
    CREATE TABLE project_members(user_id TEXT,organization_id TEXT,project_id TEXT,role TEXT,status TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,organization_id TEXT,status TEXT,deleted_at TEXT);
    INSERT INTO users VALUES('user-1','active');
    INSERT INTO organizations VALUES('org-1','active');
    INSERT INTO organization_members VALUES('user-1','org-1','admin','active');
    INSERT INTO projects VALUES('project-1','org-1','active',NULL),('project-2','org-1','active',NULL);
  `);
  const prepare = (sql) => {
    let values = [];
    const statement = {
      bind(...nextValues) { values = nextValues; return statement; },
      first() { return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null); },
      all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...values) }); },
      run() {
        const result = sqlite.prepare(sql).run(...values);
        return Promise.resolve({ meta: { changes: Number(result.changes ?? 0) } });
      },
    };
    return statement;
  };
  const db = {
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
  return { sqlite, db };
}

test("generated topic suggestions stay in inspiration, including legacy model topic fields", async () => {
  const { sqlite, db } = createD1TestDatabase();
  try {
    insertBenchmark(sqlite, { id: "local", projectId: "project-1", title: "背景目标输出", summary: "用背景、目标和输出要求讲解提问方法。" });
    insertBenchmark(sqlite, { id: "foreign", projectId: "project-2", title: "其他空间", summary: "其他空间的素材不得进入本项目。" });
    const conversation = await createProjectAssistantConversationWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1" });
    // A legacy-shaped model response must not trigger any topic writes.
    sqlite.exec("CREATE TRIGGER reject_topic BEFORE INSERT ON topic_ideas BEGIN SELECT RAISE(ABORT, 'Unexpected topic write'); END;");
    const result = await runProjectAssistantConversationWithDb(db, {
      organizationId: "org-1", projectId: "project-1", userId: "user-1", conversationId: conversation.id, question: "推荐一个具体选题",
      invoke: async ({ system }) => {
        assert.match(system, /不会自动进入选题中心/);
        return { provider: "fake", model: "test", content: JSON.stringify({ reply: "可以围绕提问方式展开。", recommendations: [{ title: "如何向 ChatGPT 说明任务", coreInsight: "用提问前后的对比，解释背景、目标和输出要求。", benchmarkIds: ["local", "foreign"], topic: { angle: "对比一句模糊提问与交代完整任务之后的回答。" }, topicId: "model-invented-id" }] }) };
      },
    });
    const suggestion = result.assistantMessage.suggestions[0];
    assert.equal(suggestion.topicId, undefined);
    assert.equal(suggestion.topic, undefined);
    assert.deepEqual(suggestion.benchmarkIds, ["local"]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM topic_ideas").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM topic_citations").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'topic.created'").get().count, 0);
    for (let i = 0; i < 2; i++) {
      const transcript = await readProjectAssistantMessagesWithDb(db, { organizationId: "org-1", projectId: "project-1", conversationId: conversation.id });
      assert.equal(transcript.messages.find(message => message.role === "assistant").suggestions[0].topicId, undefined);
    }
    const saved = await saveProjectAssistantRecommendationsWithDb(db, { organizationId: "org-1", projectId: "project-1", userId: "user-1", messageId: result.assistantMessage.id, recommendationIndexes: [0] });
    assert.equal(saved.length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM project_inspiration_cards").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM topic_ideas").get().count, 0);
  } finally { sqlite.close(); }
});

async function enqueueAndClaim(db, sourceId, projectId = "project-1", sourceType = "project_assistant_message") {
  const queued = await enqueueProjectMemoryEventWithDb(db, {
    organizationId: "org-1",
    projectId,
    userId: "user-1",
    eventType: "inspiration_conversation",
    sourceType,
    sourceId,
    payload: { sourceId },
  });
  const claimed = await claimProjectMemoryEventWithDb(db, {
    eventId: queued.event.id,
    organizationId: "org-1",
    projectId,
  });
  assert.equal(claimed.claimed, true);
  return db.prepare("SELECT * FROM project_memory_events WHERE id = ?").bind(queued.event.id).first();
}

function memoryOperation(overrides = {}) {
  return {
    operation: "add",
    canonicalKey: "video_analysis_preference",
    title: "视频分析偏好",
    content: "优先分析结构、语言与节奏。",
    confidence: 92,
    evidence: [{ sourceType: "video_analysis", sourceId: "analysis-1", quote: "本次重点关注结构与节奏" }],
    mergeFromKeys: [],
    reason: "多次反馈形成稳定偏好。",
    ...overrides,
  };
}

function insertConfirmedMemory(sqlite, { id, projectId, content }) {
  sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, confirmed_by, confirmed_at, created_at, updated_at) VALUES (?, 'org-1', ?, 'audience', 'target_audience', 'hard', 'confirmed', '目标客户', ?, '{}', 'project_assistant', 'event-seed', 1, ?, 'user-1', 'user-1', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z')").run(id, projectId, content, "hash-" + id);
}

function insertBenchmark(sqlite, { id, projectId, title, summary }) {
  const videoId = "video-" + id;
  sqlite.prepare("INSERT INTO videos (id, organization_id, project_id, title, source_url, author_name, deleted_at) VALUES (?, 'org-1', ?, ?, NULL, '对标作者', NULL)").run(videoId, projectId, title);
  sqlite.prepare("INSERT INTO video_library_entries (id, organization_id, source_video_id) VALUES (?, 'org-1', ?)").run(id, videoId);
  sqlite.prepare("INSERT INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, status, created_at) VALUES (?, 'org-1', ?, ?, 'benchmark', 'active', '2026-08-28T00:00:00Z')").run("ref-" + id, projectId, id);
  sqlite.prepare("INSERT INTO video_analyses (id, organization_id, project_id, video_id, report_json, created_at) VALUES (?, 'org-1', ?, ?, ?, '2026-08-28T00:00:00Z')").run("analysis-" + id, projectId, videoId, JSON.stringify({ summary, hook: "问题式开场", audience: "企业经营者", structure: ["冲突", "方法", "行动"], highlights: ["用具体案例证明方法"], recommendations: ["复用问题钩子"] }));
}

test("project assistant model configuration has no implicit content or analyzer fallback", () => {
  const source = readFileSync(new URL("../lib/project-assistant-model.ts", import.meta.url), "utf8");
  assert.match(source, /PROJECT_ASSISTANT_MODEL_API_KEY/);
  assert.match(source, /implicitFallback:\s*false/);
  assert.doesNotMatch(source, /CONTENT_MODEL_(?:PROVIDER|BASE_URL|NAME|API_KEY)/);
  assert.doesNotMatch(source, /ANALYZER_(?:LLM|VISION)_[A-Z_]+/);
});

test("only inspiration assistant reads adopted memories; topic and content stay isolated", () => {
  const conversation = readFileSync(new URL("../lib/project-assistant-conversation.ts", import.meta.url), "utf8");
  const statusRoute = readFileSync(new URL("../app/api/project-assistant/status/route.ts", import.meta.url), "utf8");
  assert.match(conversation, /benchmarkLibrary/);
  assert.match(statusRoute, /readProjectAssistantBenchmarkStatusWithDb/);
  assert.match(conversation, /readInspirationMemories/);
  for (const path of ["../app/api/topics/generate/route.ts", "../app/api/content-items/[contentId]/generate/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /readInspirationMemories|readCurrentProjectMemoriesWithDb|retrieveProjectContext/);
  }
  assert.doesNotMatch(statusRoute, /readProjectMemoryEventSummaryWithDb/);
});

test("project memory workspace uses only adopt or reject decisions", () => {
  const memory = readFileSync(new URL("../components/ProjectMemoryWorkspace.tsx", import.meta.url), "utf8");
  const inspiration = readFileSync(new URL("../components/InspirationWorkspace.tsx", import.meta.url), "utf8");
  assert.match(memory, /候选由系统提取 · 人工决定/);
  assert.match(memory, /待采纳/);
  assert.match(memory, /已采纳/);
  assert.match(memory, /不采纳/);
  assert.match(memory, /已采纳记忆仅用于灵感对话/);
  assert.doesNotMatch(memory, /PROJECT_MEMORY_CATEGORIES|<label>分类|八类长期档案/);
  assert.match(memory, /系统不会借用视频分析或内容生成模型/);
  assert.match(memory, /当前没有待提取的新信息/);
  assert.match(memory, /审核退回意见会直接生成待采纳候选/);
  assert.ok(memory.includes("finally {"));
  assert.ok(memory.includes("setSyncing(false);"));
  assert.equal(memory.includes("disabled={!canWrite || syncing || !configuration?.configured}"), false);
  assert.match(inspiration, /生成的建议可手动保存为灵感卡片/);
  assert.doesNotMatch(inspiration, /已加入选题中心|suggestion\.topicId/);
  assert.doesNotMatch(inspiration, /已读取 .*当前项目记忆/);
  assert.match(inspiration, /可连续追问 · 刷新后保留/);
  assert.match(inspiration, /保存为灵感卡/);
  assert.match(inspiration, /让项目助理给出建议后，可一键把建议保存到这里/);
});
test("confirming an edited memory immediately replaces every active revision", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const insert = sqlite.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, created_at, updated_at) VALUES (?, 'org-1', 'project-1', 'content_style/analogy', ?, 'soft', ?, '类比表达', ?, '{}', ?, ?, ?, ?, 'user-1', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')");
  insert.run("memory-v1", "memory", "confirmed", "优先使用类比。", "project_assistant", "event-1", 1, "hash-v1");
  insert.run("memory-v2", "memory", "candidate", "使用老板熟悉的类比。", "project_assistant", "event-2", 2, "hash-v2");
  insert.run("memory-v3", "memory", "candidate", "客户偏好使用老板熟悉的职场类比。", "manual_correction", "memory-v2", 3, "hash-v3");

  const result = await transitionProjectMemory({
    db,
    memoryId: "memory-v3",
    organizationId: "org-1",
    projectId: "project-1",
    userId: "user-1",
    action: "confirm",
    now: "2026-08-28T01:00:00Z",
  });

  assert.deepEqual(result, { ok: true, status: "confirmed" });
  const rows = sqlite.prepare("SELECT id, status, superseded_by FROM project_memory_items ORDER BY revision").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { id: "memory-v1", status: "superseded", superseded_by: "memory-v3" },
    { id: "memory-v2", status: "superseded", superseded_by: "memory-v3" },
    { id: "memory-v3", status: "confirmed", superseded_by: null },
  ]);
  sqlite.close();
});
test("project memory list collapses old revisions and same-title aliases", () => {
  const items = collapseProjectMemoryListItems([
    { id: "old", canonical_key: "analogy-a", status: "candidate", title: "用老板熟悉的职场类比解释 AI 概念", content: "把AI比作新员工，降低老板的理解门槛。", revision: 1, updated_at: "2026-08-28T01:00:00Z" },
    { id: "edited", canonical_key: "analogy-a", status: "candidate", title: "用老板熟悉的职场类比解释AI概念", content: "将AI概念类比为老板熟悉的职场元素，例如把AI比作新招员工，大模型比作脑子，提示词比作工作指令，知识库比作培训资料，降低非技术老板的理解门槛。", revision: 2, updated_at: "2026-08-28T02:00:00Z" },
    { id: "adopted-alias", canonical_key: "analogy-b", status: "confirmed", title: "用职场类比降低非技术老板理解门槛", content: "面向老板解释AI时，用新员工、脑子、工作指令和培训资料等熟悉的职场类比解释AI概念，降低非技术背景老板的理解门槛并提升接受度。", revision: 1, updated_at: "2026-08-28T03:00:00Z" },
    { id: "other", canonical_key: "question-hook", status: "candidate", title: "问题式开场", content: "开场抛出受众最关心的问题，吸引继续观看。", revision: 1, updated_at: "2026-08-28T04:00:00Z" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["adopted-alias", "other"]);
});
test("semantic similarity merges equivalent atoms but keeps adjacent mechanisms separate", () => {
  assert.equal(areProjectMemoriesEquivalent(
    { title: "用评论区指令引导互动转化", content: "在结尾设置明确评论区指令，促进互动和转化。" },
    { title: "用评论区互动引导提升转化", content: "结尾给出明确互动指令，降低行动门槛并促进观众转化。" },
  ), true);
  assert.equal(areProjectMemoriesEquivalent(
    { title: "用免费资源作为转化诱饵", content: "提供手册并引导观众领取。" },
    { title: "用评论区指令引导互动转化", content: "设置明确评论指令促进互动。" },
  ), false);
});

test("extraction context includes pending atoms while semantic aliases only add evidence", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const firstEvent = await enqueueAndClaim(db, "semantic-source-1");
  const first = await applyProjectMemoryOperationsWithDb(db, {
    event: firstEvent,
    operations: [memoryOperation({
      canonicalKey: "comment_instruction",
      title: "用评论区指令引导互动转化",
      content: "在内容结尾设置明确的评论区指令，能有效促进互动和转化。",
      evidence: [{ sourceType: "project_assistant_message", sourceId: "semantic-message-1", quote: "评论区扣关键词" }],
    })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v8",
  });
  assert.equal(first[0].outcome, "candidate");

  const context = await readProjectMemoryExtractionContextWithDb(db, { organizationId: "org-1", projectId: "project-1" });
  assert.equal(context.length, 1);
  assert.equal(context[0].status, "candidate");
  assert.equal(context[0].canonicalKey, "comment_instruction");

  const secondEvent = await enqueueAndClaim(db, "semantic-source-2");
  const second = await applyProjectMemoryOperationsWithDb(db, {
    event: secondEvent,
    operations: [memoryOperation({
      canonicalKey: "comment_engagement_conversion",
      title: "用评论区互动引导提升转化",
      content: "在结尾给出明确互动指令，降低行动门槛并促进观众参与和转化。",
      evidence: [{ sourceType: "project_assistant_message", sourceId: "semantic-message-2", quote: "留言领取资料" }],
    })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v8",
  });
  assert.equal(second[0].outcome, "deduplicated");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items").get().count), 1);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_evidence").get().count), 2);
  sqlite.close();
});
test("invalid model JSON has an explicit 502-safe contract error", () => {
  assert.throws(
    () => parseProjectAssistantChatResponse("not-json"),
    (error) => error instanceof ProjectAssistantInvalidResponseError && error.code === "PROJECT_ASSISTANT_INVALID_RESPONSE",
  );
});

test("project assistant confidence accepts fractional and percentage scales exactly once", () => {
  assert.equal(normalizeProjectAssistantConfidence(0), 0);
  assert.equal(normalizeProjectAssistantConfidence(0.01), 1);
  assert.equal(normalizeProjectAssistantConfidence(0.65), 65);
  assert.equal(normalizeProjectAssistantConfidence(1), 100);
  assert.equal(normalizeProjectAssistantConfidence(1.01), 1);
  assert.equal(normalizeProjectAssistantConfidence(65), 65);
  assert.equal(normalizeProjectAssistantConfidence(100), 100);
  assert.equal(normalizeProjectAssistantConfidence("not-a-number", 70), 70);
});

test("legacy fractional confidence failures are identified and requeued exactly once", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const legacyEvent = await enqueueAndClaim(db, "legacy-confidence-source");
  const legacySummary = [
    { operation: "add", canonicalKey: "audience", outcome: "skipped", confidence: 1, reason: "置信度低于 65，未写入记忆。" },
    { operation: "revise", canonicalKey: "analysis_focus", outcome: "skipped", confidence: 1, reason: "置信度低于 65，未写入记忆。" },
  ];
  sqlite.prepare("UPDATE project_memory_events SET status = 'completed', operation_summary_json = ?, prompt_version = 'project-assistant.v1', processed_at = '2026-08-24T01:00:00Z' WHERE id = ?")
    .run(JSON.stringify(legacySummary), legacyEvent.id);

  const noopEvent = await enqueueAndClaim(db, "intentional-noop-source");
  sqlite.prepare("UPDATE project_memory_events SET status = 'completed', operation_summary_json = ?, prompt_version = 'project-assistant.v1', processed_at = '2026-08-24T01:01:00Z' WHERE id = ?")
    .run(JSON.stringify([{ operation: "noop", canonicalKey: null, outcome: "noop", confidence: 0, reason: "无需更新。" }]), noopEvent.id);

  assert.equal(isProjectMemoryConfidenceRepairSummary(legacySummary), true);
  assert.equal(isProjectMemoryConfidenceRepairSummary([{ ...legacySummary[0], confidence: 65 }]), false);
  const preview = await readProjectMemoryConfidenceRepairCandidatesWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
  });
  assert.equal(preview.count, 1);
  assert.equal(preview.operationCount, 2);
  assert.equal(preview.candidates[0].id, legacyEvent.id);

  const repaired = await requeueProjectMemoryConfidenceRepairCandidatesWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    userId: "user-1",
    now: "2026-08-25T01:00:00Z",
  });
  assert.equal(repaired.count, 1);
  assert.equal(repaired.operationCount, 2);
  const row = sqlite.prepare("SELECT status, operation_summary_json, prompt_version, processed_at FROM project_memory_events WHERE id = ?").get(legacyEvent.id);
  assert.deepEqual({ ...row }, { status: "pending", operation_summary_json: "[]", prompt_version: null, processed_at: null });
  const audit = sqlite.prepare("SELECT action, target_id, metadata_json FROM audit_logs").get();
  assert.equal(audit.action, "project_memory.confidence_scale_requeued");
  assert.equal(audit.target_id, legacyEvent.id);
  assert.equal(JSON.parse(audit.metadata_json).operationCount, 2);

  const repeated = await requeueProjectMemoryConfidenceRepairCandidatesWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    userId: "user-1",
  });
  assert.equal(repeated.count, 0);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM audit_logs").get().count), 1);
  sqlite.close();
});

test("memory events deduplicate stable payloads inside one project but stay isolated across projects", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const first = await enqueueProjectMemoryEventWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
    eventType: "video_analysis_completed", sourceType: "video_analysis", sourceId: "analysis-1",
    payload: { b: 2, a: 1 },
  });
  const duplicate = await enqueueProjectMemoryEventWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
    eventType: "video_analysis_completed", sourceType: "video_analysis", sourceId: "analysis-1",
    payload: { a: 1, b: 2 },
  });
  const otherProject = await enqueueProjectMemoryEventWithDb(db, {
    organizationId: "org-1", projectId: "project-2", userId: "user-1",
    eventType: "video_analysis_completed", sourceType: "video_analysis", sourceId: "analysis-1",
    payload: { a: 1, b: 2 },
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.event.id, first.event.id);
  assert.equal(otherProject.created, true);
  assert.notEqual(otherProject.event.id, first.event.id);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_events").get().count), 2);
  sqlite.close();
});

test("automatic extraction only creates candidates, accumulates evidence, deduplicates and gates confidence", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const firstEvent = await enqueueAndClaim(db, "source-1");
  const firstSummary = await applyProjectMemoryOperationsWithDb(db, {
    event: firstEvent,
    operations: [memoryOperation({ content: "优先分析结构和节奏。", confidence: 95 })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v1",
  });
  assert.equal(firstSummary[0].outcome, "candidate");

  const secondEvent = await enqueueAndClaim(db, "source-2");
  const secondSummary = await applyProjectMemoryOperationsWithDb(db, {
    event: secondEvent,
    operations: [memoryOperation({ operation: "revise", content: "长视频分析优先覆盖结构、亮点、画面、语言和节奏。", confidence: 96, evidence: [{ sourceType: "project_assistant_message", sourceId: "message-2", quote: "以后长视频都按五个模块分析" }] })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v1",
  });
  assert.equal(secondSummary[0].outcome, "candidate");
  assert.deepEqual(
    sqlite.prepare("SELECT revision, status FROM project_memory_items WHERE canonical_key = 'video_analysis_preference' ORDER BY revision").all().map((row) => [Number(row.revision), row.status]),
    [[1, "candidate"], [2, "candidate"]],
  );

  const duplicateEvent = await enqueueAndClaim(db, "source-3");
  const duplicateSummary = await applyProjectMemoryOperationsWithDb(db, {
    event: duplicateEvent,
    operations: [memoryOperation({ operation: "revise", content: "长视频分析优先覆盖结构、亮点、画面、语言和节奏。", confidence: 98 })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v1",
  });
  assert.equal(duplicateSummary[0].outcome, "deduplicated");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items WHERE canonical_key = 'video_analysis_preference'").get().count), 2);

  const candidateEvent = await enqueueAndClaim(db, "source-4");
  const candidateSummary = await applyProjectMemoryOperationsWithDb(db, {
    event: candidateEvent,
    operations: [memoryOperation({ canonicalKey: "topic_style", title: "选题风格", content: "优先使用问题式标题。", confidence: 70 })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v1",
  });
  assert.equal(candidateSummary[0].outcome, "candidate");

  const skippedEvent = await enqueueAndClaim(db, "source-5");
  const skippedSummary = await applyProjectMemoryOperationsWithDb(db, {
    event: skippedEvent,
    operations: [memoryOperation({ canonicalKey: "weak_guess", title: "弱推测", content: "未经证实的推测。", confidence: 60 })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v1",
  });
  assert.equal(skippedSummary[0].outcome, "skipped");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items WHERE canonical_key = 'weak_guess'").get().count), 0);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_evidence").get().count), 4);
  sqlite.close();
});

test("one benchmark video creates a candidate and later evidence strengthens it", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const singleEvent = await enqueueAndClaim(db, "analysis-1", "project-1", "video_analysis");
  const single = await applyProjectMemoryOperationsWithDb(db, {
    event: singleEvent,
    operations: [memoryOperation({
      canonicalKey: "benchmark_question_hook",
      title: "问题式开头表现稳定",
      content: "问题式开头在对标内容中表现稳定。",
      evidence: [{ sourceType: "video_analysis", sourceId: "analysis-1", quote: "用问题开场" }],
    })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v8",
  });
  assert.equal(single[0].outcome, "candidate");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items").get().count), 1);
  assert.equal(sqlite.prepare("SELECT status FROM project_memory_items").get().status, "candidate");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_evidence").get().count), 1);

  const corroboratedEvent = await enqueueAndClaim(db, "analysis-2", "project-1", "video_analysis");
  const corroborated = await applyProjectMemoryOperationsWithDb(db, {
    event: corroboratedEvent,
    operations: [memoryOperation({
      canonicalKey: "benchmark_question_hook",
      title: "问题式开头表现稳定",
      content: "问题式开头在对标内容中表现稳定。",
      evidence: [
        { sourceType: "video_analysis", sourceId: "analysis-1", quote: "用问题开场" },
        { sourceType: "video_analysis", sourceId: "analysis-2", quote: "以受众疑问开场" },
      ],
    })],
    provider: "fake", model: "assistant-test", promptVersion: "project-assistant.v8",
  });
  assert.equal(corroborated[0].outcome, "deduplicated");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items").get().count), 1);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_evidence").get().count), 2);
  sqlite.close();
});

test("recommendation questions get one controlled repair and plain replies remain saveable", async () => {
  const { sqlite, db } = createD1TestDatabase();
  assert.equal(questionRequestsProjectAssistantRecommendations("请推荐三个系列选题"), true);
  assert.equal(questionRequestsProjectAssistantRecommendations("帮我整理刚才这段话"), false);

  const recommendationConversation = await createProjectAssistantConversationWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
  });
  let calls = 0;
  const repaired = await runProjectAssistantConversationWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    conversationId: recommendationConversation.id,
    userId: "user-1",
    question: "请推荐三个系列选题",
    invoke: async (input) => {
      calls += 1;
      const modelInput = JSON.parse(input.user);
      assert.equal(modelInput.requiresRecommendations, true);
      assert.equal(modelInput.benchmarkContext.available, false);
      if (calls === 1) {
        return {
          provider: "fake-provider", model: "assistant-test", latencyMs: 1, raw: {},
          content: JSON.stringify({
            reply: "当前暂无可用对标内容，我先给出一个初步方向。",
            citations: [],
            recommendations: [],
            memoryOperations: [{ operation: "noop", confidence: 100, reason: "暂无稳定规律。" }],
          }),
        };
      }
      assert.equal(modelInput.repair.reason, "recommendations_empty");
      return {
        provider: "fake-provider", model: "assistant-test", latencyMs: 1, raw: {},
        content: JSON.stringify({
          reply: "当前暂无可用对标内容，建议先用一个低成本系列验证受众反馈。",
          citations: [],
          recommendations: [{
            title: "客户最常问的三个问题",
            coreInsight: "先把高频问题拆成三期，用真实反馈校准后续内容方向。",
            applicableScenarios: ["项目起步期"],
            excludedScenarios: [],
            tags: ["验证", "系列"],
            confidence: 72,
            benchmarkIds: [],
          }],
          memoryOperations: [{ operation: "noop", confidence: 100, reason: "本轮只是初始建议。" }],
        }),
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(repaired.assistantMessage.suggestions.length, 1);

  const plainConversation = await createProjectAssistantConversationWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
  });
  let plainCalls = 0;
  const plain = await runProjectAssistantConversationWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    conversationId: plainConversation.id,
    userId: "user-1",
    question: "帮我整理刚才这段话",
    invoke: async () => {
      plainCalls += 1;
      return {
        provider: "fake-provider", model: "assistant-test", latencyMs: 1, raw: {},
        content: JSON.stringify({
          reply: "这段想法的核心是先验证真实需求，再根据反馈决定是否扩展成系列内容。",
          citations: [],
          recommendations: [],
          memoryOperations: [{ operation: "noop", confidence: 100, reason: "只是整理表达。" }],
        }),
      };
    },
  });
  assert.equal(plainCalls, 1);
  assert.equal(plain.assistantMessage.suggestions.length, 0);
  const replyCards = await saveProjectAssistantRecommendationsWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    messageId: plain.assistantMessage.id,
    userId: "user-1",
    recommendationIndexes: [],
    saveReply: true,
  });
  assert.equal(replyCards.length, 1);
  assert.equal(replyCards[0].index, -1);
  assert.match(String(sqlite.prepare("SELECT canonical_key FROM project_inspiration_cards WHERE id = ?").get(replyCards[0].id).canonical_key), /_reply$/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_inspiration_card_sources WHERE message_id = ?").get(plain.assistantMessage.id).count), 1);
  sqlite.close();
});

test("legacy project-memory references are ignored when old inspiration messages are reopened or saved", async () => {
  const { sqlite, db } = createD1TestDatabase();
  const conversation = await createProjectAssistantConversationWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
  });
  sqlite.prepare("INSERT INTO project_assistant_messages (id, organization_id, project_id, conversation_id, role, status, content, suggestions_json, citations_json, memory_operations_json, model_provider, model_name, prompt_version, error_code, created_by, created_at) VALUES ('legacy-message', 'org-1', 'project-1', ?, 'assistant', 'completed', '旧回复', ?, ?, '[]', 'fake', 'old-model', 'project-assistant.v8', NULL, 'user-1', '2026-08-28T00:00:00Z')").run(
    conversation.id,
    JSON.stringify([{
      title: "旧灵感", coreInsight: "保留内容，但不再沿用项目记忆引用。",
      applicableScenarios: ["历史对话"], excludedScenarios: [], tags: ["旧数据"], confidence: 80,
      memoryIds: ["memory-legacy"],
    }]),
    JSON.stringify([{ memoryId: "memory-legacy", quote: "旧项目记忆" }]),
  );
  const transcript = await readProjectAssistantMessagesWithDb(db, {
    organizationId: "org-1", projectId: "project-1", conversationId: conversation.id,
  });
  assert.deepEqual(transcript.messages[0].citations, []);
  assert.deepEqual(transcript.messages[0].suggestions[0].benchmarkIds, []);
  const cards = await saveProjectAssistantRecommendationsWithDb(db, {
    organizationId: "org-1", projectId: "project-1", messageId: "legacy-message",
    userId: "user-1", recommendationIndexes: [0],
  });
  assert.equal(cards.length, 1);
  assert.equal(sqlite.prepare("SELECT evidence_json FROM project_inspiration_cards WHERE id = ?").get(cards[0].id).evidence_json, "[]");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items WHERE source_type = 'inspiration_card'").get().count), 0);
  sqlite.close();
});

test("assistant conversations use only current enterprise-space benchmarks and save benchmark evidence", async () => {
  const { sqlite, db } = createD1TestDatabase();
  insertConfirmedMemory(sqlite, { id: "memory-p1", projectId: "project-1", content: "这条已采纳记忆可用于灵感讨论具体内容问题。" });
  insertBenchmark(sqlite, { id: "benchmark-p1", projectId: "project-1", title: "制造业增长三问", summary: "用问题钩子拆解制造业获客、转化和复购。" });
  insertBenchmark(sqlite, { id: "benchmark-p2", projectId: "project-2", title: "餐饮门店增长", summary: "用门店案例拆解复购。" });
  assert.deepEqual(await readProjectAssistantBenchmarkStatusWithDb(db, {
    organizationId: "org-1", projectId: "project-1",
  }), { available: true, activeCount: 1, readyCount: 1 });
  const conversation = await createProjectAssistantConversationWithDb(db, {
    organizationId: "org-1", projectId: "project-1", userId: "user-1",
  });
  let modelInput = null;
  const result = await runProjectAssistantConversationWithDb(db, {
    organizationId: "org-1",
    projectId: "project-1",
    conversationId: conversation.id,
    userId: "user-1",
    question: "根据对标内容推荐三个系列选题",
    invoke: async (input) => {
      modelInput = JSON.parse(input.user);
      return {
        provider: "fake-provider",
        model: "assistant-test",
        latencyMs: 1,
        raw: {},
        content: JSON.stringify({
          reply: "建议围绕制造业老板的增长焦虑，连续拆解获客、转化和复购。",
          citations: [
            { benchmarkId: "benchmark-p1", quote: "拆解制造业获客、转化和复购" },
            { benchmarkId: "benchmark-p2", quote: "门店案例" },
          ],
          recommendations: [{
            title: "制造业增长三问",
            coreInsight: "围绕已确认的客户增长诉求拆成获客、转化、复购三期内容。",
            applicableScenarios: ["短视频系列"],
            excludedScenarios: ["餐饮项目"],
            tags: ["制造业", "增长"],
            confidence: 88,
            benchmarkIds: ["benchmark-p1", "benchmark-p2"],
          }],
          memoryOperations: [{ operation: "noop", confidence: 100, reason: "本轮只是一次选题建议。" }],
        }),
      };
    },
  });
  assert.deepEqual(modelInput.benchmarkLibrary.map((item) => item.id), ["benchmark-p1"]);
  assert.equal("currentProjectMemory" in modelInput, false);
  assert.deepEqual(result.assistantMessage.citations.map((item) => item.benchmarkId), ["benchmark-p1"]);
  assert.deepEqual(result.assistantMessage.suggestions[0].benchmarkIds, ["benchmark-p1"]);
  assert.equal(result.knowledgeSource, "benchmark_and_memory_library");
  assert.equal(modelInput.memoryLibrary[0].id, "memory-p1");

  const transcript = await readProjectAssistantMessagesWithDb(db, {
    organizationId: "org-1", projectId: "project-1", conversationId: conversation.id,
  });
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[1].provider, "fake-provider");
  assert.equal(await readProjectAssistantMessagesWithDb(db, {
    organizationId: "org-1", projectId: "project-2", conversationId: conversation.id,
  }), null);
  assert.equal((await listProjectAssistantConversationsWithDb(db, { organizationId: "org-1", projectId: "project-1" })).length, 1);
  assert.equal((await listProjectAssistantConversationsWithDb(db, { organizationId: "org-1", projectId: "project-2" })).length, 0);

  const firstSave = await saveProjectAssistantRecommendationsWithDb(db, {
    organizationId: "org-1", projectId: "project-1", messageId: result.assistantMessage.id,
    userId: "user-1", recommendationIndexes: [0],
  });
  const repeatedSave = await saveProjectAssistantRecommendationsWithDb(db, {
    organizationId: "org-1", projectId: "project-1", messageId: result.assistantMessage.id,
    userId: "user-1", recommendationIndexes: [0],
  });
  assert.equal(firstSave[0].existing, false);
  assert.equal(repeatedSave[0].existing, true);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_inspiration_cards").get().count), 1);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) count FROM project_memory_items WHERE source_type = 'inspiration_card'").get().count), 0);
  const trace = sqlite.prepare("SELECT project_id, conversation_id, message_id, memory_item_id FROM project_inspiration_card_sources").get();
  assert.deepEqual({ ...trace }, {
    project_id: "project-1",
    conversation_id: conversation.id,
    message_id: result.assistantMessage.id,
    memory_item_id: null,
  });
  assert.match(String(sqlite.prepare("SELECT evidence_json FROM project_inspiration_cards").get().evidence_json), /benchmark-p1/);
  await assert.rejects(() => saveProjectAssistantRecommendationsWithDb(db, {
    organizationId: "org-1", projectId: "project-2", messageId: result.assistantMessage.id,
    userId: "user-1", recommendationIndexes: [0],
  }), /不属于当前项目/);
  sqlite.close();
});
