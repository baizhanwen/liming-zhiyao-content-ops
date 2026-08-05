import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { finalizeReportSchema } from "../../../../../lib/performance-analytics";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ reportId: string }> }) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再定稿报告。", 401);
  try {
    const parsed = finalizeReportSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_REPORT_FINALIZATION", "报告定稿参数无效。", 400);
    const { organizationId, projectId } = parsed.data; const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("REPORT_ACCESS_DENIED", "当前角色不能定稿报告。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString(); const { reportId } = await context.params; const db = getD1();
    const result = await db.prepare("UPDATE performance_reports SET status = 'final', finalized_by = ?, finalized_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'draft'").bind(user.id, now, now, reportId, organizationId, projectId).run();
    if (!result.meta.changes) return apiError("REPORT_NOT_FINALIZABLE", "报告不存在、已定稿或状态已经变化。", 409);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, 'performance.report.finalized', 'performance_report', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, reportId, now).run();
    return Response.json({ report: { id: reportId, status: "final", finalized_at: now, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}

