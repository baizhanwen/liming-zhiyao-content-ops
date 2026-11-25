import { fetchTikHubCover, fetchTikHubMetadata, fetchTikHubWebComments, TikHubError } from "./tikhub-metadata.ts";
import { platformCommentBindings } from "./video-platform-comments.ts";
import { projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access.ts";

type Scope = ProjectWriteScope & { videoId: string };
type Bindings = { db: D1Database; bucket: R2Bucket; apiKey: string };
type Source = { platform_work_id: string | null; source_url: string; platform: string; source_type: string };
type StoredCover = { id: string; r2_key: string; sha256: string };
type RefreshReply = { status: "available" | "partial" | "failed" | "refreshing"; message: string; httpStatus: number };
const owned = "id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL";
// Both metadata refresh and author backfill reserve the same work. Old leases predate the dedicated clock.
export const metadataLockAvailable = "(metadata_request_id IS NULL OR COALESCE(metadata_lock_acquired_at,metadata_attempted_at,'') < ?)";
export function staleMetadataLockBefore() { return new Date(Date.now() - 120_000).toISOString(); }
const locked = `EXISTS(SELECT 1 FROM videos WHERE ${owned} AND metadata_request_id=? AND (platform_work_id IS NULL OR platform_work_id=?))`;
const coverFilter = "organization_id=? AND project_id=? AND video_id=? AND kind='platform_cover' AND status='active'";

async function collectComments(apiKey: string, platformWorkId: string) {
  try {
    const sample = await fetchTikHubWebComments({ apiKey, platformWorkId });
    return { comments: sample.comments, collected_at: sample.collectedAt };
  } catch (error) {
    return { error: error instanceof TikHubError ? error.message : "暂时无法获取抖音 Web 评论。" };
  }
}

async function keepOriginalCover(bindings: Bindings, scope: Scope, lock: string, workId: string, urls: string[]) {
  const { db, bucket } = bindings;
  const { organizationId, projectId, videoId, userId } = scope;
  const previous = await db.prepare(`SELECT id,r2_key,sha256 FROM media_assets WHERE ${coverFilter}`)
    .bind(organizationId, projectId, videoId).first<StoredCover>();
  const image = await fetchTikHubCover(urls);
  if (!image) return false;
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes));
  const digest = Array.from(sha, byte => byte.toString(16).padStart(2, "0")).join("");
  if (previous?.sha256 === digest && await bucket.head(previous.r2_key)) return true;

  const now = new Date().toISOString();
  const key = `organizations/${organizationId}/projects/${projectId}/videos/${videoId}/covers/${lock}.${image.extension}`;
  if (!await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } })) return false;
  try {
    const result = previous
      ? await db.prepare(`UPDATE media_assets SET r2_key=?,filename=?,content_type=?,size_bytes=?,sha256=?,updated_by=?,updated_at=?
            WHERE id=? AND ${coverFilter} AND ${locked} AND ${projectWriteAccessCondition}`)
          .bind(key, `cover.${image.extension}`, image.contentType, image.bytes.byteLength, digest, userId, now, previous.id,
            organizationId, projectId, videoId, videoId, organizationId, projectId, lock, workId, ...projectWriteAccessBindings(scope)).run()
      : await db.prepare(`INSERT INTO media_assets (id,organization_id,project_id,video_id,kind,r2_key,filename,content_type,size_bytes,sha256,status,created_by,updated_by,created_at,updated_at)
           SELECT ?,?,?,?,'platform_cover',?,?,?,?,?,'active',?,?,?,? WHERE ${locked} AND ${projectWriteAccessCondition}`)
          .bind(crypto.randomUUID(), organizationId, projectId, videoId, key, `cover.${image.extension}`, image.contentType,
            image.bytes.byteLength, digest, userId, userId, now, now, videoId, organizationId, projectId, lock, workId, ...projectWriteAccessBindings(scope)).run();
    if (!result.meta.changes) { await bucket.delete(key); return false; }
  } catch (error) {
    // D1 may have committed before a transport error. Keep any object referenced by a row.
    if (!await db.prepare("SELECT id FROM media_assets WHERE r2_key=?").bind(key).first()) await bucket.delete(key);
    throw error;
  }
  if (previous) await bucket.delete(previous.r2_key).catch(() => undefined);
  return true;
}

