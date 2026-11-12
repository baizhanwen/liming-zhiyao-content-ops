import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

const tasks = new Set(["canonical_transcript", "canonical_review", "canonical_repair", "vision_batch", "report", "report_continuation", "corrected_original", "light_rewrite", "restructure_plan", "restructure_section", "insight_evidence",
  "content_classification:text_topic_structure_audience", "content_classification:text_expression_value",
  "content_classification:visual", "content_classification:synthesis"]);
const counter = (value: unknown) => value === null || value === undefined ? null : Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000 ? Number(value) : undefined;

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const workerId = normalizeWorkerId(payload.workerId);
    const { id, task, status, attempt, outputBudget } = payload;
    // Only the MCP vision runner lacks an exposed output cap. Its internal 0
    // sentinel means unknown, never a measured zero; report diagnostics use null.
    const input = counter(payload.inputTokens), output = counter(payload.outputTokens), total = counter(payload.totalTokens);
    if (!workerId || typeof id !== "string" || !/^[a-zA-Z0-9:-]{16,100}$/.test(id) || typeof task !== "string" || !tasks.has(task)
      || !["started", "completed", "failed"].includes(String(status)) || !Number.isSafeInteger(attempt) || Number(attempt) < 1
      || !Number.isSafeInteger(outputBudget) || Number(outputBudget) < (task === "vision_batch" ? 0 : 1) || Number(outputBudget) > 1_000_000
      || input === undefined || output === undefined || total === undefined) return apiError("INVALID_MODEL_CALL", "模型调用记录格式无效。", 400);
    const { jobId } = await context.params, db = getD1(), now = new Date().toISOString();
    // The ownership condition is part of the write, preventing a cancelled or
    // replaced attempt from starting another externally billable operation.
    const ownership = `SELECT 1 FROM analysis_jobs WHERE id = ? AND lease_owner = ? AND attempt_count = ?
      AND status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND lease_expires_at > ?`;
    const changed = status === "started"
      ? await db.prepare(`INSERT INTO analysis_model_calls (id, job_id, attempt, task, status, output_budget, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'started', ?, ?, ? WHERE EXISTS (${ownership})
          ON CONFLICT(id) DO NOTHING`).bind(id, jobId, attempt, task, outputBudget, now, now, jobId, workerId, attempt, now).run()
      : await db.prepare(`UPDATE analysis_model_calls SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, updated_at = ?
          WHERE id = ? AND job_id = ? AND attempt = ? AND task = ? AND status = 'started' AND EXISTS (${ownership})`)
          .bind(status, input, output, total, now, id, jobId, attempt, task, jobId, workerId, attempt, now).run();
    if (!changed.meta.changes) {
      const owned = await db.prepare(ownership).bind(jobId, workerId, attempt, now).first();
      const existing = owned && await db.prepare("SELECT status FROM analysis_model_calls WHERE id = ? AND job_id = ? AND attempt = ? AND task = ?").bind(id, jobId, attempt, task).first<{ status: string }>();
      if (!existing || existing.status !== status) return apiError("MODEL_CALL_REVOKED", "调用记录已变化或任务已失去执行权。", 409);
    }
    const summary = await db.prepare(`SELECT COUNT(*) AS requests, SUM(CASE WHEN status = 'started' THEN 1 ELSE 0 END) AS unfinished_requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
      SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage_requests,
      COALESCE(SUM(total_tokens),0) AS known_total_tokens FROM analysis_model_calls WHERE job_id = ?`).bind(jobId).first();
    return Response.json({ summary });
  } catch (error) { return errorResponse(error); }
}
