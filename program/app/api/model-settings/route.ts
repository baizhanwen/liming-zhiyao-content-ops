import { z } from "zod";
import { ensureUser, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { ModelSettingsError, readModelSettings, saveModelSettings } from "../../../lib/model-settings";

const role = z.object({ provider: z.string().trim().max(100), baseUrl: z.string().trim().max(1000), model: z.string().trim().max(200), apiKey: z.string().max(16000).optional(), clearApiKey: z.boolean().optional() }).strict();
const schema = z.object({ organizationId: z.string().uuid(), version: z.number().int().nonnegative().optional(), roles: z.object({ analysisText: role.optional(), contentGeneration: role.optional(), visualUnderstanding: role.optional(), projectAssistant: role.optional() }).strict() }).strict();

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId") || "";
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以管理模型配置。", 403);
    return Response.json({ ...await readModelSettings(organizationId), canManage: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelSettingsError) return apiError(error.code, error.message, error.status);
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return apiError("INVALID_ORIGIN", "请从当前项目页面保存配置。", 403);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_MODEL_SETTINGS", "模型配置格式无效。", 400);
    const { organizationId, roles, version } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以管理模型配置。", 403);
    const user = await ensureUser(identity);
    return Response.json({ ...await saveModelSettings(organizationId, user.id, roles, version), canManage: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelSettingsError) return apiError(error.code, error.message, error.status);
    return errorResponse(error);
  }
}
