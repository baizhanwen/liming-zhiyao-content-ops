import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { createRecordedProjectAssistantInvoker } from "../../../../lib/recorded-project-assistant-model";
import { apiError, errorResponse } from "../../../../lib/api-response";
import {
  probeProjectAssistantModel,
  projectAssistantConfigurationStatus,
  ProjectAssistantConfigurationError,
  ProjectAssistantRequestError,
} from "../../../../lib/project-assistant-model";
import { readProjectAssistantBenchmarkStatusWithDb } from "../../../../lib/project-assistant-benchmarks";
import type { ProjectAssistantDatabase } from "../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { readCoreContentStrategy } from "../../../../lib/content-strategy-policy";
import { createProjectWriteAssertion } from "../../../../lib/project-write-access";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

async function authorize(request: Request, payload?: Record<string, unknown>) {
  const identity = await readRequestIdentity(request);
  if (!identity) return { error: apiError("AUTH_REQUIRED", "请先登录后再查看项目助理状态。", 401) } as const;
  const url = new URL(request.url);
  const organizationId = text(payload?.organizationId ?? url.searchParams.get("organizationId"), 100);
  const projectId = text(payload?.projectId ?? url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId) return { error: apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400) } as const;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
  if (!access) return { error: apiError("ACCESS_DENIED", "无权访问该项目助理。", 403) } as const;
  return { organizationId, projectId, identity, access } as const;
}

export async function GET(request: Request) {
  const current = await authorize(request);
  if ("error" in current) return current.error;
  try {
    const db = getD1() as unknown as ProjectAssistantDatabase;
    const [benchmarks, coreStrategy, memories] = await Promise.all([
      readProjectAssistantBenchmarkStatusWithDb(db, current), readCoreContentStrategy(db, current),
      db.prepare("SELECT COUNT(*) AS count FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND status = 'confirmed' AND (expires_at IS NULL OR expires_at > ?)").bind(current.organizationId, current.projectId, new Date().toISOString()).first<{ count: number }>(),
    ]);
    return Response.json({ configuration: projectAssistantConfigurationStatus(), health: { checked: false }, benchmarks, coreStrategy, memoryStatus: { confirmedCount: Number(memories?.count || 0) } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const current = await authorize(request, payload);
  if ("error" in current) return current.error;
  try {
    if (!canWriteProjectAccess(current.access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能发起收费的模型连接检查。", 403);
    const user = await ensureUser(current.identity);
    const assertWriteAccess = createProjectWriteAssertion(getD1(), { organizationId: current.organizationId, projectId: current.projectId, userId: user.id }, async () => (await readRequestIdentity(request))?.authSubject === current.identity.authSubject);
    const health = await probeProjectAssistantModel(createRecordedProjectAssistantInvoker({ organizationId: current.organizationId, projectId: current.projectId, userId: user.id, taskType: "project_assistant.probe", promptVersion: "project-assistant.probe.v1", assertWriteAccess }));
    await assertWriteAccess();
    return Response.json({ configuration: projectAssistantConfigurationStatus(), health: { checked: true, ...health } });
  } catch (error) {
    if (error instanceof ProjectAssistantConfigurationError) return apiError(error.code, error.message, 503);
    if (error instanceof ProjectAssistantRequestError) return apiError(error.code, error.message, error.code === "MODEL_QUOTA_EXCEEDED" ? 429 : 502);
    return errorResponse(error);
  }
}
