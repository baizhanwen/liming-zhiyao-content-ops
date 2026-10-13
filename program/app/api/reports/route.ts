import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { buildReportNarrative, createReportSchema, loadPerformanceAnalytics } from "../../../lib/performance-analytics";
import { readRequestIdentity } from "../../../lib/request-auth";

import { commitReportWrite, nextReportVersion } from "../../../lib/report-write-transaction";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问报告中心。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的报告。", 403);
    const reports = await getD1().prepare("SELECT id, report_type, period_start, period_end, title, status, summary, metrics_json, highlights_json, recommendations_json, generated_at, finalized_at, updated_at FROM performance_reports WHERE organization_id = ? AND project_id = ? ORDER BY period_end DESC, generated_at DESC LIMIT 100").bind(organizationId, projectId).all();
    return Response.json({ reports: reports.results, canGenerate: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成报告。", 401);
  try {
    const parsed = createReportSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_REPORT_INPUT", parsed.error.issues[0]?.message || "报告参数无效。", 400);
    const { organizationId, projectId, reportType, periodStart, periodEnd, title } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("REPORT_ACCESS_DENIED", "当前角色不能生成报告。", 403);
    const db = getD1(); const existing = await db.prepare("SELECT id, status, updated_at FROM performance_reports WHERE organization_id = ? AND project_id = ? AND period_start = ? AND period_end = ? AND report_type = ?").bind(organizationId, projectId, periodStart, periodEnd, reportType).first<{ id: string; status: string; updated_at: string }>();
    if (existing?.status === "final") return apiError("FINAL_REPORT_IMMUTABLE", "该周期报告已经定稿，不能覆盖。", 409);
    const snapshot = await loadPerformanceAnalytics(db, organizationId, projectId, periodStart, periodEnd); const narrative = buildReportNarrative(snapshot); const user = await ensureUser(identity); const now = new Date().toISOString(); const reportId = existing?.id || crypto.randomUUID(); const defaultTitle = `${periodStart} 至 ${periodEnd} ${reportType === "weekly" ? "周报" : reportType === "monthly" ? "月报" : "运营报告"}`;
    const version = nextReportVersion(existing?.updated_at);
    const committed = await commitReportWrite(db, {
      request, authSubject: identity.authSubject, scope: { organizationId,projectId,userId:user.id }, reportId, version,
      action: "performance.report.generated", targetType: "performance_report", metadata: { reportType,periodStart,periodEnd,refreshed:Boolean(existing) },
      guard: existing ? "EXISTS(SELECT 1 FROM performance_reports WHERE id=? AND organization_id=? AND project_id=? AND status='draft' AND updated_at=?)"
        : "NOT EXISTS(SELECT 1 FROM performance_reports WHERE project_id=? AND period_start=? AND period_end=? AND report_type=?)",
      bindings: existing ? [reportId,organizationId,projectId,existing.updated_at] : [projectId,periodStart,periodEnd,reportType],
      mutate: (exists,marker) => existing
        ? db.prepare(`UPDATE performance_reports SET title=?,summary=?,metrics_json=?,highlights_json=?,recommendations_json=?,generated_by=?,generated_at=?,updated_at=?
            WHERE id=? AND organization_id=? AND project_id=? AND status='draft' AND updated_at=? AND ${exists}`)
          .bind(title||defaultTitle,narrative.summary,JSON.stringify(snapshot),JSON.stringify(narrative.highlights),JSON.stringify(narrative.recommendations),user.id,now,version,reportId,organizationId,projectId,existing.updated_at,marker)
        : db.prepare(`INSERT INTO performance_reports(id,organization_id,project_id,report_type,period_start,period_end,title,status,summary,metrics_json,highlights_json,recommendations_json,generated_by,generated_at,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,? WHERE ${exists}`)
          .bind(reportId,organizationId,projectId,reportType,periodStart,periodEnd,title||defaultTitle,narrative.summary,JSON.stringify(snapshot),JSON.stringify(narrative.highlights),JSON.stringify(narrative.recommendations),user.id,now,now,version,marker),
    });
    if (!committed) return apiError("REPORT_VERSION_CONFLICT", "该周期报告已被其他操作生成、刷新或定稿，本次未覆盖。请刷新列表，核对当前报告后再操作。", 409);
    return Response.json({ report: { id: reportId, report_type: reportType, period_start: periodStart, period_end: periodEnd, title: title || defaultTitle, status: "draft", summary: narrative.summary, metrics_json: JSON.stringify(snapshot), highlights_json: JSON.stringify(narrative.highlights), recommendations_json: JSON.stringify(narrative.recommendations), generated_at: now, finalized_at: null, updated_at: version } }, { status: existing ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}

