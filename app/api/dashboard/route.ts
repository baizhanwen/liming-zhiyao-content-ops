import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问工作台。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作台。", 403);
    await ensureUser(identity); const db = getD1(); const now = new Date(); const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(); const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString();
    const memberScope = (alias: string) => access.organizationRole === "admin" ? "" : ` AND EXISTS (SELECT 1 FROM project_members own WHERE own.organization_id = ${alias}.organization_id AND own.project_id = ${alias}.project_id AND own.user_id = ? AND own.status = 'active')`;
    const scopeValues = access.organizationRole === "admin" ? [] : [access.userId];
    const [pendingReviews, activeJobs, failedJobs, upcomingSchedules, reviews, jobs, projects, published] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS value FROM content_reviews r INNER JOIN content_items c ON c.id = r.content_item_id WHERE c.organization_id = ? AND r.decision = 'pending'${memberScope("c")}`).bind(organizationId, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM analysis_jobs j WHERE j.organization_id = ? AND j.status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')${memberScope("j")}`).bind(organizationId, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM analysis_jobs j WHERE j.organization_id = ? AND j.status = 'failed'${memberScope("j")}`).bind(organizationId, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_schedules s WHERE s.organization_id = ? AND s.status IN ('planned','ready') AND s.scheduled_at >= ? AND s.scheduled_at <= ?${memberScope("s")}`).bind(organizationId, now.toISOString(), weekEnd, ...scopeValues).first<{ value: number }>(),
      db.prepare(`SELECT r.id, r.review_stage, r.requested_at, c.id AS content_id, c.title, c.due_at, p.name AS project_name
        FROM content_reviews r INNER JOIN content_items c ON c.id = r.content_item_id INNER JOIN projects p ON p.id = c.project_id
        WHERE r.organization_id = ? AND r.decision = 'pending'${memberScope("c")} ORDER BY COALESCE(c.due_at, r.requested_at) ASC LIMIT 8`).bind(organizationId, ...scopeValues).all(),
      db.prepare(`SELECT j.id, j.status, j.progress, j.current_stage, j.updated_at, v.title, p.name AS project_name
        FROM analysis_jobs j LEFT JOIN videos v ON v.id = j.video_id INNER JOIN projects p ON p.id = j.project_id
        WHERE j.organization_id = ?${memberScope("j")} ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'analyzing' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, j.updated_at DESC LIMIT 8`).bind(organizationId, ...scopeValues).all(),
      db.prepare(`SELECT p.id, p.name, p.content_target, p.status FROM projects p WHERE p.organization_id = ? AND p.deleted_at IS NULL AND p.status != 'archived'${memberScope("p")}`).bind(organizationId, ...scopeValues).all<{ id: string; name: string; content_target: number; status: string }>(),
      db.prepare(`SELECT COUNT(*) AS value FROM content_items c WHERE c.organization_id = ? AND c.status = 'published' AND c.updated_at >= ?${memberScope("c")}`).bind(organizationId, monthStart, ...scopeValues).first<{ value: number }>(),
    ]);
    return Response.json({
      summary: { pendingReviews: pendingReviews?.value ?? 0, publishedMonth: published?.value ?? 0, activeJobs: activeJobs?.value ?? 0, failedJobs: failedJobs?.value ?? 0, upcomingSchedules: upcomingSchedules?.value ?? 0, monthlyContentTarget: projects.results.reduce((sum, project) => sum + (project.content_target || 0), 0) },
      reviews: reviews.results, jobs: jobs.results, projects: projects.results,
    });
  } catch (error) { return errorResponse(error); }
}
