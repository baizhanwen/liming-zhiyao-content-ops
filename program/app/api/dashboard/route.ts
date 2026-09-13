import { ACTIVE_ANALYSIS_STATUSES_SQL } from "../../../lib/analysis-jobs";
import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

const OPEN_CONTENT_STATUSES = "'draft','internal_revision','internal_review','client_review','publish_ready'";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问工作台。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);

  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作台。", 403);

    const user = await ensureUser(identity);
    const db = getD1();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString();
    const isAdmin = access.organizationRole === "admin";
    const projectScope = (alias: string) => isAdmin ? "" : ` AND EXISTS (
      SELECT 1 FROM project_members own
      WHERE own.organization_id = ${alias}.organization_id AND own.project_id = ${alias}.project_id
        AND own.user_id = ? AND own.status = 'active'
    )`;
    const scopeValues = isAdmin ? [] : [access.userId];
    const ownerScope = (alias: string) => isAdmin ? "" : ` AND COALESCE(${alias}.assignee_user_id, ${alias}.created_by) = ?`;
    const ownerValues = isAdmin ? [] : [access.userId];
    const jobOwnerScope = isAdmin ? "" : " AND j.created_by = ?";
    const jobOwnerValues = isAdmin ? [] : [access.userId];
    const reviewScope = isAdmin ? "" : ` AND EXISTS (
      SELECT 1 FROM project_members reviewer
      WHERE reviewer.organization_id = c.organization_id AND reviewer.project_id = c.project_id
        AND reviewer.user_id = ? AND reviewer.status = 'active'
    )`;
    const reviewValues = isAdmin ? [] : [access.userId];

    const [
      pendingReviews,
      activeJobs,
      failedJobs,
      upcomingSchedules,
      openTasks,
      reviews,
      tasks,
      jobs,
      projects,
      published,
      team,
      writeAccess,
    ] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS value
        FROM content_reviews r INNER JOIN content_items c ON c.id = r.content_item_id
        WHERE c.organization_id = ? AND c.deleted_at IS NULL AND r.review_stage = 'internal' AND r.decision = 'pending'${reviewScope}`)
        .bind(organizationId, ...reviewValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM analysis_jobs j
        WHERE j.organization_id = ? AND j.status IN (${ACTIVE_ANALYSIS_STATUSES_SQL})${jobOwnerScope}${projectScope("j")}`)
        .bind(organizationId, ...jobOwnerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM analysis_jobs j
        WHERE j.organization_id = ? AND j.status = 'failed'${jobOwnerScope}${projectScope("j")}`)
        .bind(organizationId, ...jobOwnerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_schedules s
        INNER JOIN content_items c ON c.id = s.content_item_id
        WHERE s.organization_id = ? AND s.status IN ('planned','ready') AND s.scheduled_at >= ? AND s.scheduled_at <= ?${ownerScope("c")}${projectScope("s")}`)
        .bind(organizationId, now.toISOString(), weekEnd, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_items c
        WHERE c.organization_id = ? AND c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES})${ownerScope("c")}${projectScope("c")}`)
        .bind(organizationId, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT r.id, r.review_stage, r.requested_at, c.id AS content_id, c.title, c.due_at, p.name AS project_name
        FROM content_reviews r INNER JOIN content_items c ON c.id = r.content_item_id INNER JOIN projects p ON p.id = c.project_id
        WHERE r.organization_id = ? AND c.deleted_at IS NULL AND r.review_stage = 'internal' AND r.decision = 'pending'${reviewScope}
        ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END, COALESCE(c.due_at, r.requested_at) ASC LIMIT 8`)
        .bind(organizationId, ...reviewValues).all(),
      db.prepare(`SELECT c.id, c.title, c.status, c.due_at, c.updated_at, p.id AS project_id, p.name AS project_name
        FROM content_items c INNER JOIN projects p ON p.id = c.project_id
        WHERE c.organization_id = ? AND c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES})${ownerScope("c")}${projectScope("c")}
        ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END, c.due_at ASC, c.updated_at DESC LIMIT 10`)
        .bind(organizationId, ...ownerValues, ...scopeValues).all(),
      db.prepare(`SELECT j.id, j.status, j.progress, j.current_stage, j.updated_at, v.title, p.name AS project_name
        FROM analysis_jobs j LEFT JOIN videos v ON v.id = j.video_id INNER JOIN projects p ON p.id = j.project_id
        WHERE j.organization_id = ?${jobOwnerScope}${projectScope("j")}
        ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'analyzing' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, j.updated_at DESC LIMIT 6`)
        .bind(organizationId, ...jobOwnerValues, ...scopeValues).all(),
      db.prepare(`SELECT p.id, p.name, p.content_target, p.status,
          COUNT(DISTINCT CASE WHEN c.status = 'published' AND c.updated_at >= ? THEN c.id END) AS published_month,
          COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES}) THEN c.id END) AS open_items
        FROM projects p LEFT JOIN content_items c ON c.project_id = p.id AND c.organization_id = p.organization_id
        WHERE p.organization_id = ? AND p.deleted_at IS NULL AND p.status != 'archived'${isAdmin ? "" : " AND EXISTS (SELECT 1 FROM project_members own WHERE own.organization_id = p.organization_id AND own.project_id = p.id AND own.user_id = ? AND own.status = 'active')"}
        GROUP BY p.id, p.name, p.content_target, p.status ORDER BY p.updated_at DESC`)
        .bind(monthStart, organizationId, ...scopeValues).all<{ id: string; name: string; content_target: number; status: string; published_month: number; open_items: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_items c
        WHERE c.organization_id = ? AND c.deleted_at IS NULL AND c.status = 'published' AND c.updated_at >= ?${ownerScope("c")}${projectScope("c")}`)
        .bind(organizationId, monthStart, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name, om.role,
          COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES}) THEN c.id END) AS open_tasks,
          COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES}) AND c.due_at IS NOT NULL AND c.due_at <= ? THEN c.id END) AS due_soon,
          COUNT(DISTINCT CASE WHEN j.status IN (${ACTIVE_ANALYSIS_STATUSES_SQL}) THEN j.id END) AS active_jobs
        FROM organization_members om INNER JOIN users u ON u.id = om.user_id
        LEFT JOIN content_items c ON c.organization_id = om.organization_id AND COALESCE(c.assignee_user_id, c.created_by) = u.id
        LEFT JOIN analysis_jobs j ON j.organization_id = om.organization_id AND j.created_by = u.id
        WHERE om.organization_id = ? AND om.status = 'active' AND ? = 1
        GROUP BY u.id, u.display_name, u.email, om.role ORDER BY due_soon DESC, open_tasks DESC, active_jobs DESC LIMIT 8`)
        .bind(weekEnd, organizationId, isAdmin ? 1 : 0).all(),
      isAdmin
        ? Promise.resolve({ allowed: 1 })
        : db.prepare(`SELECT 1 AS allowed FROM project_members
            WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1`)
          .bind(organizationId, access.userId).first<{ allowed: number }>(),
    ]);

    return Response.json({
      mode: isAdmin ? "admin" : "employee",
      organizationRole: access.organizationRole,
      canCreateContent: Boolean(writeAccess?.allowed),
      currentUser: { id: user.id, displayName: user.display_name || user.email },
      summary: {
        pendingReviews: pendingReviews?.value ?? 0,
        publishedMonth: published?.value ?? 0,
        activeJobs: activeJobs?.value ?? 0,
        failedJobs: failedJobs?.value ?? 0,
        upcomingSchedules: upcomingSchedules?.value ?? 0,
        openTasks: openTasks?.value ?? 0,
        monthlyContentTarget: projects.results.reduce((sum, project) => sum + (project.content_target || 0), 0),
      },
      reviews: reviews.results,
      tasks: tasks.results,
      jobs: jobs.results,
      projects: projects.results,
      team: team.results,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
