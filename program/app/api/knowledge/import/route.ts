import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { validateKnowledgeImportRows, type KnowledgeImportIssue } from "../../../../lib/knowledge-import";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再导入品牌知识。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : "";
    const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
    const filename = typeof payload.filename === "string" ? payload.filename.trim().slice(0, 255) : "品牌知识导入.xlsx";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或企业空间范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能批量导入品牌知识。", 403);
    const validation = validateKnowledgeImportRows(payload.rows);
    if (!validation.rows.length) return Response.json({ error: { code: "NO_VALID_KNOWLEDGE_ROWS", message: "文件中没有可导入的有效知识。" }, importedCount: 0, rejectedCount: validation.issues.length, issues: validation.issues }, { status: 400 });

    const db = getD1(); const issues: KnowledgeImportIssue[] = [...validation.issues];
    const existing = await db.prepare(`
      SELECT LOWER(k.title) AS normalized_title, v.body
      FROM knowledge_items k INNER JOIN knowledge_item_versions v
        ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
      WHERE k.organization_id = ? AND k.project_id = ? AND k.deleted_at IS NULL
    `).bind(organizationId, projectId).all<{ normalized_title: string; body: string }>();
    const existingKeys = new Set(existing.results.map((item) => `${item.normalized_title}\u0000${item.body}`));
    const accepted = validation.rows.filter((row) => {
      const duplicate = existingKeys.has(`${row.title.toLocaleLowerCase("zh-CN")}\u0000${row.body}`);
      if (duplicate) issues.push({ rowNumber: row.rowNumber, message: "当前企业空间已存在相同标题和正文的知识" });
      return !duplicate;
    });
    if (!accepted.length) return Response.json({ error: { code: "NO_NEW_KNOWLEDGE_ROWS", message: "文件中的有效知识均已存在，无需重复导入。" }, importedCount: 0, rejectedCount: issues.length, issues }, { status: 409 });

    const user = await ensureUser(identity); const now = new Date().toISOString(); const statements = [];
    for (const row of accepted) {
      const itemId = crypto.randomUUID();
      statements.push(
        db.prepare("INSERT INTO knowledge_items (id, organization_id, project_id, category, title, status, current_version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").bind(itemId, organizationId, projectId, row.category, row.title, user.id, user.id, now, now),
        db.prepare("INSERT INTO knowledge_item_versions (id, organization_id, project_id, item_id, version, body, source_type, source_ref, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'Excel 批量导入', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, itemId, row.body, row.sourceType, row.sourceRef, user.id, now),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'knowledge.imported', 'knowledge_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, itemId, JSON.stringify({ filename, rowNumber: row.rowNumber, category: row.category, sourceType: row.sourceType }), now),
      );
    }
    await db.batch(statements);
    return Response.json({ importedCount: accepted.length, rejectedCount: issues.length, issues, status: "draft" }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
