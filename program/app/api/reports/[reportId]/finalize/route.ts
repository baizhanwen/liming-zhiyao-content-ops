import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { finalizeReportSchema } from "../../../../../lib/performance-analytics";
import { readRequestIdentity } from "../../../../../lib/request-auth";

import { commitReportWrite, nextReportVersion } from "../../../../../lib/report-write-transaction";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ reportId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再定稿报告。", 401);
  try {
    const parsed = finalizeReportSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_REPORT_FINALIZATION", "请刷新报告并核对当前版本后再定稿。", 400);
    const { organizationId, projectId, expectedUpdatedAt } = parsed.data; const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("REPORT_ACCESS_DENIED", "当前角色不能定稿报告。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString(); const { reportId } = await context.params; const db = getD1();
    const version = nextReportVersion(expectedUpdatedAt);
    const committed = await commitReportWrite(db, {
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},reportId,version,
      action:"performance.report.finalized",targetType:"performance_report",metadata:{expectedUpdatedAt},
      guard:"EXISTS(SELECT 1 FROM performance_reports WHERE id=? AND organization_id=? AND project_id=? AND status='draft' AND updated_at=?)",
      bindings:[reportId,organizationId,projectId,expectedUpdatedAt],
      mutate:(exists,marker)=>db.prepare(`UPDATE performance_reports SET status = 'final',finalized_by=?,finalized_at=?,updated_at=?
        WHERE id=? AND organization_id=? AND project_id=? AND status = 'draft' AND updated_at=? AND ${exists}`)
        .bind(user.id,now,version,reportId,organizationId,projectId,expectedUpdatedAt,marker),
    });
    if (!committed) return apiError("REPORT_NOT_FINALIZABLE", "报告不存在、已被刷新或已定稿。本次未定稿，请刷新并重新核对报告。", 409);
    return Response.json({ report: { id: reportId, status: "final", finalized_at: now, updated_at: version } });
  } catch (error) { return errorResponse(error); }
}

