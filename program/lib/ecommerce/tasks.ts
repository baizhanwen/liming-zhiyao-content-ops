import { getD1 } from "../../db/runtime";
import { auditStatement, commitMutation, writeBindings, writeGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import { taskBriefSchema, type TaskBrief } from "./contracts";

export type TaskRow = {
  id: string; organization_id: string; project_id: string; title: string; product_id: string; product_version_id: string;
  brief_json: string; revision: number; current_version: number; status: string;
};
export async function readTask(access: EcommerceAccess, id: string) {
  const task = await getD1().prepare("SELECT * FROM ecommerce_tasks WHERE id=? AND organization_id=? AND project_id=?")
    .bind(id, access.organizationId, access.projectId).first<TaskRow>();
  if (!task) throw new EcommerceError("TASK_UNAVAILABLE", "电商任务不可用。", 404);
  return task;
}

export async function validateTaskReferences(access: EcommerceAccess, productId: string, versionId: string, brief: TaskBrief) {
  const db = getD1(), scope = [access.organizationId, access.projectId];
  if (!await db.prepare("SELECT id FROM ecommerce_product_versions WHERE id=? AND product_id=? AND organization_id=? AND project_id=?").bind(versionId, productId, ...scope).first())
    throw new EcommerceError("PRODUCT_VERSION_UNAVAILABLE", "商品版本不可用。", 409);
  for (const id of brief.evidenceIds) {
    if (!await db.prepare("SELECT id FROM ecommerce_evidence WHERE id=? AND product_id=? AND organization_id=? AND project_id=?").bind(id, productId, ...scope).first())
      throw new EcommerceError("EVIDENCE_UNAVAILABLE", "所选证据不可用。", 409);
  }
  for (const id of brief.knowledgeIds) {
    if (!await db.prepare("SELECT id FROM knowledge_items WHERE id=? AND organization_id=? AND project_id=? AND status='confirmed' AND deleted_at IS NULL").bind(id, ...scope).first())
      throw new EcommerceError("KNOWLEDGE_UNAVAILABLE", "所选品牌知识不可用。", 409);
  }
  for (const id of brief.componentIds) {
    if (!await db.prepare("SELECT id FROM ecommerce_components WHERE id=? AND status='confirmed' AND ((scope='project' AND organization_id=? AND project_id=?) OR scope='system')").bind(id, ...scope).first())
      throw new EcommerceError("COMPONENT_UNAVAILABLE", "所选组件不可用。", 409);
  }
  for (const id of brief.caseIds) {
    if (!await db.prepare(`SELECT c.id FROM ecommerce_case_profiles c INNER JOIN project_video_references r ON r.id=c.reference_id AND r.organization_id=c.organization_id AND r.project_id=c.project_id
      WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.status='confirmed' AND r.status='active' AND r.purpose='benchmark'`).bind(id, ...scope).first())
      throw new EcommerceError("CASE_UNAVAILABLE", "所选案例不可用。", 409);
  }
}

export async function saveTask(request: Request, access: EcommerceAccess, input: { id?: string; title: string; revision: number; productId: string; productVersionId: string; brief: TaskBrief }) {
  if (input.id && input.revision < 1 || !input.id && input.revision !== 0) throw new EcommerceError("INVALID_REVISION", "任务版本无效。");
  const brief = taskBriefSchema.parse(input.brief);
  await validateTaskReferences(access, input.productId, input.productVersionId, brief);
  const db = getD1(), id = input.id ?? crypto.randomUUID(), now = new Date().toISOString(), scope = [access.organizationId, access.projectId];
  const results = await commitMutation(request, access, [
    input.id
      ? db.prepare(`UPDATE ecommerce_tasks SET title=?,product_id=?,product_version_id=?,brief_json=?,revision=revision+1,status='draft',updated_by=?,updated_at=?
        WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND status != 'archived' AND NOT EXISTS (SELECT 1 FROM ecommerce_generation_runs WHERE task_id=? AND status='running') AND ${writeGuard}`)
        .bind(input.title, input.productId, input.productVersionId, JSON.stringify(brief), access.userId, now, id, ...scope, input.revision, id, ...writeBindings(access))
      : db.prepare(`INSERT INTO ecommerce_tasks (id,organization_id,project_id,product_id,product_version_id,title,brief_json,created_by,updated_by,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${writeGuard}`).bind(id, ...scope, input.productId, input.productVersionId, input.title, JSON.stringify(brief), access.userId, access.userId, now, now, ...writeBindings(access)),
    auditStatement(access, "ecommerce.task.saved", id, { productVersionId: input.productVersionId }),
  ]); requireChanged(results);
  return readTask(access, id);
}
