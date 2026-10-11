import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { projectAssistantConfigurationStatus } from "../../../../lib/project-assistant-model";
import {
  readProjectMemoryEventSummaryWithDb,
  syncProjectMemoryEventsWithDb,
} from "../../../../lib/project-memory-event-processor";
import type { ProjectAssistantDatabase } from "../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { backfillProjectBenchmarkKnowledgeAtoms } from "../../../../lib/video-knowledge-atoms";
import { createProjectWriteAssertion } from "../../../../lib/project-write-access";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再同步项目记忆。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能同步项目记忆。", 403);
    const configuration = projectAssistantConfigurationStatus();
    if (!configuration.configured) {
      return apiError(
        "PROJECT_ASSISTANT_NOT_CONFIGURED",
        "独立项目助理 API 尚未配置，待处理事件会安全保留，不会借用其他模型。",
        503,
        { missing: configuration.missing },
      );
    }
    const user = await ensureUser(identity);
    const assertWriteAccess = createProjectWriteAssertion(getD1(), { organizationId, projectId, userId: user.id }, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    await assertWriteAccess();
    const atomBackfill = await backfillProjectBenchmarkKnowledgeAtoms({ organizationId, projectId });
    const db = getD1() as unknown as ProjectAssistantDatabase;
    const results = await syncProjectMemoryEventsWithDb(db, {
      organizationId,
      projectId,
      userId: user.id,
      assertWriteAccess,
      limit: typeof payload.limit === "number" ? payload.limit : 3,
    });
    await assertWriteAccess();
    const events = await readProjectMemoryEventSummaryWithDb(db, { organizationId, projectId });
    return Response.json({ results, events, configuration, atomBackfill });
  } catch (error) {
    return errorResponse(error);
  }
}