export async function refreshVideoMetadata(bindings: Bindings, scope: Scope): Promise<RefreshReply> {
  const { db, apiKey } = bindings;
  const { organizationId, projectId, videoId, userId } = scope;
  const ids = [videoId, organizationId, projectId];
  const video = await db.prepare(`SELECT platform_work_id,source_url,platform,source_type FROM videos WHERE ${owned}`).bind(...ids).first<Source>();
  if (!video) return { status: "failed", message: "当前空间找不到这条视频。", httpStatus: 404 };
  if (video.platform !== "douyin" || video.source_type !== "url" || !video.source_url) {
    return { status: "failed", message: "只有已关联抖音作品链接的视频可以刷新平台资料。", httpStatus: 422 };
  }
  if (!apiKey) return { status: "failed", message: "请在系统设置中配置 TikHub 抖音数据采集密钥。", httpStatus: 503 };

  const lock = crypto.randomUUID();
  const attemptedAt = new Date().toISOString();
  const lease = await db.prepare(`UPDATE videos SET metadata_request_id=?,metadata_lock_acquired_at=?,metadata_status='refreshing',metadata_message=NULL,metadata_attempted_at=?
    WHERE ${owned} AND ${metadataLockAvailable} AND ${projectWriteAccessCondition}`)
    .bind(lock, attemptedAt, attemptedAt, ...ids, staleMetadataLockBefore(), ...projectWriteAccessBindings(scope)).run();
  if (!lease.meta.changes) return { status: "refreshing", message: "请刷新页面确认采集状态和当前项目权限。", httpStatus: 409 };
  let failure = "TikHub 作品资料暂未获取，请稍后重试。";
  try {
    const detail = await fetchTikHubMetadata({ apiKey, sourceUrl: video.source_url, platformWorkId: video.platform_work_id });
    if (!detail.platformWorkId || (video.platform_work_id && video.platform_work_id !== detail.platformWorkId)) {
      throw new TikHubError("workMismatch");
    }
    const guardArgs = [...ids, lock, detail.platformWorkId];
    const saved = await db.prepare(`SELECT platform_author_sec_uid,platform_author_uid FROM videos WHERE ${owned}
        AND metadata_request_id=? AND (platform_work_id IS NULL OR platform_work_id=?) AND ${projectWriteAccessCondition}`)
      .bind(...guardArgs, ...projectWriteAccessBindings(scope)).first<{ platform_author_sec_uid: string | null; platform_author_uid: string | null }>();
    if (!saved) {
      failure = "作品绑定或项目权限已经变化，请刷新。";
      throw new Error("METADATA_WRITE_CONFLICT");
    }
    if ((saved.platform_author_sec_uid && detail.authorSecUid && saved.platform_author_sec_uid !== detail.authorSecUid)
        || (saved.platform_author_uid && detail.authorUid && saved.platform_author_uid !== detail.authorUid)) {
      failure = "该作品返回的作者标识与已保存记录不一致，请核对作品链接。";
      throw new Error("METADATA_AUTHOR_CONFLICT");
    }
    const [cover, comments] = await Promise.all([
      keepOriginalCover(bindings, scope, lock, detail.platformWorkId, detail.coverUrls).catch(() => false),
      collectComments(apiKey, detail.platformWorkId),
    ]);
    const counters = detail.metrics;
    const metrics = [counters.plays, counters.likes, counters.comments, counters.favorites, counters.shares];
    const missing = [];
    if (!detail.publishedAt) missing.push("发布时间");
    if (!detail.title) missing.push("标题");
    if (!detail.authorName) missing.push("作者");
    if (!detail.authorSecUid && !detail.authorUid && !saved.platform_author_sec_uid && !saved.platform_author_uid) missing.push("作者账号标识");
    if (detail.durationSec === null) missing.push("时长");
    if (metrics.some(v => v === null)) missing.push("部分指标");
    if (!cover) missing.push("本次原封面");
    if (comments.error) missing.push("本次一级评论");
    const status = missing.length ? "partial" : "available";
    const message = missing.length ? `已采集可用资料，${missing.join("、")}未获取。` : "已更新作品资料、互动数据、原封面和一级评论。";
    const statements = [];
    if (metrics.some(v => v !== null)) {
      statements.push(db.prepare(`INSERT INTO video_metric_snapshots
        (id, organization_id, project_id, video_id, source, plays, likes, comments, favorites, shares, collected_at, created_by, created_at)
        SELECT ?,?,?,?,'tikhub',?,?,?,?,?,?,?,? WHERE ${locked} AND ${projectWriteAccessCondition}`)
        .bind(lock, organizationId, projectId, videoId, ...metrics, detail.collectedAt, userId, attemptedAt, ...guardArgs, ...projectWriteAccessBindings(scope)));
    }
    statements.push(db.prepare(`UPDATE videos SET platform_work_id=?,platform_title=COALESCE(?,platform_title),platform_description=COALESCE(?,platform_description),
        title=COALESCE(title,?),author_name=COALESCE(?,author_name),duration_sec=COALESCE(?,duration_sec),
        platform_author_sec_uid=COALESCE(platform_author_sec_uid,?),platform_author_uid=COALESCE(platform_author_uid,?),
        published_at=COALESCE(?,published_at),published_at_source=CASE WHEN ? IS NOT NULL THEN 'tikhub' ELSE published_at_source END,
        platform_comments_json=COALESCE(?,platform_comments_json),platform_comments_collected_at=COALESCE(?,platform_comments_collected_at),platform_comments_error=?,
        metadata_status=?,metadata_message=?,metadata_collected_at=?,metadata_request_id=NULL,metadata_lock_acquired_at=NULL,updated_at=?,updated_by=?
        WHERE ${owned} AND metadata_request_id=? AND (platform_work_id IS NULL OR platform_work_id=?) AND ${projectWriteAccessCondition}`)
      .bind(detail.platformWorkId, detail.title?.slice(0,500) ?? null, detail.description?.slice(0,4000) ?? null, detail.title?.slice(0,500) ?? null,
        detail.authorName, detail.durationSec, detail.authorSecUid, detail.authorUid, detail.publishedAt, detail.publishedAt, ...platformCommentBindings(comments), status, message, detail.collectedAt,
        new Date().toISOString(), userId, ...guardArgs, ...projectWriteAccessBindings(scope)));
    const writes = await db.batch(statements);
    if (!writes[writes.length - 1].meta.changes) {
      failure = "作品绑定或项目权限已经变化，请刷新。";
      throw new Error("METADATA_WRITE_CONFLICT");
    }
    return { status, message, httpStatus: 200 };
  } catch (error) {
    if (error instanceof TikHubError) failure = error.message;
    await db.prepare(`UPDATE videos SET metadata_status='failed',metadata_message=?,metadata_request_id=NULL,metadata_lock_acquired_at=NULL WHERE ${owned} AND metadata_request_id=?`)
      .bind(failure, ...ids, lock).run();
    return { status: "failed", message: failure, httpStatus: 502 };
  }
}
