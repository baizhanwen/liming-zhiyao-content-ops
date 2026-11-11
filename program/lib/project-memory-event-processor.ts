import {
  parseMemoryOperationsResponse,
  type ProjectAssistantEvidence,
} from "./project-assistant-contract.ts";
import {
  ProjectAssistantConfigurationError,
  type ProjectAssistantInvocation,
} from "./project-assistant-model.ts";
import {
  applyProjectMemoryOperationsWithDb,
  claimProjectMemoryEventWithDb,
  markProjectMemoryEventFailureWithDb,
  readProjectMemoryExtractionContextWithDb,
  type ProjectAssistantDatabase,
  type ProjectMemoryEventRow,
} from "./project-memory-events.ts";
import { analysisReportSourceText } from "./content-production.ts";
import { createRecordedProjectAssistantInvoker } from "./recorded-project-assistant-model.ts";
import { projectWriteAccessBindings, projectWriteAccessCondition, ProjectWriteAccessChangedError } from "./project-write-access.ts";
import { assertMemoryAttempt, ProjectMemoryAttemptChangedError } from "./project-memory-write.ts";
import { assessAnalysisQuality } from "./analysis-quality.ts";

export const PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION = "project-memory.v2-content-and-methods";

type InvocationFunction = (input: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<ProjectAssistantInvocation>;

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

async function loadEventSource(
  db: ProjectAssistantDatabase,
  event: ProjectMemoryEventRow,
) {
  const payload = safeJson(event.payload_json);
  if (event.source_type !== "video_analysis" || !event.source_id) return payload;
  const analysis = await db.prepare(`
    SELECT analysis.id, analysis.video_id, analysis.schema_version, analysis.created_at, analysis.report_json
    FROM video_analyses analysis
    INNER JOIN video_library_entries library
      ON library.organization_id = analysis.organization_id AND library.source_video_id = analysis.video_id
    INNER JOIN videos source_video ON source_video.id = analysis.video_id AND source_video.organization_id = analysis.organization_id AND source_video.deleted_at IS NULL
    INNER JOIN project_video_references refs
      ON refs.organization_id = library.organization_id AND refs.library_entry_id = library.id
      AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
    WHERE analysis.id = ? AND analysis.organization_id = ?
    LIMIT 1
  `).bind(event.project_id, event.source_id, event.organization_id).first<{
    id: string;
    video_id: string;
    schema_version: string;
    created_at: string;
    report_json: string;
  }>();
  if (!analysis) return { payload, sourceUnavailable: true };
  let report: unknown = null;
  try { report = JSON.parse(analysis.report_json); } catch { /* Stored invalid reports remain historical and do not trigger a model call. */ }
  if (!assessAnalysisQuality(analysis.schema_version, report).accepted) return { payload, sourceUnavailable: true };
  const corpusRows = await db.prepare(`
    SELECT atoms.analysis_id, atoms.atom_type, atoms.title, atoms.content, atoms.confidence
    FROM video_knowledge_atoms atoms
    INNER JOIN project_video_references refs
      ON refs.organization_id = atoms.organization_id AND refs.library_entry_id = atoms.library_entry_id
      AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
    WHERE atoms.organization_id = ? AND atoms.status = 'active'
      AND atoms.atom_type IN ('summary', 'audience', 'highlights', 'recommendations', 'risks', 'hook', 'structure', 'hook_analysis', 'viral_points', 'rhythm_analysis', 'emotion_curve', 'conversion_design')
    ORDER BY atoms.analysis_id, atoms.atom_type, atoms.atom_key
    LIMIT 240
  `).bind(event.project_id, event.organization_id).all<{
    analysis_id: string;
    atom_type: string;
    title: string;
    content: string;
    confidence: number | null;
  }>();
  const corpusByAnalysis = new Map<string, {
    analysisId: string;
    observations: Array<{ type: string; title: string; content: string; confidence: number | null }>;
  }>();
  const acceptedCorpus = new Map<string, boolean>([[analysis.id, true]]);
  for (const row of corpusRows.results) {
    if (!acceptedCorpus.has(row.analysis_id)) {
      const candidate = await db.prepare(`SELECT a.schema_version, a.report_json FROM video_analyses a
        JOIN videos v ON v.id=a.video_id AND v.organization_id=a.organization_id AND v.deleted_at IS NULL
        WHERE a.id=? AND a.organization_id=? LIMIT 1`).bind(row.analysis_id, event.organization_id).first<{ schema_version: string; report_json: string }>();
      let candidateReport: unknown = null;
      try { candidateReport = candidate ? JSON.parse(candidate.report_json) : null; } catch { /* Historical atoms remain stored but cannot bypass report acceptance. */ }
      acceptedCorpus.set(row.analysis_id, Boolean(candidate && assessAnalysisQuality(candidate.schema_version, candidateReport).accepted));
    }
    if (!acceptedCorpus.get(row.analysis_id)) continue;
    const item = corpusByAnalysis.get(row.analysis_id) ?? { analysisId: row.analysis_id, observations: [] };
    item.observations.push({
      type: row.atom_type,
      title: row.title,
      content: row.content.slice(0, 1_500),
      confidence: row.confidence,
    });
    corpusByAnalysis.set(row.analysis_id, item);
  }
  return {
    payload,
    analysis: {
      id: analysis.id,
      videoId: analysis.video_id,
      schemaVersion: analysis.schema_version,
      createdAt: analysis.created_at,
      content: analysisReportSourceText(analysis.report_json).slice(0, 14000),
    },
    benchmarkCorpus: Array.from(corpusByAnalysis.values()),
  };
}

function gateVideoAnalysisOperations(
  operations: ReturnType<typeof parseMemoryOperationsResponse>,
  source: unknown,
) {
  if (!source || typeof source !== "object") return operations.map((operation) => ({
    ...operation,
    operation: "noop" as const,
    reason: "缺少可核验的对标视频语料，无法生成项目记忆候选。",
  }));
  const row = source as { analysis?: { id?: unknown; content?: string }; benchmarkCorpus?: Array<{ analysisId?: unknown; observations?: Array<{ content: string }> }> };
  const allowedAnalysisIds = new Set<string>();
  const sourceTexts = new Map<string, string>();
  if (typeof row.analysis?.id === "string" && row.analysis.id) allowedAnalysisIds.add(row.analysis.id);
  if (typeof row.analysis?.id === "string") sourceTexts.set(row.analysis.id, row.analysis.content || "");
  for (const item of Array.isArray(row.benchmarkCorpus) ? row.benchmarkCorpus : []) {
    if (typeof item.analysisId === "string" && item.analysisId) allowedAnalysisIds.add(item.analysisId);
    if (typeof item.analysisId === "string") sourceTexts.set(item.analysisId, (sourceTexts.get(item.analysisId) || "") + "\n" + (item.observations || []).map(observation => observation.content).join("\n"));
  }
  return operations.map((operation) => {
    if (operation.operation === "noop") return operation;
    const evidence = operation.evidence.filter((item) => item.sourceType === "video_analysis" && allowedAnalysisIds.has(item.sourceId) && item.quote && item.quote.length >= 8 && sourceTexts.get(item.sourceId)?.includes(item.quote));
    if (!new Set(evidence.map((item) => item.sourceId)).size) {
      return {
        ...operation,
        operation: "noop" as const,
        evidence,
        reason: "没有可核验的视频分析依据，不能生成项目记忆候选。",
      };
    }
    return { ...operation, evidence };
  });
}

function memorySystemPrompt() {
  return [
    "你是当前企业空间专属的长期项目记忆整理器。",
    "项目记忆不做分类。你的任务只是判断来源中是否存在明确、长期、可复用且值得人工决定是否采纳的信息。",
    "单期指标、一般复盘建议、待办事项、临时诊断、一次性灵感、单条作品表现和未经确认的推测一律返回 noop。",
    "项目事实、目标、受众、业务信息、偏好、约束、策略和决策，必须来自用户或客户的明确表述，不能根据视频表现自行推断。",
    "项目记忆仅用于灵感对话与灵感卡片，保留两种有复用价值的材料：内容启发（具体受众问题、观点、解释、知识点、有出处的外部案例及可延展的选题角度）和表达方法（钩子、结构、叙事、节奏、互动等）。逐一检查两方面，不要只提取写法；没有内容材料时不要硬凑。",
    "内容记忆必须写清具体讲了什么、对谁或什么问题有用、来源归属与适用限制，不要把具体观点抽空成通用结构。对标作者的案例与数字只保留为来源中的说法，不当作本账号经历或已核实通用事实；有时效的预测保留时间与不确定性，不沉淀为长期确定结论。",
    "处理视频分析时，一条视频存在清晰、可复用的内容启发或方法即可提出候选，evidence 必须包含真实的 video_analysis sourceId 与来源中的连续原文。",
    "所有新增、修订和合并都只是待人工决定候选；模型无权自动采纳或停用项目记忆。",
    "灵感对话和卡片如果只是复述已有记忆，不构成独立新证据，返回 noop；只有用户明确补充的新信息或新的原始来源才可追加，不能循环引用自己的建议来提高可信度。",
    "currentMemories 同时包含已采纳和待采纳知识原子。提取前必须逐条比较核心动作、适用场景和作用机制；三者基本相同就是同一个原子，必须复用 canonicalKey 并补充 evidence，不得因标题或措辞不同而新增。",
    "每条记忆只表达一个可独立复用的观点、问题、案例线索或表达方法。不同内容观点不能因为采用相同结构就合并，也不能因为同属一个主题就当作重复；对内容比较核心主张、证据和适用条件，对方法比较动作、场景与机制。",
    "只有信息实质相同才复用 canonicalKey 并补充 evidence；同题不同观点、相反结论、不同案例应分别保留。冲突不确定时保留已采纳记忆并生成候选。",
    "所有 confidence 必须返回 0 到 100 的整数，例如 82；禁止返回 0 到 1 的小数比例。",
    "只返回 JSON：{memoryOperations:[{operation:'add|revise|merge|retire|noop',canonicalKey,title,content,confidence,evidence:[{sourceType,sourceId,quote}],mergeFromKeys:[],reason}]}。不得返回 category 或 kind。",
  ].join("\n");
}
export async function processProjectMemoryEventWithDb(
  db: ProjectAssistantDatabase,
  input: {
    eventId: string;
    organizationId: string;
    projectId: string;
    invoke?: InvocationFunction;
    userId?: string;
    assertWriteAccess?: () => Promise<void>;
  },
) {
  await input.assertWriteAccess?.();
  const claimed = await claimProjectMemoryEventWithDb(db, input);
  if (!claimed.claimed) return { status: claimed.status, processed: false as const, operations: [] };
  const event = await db.prepare(
    "SELECT * FROM project_memory_events WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1",
  ).bind(input.eventId, input.organizationId, input.projectId).first<ProjectMemoryEventRow>();
  if (!event) throw new Error("已认领的项目记忆事件不存在。");
  try {
    if (event.status !== "processing" || event.attempt_count !== claimed.attemptCount) throw new ProjectMemoryAttemptChangedError();
    const assertWriteAccess = async () => { await input.assertWriteAccess?.(); await assertMemoryAttempt(db, { ...input, attemptCount: claimed.attemptCount }); };
    const [currentMemories, source] = await Promise.all([
      readProjectMemoryExtractionContextWithDb(db, input),
      loadEventSource(db, event),
    ]);
    if (
      event.source_type === "video_analysis"
      && source && typeof source === "object"
      && "sourceUnavailable" in source
      && source.sourceUnavailable === true
    ) {
      const applied = await applyProjectMemoryOperationsWithDb(db, {
        event,
        operations: [],
        provider: "system",
        model: "benchmark-scope-gate",
        promptVersion: PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION,
        userId: input.userId,
        assertWriteAccess,
      });
      return { status: "completed" as const, processed: true as const, operations: applied };
    }
    const fallbackEvidence: ProjectAssistantEvidence = {
      sourceType: event.source_type,
      sourceId: event.source_id || event.id,
      quote: null,
    };
    const invoke = input.invoke ?? createRecordedProjectAssistantInvoker({ organizationId: event.organization_id, projectId: event.project_id, userId: input.userId ?? event.created_by, taskType: "project_assistant.memory", promptVersion: PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION, sourceId: event.id, assertWriteAccess, memoryEventId: event.id, memoryAttemptCount: claimed.attemptCount });
    await assertWriteAccess();
    const invocation = await invoke({
      system: memorySystemPrompt(),
      user: JSON.stringify({
        project: { organizationId: event.organization_id, projectId: event.project_id },
        currentMemories,
        event: {
          id: event.id,
          eventType: event.event_type,
          sourceType: event.source_type,
          sourceId: event.source_id,
          source,
        },
      }),
      temperature: 0.2,
      maxTokens: 8_000,
      timeoutMs: 75_000,
    });
    const parsedOperations = parseMemoryOperationsResponse(invocation.content, fallbackEvidence);
    const operations = event.source_type === "video_analysis"
      ? gateVideoAnalysisOperations(parsedOperations, source)
      : parsedOperations;
    const applied = await applyProjectMemoryOperationsWithDb(db, {
      event,
      operations,
      provider: invocation.provider,
      model: invocation.model,
      promptVersion: PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION,
      userId: input.userId,
      assertWriteAccess,
    });
    return { status: "completed" as const, processed: true as const, operations: applied };
  } catch (error) {
    const blocked = error instanceof ProjectAssistantConfigurationError;
    const code = blocked
      ? error.code
      : error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "PROJECT_MEMORY_EVENT_FAILED";
    const message = error instanceof Error ? error.message : "项目记忆事件处理失败。";
    await markProjectMemoryEventFailureWithDb(db, {
      eventId: event.id,
      organizationId: event.organization_id,
      projectId: event.project_id,
      status: blocked ? "blocked" : "failed",
      code,
      message,
      attemptCount: claimed.attemptCount,
    });
    if (error instanceof ProjectWriteAccessChangedError) throw error;
    return { status: blocked ? "blocked" as const : "failed" as const, processed: false as const, operations: [], error: { code, message } };
  }
}

export async function syncProjectMemoryEventsWithDb(
  db: ProjectAssistantDatabase,
  input: {
    organizationId: string;
    projectId: string;
    limit?: number;
    invoke?: InvocationFunction;
    userId?: string;
    assertWriteAccess?: () => Promise<void>;
  },
) {
  const limit = Math.max(1, Math.min(5, input.limit ?? 3));
  await input.assertWriteAccess?.();
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE project_memory_events
    SET status = 'pending', operation_summary_json = '[]', error_code = NULL, error_message = NULL,
        model_provider = NULL, model_name = NULL, prompt_version = ?, processed_at = NULL, updated_at = ?
    WHERE id IN (
      SELECT legacy.id
      FROM project_memory_events legacy
      WHERE legacy.organization_id = ? AND legacy.project_id = ?
        AND legacy.source_type = 'video_analysis' AND legacy.status = 'completed'
        AND COALESCE(legacy.prompt_version, '') <> ?
      ORDER BY legacy.created_at DESC
      LIMIT ?
    ) ${input.userId ? `AND ${projectWriteAccessCondition}` : ""}
  `).bind(
    PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION,
    now,
    input.organizationId,
    input.projectId,
    PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION,
    limit,
    ...(input.userId ? projectWriteAccessBindings({ ...input, userId: input.userId }) : []),
  ).run();
  await input.assertWriteAccess?.();
  const rows = await db.prepare(
    "SELECT id FROM project_memory_events WHERE organization_id = ? AND project_id = ? AND status IN ('pending', 'blocked', 'failed') ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, created_at ASC LIMIT ?",
  ).bind(input.organizationId, input.projectId, limit).all<{ id: string }>();
  const results = [];
  for (const row of rows.results) {
    await input.assertWriteAccess?.();
    results.push(await processProjectMemoryEventWithDb(db, {
      ...input,
      eventId: row.id,
    }));
  }
  return results;
}

export async function readProjectMemoryEventSummaryWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const [counts, recent] = await Promise.all([
    db.prepare(
      "SELECT status, COUNT(*) AS count FROM project_memory_events WHERE organization_id = ? AND project_id = ? GROUP BY status",
    ).bind(input.organizationId, input.projectId).all<{ status: string; count: number }>(),
    db.prepare(
      "SELECT id, event_type, source_type, source_id, status, operation_summary_json, error_code, error_message, attempt_count, created_at, updated_at, processed_at FROM project_memory_events WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 30",
    ).bind(input.organizationId, input.projectId).all<Record<string, unknown>>(),
  ]);
  return {
    counts: Object.fromEntries(counts.results.map((row) => [row.status, Number(row.count)])),
    recent: recent.results.map((row) => ({
      id: String(row.id),
      eventType: String(row.event_type),
      sourceType: String(row.source_type),
      sourceId: row.source_id ? String(row.source_id) : null,
      status: String(row.status),
      operations: typeof row.operation_summary_json === "string" ? safeJson(row.operation_summary_json) : [],
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      attemptCount: Number(row.attempt_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      processedAt: row.processed_at ? String(row.processed_at) : null,
    })),
  };
}
