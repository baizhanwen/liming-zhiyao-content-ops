export const MAX_PLATFORM_COMMENTS = 10;
export const MAX_PLATFORM_COMMENT_LENGTH = 8192;

export type PlatformComment = {
  comment_id: string;
  text: string;
  like_count: number | null;
  reply_count: number | null;
  published_at: string | null;
  has_image: boolean;
};

export type PlatformCommentSample = { collected_at: string; comments: PlatformComment[] };
export type PlatformComments = {
  status: "not_collected" | "available" | "failed";
  collected_at: string | null;
  error: string | null;
  comments: PlatformComment[];
};

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown) {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function isPlatformCommentSample(value: unknown): value is PlatformCommentSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  if (!validTime(sample.collected_at) || !Array.isArray(sample.comments) || sample.comments.length > MAX_PLATFORM_COMMENTS) return false;
  const ids = new Set<string>();
  for (const row of sample.comments) {
    if (!row || typeof row !== "object" || Object.keys(row).length !== 6
      || typeof row.comment_id !== "string" || !/^[1-9]\d{0,24}$/.test(row.comment_id) || ids.has(row.comment_id)
      || typeof row.text !== "string" || row.text.length > MAX_PLATFORM_COMMENT_LENGTH
      || !validCount(row.like_count) || !validCount(row.reply_count)
      || (row.published_at !== null && !validTime(row.published_at)) || typeof row.has_image !== "boolean") return false;
    ids.add(row.comment_id);
  }
  return true;
}

export function platformCommentBindings(outcome: PlatformCommentSample | { error: string }): [string | null, string | null, string | null] {
  if ("error" in outcome) return [null, null, outcome.error];
  return [JSON.stringify(outcome.comments), outcome.collected_at, null];
}

export function storedPlatformCommentSample(json: unknown, collectedAt: unknown): PlatformCommentSample | null {
  if (json == null && collectedAt == null) return null;
  const sample: unknown = { collected_at: collectedAt, comments: JSON.parse(String(json)) };
  if (!isPlatformCommentSample(sample)) throw new Error("Invalid stored platform comment sample");
  return sample;
}

export async function readVideoPlatformComments(db: D1Database, organizationId: string, projectId: string, videoId: string): Promise<PlatformComments> {
  const row = await db.prepare(`SELECT platform_comments_json, platform_comments_collected_at, platform_comments_error
    FROM videos WHERE organization_id=? AND project_id=? AND id=? AND deleted_at IS NULL`)
    .bind(organizationId, projectId, videoId)
    .first<{ platform_comments_json: string | null; platform_comments_collected_at: string | null; platform_comments_error: string | null }>();
  const error = row?.platform_comments_error ?? null;
  try {
    const sample = storedPlatformCommentSample(row?.platform_comments_json, row?.platform_comments_collected_at);
    return { status: error ? "failed" : sample ? "available" : "not_collected", error,
      collected_at: sample?.collected_at ?? null, comments: sample?.comments ?? [] };
  } catch {
    return { status: "failed", error: "已保存的评论样本无法读取，请重新采集。", collected_at: null, comments: [] };
  }
}
