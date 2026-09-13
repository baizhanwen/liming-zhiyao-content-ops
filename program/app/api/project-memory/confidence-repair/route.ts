import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import {
  readProjectMemoryConfidenceRepairCandidatesWithDb,
  requeueProjectMemoryConfidenceRepairCandidatesWithDb,
  type ProjectAssistantDatabase,
} from "../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再检查项目记忆修复。", 401);
  const url = new URL(request.url);
  const organizationId = text(url.searchParams.get("organizationId"), 100);
  const projectId = text(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目记忆。", 403);
    const repair = await readProjectMemoryConfidenceRepairCandidatesWithDb(
      getD1() as unknown as ProjectAssistantDatabase,
      { organizationId, projectId },
    );
    return Response.json({ repair, canWrite: canWriteProjectAccess(access) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再修复项目记忆。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能修复项目记忆。", 403);
    const user = await ensureUser(identity);
    const repair = await requeueProjectMemoryConfidenceRepairCandidatesWithDb(
      getD1() as unknown as ProjectAssistantDatabase,
      { organizationId, projectId, userId: user.id },
    );
    return Response.json({ repair, idempotent: true });
  } catch (error) {
    return errorResponse(error);
  }
}
