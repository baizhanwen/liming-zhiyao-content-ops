import type { ProjectAssistantMemoryOperation } from "./project-assistant-contract.ts";
import { PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND } from "./project-memory-taxonomy.ts";
import { collapseProjectMemoryListItems } from "./project-memory-list.ts";
import { areProjectMemoriesEquivalent, projectMemorySimilarity } from "./project-memory-similarity.ts";


export type ProjectAssistantDbResult = { meta: { changes: number } };

export type ProjectAssistantBoundStatement = {
  first<T>(): Promise<T | null | undefined>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<ProjectAssistantDbResult>;
};

export type ProjectAssistantDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): ProjectAssistantBoundStatement;
  };
  batch(statements: ProjectAssistantBoundStatement[]): Promise<ProjectAssistantDbResult[]>;
};

export type ProjectMemoryEventStatus = "pending" | "processing" | "completed" | "blocked" | "failed";

export type ProjectMemoryEventInput = {
  organizationId: string;
  projectId: string;
  userId: string;
  eventType: string;
  sourceType: string;
  sourceId?: string | null;
  payload: unknown;
};

export type ProjectMemoryEventRow = {
  id: string;
  organization_id: string;
  project_id: string;
  event_type: string;
  source_type: string;
  source_id: string | null;
  dedupe_key: string;
  payload_json: string;
  payload_hash: string;
  status: ProjectMemoryEventStatus;
  operation_summary_json: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  created_by: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MemoryRow = {
  id: string;
  canonical_key: string;
  status: string;
  title: string;
  content: string;
  revision: number;
  content_hash: string;
};

export type AppliedMemoryOperation = {
  operation: ProjectAssistantMemoryOperation["operation"];
  canonicalKey: string | null;
  outcome: "confirmed" | "candidate" | "deduplicated" | "retired" | "skipped" | "noop";
  memoryId?: string;
  revision?: number;
  confidence: number;
  reason: string;
};

export type ProjectMemoryConfidenceRepairCandidate = {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string | null;
  operationCount: number;
  createdAt: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    if (value === undefined) return null;
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function stableProjectAssistantJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export async function sha256ProjectAssistantText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isProjectMemoryConfidenceRepairSummary(value: unknown): value is AppliedMemoryOperation[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const operation = item as Record<string, unknown>;
    const confidence = Number(operation.confidence);
    return operation.operation !== "noop"
      && typeof operation.canonicalKey === "string"
      && operation.canonicalKey.length > 0
      && operation.outcome === "skipped"
      && Number.isFinite(confidence)
      && confidence > 0
      && confidence <= 1
      && !operation.memoryId;
  });
}

export async function readProjectMemoryConfidenceRepairCandidatesWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const rows = await db.prepare(
    "SELECT e.id, e.event_type, e.source_type, e.source_id, e.operation_summary_json, e.created_at, (SELECT COUNT(*) FROM project_memory_items m WHERE m.organization_id = e.organization_id AND m.project_id = e.project_id AND m.source_id = e.id) AS memory_item_count FROM project_memory_events e WHERE e.organization_id = ? AND e.project_id = ? AND e.status = 'completed' AND e.prompt_version = 'project-assistant.v1' ORDER BY e.created_at ASC",
  ).bind(input.organizationId, input.projectId).all<Record<string, unknown>>();
  const candidates: ProjectMemoryConfidenceRepairCandidate[] = [];
  for (const row of rows.results) {
    if (Number(row.memory_item_count) !== 0 || typeof row.operation_summary_json !== "string") continue;
    let summary: unknown;
    try {
      summary = JSON.parse(row.operation_summary_json);
    } catch {
      continue;
    }
    if (!isProjectMemoryConfidenceRepairSummary(summary)) continue;
    candidates.push({
      id: String(row.id),
      eventType: String(row.event_type),
      sourceType: String(row.source_type),
      sourceId: row.source_id ? String(row.source_id) : null,
      operationCount: summary.length,
      createdAt: String(row.created_at),
    });
  }
  return {
    count: candidates.length,
    operationCount: candidates.reduce((sum, item) => sum + item.operationCount, 0),
    candidates,
  };
}

