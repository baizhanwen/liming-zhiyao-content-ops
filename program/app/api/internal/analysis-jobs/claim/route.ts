import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../lib/analysis-jobs";
import { getD1 } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { normalizeLeaseSeconds, normalizeWorkerId, requireAnalyzerService } from "../../../../../lib/service-auth";
import { parseAnalyzerBrowserAuth, type WorkerJobRow } from "../../../../../lib/analysis-worker";

type ClaimedJob = WorkerJobRow & { source_type: "url" | "upload"; source_ref: string; input_transcript_id: string | null; analysis_profile: "max" | "economy" | "standard" | "deep"; checkpoint_stage: string | null; checkpoint_json: string | null; checkpoint_updated_at: string | null; resume_count: number };
type JobSource = { source_url: string | null; media_asset_id: string | null; r2_key: string | null; content_type: string | null; filename: string | null; size_bytes: number | null; sha256: string | null; transcript_id: string | null; transcript_version: number | null; transcript_language: string | null; transcript_segments_json: string | null };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = await request.json() as { workerId?: unknown; leaseSeconds?: unknown; browserAuth?: unknown };
    const workerId = normalizeWorkerId(payload.workerId); if (!workerId) return apiError("INVALID_WORKER_ID", "workerId 格式无效。", 400);
    const leaseSeconds = normalizeLeaseSeconds(payload.leaseSeconds); const browserAuth = parseAnalyzerBrowserAuth(payload.browserAuth); const now = new Date(); const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString(); const actor = `service:${workerId}`; const db = getD1();
    await db.prepare(`
      INSERT INTO analyzer_workers (worker_id, status, started_at, last_seen_at, browser_auth_status, browser_auth_browser, browser_auth_checked_at, browser_auth_message, updated_at)
      VALUES (?, 'online', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET status = 'online', last_seen_at = excluded.last_seen_at, last_error = NULL,
        browser_auth_status = excluded.browser_auth_status, browser_auth_browser = excluded.browser_auth_browser,
        browser_auth_checked_at = excluded.browser_auth_checked_at, browser_auth_message = excluded.browser_auth_message, updated_at = excluded.updated_at
    `).bind(workerId, nowIso, nowIso, browserAuth?.status ?? "unknown", browserAuth?.browser ?? null, browserAuth?.checkedAt ?? null, browserAuth?.message ?? null, nowIso).run();
    const job = await db.prepare(`
      UPDATE analysis_jobs
      SET status = 'queued',
          progress = CASE WHEN checkpoint_stage IN ('evidence_ready', 'segment_progress') THEN 82 ELSE 1 END,
          current_stage = CASE WHEN checkpoint_stage IN ('evidence_ready', 'segment_progress') THEN '分析服务已领取恢复任务' ELSE '分析服务已领取任务' END,
          lease_owner = ?, lease_expires_at = ?, last_heartbeat_at = ?, attempt_count = attempt_count + 1,
          resume_count = resume_count + CASE WHEN checkpoint_stage IN ('evidence_ready', 'segment_progress') THEN 1 ELSE 0 END,
          version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = (
        SELECT j.id FROM analysis_jobs j
        INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id AND v.deleted_at IS NULL
        WHERE j.video_id IS NOT NULL AND (
          j.status = 'pending' OR
          (j.status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
        )
        ORDER BY CASE WHEN j.status = 'pending' THEN 0 ELSE 1 END, j.created_at ASC, j.id ASC
        LIMIT 1
      )
      RETURNING id, organization_id, project_id, video_id, input_transcript_id, source_type, source_ref, analysis_profile, status, progress, current_stage,
        lease_owner, lease_expires_at, attempt_count, version, result_key, checkpoint_stage, checkpoint_json, checkpoint_updated_at, resume_count
    `).bind(workerId, leaseExpiresAt, nowIso, actor, nowIso, nowIso).first<ClaimedJob>();
    if (!job) return new Response(null, { status: 204 });

    const source = await db.prepare(`
      SELECT v.source_url, v.media_asset_id, m.r2_key, m.content_type, m.filename, m.size_bytes, m.sha256,
        t.id AS transcript_id, t.version AS transcript_version, t.language AS transcript_language, t.segments_json AS transcript_segments_json
      FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      LEFT JOIN media_assets m ON m.id = v.media_asset_id AND m.organization_id = j.organization_id AND m.project_id = j.project_id AND m.status = 'active'
      LEFT JOIN video_transcripts t ON t.id = j.input_transcript_id AND t.organization_id = j.organization_id AND t.project_id = j.project_id AND t.video_id = j.video_id
      WHERE j.id = ? AND j.lease_owner = ? AND j.version = ?
    `).bind(job.id, workerId, job.version).first<JobSource>();
    if (!source || (job.source_type === "url" ? !source.source_url : !source.r2_key)) {
      await db.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = 'SOURCE_UNAVAILABLE', error_message = '任务来源记录不完整', lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ?").bind(nowIso, job.id, workerId, job.version).run();
      return apiError("JOB_SOURCE_UNAVAILABLE", "任务来源记录不完整。", 409);
    }
    if (job.input_transcript_id && (!source.transcript_id || !source.transcript_segments_json || !source.transcript_language)) {
      await db.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = 'TRANSCRIPT_UNAVAILABLE', error_message = '人工校正版不存在或范围不匹配', lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ?").bind(nowIso, job.id, workerId, job.version).run();
      return apiError("JOB_TRANSCRIPT_UNAVAILABLE", "人工校正版不存在或范围不匹配。", 409);
    }
    await db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, to_status, progress, worker_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), job.organization_id, job.project_id, job.id, job.video_id, job.status, job.progress, workerId, JSON.stringify({ attempt: job.attempt_count, leaseExpiresAt, checkpointStage: job.checkpoint_stage, resumeCount: job.resume_count }), nowIso).run();
    let manualTranscript: { id: string; version: number; language: string; segments: unknown[] } | null = null;
    if (source.transcript_id && source.transcript_language && source.transcript_segments_json) {
      try {
        const segments = JSON.parse(source.transcript_segments_json) as unknown;
        if (!Array.isArray(segments)) throw new Error("segments must be an array");
        manualTranscript = { id: source.transcript_id, version: source.transcript_version ?? 1, language: source.transcript_language, segments };
      } catch {
        await db.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = 'TRANSCRIPT_INVALID', error_message = '人工校正版内容损坏', lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ?").bind(nowIso, job.id, workerId, job.version).run();
        return apiError("JOB_TRANSCRIPT_INVALID", "人工校正版内容损坏，无法重新分析。", 409);
      }
    }
    const safeSource = {
      source_url: source.source_url,
      media_asset_id: source.media_asset_id,
      r2_key: source.r2_key,
      content_type: source.content_type,
      filename: source.filename,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
    };
    let checkpoint: Record<string, unknown> | null = null;
    if ((job.checkpoint_stage === "evidence_ready" || job.checkpoint_stage === "segment_progress") && job.checkpoint_json) {
      try {
        const parsed = JSON.parse(job.checkpoint_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) checkpoint = parsed as Record<string, unknown>;
      } catch { checkpoint = null; }
    }
    const safeJob: Partial<typeof job> = { ...job };
    delete safeJob.checkpoint_json;
    return Response.json({ job: { ...safeJob, checkpoint, source: { ...safeSource, manual_transcript: manualTranscript } } });
  } catch (error) { return errorResponse(error); }
}
