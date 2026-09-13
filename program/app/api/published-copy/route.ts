import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../lib/content-ops";
import { analyzePublishedCopy, buildPublishedCopyProfile, createPublishedCopySchema, publishedCopyPerformanceScore, readPublishedCopyPerformance, type PublishedCopyRecord } from "../../../lib/published-copy";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

function present(record: PublishedCopyRecord) {
  const performance = readPublishedCopyPerformance(record.performance_json);
  return {
    ...record,
    monetization_types: JSON.parse(record.monetization_types_json || "[]") as string[],
    analysis: JSON.parse(record.analysis_json || "{}") as Record<string, unknown>,
    performance,
    performance_score: publishedCopyPerformanceScore(performance).score,
  };
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问历史发布文案。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的历史发布文案。", 403);
    const rows = await getD1().prepare(`
      SELECT pc.id, pc.title, pc.body, pc.platform, pc.content_format, pc.source_type, pc.published_at, pc.external_url,
        pc.character_count, pc.paragraph_count, pc.monetization_types_json, pc.monetization_detail,
        pc.analysis_json,
        CASE WHEN latest.id IS NULL THEN pc.performance_json ELSE json_set(
          COALESCE(NULLIF(pc.performance_json, ''), '{}'),
          '$.views', latest.views, '$.likes', latest.likes, '$.saves', latest.saves, '$.leads', latest.leads
        ) END AS performance_json,
        pc.created_at, pc.updated_at
      FROM published_copy_records pc
      LEFT JOIN publication_metric_snapshots latest ON latest.id = (
        SELECT snapshot.id FROM publication_metric_snapshots snapshot
        WHERE snapshot.organization_id = pc.organization_id AND snapshot.project_id = pc.project_id AND snapshot.publication_id = pc.publication_id
        ORDER BY snapshot.observed_at DESC, snapshot.created_at DESC LIMIT 1
      )
      WHERE pc.organization_id = ? AND pc.project_id = ? AND pc.deleted_at IS NULL
      ORDER BY COALESCE(pc.published_at, pc.created_at) DESC, pc.updated_at DESC LIMIT 300
    `).bind(organizationId, projectId).all<PublishedCopyRecord>();
    return Response.json({ records: rows.results.map(present), profile: buildPublishedCopyProfile(rows.results), canWrite: canWriteProjectAccess(access), canManage: canManageProjectKnowledge(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存历史发布文案。", 401);
  try {
    const parsed = createPublishedCopySchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_PUBLISHED_COPY", parsed.error.issues[0]?.message || "历史文案参数无效。", 400);
    const input = parsed.data; const access = await getProjectAccess(identity.authSubject, input.organizationId, input.projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能添加历史发布文案。", 403);
    const user = await ensureUser(identity); const db = getD1(); const id = crypto.randomUUID(); const now = new Date().toISOString();
    const analysis = analyzePublishedCopy(input.body, input.monetizationTypes);
    const performance = Object.fromEntries(Object.entries(input.performance || {}).filter(([, value]) => typeof value === "number"));
    await db.batch([
      db.prepare(`INSERT INTO published_copy_records (
        id, organization_id, project_id, source_type, title, body, platform, content_format,
        published_at, external_url, character_count, paragraph_count, monetization_types_json,
        monetization_detail, analysis_json, performance_json, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, input.organizationId, input.projectId, input.title, input.body, input.platform, input.contentFormat, input.publishedAt || null, input.externalUrl || null, analysis.characterCount, analysis.paragraphCount, JSON.stringify(analysis.monetizationTypes), input.monetizationDetail || null, JSON.stringify(analysis), JSON.stringify(performance), user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'published_copy.created', 'published_copy', ?, ?, ?)")
        .bind(crypto.randomUUID(), input.organizationId, input.projectId, user.id, id, JSON.stringify({ platform: input.platform, contentFormat: input.contentFormat, characterCount: analysis.characterCount, monetizationTypes: analysis.monetizationTypes }), now),
    ]);
    const record: PublishedCopyRecord = { id, title: input.title, body: input.body, platform: input.platform, content_format: input.contentFormat, source_type: "manual", published_at: input.publishedAt || null, external_url: input.externalUrl || null, character_count: analysis.characterCount, paragraph_count: analysis.paragraphCount, monetization_types_json: JSON.stringify(analysis.monetizationTypes), monetization_detail: input.monetizationDetail || null, analysis_json: JSON.stringify(analysis), performance_json: JSON.stringify(performance), created_at: now, updated_at: now };
    return Response.json({ record: present(record) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
