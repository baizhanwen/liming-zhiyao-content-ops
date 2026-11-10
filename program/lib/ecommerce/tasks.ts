import { getD1 } from "../../db/runtime";
import { auditStatement, commitMutation, writeBindings, writeGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import { taskBriefSchema, taskReferenceMode, type TaskBrief } from "./contracts";
import { readCaseSource } from "./cases";

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
  const writingComponentIds: string[] = [], mode = taskReferenceMode(brief);
  for (const id of mode === "method" ? brief.componentIds : []) {
    const component = await db.prepare(`SELECT c.id,c.kind,c.status,v.body_json FROM ecommerce_components c
      JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version
      WHERE c.id=? AND ((c.scope='project' AND c.organization_id=? AND c.project_id=?) OR c.scope='system')`).bind(id, ...scope)
      .first<{ id: string; kind: string; status: string; body_json: string }>();
    if (!component) throw new EcommerceError("COMPONENT_UNAVAILABLE", "所选组件不可用。", 409);
    // Retain old task selections in storage, but they are not writing sources.
    const body = JSON.parse(component.body_json) as { requiredFilming?: unknown[] };
    if (!["hook", "structure"].includes(component.kind) || Array.isArray(body.requiredFilming) && body.requiredFilming.length) continue;
    if (component.status !== "confirmed") throw new EcommerceError("COMPONENT_UNAVAILABLE", "所选组件不可用。", 409);
    writingComponentIds.push(id);
  }
  if (mode === "benchmark" && Number(Boolean(brief.benchmark)) + brief.caseIds.length !== 1)
    throw new EcommerceError("BENCHMARK_REQUIRED", "请只选择一个对标带货视频。", 409);
  if (mode === "benchmark" && brief.benchmark) await readCaseSource(access, brief.benchmark.referenceId, brief.benchmark.analysisId, brief.benchmark.transcriptId);
  for (const id of mode === "benchmark" ? brief.caseIds : []) {
    if (!await db.prepare(`SELECT c.id FROM ecommerce_case_profiles c INNER JOIN project_video_references r ON r.id=c.reference_id AND r.organization_id=c.organization_id AND r.project_id=c.project_id
      WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.status='confirmed' AND r.status='active' AND r.purpose='benchmark'`).bind(id, ...scope).first())
      throw new EcommerceError("CASE_UNAVAILABLE", "所选案例不可用。", 409);
  }
  return { writingComponentIds };
}

export async function saveTask(request: Request, access: EcommerceAccess, input: { id?: string; title: string; revision: number; productId: string; productVersionId: string; brief: TaskBrief }) {
  if (input.id && input.revision < 1 || !input.id && input.revision !== 0) throw new EcommerceError("INVALID_REVISION", "任务版本无效。");
  const parsed = taskBriefSchema.parse(input.brief), brief = { ...parsed, referenceMode: taskReferenceMode(parsed) };
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
