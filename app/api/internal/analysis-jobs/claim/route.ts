import { getD1 } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { normalizeLeaseSeconds, normalizeWorkerId, requireAnalyzerService } from "../../../../../lib/service-auth";
import type { WorkerJobRow } from "../../../../../lib/analysis-worker";

type ClaimedJob = WorkerJobRow & { source_type: "url" | "upload"; source_ref: string };
type JobSource = { source_url: string | null; media_asset_id: string | null; r2_key: string | null; content_type: string | null; filename: string | null; size_bytes: number | null; sha256: string | null };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = await request.json() as { workerId?: unknown; leaseSeconds?: unknown };
    const workerId = normalizeWorkerId(payload.workerId); if (!workerId) return apiError("INVALID_WORKER_ID", "workerId 格式无效。", 400);
    const leaseSeconds = normalizeLeaseSeconds(payload.leaseSeconds); const now = new Date(); const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString(); const actor = `service:${workerId}`; const db = getD1();
    const job = await db.prepare(`
      UPDATE analysis_jobs
      SET status = CASE WHEN status = 'pending' THEN 'queued' ELSE status END,
          progress = CASE WHEN status = 'pending' THEN 1 ELSE progress END,
          current_stage = CASE WHEN status = 'pending' THEN '分析服务已领取任务' ELSE current_stage END,
          lease_owner = ?, lease_expires_at = ?, last_heartbeat_at = ?, attempt_count = attempt_count + 1,
          version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = (
        SELECT j.id FROM analysis_jobs j
        INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id AND v.deleted_at IS NULL
        WHERE j.video_id IS NOT NULL AND (
          j.status = 'pending' OR
          (j.status IN ('queued', 'downloading', 'processing', 'transcribing', 'extracting', 'analyzing') AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
        )
        ORDER BY CASE WHEN j.status = 'pending' THEN 0 ELSE 1 END, j.created_at ASC
        LIMIT 1
      )
      RETURNING id, organization_id, project_id, video_id, source_type, source_ref, status, progress, current_stage,
        lease_owner, lease_expires_at, attempt_count, version, result_key
    `).bind(workerId, leaseExpiresAt, nowIso, actor, nowIso, nowIso).first<ClaimedJob>();
    if (!job) return new Response(null, { status: 204 });

    const source = await db.prepare(`
      SELECT v.source_url, v.media_asset_id, m.r2_key, m.content_type, m.filename, m.size_bytes, m.sha256
      FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      LEFT JOIN media_assets m ON m.id = v.media_asset_id AND m.organization_id = j.organization_id AND m.project_id = j.project_id AND m.status = 'active'
      WHERE j.id = ? AND j.lease_owner = ? AND j.version = ?
    `).bind(job.id, workerId, job.version).first<JobSource>();
    if (!source || (job.source_type === "url" ? !source.source_url : !source.r2_key)) {
      await db.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = 'SOURCE_UNAVAILABLE', error_message = '任务来源记录不完整', lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ?").bind(nowIso, job.id, workerId, job.version).run();
      return apiError("JOB_SOURCE_UNAVAILABLE", "任务来源记录不完整。", 409);
    }
    await db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, to_status, progress, worker_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), job.organization_id, job.project_id, job.id, job.video_id, job.status, job.progress, workerId, JSON.stringify({ attempt: job.attempt_count, leaseExpiresAt }), nowIso).run();
    return Response.json({ job: { ...job, source } });
  } catch (error) { return errorResponse(error); }
}
