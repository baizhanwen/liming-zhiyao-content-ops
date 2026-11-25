import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../db/runtime";
import { loadAnalyzedAccounts } from "../../../../lib/analyzed-accounts";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看已分析账号。", 401);
  const params = new URL(request.url).searchParams;
  const organizationId = params.get("organizationId")?.trim();
  const projectId = params.get("projectId")?.trim();
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或企业空间。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权查看这个空间的已分析账号。", 403);
    return Response.json(await loadAnalyzedAccounts(getD1(), organizationId, projectId, canWriteProjectAccess(access)));
  } catch (error) { return errorResponse(error); }
}