export async function requeueProjectMemoryConfidenceRepairCandidatesWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string; userId: string; now?: string },
) {
  const preview = await readProjectMemoryConfidenceRepairCandidatesWithDb(db, input);
  const now = input.now ?? new Date().toISOString();
  const requeued: ProjectMemoryConfidenceRepairCandidate[] = [];
  for (const candidate of preview.candidates) {
    const result = await db.prepare(
      "UPDATE project_memory_events SET status = 'pending', operation_summary_json = '[]', error_code = NULL, error_message = NULL, model_provider = NULL, model_name = NULL, prompt_version = NULL, processed_at = NULL, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'completed' AND prompt_version = 'project-assistant.v1' AND NOT EXISTS (SELECT 1 FROM project_memory_items m WHERE m.organization_id = project_memory_events.organization_id AND m.project_id = project_memory_events.project_id AND m.source_id = project_memory_events.id)",
    ).bind(now, candidate.id, input.organizationId, input.projectId).run();
    if (!result.meta.changes) continue;
    await db.prepare(
      "INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'project_memory.confidence_scale_requeued', 'project_memory_event', ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.projectId,
      input.userId,
      candidate.id,
      JSON.stringify({
        reason: "legacy_fractional_confidence_scale",
        operationCount: candidate.operationCount,
        previousPromptVersion: "project-assistant.v1",
      }),
      now,
    ).run();
    requeued.push(candidate);
  }
  return {
    count: requeued.length,
    operationCount: requeued.reduce((sum, item) => sum + item.operationCount, 0),
    candidates: requeued,
  };
}

export async function enqueueProjectMemoryEventWithDb(
  db: ProjectAssistantDatabase,
  input: ProjectMemoryEventInput,
) {
  const payloadJson = stableProjectAssistantJson(input.payload);
  if (payloadJson.length > 200_000) throw new Error("项目记忆事件内容超过 200000 字符上限。");
  const payloadHash = await sha256ProjectAssistantText(payloadJson);
  const identity = [
    input.eventType.trim().slice(0, 80),
    input.sourceType.trim().slice(0, 80),
    input.sourceId?.trim().slice(0, 180) || "",
    payloadHash,
  ].join(":");
  const dedupeKey = await sha256ProjectAssistantText(identity);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.prepare(
    "INSERT OR IGNORE INTO project_memory_events (id, organization_id, project_id, event_type, source_type, source_id, dedupe_key, payload_json, payload_hash, status, operation_summary_json, attempt_count, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', 0, ?, ?, ?)",
  ).bind(
    id,
    input.organizationId,
    input.projectId,
    input.eventType.trim().slice(0, 80),
    input.sourceType.trim().slice(0, 80),
    input.sourceId?.trim().slice(0, 180) || null,
    dedupeKey,
    payloadJson,
    payloadHash,
    input.userId,
    now,
    now,
  ).run();
  const row = await db.prepare(
    "SELECT * FROM project_memory_events WHERE organization_id = ? AND project_id = ? AND dedupe_key = ? LIMIT 1",
  ).bind(input.organizationId, input.projectId, dedupeKey).first<ProjectMemoryEventRow>();
  if (!row) throw new Error("项目记忆事件写入后无法读取。");
  return { event: row, created: result.meta.changes > 0 };
}

export async function claimProjectMemoryEventWithDb(
  db: ProjectAssistantDatabase,
  input: { eventId: string; organizationId: string; projectId: string; now?: string },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db.prepare(
    "UPDATE project_memory_events SET status = 'processing', attempt_count = attempt_count + 1, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('pending', 'blocked', 'failed')",
  ).bind(now, input.eventId, input.organizationId, input.projectId).run();
  if (!result.meta.changes) {
    const current = await db.prepare(
      "SELECT status FROM project_memory_events WHERE id = ? AND organization_id = ? AND project_id = ?",
    ).bind(input.eventId, input.organizationId, input.projectId).first<{ status: ProjectMemoryEventStatus }>();
    return { claimed: false as const, status: current?.status ?? null };
  }
  return { claimed: true as const, status: "processing" as const };
}

