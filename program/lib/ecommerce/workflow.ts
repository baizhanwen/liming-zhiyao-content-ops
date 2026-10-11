import { z } from "zod";
import { getD1 } from "../../db/runtime";
import { auditStatement, commitMutation, enabledGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import { buildEcommerceContext } from "./context";
import { packSchema, scopeSchema, type EcommercePack } from "./contracts";
import { validateEcommercePack } from "./generation-contract";
import { generationActorGuard, generationSourceGuard } from "./source-guard";
import { readTask } from "./tasks";

export const manualVersionSchema = scopeSchema.extend({ revision: z.number().int().min(1), baseVersion: z.number().int().min(1), pack: packSchema, changeSummary: z.string().trim().min(1).max(1000) }).strict();
export const reviewInputSchema = scopeSchema.extend({
  revision: z.number().int().min(1), versionId: z.string().min(1).max(100),
  action: z.enum(["submit", "approve", "changes_requested", "archive", "reviewed"]), note: z.string().trim().max(3000).default(""),
  confirmations: z.array(z.enum(["facts", "filming", "destination"])).max(3).default([]),
}).strict().superRefine((v, ctx) => {
  if (v.action === "changes_requested" && !v.note) ctx.addIssue({ code: "custom", message: "请填写退回原因" });
  if (v.action === "approve" && new Set(v.confirmations).size !== 3) ctx.addIssue({ code: "custom", message: "请确认商品事实、拍摄可行性与承接位置" });
});
export type VersionData = { id: string; task_id: string; version: number; product_version_id: string; pack_json: string; input_snapshot_json: string; validation_json: string };
export async function readVersion(access: EcommerceAccess, taskId: string, versionId: string) {
  const version = await getD1().prepare("SELECT * FROM ecommerce_versions WHERE id=? AND task_id=? AND organization_id=? AND project_id=?")
    .bind(versionId, taskId, access.organizationId, access.projectId).first<VersionData>();
  if (!version) throw new EcommerceError("VERSION_UNAVAILABLE", "稿件版本不可用。", 404);
  return version;
}

export async function saveManualVersion(request: Request, access: EcommerceAccess, taskId: string, input: z.infer<typeof manualVersionSchema>) {
  const context = await buildEcommerceContext(access, taskId), task = context.task, db = getD1(), scope = [access.organizationId, access.projectId];
  if (task.revision !== input.revision || task.current_version !== input.baseVersion || task.status === "archived") throw new EcommerceError("STATE_CHANGED", "任务或稿件已改变。", 409);
  const base = await db.prepare("SELECT id,product_version_id FROM ecommerce_versions WHERE task_id=? AND version=? AND organization_id=? AND project_id=?").bind(taskId, input.baseVersion, ...scope).first<{ id: string; product_version_id: string }>();
  if (!base || base.product_version_id !== task.product_version_id) throw new EcommerceError("VERSION_UNAVAILABLE", "请先为当前商品版本生成稿件。", 409);
  const validation = validateEcommercePack(input.pack, context), id = crypto.randomUUID(), now = new Date().toISOString();
  // Invalid drafts may be saved for editing, but cannot enter review or publication.
  const saved = await commitMutation(request, access, [
    db.prepare(`WITH expected AS (SELECT ? AS doc) UPDATE ecommerce_tasks SET current_version=current_version+1,status='draft',updated_by=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND current_version=? AND status!='archived'
      AND ${enabledGuard} AND ${generationSourceGuard} AND ${generationActorGuard} AND NOT EXISTS(SELECT 1 FROM ecommerce_generation_runs WHERE task_id=? AND status='running')`)
      .bind(JSON.stringify(context.input), access.userId, now, taskId, ...scope, input.revision, input.baseVersion, ...scope, access.userId, taskId),
    db.prepare(`INSERT INTO ecommerce_versions (id,organization_id,project_id,task_id,product_id,product_version_id,version,parent_version_id,mode,pack_json,input_snapshot_json,input_hash,source_manifest_json,validation_json,change_summary,created_by,created_at)
      SELECT ?,organization_id,project_id,id,product_id,product_version_id,current_version,?,'manual',?,?,?,?,?,?,?,? FROM ecommerce_tasks WHERE id=? AND organization_id=? AND project_id=? AND changes()=1`)
      .bind(id, base.id, JSON.stringify(input.pack), JSON.stringify({ ...context.input, taskRevision: task.revision }), context.inputHash, JSON.stringify(context.manifest), JSON.stringify({ ...validation, humanReviewRequired: true, modelReviewStale: true }), input.changeSummary, access.userId, now, taskId, ...scope),
    auditStatement(access, "ecommerce.version.manual", taskId, { versionId: id }),
  ]); requireChanged(saved);
  return { id, version: input.baseVersion + 1, validation };
}

export async function reviewEcommerce(request: Request, access: EcommerceAccess, taskId: string, input: z.infer<typeof reviewInputSchema>) {
  const task = await readTask(access, taskId), version = await readVersion(access, taskId, input.versionId), db = getD1(), scope = [access.organizationId, access.projectId];
  if (task.revision !== input.revision || task.current_version !== version.version || task.status === "archived") throw new EcommerceError("STATE_CHANGED", "请针对当前稿件版本操作。", 409);
  const transitions: Record<string, { from: string[]; to: string }> = {
    submit: { from: ["draft"], to: "internal_review" }, approve: { from: ["internal_review"], to: "publish_ready" },
    changes_requested: { from: ["internal_review", "publish_ready"], to: "draft" },
    archive: { from: ["draft", "internal_review", "publish_ready", "published", "reviewed"], to: "archived" },
    reviewed: { from: ["published"], to: "reviewed" },
  };
  const transition = transitions[input.action];
  if (!transition.from.includes(task.status)) throw new EcommerceError("INVALID_TRANSITION", "当前状态不支持该操作。", 409);
  const validateSources = input.action === "submit" || input.action === "approve";
  const context = validateSources ? await buildEcommerceContext(access, taskId) : null;
  if (context) {
    if (version.product_version_id !== task.product_version_id || JSON.parse(version.input_snapshot_json).taskRevision !== task.revision) throw new EcommerceError("BRIEF_CHANGED", "任务条件已改变，请先保存或生成适用的新版本。", 409);
    const pack = packSchema.parse(JSON.parse(version.pack_json)), validation = validateEcommercePack(pack, context);
    if (!context.ready || !validation.ok || pack.pendingConfirmations.length) throw new EcommerceError("REVIEW_NOT_READY", ["请先解决稿件问题和待确认项", ...context.missing, ...validation.issues, ...pack.pendingConfirmations].join("；"), 409);
  }
  if (input.action === "reviewed" && !await db.prepare(`SELECT m.id FROM ecommerce_metric_snapshots m JOIN ecommerce_publications p ON p.id=m.publication_id AND p.organization_id=m.organization_id AND p.project_id=m.project_id WHERE p.task_id=? AND p.version_id=? AND p.organization_id=? AND p.project_id=? LIMIT 1`).bind(taskId, version.id, ...scope).first())
    throw new EcommerceError("METRICS_REQUIRED", "请先回填至少一组有统计口径的发布数据。", 409);
  const now = new Date().toISOString(), reviewId = crypto.randomUUID();
  const updateSql = `${context ? "WITH expected AS (SELECT ? AS doc) " : ""}UPDATE ecommerce_tasks SET status=?,updated_by=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND current_version=? AND status=? AND ${enabledGuard} AND ${generationActorGuard} ${context ? `AND ${generationSourceGuard}` : ""} AND NOT EXISTS(SELECT 1 FROM ecommerce_generation_runs WHERE task_id=? AND status='running')`;
  const statements = [db.prepare(updateSql).bind(...context ? [JSON.stringify(context.input)] : [], transition.to, access.userId, now, taskId, ...scope, input.revision, version.version, task.status, ...scope, access.userId, taskId)];
  if (["submit", "approve", "changes_requested"].includes(input.action)) statements.push(db.prepare("INSERT INTO ecommerce_reviews (id,organization_id,project_id,task_id,version_id,decision,note,created_by,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1")
    .bind(reviewId, ...scope, taskId, version.id, input.action === "submit" ? "submitted" : input.action === "approve" ? "approved" : "changes_requested", input.note, access.userId, now));
  statements.push(auditStatement(access, `ecommerce.review.${input.action}`, taskId, { versionId: version.id, confirmations: input.confirmations, note: input.note }));
  requireChanged(await commitMutation(request, access, statements));
  return { id: taskId, status: transition.to, versionId: version.id };
}

export function exportedScript(pack: EcommercePack) { return pack.segments.map(s => s.script).join("\n\n"); }
