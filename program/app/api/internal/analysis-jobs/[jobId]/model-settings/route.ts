import { getD1 } from "../../../../../../db/runtime";
import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { readEffectiveModelRuntime } from "../../../../../../lib/model-settings";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request);
  if ("error" in service) return service.error;
  try {
    const body = await request.json() as { workerId?: unknown; version?: unknown };
    const workerId = normalizeWorkerId(body.workerId);
    if (!workerId || !Number.isInteger(body.version)) return apiError("INVALID_WORKER_REQUEST", "分析任务凭据无效。", 400);
    const { jobId } = await context.params;
    const job = await getD1().prepare(`SELECT organization_id FROM analysis_jobs WHERE id = ? AND lease_owner = ? AND version = ? AND lease_expires_at > ? AND status IN (${LEASED_ANALYSIS_STATUSES_SQL})`)
      .bind(jobId, workerId, body.version, new Date().toISOString()).first<{ organization_id: string }>();
    if (!job) return apiError("MODEL_CONFIG_LEASE_REQUIRED", "任务租约不存在或已失效。", 409);
    const runtime = await readEffectiveModelRuntime(job.organization_id);
    return Response.json({ configuration: {
      llm_provider: runtime.ANALYZER_LLM_PROVIDER || "", llm_base_url: runtime.ANALYZER_LLM_BASE_URL || "",
      llm_model: runtime.ANALYZER_LLM_MODEL || "", llm_api_key: runtime.ANALYZER_LLM_API_KEY || "",
      vision_provider: runtime.ANALYZER_VISION_PROVIDER || "", vision_base_url: runtime.ANALYZER_VISION_BASE_URL || "",
      vision_model: runtime.ANALYZER_VISION_MODEL || "", vision_api_key: runtime.ANALYZER_VISION_API_KEY || "",
    } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
