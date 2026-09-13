import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { projectAssistantConfigurationStatus } from "../../../lib/project-assistant-model";
import { readProjectMemoryEventSummaryWithDb } from "../../../lib/project-memory-event-processor";
import {
  readProjectMemoryConfidenceRepairCandidatesWithDb,
  type ProjectAssistantDatabase,
} from "../../../lib/project-memory-events";
import { createMemoryCandidate } from "../../../lib/project-memory";
import { collapseProjectMemoryListItems } from "../../../lib/project-memory-list";
import { readRequestIdentity } from "../../../lib/request-auth";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问项目记忆。", 401);
  const url = new URL(request.url);
  const organizationId = text(url.searchParams.get("organizationId"), 100);
  const projectId = text(url.searchParams.get("projectId"), 100);
  const status = text(url.searchParams.get("status"), 30);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目记忆。", 403);
    const clauses = ["m.organization_id = ?", "m.project_id = ?"];
    const bindings: unknown[] = [organizationId, projectId];
    if (["candidate", "confirmed", "rejected", "superseded", "expired"].includes(status)) {
      clauses.push("m.status = ?");
      bindings.push(status);
    }
    const db = getD1();
    const [rows, events, repair] = await Promise.all([
      db.prepare(
        "SELECT m.*, (SELECT json_group_array(json_object('id', e.id, 'sourceType', e.source_type, 'sourceId', e.source_id, 'quote', e.quote, 'relevance', e.relevance)) FROM project_memory_evidence e WHERE e.memory_item_id = m.id) AS evidence_json FROM project_memory_items m WHERE "
        + clauses.join(" AND ")
        + " ORDER BY CASE m.status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, m.updated_at DESC LIMIT 300",
      ).bind(...bindings).all<Record<string, unknown>>(),
      readProjectMemoryEventSummaryWithDb(
        db as unknown as ProjectAssistantDatabase,
        { organizationId, projectId },
      ),
      readProjectMemoryConfidenceRepairCandidatesWithDb(
        db as unknown as ProjectAssistantDatabase,
        { organizationId, projectId },
      ),
    ]);
    const mappedItems = rows.results.map((row) => ({
      ...row,
      id: String(row.id ?? ""),
      canonical_key: String(row.canonical_key ?? ""),
      status: typeof row.status === "string" ? row.status : "",
      title: String(row.title ?? ""),
      content: String(row.content ?? ""),
      revision: Number(row.revision ?? 0),
      updated_at: String(row.updated_at ?? ""),
      category: typeof row.category === "string" ? row.category : null,
      metadata: parseJson(row.value_json, {}),
      evidence: parseJson(row.evidence_json, []),
    }));
    const items = status
      ? mappedItems
      : collapseProjectMemoryListItems(mappedItems.filter((item) => item.status === "candidate" || item.status === "confirmed"));
    return Response.json({
      items,
      canWrite: canWriteProjectAccess(access),
      configuration: projectAssistantConfigurationStatus(),
      events,
      repair,
      mode: "structured_archive",
      manualEditingPurpose: "create_and_correct",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再维护项目记忆。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    const canonicalKey = text(payload.canonicalKey, 160) || "memory_" + crypto.randomUUID();
    const title = text(payload.title, 160);
    const content = text(payload.content, 20_000);
    const sourceType = "manual_entry";
    const sourceId = text(payload.sourceId, 160) || null;
    const quote = text(payload.quote, 4_000) || null;
    const evidence = Array.isArray(payload.evidence) ? payload.evidence.map((item, index) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const evidenceQuote = text(row.quote, 4_000);
      return evidenceQuote ? { sourceType: "manual_validation", sourceId: text(row.sourceId, 160) || `manual-${index + 1}-${crypto.randomUUID()}`, quote: evidenceQuote, relevance: 100 } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 20) : undefined;
    if (!organizationId || !projectId || !canonicalKey || title.length < 2 || content.length < 2) {
      return apiError("MEMORY_FIELDS_REQUIRED", "新增项目记忆需要标题和内容。", 400);
    }
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能纠正项目记忆。", 403);
    const user = await ensureUser(identity);
    const result = await createMemoryCandidate({
      organizationId,
      projectId,
      userId: user.id,
      canonicalKey,
      title,
      content,
      value: payload.value,
      sourceType,
      sourceId,
      quote,
      evidence,
    });
    return Response.json({ item: result, status: "candidate", confirmationRequired: true }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