export async function markProjectMemoryEventFailureWithDb(
  db: ProjectAssistantDatabase,
  input: {
    eventId: string;
    organizationId: string;
    projectId: string;
    status: "blocked" | "failed";
    code: string;
    message: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  await db.prepare(
    "UPDATE project_memory_events SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'processing'",
  ).bind(
    input.status,
    input.code.slice(0, 100),
    input.message.slice(0, 2000),
    now,
    input.eventId,
    input.organizationId,
    input.projectId,
  ).run();
}

export async function readCurrentProjectMemoriesWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const rows = await db.prepare(
    "SELECT id, canonical_key, status, title, content, revision, content_hash, source_type, source_id, value_json, updated_at FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND status = 'confirmed' AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 300",
  ).bind(input.organizationId, input.projectId, new Date().toISOString()).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    id: String(row.id),
    canonicalKey: String(row.canonical_key),
    title: String(row.title),
    content: String(row.content),
    revision: Number(row.revision),
    contentHash: String(row.content_hash),
    sourceType: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    metadata: typeof row.value_json === "string" ? parseJsonObject(row.value_json) : {},
    updatedAt: String(row.updated_at),
  }));
}

export async function readProjectMemoryExtractionContextWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const rows = await db.prepare(
    "SELECT id, canonical_key, status, title, content, revision, content_hash, source_type, source_id, value_json, updated_at FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND status IN ('candidate', 'confirmed') AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 300",
  ).bind(input.organizationId, input.projectId, new Date().toISOString()).all<Record<string, unknown>>();
  const current = rows.results.map((row) => ({
    id: String(row.id),
    canonical_key: String(row.canonical_key),
    status: String(row.status),
    title: String(row.title),
    content: String(row.content),
    revision: Number(row.revision),
    updated_at: String(row.updated_at),
    contentHash: String(row.content_hash),
    sourceType: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    metadata: typeof row.value_json === "string" ? parseJsonObject(row.value_json) : {},
  }));
  return collapseProjectMemoryListItems(current).map((row) => ({
    id: row.id,
    canonicalKey: row.canonical_key,
    status: row.status,
    title: row.title,
    content: row.content,
    revision: row.revision,
    contentHash: row.contentHash,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    metadata: row.metadata,
    updatedAt: row.updated_at,
  }));
}
export async function applyProjectMemoryOperationsWithDb(
  db: ProjectAssistantDatabase,
  input: {
    event: ProjectMemoryEventRow;
    operations: ProjectAssistantMemoryOperation[];
    provider: string;
    model: string;
    promptVersion: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const summaries: AppliedMemoryOperation[] = [];
  for (const operation of input.operations.slice(0, 30)) {
    if (operation.operation === "noop" || !operation.canonicalKey) {
      summaries.push({
        operation: "noop",
        canonicalKey: operation.canonicalKey,
        outcome: "noop",
        confidence: operation.confidence,
        reason: operation.reason,
      });
      continue;
    }
    if (
      input.event.source_type === "video_analysis"
      && new Set(operation.evidence.filter((item) => item.sourceType === "video_analysis").map((item) => item.sourceId)).size < 1
    ) {
      summaries.push({ operation: operation.operation, canonicalKey: operation.canonicalKey, outcome: "skipped", confidence: operation.confidence, reason: "视频候选至少需要一条可核验的视频分析依据。" });
      continue;
    }
    const latest = await db.prepare(
      "SELECT id, canonical_key, status, title, content, revision, content_hash FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND canonical_key = ? ORDER BY revision DESC LIMIT 1",
    ).bind(input.event.organization_id, input.event.project_id, operation.canonicalKey).first<MemoryRow>();
    const confirmed = await db.prepare(
      "SELECT id, canonical_key, status, title, content, revision, content_hash FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND canonical_key = ? AND status = 'confirmed' ORDER BY revision DESC LIMIT 1",
    ).bind(input.event.organization_id, input.event.project_id, operation.canonicalKey).first<MemoryRow>();

    if (operation.operation === "retire") {
      summaries.push({ operation: operation.operation, canonicalKey: operation.canonicalKey, outcome: "skipped", confidence: operation.confidence, reason: "模型不能自动停用正式项目记忆，请人工核对后停用。" });
      continue;
    }
    if (!operation.title || !operation.content) {
      summaries.push({ operation: operation.operation, canonicalKey: operation.canonicalKey, outcome: "skipped", confidence: operation.confidence, reason: "标题或内容缺失，未写入记忆。" });
      continue;
    }
    if (operation.confidence < 65) {
      summaries.push({ operation: operation.operation, canonicalKey: operation.canonicalKey, outcome: "skipped", confidence: operation.confidence, reason: "置信度低于 65，未写入记忆。" });
      continue;
    }
    const contentHash = await sha256ProjectAssistantText(operation.content);
    type DuplicateMemoryRow = {
      id: string;
      canonical_key: string;
      revision: number;
      status: string;
      title: string;
      content: string;
      value_json: string;
      updated_at: string;
    };
    let duplicate = await db.prepare(
      "SELECT id, canonical_key, revision, status, title, content, value_json, updated_at FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND content_hash = ? AND status IN ('candidate', 'confirmed') ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
    ).bind(input.event.organization_id, input.event.project_id, contentHash).first<DuplicateMemoryRow>();
    if (!duplicate) {
      const activeRows = await db.prepare(
        "SELECT id, canonical_key, revision, status, title, content, value_json, updated_at FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND canonical_key != ? AND status IN ('candidate', 'confirmed') ORDER BY updated_at DESC LIMIT 300",
      ).bind(input.event.organization_id, input.event.project_id, operation.canonicalKey).all<DuplicateMemoryRow>();
      duplicate = activeRows.results
        .filter((row) => areProjectMemoriesEquivalent(
          { title: operation.title || "", content: operation.content || "" },
          { title: row.title, content: row.content },
        ))
        .sort((left, right) => {
          if (left.status !== right.status) return left.status === "confirmed" ? -1 : 1;
          const leftScore = projectMemorySimilarity({ title: operation.title || "", content: operation.content || "" }, left).combined;
          const rightScore = projectMemorySimilarity({ title: operation.title || "", content: operation.content || "" }, right).combined;
          if (leftScore !== rightScore) return rightScore - leftScore;
          return Date.parse(right.updated_at) - Date.parse(left.updated_at);
        })[0];
    }
    if (duplicate) {
      if (operation.evidence.length) {
        const priorEvidence = await db.prepare("SELECT source_type, source_id FROM project_memory_evidence WHERE memory_item_id = ?").bind(duplicate.id).all<{ source_type: string; source_id: string }>();
        const known = new Set(priorEvidence.results.map((item) => `${item.source_type}:${item.source_id}`));
        const additions = operation.evidence.filter((item) => {
          const evidenceKey = `${item.sourceType}:${item.sourceId}`;
          if (known.has(evidenceKey)) return false;
          known.add(evidenceKey);
          return true;
        }).slice(0, 20);
        if (additions.length) {
          await db.batch(additions.map((evidence) => db.prepare("INSERT INTO project_memory_evidence (id, organization_id, project_id, memory_item_id, source_type, source_id, quote, relevance, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), input.event.organization_id, input.event.project_id, duplicate.id, evidence.sourceType, evidence.sourceId, evidence.quote, operation.confidence, input.event.created_by, now)));
          let duplicateMetadata: Record<string, unknown> = {};
          try {
            duplicateMetadata = JSON.parse(duplicate.value_json || "{}") as Record<string, unknown>;
          } catch {
            duplicateMetadata = {};
          }
          const evidenceCount = known.size;
          await db.prepare("UPDATE project_memory_items SET value_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({
            ...duplicateMetadata,
            evidenceCount,
            validationState: "ready_for_review",
          }), now, duplicate.id).run();
        }
      }
      summaries.push({ operation: operation.operation, canonicalKey: operation.canonicalKey, outcome: "deduplicated", memoryId: duplicate.id, revision: duplicate.revision, confidence: operation.confidence, reason: "相同或语义等价的知识原子已存在，已归并依据。" });
      continue;
    }

    const revision = Number(latest?.revision ?? 0) + 1;
    const id = crypto.randomUUID();
    const status = "candidate" as const;
    const inheritedEvidence = latest
      ? (await db.prepare("SELECT source_type, source_id, quote, relevance FROM project_memory_evidence WHERE memory_item_id = ?").bind(latest.id).all<{ source_type: string; source_id: string; quote: string | null; relevance: number | null }>()).results
      : [];
    const evidenceBySource = new Map<string, { sourceType: string; sourceId: string; quote: string | null; relevance: number }>();
    for (const evidence of [...inheritedEvidence.map((item) => ({ sourceType: item.source_type, sourceId: item.source_id, quote: item.quote, relevance: Number(item.relevance ?? operation.confidence) })), ...operation.evidence.map((item) => ({ ...item, relevance: operation.confidence }))]) {
      if (evidence.sourceType && evidence.sourceId) evidenceBySource.set(`${evidence.sourceType}:${evidence.sourceId}`, evidence);
    }
    const combinedEvidence = Array.from(evidenceBySource.values()).slice(0, 20);
    const metadata = {
      confidence: operation.confidence,
      operation: operation.operation,
      reason: operation.reason,
      eventId: input.event.id,
      mergeFromKeys: operation.mergeFromKeys,
      model: { provider: input.provider, name: input.model, promptVersion: input.promptVersion },
      conflictWithConfirmed: Boolean(confirmed && confirmed.content_hash !== contentHash),
      evidenceCount: combinedEvidence.length,
      validationState: "ready_for_review",
    };
    const writes: ProjectAssistantBoundStatement[] = [
      db.prepare(
        "INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, confirmed_by, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'project_assistant', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        input.event.organization_id,
        input.event.project_id,
        operation.canonicalKey,
        PROJECT_MEMORY_STORAGE_CATEGORY,
        PROJECT_MEMORY_STORAGE_KIND,
        status,
        operation.title,
        operation.content,
        JSON.stringify(metadata),
        input.event.id,
        revision,
        contentHash,
        input.event.created_by,
        null,
        null,
        now,
        now,
      ),
    ];
    for (const evidence of combinedEvidence) {
      writes.push(db.prepare(
        "INSERT INTO project_memory_evidence (id, organization_id, project_id, memory_item_id, source_type, source_id, quote, relevance, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        input.event.organization_id,
        input.event.project_id,
        id,
        evidence.sourceType,
        evidence.sourceId,
        evidence.quote,
        operation.confidence,
        input.event.created_by,
        now,
      ));
    }
    await db.batch(writes);
    summaries.push({
      operation: operation.operation,
      canonicalKey: operation.canonicalKey,
      outcome: status,
      memoryId: id,
      revision,
      confidence: operation.confidence,
      reason: operation.reason,
    });
  }

  await db.prepare(
    "UPDATE project_memory_events SET status = 'completed', operation_summary_json = ?, error_code = NULL, error_message = NULL, model_provider = ?, model_name = ?, prompt_version = ?, processed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'processing'",
  ).bind(
    JSON.stringify(summaries),
    input.provider,
    input.model,
    input.promptVersion,
    now,
    now,
    input.event.id,
    input.event.organization_id,
    input.event.project_id,
  ).run();
  return summaries;
}
