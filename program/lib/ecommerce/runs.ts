import { z } from "zod";
import { getD1 } from "../../db/runtime";
import { scopeSchema } from "./contracts";
import { auditStatement, EcommerceError, type EcommerceAccess } from "./access";
import { readTask } from "./tasks";

export const runControlSchema = scopeSchema.extend({
  runId: z.string().min(1).max(200),
  action: z.enum(["cancel", "recover"]),
}).strict();

// The model adapter aborts each request after 90 seconds. Recovery is explicit,
// with extra allowance for recording the result; elapsed UI wait alone does not
// end a run. A cancelled request still occupies capacity until its call settles.
export const RECOVERY_IDLE_MS = 5 * 60 * 1000;
export const activeRunPredicate = `(r.status='running' OR EXISTS (
  SELECT 1 FROM model_calls mc WHERE mc.organization_id=r.organization_id AND mc.project_id=r.project_id
    AND mc.task_type LIKE 'ecommerce.%' AND mc.status='started'
    AND json_extract(mc.input_json,'$.runId')=r.id))`;

export async function controlRun(access: EcommerceAccess, taskId: string, input: z.infer<typeof runControlSchema>) {
  await readTask(access, taskId);
  const db = getD1(), scope = [access.organizationId, access.projectId];
  const run = await db.prepare("SELECT id,status,created_at,error_code FROM ecommerce_generation_runs WHERE id=? AND task_id=? AND organization_id=? AND project_id=?")
    .bind(input.runId, taskId, ...scope).first<{ id: string; status: string; created_at: string; error_code: string | null }>();
  if (!run) throw new EcommerceError("RUN_NOT_FOUND", "运行记录不存在。", 404);
  if (input.action === "recover" && access.organizationRole !== "admin") throw new EcommerceError("ADMIN_REQUIRED", "恢复中断运行需要公司管理员操作。", 403);
  if (run.status === "completed") throw new EcommerceError("RUN_COMPLETED", "本次运行已经完成，请查看已保存版本。", 409);
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - RECOVERY_IDLE_MS).toISOString();
  const code = input.action === "cancel" ? "RUN_CANCELLED" : "RUN_RECOVERED";
  const message = input.action === "cancel" ? "已取消生成；已发出的模型请求会结束并保留调用记录，原稿不变。" : "管理员已结束中断运行；原稿和调用记录保留，未自动重试。";
  // Compare the most recent call activity atomically, not just the run start:
  // a long run with a recent live call is not eligible for forced recovery.
  const recoveryGuard = `created_at<=? AND NOT EXISTS(SELECT 1 FROM model_calls m
    WHERE m.organization_id=ecommerce_generation_runs.organization_id AND m.project_id=ecommerce_generation_runs.project_id
      AND m.task_type LIKE 'ecommerce.%' AND json_extract(m.input_json,'$.runId')=ecommerce_generation_runs.id
      AND COALESCE(m.completed_at,m.created_at)>?)`;
  const result = await db.batch([
    db.prepare(`UPDATE ecommerce_generation_runs SET status='failed',error_code=?,error_message=?,completed_at=?
      WHERE id=? AND task_id=? AND organization_id=? AND project_id=?
      AND ${input.action === "cancel" ? "status='running'" : `status!='completed' AND ${recoveryGuard}`}`)
      .bind(code, message, now, run.id, taskId, ...scope, ...(input.action === "recover" ? [cutoff, cutoff] : [])),
    auditStatement(access, `ecommerce.run.${input.action}`, taskId, { runId: run.id }),
    db.prepare(`UPDATE generation_source_manifests SET status='failed',error_code=?,completed_at=?
      WHERE trace_id=? AND organization_id=? AND project_id=? AND capability='ecommerce' AND status='started'
      AND EXISTS(SELECT 1 FROM ecommerce_generation_runs WHERE id=? AND status='failed' AND error_code=?)`)
      .bind(code, now, run.id, ...scope, run.id, code),
    ...(input.action === "recover" ? [db.prepare(`UPDATE model_calls SET status='failed',error_code='ECOMMERCE_CALL_RECOVERED',error_message='管理员已回收超时调用；可能已产生供应商费用。',completed_at=?
      WHERE organization_id=? AND project_id=? AND task_type LIKE 'ecommerce.%' AND status='started' AND json_extract(input_json,'$.runId')=?
      AND EXISTS(SELECT 1 FROM ecommerce_generation_runs WHERE id=? AND error_code='RUN_RECOVERED' AND completed_at=?)`)
      .bind(now, ...scope, run.id, run.id, now)] : []),
  ]);
  if (!result[0].meta.changes && input.action === "recover") throw new EcommerceError("RUN_NOT_RECOVERABLE", "运行仍有近期活动，请先刷新记录。连续五分钟无活动后才可由管理员恢复。", 409);
  const latest = await db.prepare("SELECT id,status,error_code,error_message,completed_at FROM ecommerce_generation_runs WHERE id=? AND organization_id=? AND project_id=?").bind(run.id, ...scope).first();
  return { run: latest };
}
