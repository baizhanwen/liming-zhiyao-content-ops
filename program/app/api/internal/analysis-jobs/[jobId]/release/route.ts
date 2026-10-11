import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

// Called only after the owner has stopped its processing tree. An attempt
// number fences late acknowledgements from earlier executions by this worker.
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const { workerId: rawWorkerId, attempt } = await request.json() as { workerId?: unknown; attempt?: unknown };
    const workerId = normalizeWorkerId(rawWorkerId);
    if (!workerId || !Number.isSafeInteger(attempt) || Number(attempt) < 1) return apiError("INVALID_EXECUTION", "执行标识无效。", 400);
    const { jobId } = await context.params;
    await getD1().prepare(`UPDATE analysis_jobs SET lease_owner = NULL, lease_expires_at = NULL, current_stage = '任务已取消'
      WHERE id = ? AND status = 'cancelled' AND lease_owner = ? AND attempt_count = ?`)
      .bind(jobId, workerId, attempt).run();
    return Response.json({ released: true });
  } catch (error) { return errorResponse(error); }
}
