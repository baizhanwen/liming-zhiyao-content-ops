import { isLeasedAnalysisStatus, LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";
import { getD1, getMediaBucket, sha256Hex } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";
import { getOrganizationCapacity } from "../../../../../../lib/operations";

export const dynamic = "force-dynamic";

const artifactKinds = new Set(["keyframe", "subtitle", "report", "source_video", "source_audio"]);
const contentTypes: Record<string, Set<string>> = {
  keyframe: new Set(["image/jpeg", "image/png", "image/webp"]),
  subtitle: new Set(["text/vtt", "application/x-subrip", "application/json"]),
  report: new Set(["application/json"]),
  source_video: new Set(["video/mp4", "video/webm", "video/quicktime"]),
  source_audio: new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg"]),
};
const sizeLimits: Record<string, number> = {
  keyframe: 10 * 1024 * 1024,
  subtitle: 2 * 1024 * 1024,
  report: 5 * 1024 * 1024,
  source_video: 100 * 1024 * 1024,
  source_audio: 100 * 1024 * 1024,
};

function safeFilename(value: string) {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    return character.charCodeAt(0) < 32 || "\\/:*?\"<>".includes(character) ? "-" : character;
  }).join("").trim();
  return normalized.slice(0, 160) || "artifact";
}

function integerHeader(request: Request, name: string, minimum: number, maximum: number) {
  const value = request.headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

type ArtifactJob = {
  id: string;
  organization_id: string;
  project_id: string;
  video_id: string;
  status: string;
  lease_owner: string;
  lease_expires_at: string;
  version: number;
};

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request);
  if ("error" in service) return service.error;
  const workerId = normalizeWorkerId(request.headers.get("x-worker-id"));
  const version = integerHeader(request, "x-job-version", 0, Number.MAX_SAFE_INTEGER);
  const kind = request.headers.get("x-artifact-kind")?.trim() ?? "";
  const rawContentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const filename = safeFilename(request.headers.get("x-artifact-filename") ?? "artifact");
  if (!workerId || version === null) return apiError("INVALID_ARTIFACT_OWNER", "Worker 标识或任务版本无效。", 400);
  if (!artifactKinds.has(kind) || !contentTypes[kind]?.has(rawContentType)) return apiError("INVALID_ARTIFACT_TYPE", "分析产物类型无效。", 415);
  const maxBytes = kind === "subtitle" && filename === "manuscript.json" && rawContentType === "application/json"
    ? 16 * 1024 * 1024 : sizeLimits[kind];
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) return apiError("ARTIFACT_TOO_LARGE", "分析产物超过大小限制。", 413);

  let storedKey: string | null = null;
  let writeAttempted = false;
  let submittedResponse: Response | null = null;
  try {
    const { jobId } = await context.params;
    const now = new Date().toISOString();
    const db = getD1();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.lease_owner, j.lease_expires_at, j.version
      FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ? AND j.lease_owner = ? AND j.version = ? AND j.lease_expires_at > ? AND v.deleted_at IS NULL
    `).bind(jobId, workerId, version, now).first<ArtifactJob>();
    if (!job || !isLeasedAnalysisStatus(job.status)) return apiError("ARTIFACT_LEASE_INVALID", "任务租约已失效，分析产物未接收。", 409);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) return apiError("INVALID_ARTIFACT_SIZE", "分析产物大小无效。", 413);
    const sha256 = await sha256Hex(bytes);
    const sourceMedia = kind === "source_video" || kind === "source_audio";
    const storageQuota = sourceMedia ? (await getOrganizationCapacity(job.organization_id, `service:${workerId}`)).storage_quota_bytes : null;
    const timestampMs = integerHeader(request, "x-artifact-timestamp-ms", 0, 86_400_000);
    const confidence = integerHeader(request, "x-artifact-confidence", 0, 100);
    const existing = await db.prepare(`
      SELECT id, kind, filename, content_type, size_bytes, sha256
      FROM media_assets
      WHERE organization_id = ? AND project_id = ? AND video_id = ?
        AND analysis_job_id = ? AND kind = ? AND filename = ? AND sha256 = ? AND status = 'active'
      LIMIT 1
    `).bind(job.organization_id, job.project_id, job.video_id, jobId, kind, filename, sha256).first<Record<string, unknown>>();
    if (existing) {
      return Response.json({
        asset: { id: existing.id, kind: existing.kind, filename: existing.filename, contentType: existing.content_type, sizeBytes: existing.size_bytes, sha256: existing.sha256, timestampMs, confidence },
        reused: true,
      });
    }
    if (sourceMedia) {
      const usage = await db.prepare("SELECT COALESCE(SUM(MAX(size_bytes,0)),0) AS bytes FROM media_assets WHERE organization_id=? AND status='active'").bind(job.organization_id).first<{ bytes: number }>();
      if ((usage?.bytes ?? 0) + bytes.byteLength > (storageQuota ?? 0)) return apiError("SOURCE_STORAGE_QUOTA_EXCEEDED", "媒体空间不足，原片尚未保存。", 413);
    }
    const assetId = crypto.randomUUID();
    storedKey = `organizations/${job.organization_id}/projects/${job.project_id}/videos/${job.video_id}/${kind}/${assetId}-${filename}`;
    const stored = await getMediaBucket().put(storedKey, bytes, {
      httpMetadata: { contentType: rawContentType },
      customMetadata: {
        organizationId: job.organization_id,
        projectId: job.project_id,
        videoId: job.video_id,
        jobId,
        sha256,
        ...(timestampMs === null ? {} : { timestampMs: String(timestampMs) }),
        ...(confidence === null ? {} : { confidence: String(confidence) }),
      },
    });
    if (!stored) throw new Error("MEDIA_OBJECT_NOT_WRITTEN");
    submittedResponse = Response.json({ asset: { id: assetId, kind, filename, contentType: rawContentType, sizeBytes: bytes.byteLength, sha256, timestampMs, confidence } }, { status: 201 });
    writeAttempted = true;
    const statement = db.prepare(`
      INSERT INTO media_assets
        (id, organization_id, project_id, video_id, analysis_job_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?
      WHERE EXISTS(SELECT 1 FROM analysis_jobs j INNER JOIN videos v
        ON v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id
        WHERE j.id=? AND j.lease_owner=? AND j.version=? AND j.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND j.status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND v.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM media_assets WHERE organization_id=? AND project_id=? AND video_id=? AND analysis_job_id=? AND kind=? AND filename=? AND sha256=? AND status='active')
        AND (? IS NULL OR (SELECT COALESCE(SUM(MAX(size_bytes,0)),0) FROM media_assets WHERE organization_id=? AND status='active') + ? <= ?)
    `).bind(assetId, job.organization_id, job.project_id, job.video_id, jobId, kind, storedKey, filename, rawContentType, bytes.byteLength, sha256, `service:${workerId}`, `service:${workerId}`, now, now, jobId, workerId, version, job.organization_id, job.project_id, job.video_id, jobId, kind, filename, sha256, storageQuota, job.organization_id, bytes.byteLength, storageQuota);
    const results = sourceMedia ? await db.batch([statement, db.prepare(`
      UPDATE videos SET media_asset_id=?, updated_by=?, updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND media_asset_id IS NULL
        AND EXISTS(SELECT 1 FROM media_assets WHERE id=? AND organization_id=? AND project_id=? AND video_id=? AND analysis_job_id=? AND status='active')
    `).bind(assetId, `service:${workerId}`, now, job.video_id, job.organization_id, job.project_id, assetId, job.organization_id, job.project_id, job.video_id, jobId)]) : [await statement.run()];
    const result = results[0];
    if (!result.meta.changes) {
      const stillOwned = await db.prepare(`SELECT j.id FROM analysis_jobs j INNER JOIN videos v ON v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id
        WHERE j.id=? AND j.lease_owner=? AND j.version=? AND j.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND j.status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND v.deleted_at IS NULL`).bind(jobId, workerId, version).first();
      const winner = await db.prepare(`SELECT id,kind,filename,content_type,size_bytes,sha256 FROM media_assets WHERE organization_id=? AND project_id=? AND video_id=? AND analysis_job_id=? AND kind=? AND filename=? AND sha256=? AND status='active' LIMIT 1`).bind(job.organization_id, job.project_id, job.video_id, jobId, kind, filename, sha256).first<Record<string, unknown>>();
      if (winner && stillOwned) {
        await getMediaBucket().delete(storedKey);
        storedKey = null;
        return Response.json({ asset: { id: winner.id, kind: winner.kind, filename: winner.filename, contentType: winner.content_type, sizeBytes: winner.size_bytes, sha256: winner.sha256, timestampMs, confidence }, reused: true });
      }
      if (sourceMedia && stillOwned) throw new Error("SOURCE_STORAGE_QUOTA_EXCEEDED");
      throw new Error("ARTIFACT_LEASE_CHANGED");
    }
    storedKey = null;
    return submittedResponse;
  } catch (error) {
    if (storedKey) {
      if (writeAttempted) {
        try {
          const saved = await getD1().prepare("SELECT id FROM media_assets WHERE r2_key=?").bind(storedKey).first();
          if (saved && submittedResponse) return submittedResponse;
        } catch { return apiError("MEDIA_UPLOAD_STATUS_UNKNOWN", "分析附件提交结果暂时无法确认，对象已保留。请核对任务附件后再操作，避免重新运行模型。", 503); }
      }
      try { await getMediaBucket().delete(storedKey); }
      catch { return apiError("MEDIA_UPLOAD_CLEANUP_PENDING", "分析附件未入库，暂存对象清理失败。请联系管理员核对存储后再操作。", 503); }
    }
    if (error instanceof Error && error.message.includes("ARTIFACT_LEASE_CHANGED")) return apiError("ARTIFACT_LEASE_INVALID", "任务租约已失效，分析附件未保存。", 409);
    if (error instanceof Error && error.message.includes("SOURCE_STORAGE_QUOTA_EXCEEDED")) return apiError("SOURCE_STORAGE_QUOTA_EXCEEDED", "媒体空间在提交期间已被占用，原片未保存。", 413);
    return errorResponse(error);
  }
}
