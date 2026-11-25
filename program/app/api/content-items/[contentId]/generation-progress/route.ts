import { z } from "zod";
import { getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readContentGenerationProgress } from "../../../../../lib/content-generation-progress";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const query = z.object({
  organizationId: z.string().trim().min(1).max(100),
  projectId: z.string().trim().min(1).max(100),
  expectedVersion: z.coerce.number().int().positive().safe(),
  generationRequestId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  try {
    const params = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!params.success) return apiError("INVALID_GENERATION_PROGRESS_QUERY", "请指定空间和稿件版本。", 400);
    const { organizationId, projectId } = params.data;
    if (!await getProjectAccess(identity.authSubject, organizationId, projectId))
      return apiError("ACCESS_DENIED", "无权查看这个空间的生成进度。", 403);
    const { contentId } = await context.params;
    const progress = await readContentGenerationProgress(getD1(), { ...params.data, contentId });
    return Response.json({ progress }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
