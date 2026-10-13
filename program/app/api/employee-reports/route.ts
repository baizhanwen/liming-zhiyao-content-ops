import { ensureUser, getD1, getProjectAccess, type ProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { createEmployeeWorkReportSchema, loadEmployeeWorkReport } from "../../../lib/employee-work-report";
import { readRequestIdentity } from "../../../lib/request-auth";

import { commitReportWrite, nextReportVersion } from "../../../lib/report-write-transaction";

export const dynamic = "force-dynamic";

type Employee = { id: string; name: string; email: string; role: string };

function canViewTeam(access: ProjectAccess) { return access.organizationRole === "admin"; }
function canGenerateOwn(access: ProjectAccess) { return access.organizationRole === "admin" || access.projectRole !== null; }

async function loadEmployees(db: D1Database, access: ProjectAccess, organizationId: string, projectId: string) {
  if (!canViewTeam(access)) {
    const own = await db.prepare("SELECT id, COALESCE(display_name, email) AS name, email FROM users WHERE id = ? AND status = 'active'").bind(access.userId).first<{ id: string; name: string; email: string }>();
    return own ? [{ ...own, role: access.projectRole || "admin" }] : [];
  }
  const result = await db.prepare(`
    SELECT u.id, COALESCE(u.display_name, u.email) AS name, u.email, pm.role
    FROM project_members pm
    INNER JOIN users u ON u.id = pm.user_id AND u.status = 'active'
    INNER JOIN organization_members om ON om.organization_id = pm.organization_id AND om.user_id = pm.user_id AND om.status = 'active'
    WHERE pm.organization_id = ? AND pm.project_id = ? AND pm.status = 'active'
    ORDER BY COALESCE(u.display_name, u.email)
  `).bind(organizationId, projectId).all<Employee>();
  const employees = [...result.results];
  if (!employees.some((employee) => employee.id === access.userId)) {
    const own = await db.prepare("SELECT id, COALESCE(display_name, email) AS name, email FROM users WHERE id = ? AND status = 'active'").bind(access.userId).first<{ id: string; name: string; email: string }>();
    if (own) employees.unshift({ ...own, role: "admin" });
  }
  return employees;
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问员工工作报告。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或企业空间范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该企业空间的员工报告。", 403);
    const db = getD1(); const employees = await loadEmployees(db, access, organizationId, projectId); const requested = url.searchParams.get("employeeUserId")?.trim() || "";
    const fallback = employees.find((employee) => employee.id === access.userId)?.id || employees[0]?.id || access.userId;
    const employeeUserId = employees.some((employee) => employee.id === requested) ? requested : fallback;
    if (employeeUserId !== access.userId && !canViewTeam(access)) return apiError("EMPLOYEE_REPORT_ACCESS_DENIED", "只能查看自己的工作报告。", 403);
    const reports = await db.prepare("SELECT id, employee_user_id, report_type, period_start, period_end, title, snapshot_json, generated_at, updated_at FROM employee_work_reports WHERE organization_id = ? AND project_id = ? AND employee_user_id = ? ORDER BY period_end DESC, generated_at DESC LIMIT 100").bind(organizationId, projectId, employeeUserId).all();
    return Response.json({ reports: reports.results, employees, selectedEmployeeId: employeeUserId, currentUserId: access.userId, canViewTeam: canViewTeam(access), canGenerate: canGenerateOwn(access) && (employeeUserId === access.userId || canViewTeam(access)) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成员工工作报告。", 401);
  try {
    const parsed = createEmployeeWorkReportSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_EMPLOYEE_REPORT_INPUT", parsed.error.issues[0]?.message || "员工报告参数无效。", 400);
    const { organizationId, projectId, employeeUserId, reportType, periodStart, periodEnd, title } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canGenerateOwn(access) || (employeeUserId !== access.userId && !canViewTeam(access))) return apiError("EMPLOYEE_REPORT_ACCESS_DENIED", "当前角色不能生成这名员工的工作报告。", 403);
    const db = getD1(); const employees = await loadEmployees(db, access, organizationId, projectId); const employee = employees.find((item) => item.id === employeeUserId);
    if (!employee) return apiError("EMPLOYEE_NOT_IN_PROJECT", "该员工不属于当前企业空间。", 404);
    const existing = await db.prepare("SELECT id,updated_at FROM employee_work_reports WHERE organization_id=? AND project_id=? AND employee_user_id=? AND period_start=? AND period_end=? AND report_type=?")
      .bind(organizationId,projectId,employeeUserId,periodStart,periodEnd,reportType).first<{ id:string; updated_at:string }>();
    const snapshot = await loadEmployeeWorkReport(db, { organizationId,projectId,employeeUserId,employeeName:employee.name,periodStart,periodEnd });
    const user = await ensureUser(identity); const now = new Date().toISOString(); const reportId = existing?.id || crypto.randomUUID(); const reportTitle = title || `${employee.name} · ${periodStart} 至 ${periodEnd} 工作${reportType === "weekly" ? "周报" : reportType === "monthly" ? "月报" : "报告"}`; const snapshotJson = JSON.stringify(snapshot);
    const version = nextReportVersion(existing?.updated_at);
    const employeeGuard = `EXISTS(SELECT 1 FROM users employee JOIN organization_members om ON om.user_id=employee.id
      WHERE employee.id=? AND om.organization_id=? AND employee.status='active' AND om.status='active'
        AND (employee.id=? OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.organization_id=om.organization_id AND pm.project_id=? AND pm.user_id=employee.id AND pm.status='active')))
      AND (?=? OR EXISTS(SELECT 1 FROM organization_members WHERE user_id=? AND organization_id=? AND role='admin' AND status='active'))`;
    const stateGuard = existing ? "EXISTS(SELECT 1 FROM employee_work_reports WHERE id=? AND organization_id=? AND project_id=? AND updated_at=?)"
      : "NOT EXISTS(SELECT 1 FROM employee_work_reports WHERE project_id=? AND employee_user_id=? AND period_start=? AND period_end=? AND report_type=?)";
    const committed = await commitReportWrite(db, {
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},reportId,version,
      action:"employee.report.generated",targetType:"employee_work_report",metadata:{employeeUserId,reportType,periodStart,periodEnd,refreshed:Boolean(existing)},
      guard:`(${employeeGuard}) AND (${stateGuard})`,
      bindings:[employeeUserId,organizationId,user.id,projectId,employeeUserId,user.id,user.id,organizationId,
        ...(existing?[reportId,organizationId,projectId,existing.updated_at]:[projectId,employeeUserId,periodStart,periodEnd,reportType])],
      mutate:(exists,marker)=>existing
        ? db.prepare(`UPDATE employee_work_reports SET title=?,snapshot_json=?,generated_by=?,generated_at=?,updated_at=?
            WHERE id=? AND organization_id=? AND project_id=? AND updated_at=? AND ${exists}`)
          .bind(reportTitle,snapshotJson,user.id,now,version,reportId,organizationId,projectId,existing.updated_at,marker)
        : db.prepare(`INSERT INTO employee_work_reports(id,organization_id,project_id,employee_user_id,report_type,period_start,period_end,title,snapshot_json,generated_by,generated_at,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${exists}`)
          .bind(reportId,organizationId,projectId,employeeUserId,reportType,periodStart,periodEnd,reportTitle,snapshotJson,user.id,now,now,version,marker),
    });
    if (!committed) {
      if (employeeUserId!==user.id && !await db.prepare("SELECT 1 FROM organization_members WHERE user_id=? AND organization_id=? AND role='admin' AND status='active'").bind(user.id,organizationId).first())
        return apiError("EMPLOYEE_REPORT_ACCESS_DENIED","管理员权限已改变，本次报告未保存，请刷新确认。",403);
      if (!(await loadEmployees(db,access,organizationId,projectId)).some(item=>item.id===employeeUserId))
        return apiError("EMPLOYEE_NOT_IN_PROJECT","该员工已不属于当前企业空间，本次报告未保存。",404);
      return apiError("REPORT_VERSION_CONFLICT","该员工周期报告已被其他操作生成或刷新，本次未覆盖。请刷新列表后再操作。",409);
    }
    return Response.json({ report: { id: reportId, employee_user_id: employeeUserId, report_type: reportType, period_start: periodStart, period_end: periodEnd, title: reportTitle, snapshot_json: snapshotJson, generated_at: now, updated_at: version } }, { status: existing ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
