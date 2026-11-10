import { z } from "zod";
import { getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { AnalyzerEnvironmentError, isLocalEnvironmentRequest, requestAnalyzerEnvironment } from "../../../lib/analyzer-environment";
import { readRequestIdentity } from "../../../lib/request-auth";

const scopeSchema = z.string().uuid();
const actionSchema = z.object({ organizationId: scopeSchema, action: z.enum(["setup", "start", "stop", "check"]) }).strict();

async function authorize(request: Request, organizationId: string) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再管理分析环境。", 401);
  const access = await getOrganizationAccess(identity.authSubject, organizationId);
  if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以管理分析环境。", 403);
  if (!isLocalEnvironmentRequest(request)) return apiError("LOCAL_ONLY", "请在分析主机本机打开项目后配置运行环境。", 403);
  return null;
}

export async function GET(request: Request) {
  try {
    const scope = scopeSchema.safeParse(new URL(request.url).searchParams.get("organizationId"));
    if (!scope.success) return apiError("INVALID_SCOPE", "缺少有效的公司范围。", 400);
    const denied = await authorize(request, scope.data);
    if (denied) return denied;
    return Response.json(await requestAnalyzerEnvironment(), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) return apiError("ORIGIN_REQUIRED", "请从本项目设置页面发起环境操作。", 403);
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("INVALID_ACTION", "环境操作或公司范围无效。", 400);
    const denied = await authorize(request, parsed.data.organizationId);
    if (denied) return denied;
    return Response.json(await requestAnalyzerEnvironment(parsed.data.action), { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AnalyzerEnvironmentError) return apiError(error.code, error.message, error.status);
    return errorResponse(error);
  }
}
