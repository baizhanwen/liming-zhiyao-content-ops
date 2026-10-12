import { readBoundedJson, RequestBodyError } from "../../../../lib/bounded-request-body";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError, projectWriteAccessBindings, projectWriteAccessCondition } from "../../../../lib/project-write-access";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { validateKnowledgeImportRows, type KnowledgeImportIssue } from "../../../../lib/knowledge-import";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再导入品牌知识。", 401);
  try {
    const value = await readBoundedJson(request, 16 * 1024 * 1024, "知识导入请求最多 16 MiB，请按 100 条上限分批整理。");
    if (!value || typeof value !== "object" || Array.isArray(value)) return apiError("INVALID_KNOWLEDGE_IMPORT", "知识导入内容须为对象。", 400);
    const payload = value as Record<string, unknown>;
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
      SELECT k.id, k.current_version, k.updated_at, k.title, v.body
      FROM knowledge_items k LEFT JOIN knowledge_item_versions v
        ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
      WHERE k.organization_id = ? AND k.project_id = ? AND k.deleted_at IS NULL
    `).bind(organizationId, projectId).all<{ id: string; current_version: number; updated_at: string; title: string; body: string | null }>();
    const existingKeys = new Set(existing.results.filter(item => item.body !== null).map(item => `${item.title.toLocaleLowerCase("zh-CN")}\u0000${item.body}`));
    const accepted = validation.rows.filter((row) => {
      const duplicate = existingKeys.has(`${row.title.toLocaleLowerCase("zh-CN")}\u0000${row.body}`);
      if (duplicate) issues.push({ rowNumber: row.rowNumber, message: "当前企业空间已存在相同标题和正文的知识" });
      return !duplicate;
    });
    if (!accepted.length) return Response.json({ error: { code: "NO_NEW_KNOWLEDGE_ROWS", message: "文件中的有效知识均已存在，无需重复导入。" }, importedCount: 0, rejectedCount: issues.length, issues }, { status: 409 });

    const user = await ensureUser(identity), now = new Date().toISOString(), marker = crypto.randomUUID();
    const scope = { organizationId, projectId, userId: user.id };
    const assertAccess = createProjectWriteAssertion(db, scope, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    const snapshot = JSON.stringify(existing.results.map(item => ({ id: item.id, version: item.current_version, updatedAt: item.updated_at })));
    const receipt = { importedCount: accepted.length, rejectedCount: issues.length, issues, status: "draft" };
    const markerExists = "EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)";
    const statements = [db.prepare(`INSERT INTO audit_logs(id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?, ?, ?, ?, 'knowledge.import_batch', 'project', ?, ?, ? WHERE ${projectWriteAccessCondition}
        AND (SELECT COUNT(*) FROM knowledge_items WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL) = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN knowledge_items k
          ON k.id = json_extract(expected.value, '$.id') AND k.organization_id = ? AND k.project_id = ? AND k.deleted_at IS NULL
          WHERE k.id IS NULL OR k.current_version IS NOT json_extract(expected.value, '$.version') OR k.updated_at IS NOT json_extract(expected.value, '$.updatedAt'))`)
      .bind(marker, organizationId, projectId, user.id, projectId, JSON.stringify(receipt), now, ...projectWriteAccessBindings(scope), organizationId, projectId, existing.results.length, snapshot, organizationId, projectId)];
    for (const row of accepted) {
      const itemId = crypto.randomUUID();
      statements.push(
        db.prepare(`INSERT INTO knowledge_items (id, organization_id, project_id, category, title, status, current_version, created_by, updated_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ? WHERE ${markerExists}`).bind(itemId, organizationId, projectId, row.category, row.title, user.id, user.id, now, now, marker),
        db.prepare(`INSERT INTO knowledge_item_versions (id, organization_id, project_id, item_id, version, body, source_type, source_ref, change_summary, created_by, created_at)
          SELECT ?, ?, ?, ?, 1, ?, ?, ?, 'Excel 批量导入', ?, ? WHERE ${markerExists}`).bind(crypto.randomUUID(), organizationId, projectId, itemId, row.body, row.sourceType, row.sourceRef, user.id, now, marker),
        db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
          SELECT ?, ?, ?, ?, 'knowledge.imported', 'knowledge_item', ?, ?, ? WHERE ${markerExists}`).bind(crypto.randomUUID(), organizationId, projectId, user.id, itemId, JSON.stringify({ filename, rowNumber: row.rowNumber, category: row.category, sourceType: row.sourceType }), now, marker),
      );
    }
    await assertAccess();
    let results;
    try { results = await db.batch(statements); }
    catch (error) {
      let stored: { metadata_json: string } | null;
      try { stored = await db.prepare("SELECT metadata_json FROM audit_logs WHERE id = ? AND organization_id = ? AND project_id = ? AND actor_user_id = ? AND action = 'knowledge.import_batch' AND target_id = ?")
        .bind(marker, organizationId, projectId, user.id, projectId).first<{ metadata_json: string }>(); }
      catch { return apiError("KNOWLEDGE_IMPORT_STATUS_UNKNOWN", "暂时无法核对知识导入是否已保存，请恢复服务并刷新知识列表，勿立即重复提交。", 503); }
      if (!stored) throw error;
      if (stored.metadata_json !== JSON.stringify(receipt)) return apiError("KNOWLEDGE_IMPORT_STATUS_UNKNOWN", "知识导入回执不一致，请刷新列表核对，勿立即重复提交。", 503);
      return Response.json(receipt, { status: 201 });
    }
    if (!results[0].meta.changes) {
      await assertAccess();
      return apiError("KNOWLEDGE_IMPORT_CHANGED", "预检后知识已被其他操作改变，本次未保存。请刷新列表核对后重新选择文件。", 409);
    }
    return Response.json(receipt, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiError(error.code, error.message, error.status);
    if (error instanceof ProjectWriteAccessChangedError) return apiError(error.code, "登录状态或项目权限已改变，本次知识导入未保存。请刷新确认权限后再操作。", 403);
    return errorResponse(error);
  }
}
