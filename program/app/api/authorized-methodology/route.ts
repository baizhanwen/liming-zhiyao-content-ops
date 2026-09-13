import { getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import {
  AUTHORIZED_METHODOLOGY_FILTERS,
  buildAuthorizedMethodologyCatalog,
  type AuthorizedMethodologyCatalogQuery,
} from "../../../lib/authorized-methodology-catalog";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

function enumParameter<T extends string>(url: URL, name: string, allowed: readonly T[]) {
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!value) return { value: undefined } as const;
  if (!allowed.includes(value as T)) return { error: apiError("INVALID_METHODOLOGY_FILTER", `${name} 筛选值无效。`, 400) } as const;
  return { value: value as T } as const;
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看授权方法论。", 401);

  try {
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId")?.trim() || "";
    const projectId = url.searchParams.get("projectId")?.trim() || "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或企业空间范围。", 400);

    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("PROJECT_ACCESS_REQUIRED", "你无权查看当前企业空间的授权方法论。", 403);

    const task = enumParameter(url, "task", AUTHORIZED_METHODOLOGY_FILTERS.tasks);
    const kind = enumParameter(url, "kind", AUTHORIZED_METHODOLOGY_FILTERS.kinds);
    const stage = enumParameter(url, "stage", AUTHORIZED_METHODOLOGY_FILTERS.stages);
    const platform = enumParameter(url, "platform", AUTHORIZED_METHODOLOGY_FILTERS.platforms);
    const mode = enumParameter(url, "mode", AUTHORIZED_METHODOLOGY_FILTERS.modes);
    for (const parameter of [task, kind, stage, platform, mode]) if ("error" in parameter) return parameter.error;

    const query: AuthorizedMethodologyCatalogQuery = {
      task: task.value,
      kind: kind.value,
      stage: stage.value,
      platform: platform.value,
      mode: mode.value,
      q: url.searchParams.get("q")?.trim().slice(0, 500) || "",
    };
    const catalog = buildAuthorizedMethodologyCatalog(query);
    return Response.json(
      { ...catalog, canManage: false, scope: { organizationId, projectId } },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
