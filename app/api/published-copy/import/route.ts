import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { analyzePublishedCopy, importPublishedCopiesSchema, publishedCopyImportRowSchema, type PublishedCopyRecord } from "../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

type Rejection = { row: number; title: string; message: string };

function present(record: PublishedCopyRecord) {
  return {
    ...record,
    monetization_types: JSON.parse(record.monetization_types_json || "[]") as string[],
    analysis: JSON.parse(record.analysis_json || "{}") as Record<string, unknown>,
    performance: JSON.parse(record.performance_json || "{}") as Record<string, number>,
  };
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再批量导入历史发布文案。", 401);
  try {
    const envelope = importPublishedCopiesSchema.safeParse(await request.json());
    if (!envelope.success) return apiError("INVALID_PUBLISHED_COPY_IMPORT", envelope.error.issues[0]?.message || "批量导入参数无效。", 400);
    const { organizationId, projectId, records } = envelope.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能批量导入历史发布文案。", 403);

    const db = getD1(); const user = await ensureUser(identity); const now = new Date().toISOString();
    const existing = await db.prepare("SELECT title, body FROM published_copy_records WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL LIMIT 2000").bind(organizationId, projectId).all<{ title: string; body: string }>();
    const fingerprints = new Set(existing.results.map((item) => `${item.title.trim()}\u0000${item.body.trim()}`));
    const rejections: Rejection[] = []; const accepted: PublishedCopyRecord[] = [];

    records.forEach((raw, index) => {
      const parsed = publishedCopyImportRowSchema.safeParse(raw); const row = index + 2;
      const rawTitle = typeof raw === "object" && raw && "title" in raw ? String((raw as { title?: unknown }).title || "") : "";
      if (!parsed.success) {
        rejections.push({ row, title: rawTitle, message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "记录"}：${issue.message}`).join("；") });
        return;
      }
      const input = parsed.data; const fingerprint = `${input.title}\u0000${input.body}`;
      if (fingerprints.has(fingerprint)) { rejections.push({ row, title: input.title, message: "与当前项目中已有文案重复。" }); return; }
      fingerprints.add(fingerprint);
      const analysis = analyzePublishedCopy(input.body, input.monetizationTypes);
      const performance = Object.fromEntries(Object.entries(input.performance || {}).filter(([, value]) => typeof value === "number"));
      accepted.push({
        id: crypto.randomUUID(), title: input.title, body: input.body, platform: input.platform,
        content_format: input.contentFormat, source_type: "csv_import", published_at: input.publishedAt || null,
        external_url: input.externalUrl || null, character_count: analysis.characterCount, paragraph_count: analysis.paragraphCount,
        monetization_types_json: JSON.stringify(analysis.monetizationTypes), monetization_detail: input.monetizationDetail || null,
        analysis_json: JSON.stringify(analysis), performance_json: JSON.stringify(performance), created_at: now, updated_at: now,
      });
    });

    for (let offset = 0; offset < accepted.length; offset += 40) {
      const statements = accepted.slice(offset, offset + 40).flatMap((record) => [
        db.prepare(`INSERT INTO published_copy_records (
          id, organization_id, project_id, source_type, title, body, platform, content_format,
          published_at, external_url, character_count, paragraph_count, monetization_types_json,
          monetization_detail, analysis_json, performance_json, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'csv_import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(record.id, organizationId, projectId, record.title, record.body, record.platform, record.content_format, record.published_at, record.external_url, record.character_count, record.paragraph_count, record.monetization_types_json, record.monetization_detail, record.analysis_json, record.performance_json, user.id, user.id, now, now),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'published_copy.imported', 'published_copy', ?, ?, ?)")
          .bind(crypto.randomUUID(), organizationId, projectId, user.id, record.id, JSON.stringify({ sourceType: "csv_import", title: record.title, characterCount: record.character_count }), now),
      ]);
      if (statements.length) await db.batch(statements);
    }

    return Response.json({ importedCount: accepted.length, rejectedCount: rejections.length, rejections, records: accepted.map(present) }, { status: accepted.length ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}
