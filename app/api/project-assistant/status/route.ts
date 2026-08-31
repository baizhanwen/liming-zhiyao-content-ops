import { getD1, getProjectAccess } from "../../../../db/runtime";
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
  return { organizationId, projectId } as const;
}

export async function GET(request: Request) {
  const current = await authorize(request);
  if ("error" in current) return current.error;
  try {
    const db = getD1() as unknown as ProjectAssistantDatabase;
    const benchmarks = await readProjectAssistantBenchmarkStatusWithDb(db, current);
    return Response.json({ configuration: projectAssistantConfigurationStatus(), health: { checked: false }, benchmarks });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const current = await authorize(request, payload);
  if ("error" in current) return current.error;
  try {
    const health = await probeProjectAssistantModel();
    return Response.json({ configuration: projectAssistantConfigurationStatus(), health: { checked: true, ...health } });
  } catch (error) {
    if (error instanceof ProjectAssistantConfigurationError) return apiError(error.code, error.message, 503);
    if (error instanceof ProjectAssistantRequestError) return apiError(error.code, error.message, 502);
    return errorResponse(error);
  }
}
