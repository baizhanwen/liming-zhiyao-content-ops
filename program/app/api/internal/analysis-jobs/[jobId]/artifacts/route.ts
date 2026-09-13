import { isLeasedAnalysisStatus } from "../../../../../../lib/analysis-jobs";
import { getD1, getMediaBucket, sha256Hex } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

const artifactKinds = new Set(["keyframe", "subtitle", "report"]);
const contentTypes: Record<string, Set<string>> = {
  keyframe: new Set(["image/jpeg", "image/png", "image/webp"]),
  subtitle: new Set(["text/vtt", "application/x-subrip", "application/json"]),
  report: new Set(["application/json"]),
};
const sizeLimits: Record<string, number> = {
  keyframe: 10 * 1024 * 1024,
  subtitle: 2 * 1024 * 1024,
  report: 5 * 1024 * 1024,
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
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > sizeLimits[kind]) return apiError("ARTIFACT_TOO_LARGE", "分析产物超过大小限制。", 413);

  let storedKey: string | null = null;
  try {
    const { jobId } = await context.params;
    const now = new Date().toISOString();
    const db = getD1();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.lease_owner, j.lease_expires_at, j.version
      FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ? AND j.lease_owner = ? AND j.version = ? AND j.lease_expires_at > ?
    `).bind(jobId, workerId, version, now).first<ArtifactJob>();
    if (!job || !isLeasedAnalysisStatus(job.status)) return apiError("ARTIFACT_LEASE_INVALID", "任务租约已失效，分析产物未接收。", 409);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength <= 0 || bytes.byteLength > sizeLimits[kind]) return apiError("INVALID_ARTIFACT_SIZE", "分析产物大小无效。", 413);
    const sha256 = await sha256Hex(bytes);
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
    const assetId = crypto.randomUUID();
    storedKey = `organizations/${job.organization_id}/projects/${job.project_id}/videos/${job.video_id}/${kind}/${assetId}-${filename}`;
    await getMediaBucket().put(storedKey, bytes, {
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
    await db.prepare(`
      INSERT INTO media_assets
        (id, organization_id, project_id, video_id, analysis_job_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).bind(assetId, job.organization_id, job.project_id, job.video_id, jobId, kind, storedKey, filename, rawContentType, bytes.byteLength, sha256, `service:${workerId}`, `service:${workerId}`, now, now).run();
    storedKey = null;
    return Response.json({ asset: { id: assetId, kind, filename, contentType: rawContentType, sizeBytes: bytes.byteLength, sha256, timestampMs, confidence } }, { status: 201 });
  } catch (error) {
    if (storedKey) {
      try { await getMediaBucket().delete(storedKey); } catch { /* best-effort rollback */ }
    }
    return errorResponse(error);
  }
}
