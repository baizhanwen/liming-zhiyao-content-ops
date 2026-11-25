import { z } from "zod";
import { getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readBoundedJson, RequestBodyError } from "../../../lib/bounded-request-body";
import { OrganizationSettingsError } from "../../../lib/organization-settings-credential";
import { readRequestIdentity } from "../../../lib/request-auth";
import { readTikHubSettings, saveTikHubSettings } from "../../../lib/tikhub-settings";

const organization = z.string().trim().min(1).max(200);
const update = z.object({
  organizationId: organization,
  version: z.number().int().nonnegative(),
  apiKey: z.string().max(16_000).optional(),
  clearApiKey: z.boolean().optional(),
}).strict();
const privateHeaders = { "cache-control": "no-store" };

function settingsError(error: unknown) {
  if (error instanceof OrganizationSettingsError || error instanceof RequestBodyError) {
    return apiError(error.code, error.message, error.status);
  }
  return errorResponse(error);
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const id = organization.safeParse(new URL(request.url).searchParams.get("organizationId"));
  if (!id.success) return apiError("ORGANIZATION_REQUIRED", "请选择公司。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, id.data);
    if (access?.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "仅公司管理员可查看 TikHub 配置。", 403);
    return Response.json({ ...await readTikHubSettings(id.data), canManage: true }, { headers: privateHeaders });
  } catch (error) { return settingsError(error); }
}

export async function PUT(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return apiError("INVALID_ORIGIN", "请从当前设置页保存配置。", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return apiError("INVALID_CONTENT_TYPE", "配置请求须使用 JSON。", 415);
  }
  try {
    const parsed = update.safeParse(await readBoundedJson(request, 20 * 1024, "配置内容过大，请检查 API Key。"));
    if (!parsed.success) return apiError("INVALID_TIKHUB_SETTINGS", "TikHub 配置格式无效。", 400);
    const { organizationId, version, apiKey, clearApiKey } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (access?.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "仅公司管理员可修改 TikHub 配置。", 403);
    const saved = await saveTikHubSettings(organizationId, access.userId, { apiKey, clearApiKey }, version);
    return Response.json({ ...saved, canManage: true }, { headers: privateHeaders });
  } catch (error) { return settingsError(error); }
}
