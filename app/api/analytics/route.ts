import { getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { loadPerformanceAnalytics } from "../../../lib/performance-analytics";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问数据复盘。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || ""; const days = Math.min(365, Math.max(7, Number(url.searchParams.get("days") || 30) || 30));
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的数据复盘。", 403);
    const end = new Date(); const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
    const snapshot = await loadPerformanceAnalytics(getD1(), organizationId, projectId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    return Response.json(snapshot);
  } catch (error) { return errorResponse(error); }
}

