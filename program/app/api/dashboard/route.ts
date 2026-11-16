import { ACTIVE_ANALYSIS_STATUSES_SQL } from "../../../lib/analysis-jobs";
import { dashboardMonthRange } from "../../../lib/dashboard-period";
import { readWorkTaskSummary } from "../../../lib/work-tasks";
import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

const OPEN_CONTENT_STATUSES = "'draft','internal_revision','internal_review','client_review','publish_ready'";
const availableProject = (alias: string) => `EXISTS (SELECT 1 FROM projects available
  WHERE available.id=${alias}.project_id AND available.organization_id=${alias}.organization_id
    AND available.deleted_at IS NULL AND available.status!='archived')`;
// A transcript extraction is a separate utility task, not a new main analysis.
const latestMainJob = `j.id = (SELECT latest.id FROM analysis_jobs latest
  WHERE latest.organization_id=j.organization_id AND latest.project_id=j.project_id AND latest.video_id=j.video_id
    AND latest.idempotency_key NOT LIKE 'transcript:%' ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)`;

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问工作台。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);

  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作台。", 403);

    const user = await ensureUser(identity), db = getD1(), now = new Date();
    const month = dashboardMonthRange(now), nowIso = now.toISOString();
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
    const visibleJobs = `SELECT j.id,j.video_id,j.project_id,j.status,j.progress,j.current_stage,j.updated_at,v.title,p.name AS project_name
      FROM analysis_jobs j INNER JOIN videos v ON v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id
      INNER JOIN projects p ON p.id=j.project_id AND p.organization_id=j.organization_id
      WHERE j.organization_id=? AND j.idempotency_key NOT LIKE 'transcript:%'
        AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status!='archived'${jobOwnerScope}${projectScope("j")}`;
    const jobBindings = [organizationId, ...jobOwnerValues, ...scopeValues];
    const publicationInMonth = `EXISTS (SELECT 1 FROM publication_records publication
      WHERE publication.content_item_id=c.id AND publication.organization_id=c.organization_id AND publication.project_id=c.project_id
        AND publication.status='published' AND julianday(publication.published_at)>=julianday(?) AND julianday(publication.published_at)<julianday(?))`;

    const [pendingReviews, jobCounts, historicalFailures, upcomingSchedules, openTasks, reviews, tasks,
      jobs, projects, published, team, writeAccess, workTasks, assignableEmployees] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS value FROM content_reviews r INNER JOIN content_items c
          ON c.id=r.content_item_id AND c.organization_id=r.organization_id AND c.project_id=r.project_id
        WHERE c.organization_id=? AND c.deleted_at IS NULL AND ${availableProject("c")}
          AND r.review_stage='internal' AND r.decision='pending'${reviewScope}`)
        .bind(organizationId, ...reviewValues).first<{ value: number }>(),
      db.prepare(`WITH current_jobs AS (${visibleJobs} AND ${latestMainJob})
        SELECT COUNT(CASE WHEN status IN (${ACTIVE_ANALYSIS_STATUSES_SQL}) THEN 1 END) AS activeJobs,
          COUNT(CASE WHEN status='failed' THEN 1 END) AS currentFailedJobs,
          COUNT(CASE WHEN status='partial' THEN 1 END) AS partialJobs FROM current_jobs`)
        .bind(...jobBindings).first<{ activeJobs: number; currentFailedJobs: number; partialJobs: number }>(),
      // Historical failures include current failures; this compatibility count
      // is a count of failed records, never an additional current-alert total.
      db.prepare(`SELECT COUNT(*) AS value FROM (${visibleJobs} AND j.status='failed')`)
        .bind(...jobBindings).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_schedules s INNER JOIN content_items c
          ON c.id=s.content_item_id AND c.organization_id=s.organization_id AND c.project_id=s.project_id
        WHERE s.organization_id=? AND c.deleted_at IS NULL AND ${availableProject("s")}
          AND s.status IN ('planned','ready') AND s.scheduled_at>=? AND s.scheduled_at<=?${ownerScope("c")}${projectScope("s")}`)
        .bind(organizationId, nowIso, weekEnd, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_items c WHERE c.organization_id=? AND c.deleted_at IS NULL
        AND ${availableProject("c")} AND c.status IN (${OPEN_CONTENT_STATUSES})${ownerScope("c")}${projectScope("c")}`)
        .bind(organizationId, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT r.id,r.review_stage,r.requested_at,c.id AS content_id,c.title,c.due_at,p.id AS project_id,p.name AS project_name
        FROM content_reviews r INNER JOIN content_items c ON c.id=r.content_item_id AND c.organization_id=r.organization_id AND c.project_id=r.project_id
        INNER JOIN projects p ON p.id=c.project_id AND p.organization_id=c.organization_id
        WHERE r.organization_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status!='archived'
          AND r.review_stage='internal' AND r.decision='pending'${reviewScope}
        ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END,COALESCE(c.due_at,r.requested_at) ASC LIMIT 8`)
        .bind(organizationId, ...reviewValues).all(),
      db.prepare(`SELECT c.id,c.title,c.status,c.due_at,c.updated_at,p.id AS project_id,p.name AS project_name
        FROM content_items c INNER JOIN projects p ON p.id=c.project_id AND p.organization_id=c.organization_id
        WHERE c.organization_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status!='archived'
          AND c.status IN (${OPEN_CONTENT_STATUSES})${ownerScope("c")}${projectScope("c")}
        ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END,c.due_at ASC,c.updated_at DESC LIMIT 10`)
        .bind(organizationId, ...ownerValues, ...scopeValues).all(),
      db.prepare(`WITH current_jobs AS (${visibleJobs} AND ${latestMainJob}),
        recent_completed AS (SELECT id FROM current_jobs WHERE status='completed' ORDER BY updated_at DESC,id DESC LIMIT 2)
        SELECT * FROM current_jobs WHERE status IN ('failed','partial',${ACTIVE_ANALYSIS_STATUSES_SQL}) OR id IN (SELECT id FROM recent_completed)
        ORDER BY CASE WHEN status='failed' THEN 0 WHEN status='partial' THEN 1 WHEN status IN (${ACTIVE_ANALYSIS_STATUSES_SQL}) THEN 2 ELSE 3 END,
          updated_at DESC,id DESC LIMIT 8`)
        .bind(...jobBindings).all(),
      db.prepare(`SELECT p.id,p.name,p.content_target,p.status,
          COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL AND ${publicationInMonth} THEN c.id END) AS published_month,
          COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL AND c.status IN (${OPEN_CONTENT_STATUSES}) THEN c.id END) AS open_items
        FROM projects p LEFT JOIN content_items c ON c.project_id=p.id AND c.organization_id=p.organization_id
        WHERE p.organization_id=? AND p.deleted_at IS NULL AND p.status!='archived'${isAdmin ? "" : " AND EXISTS (SELECT 1 FROM project_members own WHERE own.organization_id=p.organization_id AND own.project_id=p.id AND own.user_id=? AND own.status='active')"}
        GROUP BY p.id,p.name,p.content_target,p.status ORDER BY p.updated_at DESC`)
        .bind(month.start, month.end, organizationId, ...scopeValues).all<{ id: string; name: string; content_target: number; status: string; published_month: number; open_items: number }>(),
      db.prepare(`SELECT COUNT(DISTINCT c.id) AS value FROM content_items c WHERE c.organization_id=? AND c.deleted_at IS NULL
        AND ${availableProject("c")} AND ${publicationInMonth}${ownerScope("c")}${projectScope("c")}`)
        .bind(organizationId, month.start, month.end, ...ownerValues, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT u.id,COALESCE(NULLIF(u.display_name,''),u.email) AS name,om.role,
          COUNT(DISTINCT CASE WHEN c.status IN (${OPEN_CONTENT_STATUSES}) THEN c.id END) AS open_tasks,
          COUNT(DISTINCT CASE WHEN c.status IN (${OPEN_CONTENT_STATUSES}) AND c.due_at IS NOT NULL AND c.due_at<=? THEN c.id END) AS due_soon,
          COUNT(DISTINCT CASE WHEN j.status IN (${ACTIVE_ANALYSIS_STATUSES_SQL}) THEN j.id END) AS active_jobs
        FROM organization_members om INNER JOIN users u ON u.id=om.user_id
        LEFT JOIN content_items c ON c.organization_id=om.organization_id AND COALESCE(c.assignee_user_id,c.created_by)=u.id
          AND c.deleted_at IS NULL AND ${availableProject("c")}
        LEFT JOIN analysis_jobs j ON j.organization_id=om.organization_id AND j.created_by=u.id AND ${latestMainJob}
          AND EXISTS (SELECT 1 FROM videos v WHERE v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id AND v.deleted_at IS NULL)
          AND ${availableProject("j")}
        WHERE om.organization_id=? AND om.status='active' AND u.status='active' AND ?=1
        GROUP BY u.id,u.display_name,u.email,om.role ORDER BY due_soon DESC,open_tasks DESC,active_jobs DESC LIMIT 8`)
        .bind(weekEnd, organizationId, isAdmin ? 1 : 0).all(),
      isAdmin ? Promise.resolve({ allowed: 1 }) : db.prepare(`SELECT 1 AS allowed FROM project_members member
        INNER JOIN projects p ON p.id=member.project_id AND p.organization_id=member.organization_id
        WHERE member.organization_id=? AND member.user_id=? AND member.status='active' AND p.deleted_at IS NULL AND p.status!='archived' LIMIT 1`)
        .bind(organizationId, access.userId).first<{ allowed: number }>(),
      readWorkTaskSummary(organizationId, access.userId, isAdmin, nowIso),
      db.prepare(`SELECT u.id,COALESCE(NULLIF(u.display_name,''),u.email) AS name
        FROM organization_members member INNER JOIN users u ON u.id=member.user_id
        WHERE member.organization_id=? AND member.role='member' AND member.status='active' AND u.status='active' AND ?=1
        ORDER BY name ASC,u.id ASC`).bind(organizationId, isAdmin ? 1 : 0).all(),
    ]);

    return Response.json({
      mode: isAdmin ? "admin" : "employee", organizationRole: access.organizationRole,
      canCreateContent: Boolean(writeAccess?.allowed), currentUser: { id: user.id, displayName: user.display_name || user.email },
      summary: {
        pendingReviews: pendingReviews?.value ?? 0, publishedMonth: published?.value ?? 0,
        activeJobs: jobCounts?.activeJobs ?? 0, currentFailedJobs: jobCounts?.currentFailedJobs ?? 0, partialJobs: jobCounts?.partialJobs ?? 0,
        failedJobs: historicalFailures?.value ?? 0, historicalFailedJobs: historicalFailures?.value ?? 0,
        upcomingSchedules: upcomingSchedules?.value ?? 0, openTasks: openTasks?.value ?? 0,
        ...workTasks,
        monthlyContentTarget: projects.results.reduce((sum, project) => sum + (project.content_target || 0), 0),
      },
      reviews: reviews.results, tasks: tasks.results, jobs: jobs.results, projects: projects.results,
      team: team.results, assignableEmployees: assignableEmployees.results,
    });
  } catch (error) { return errorResponse(error); }
}
