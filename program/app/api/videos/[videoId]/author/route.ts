import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../../db/runtime";
import { hasSavedReport } from "../../../../../lib/analyzed-accounts";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readBoundedJson, RequestBodyError } from "../../../../../lib/bounded-request-body";
import { OrganizationSettingsError } from "../../../../../lib/organization-settings-credential";
import { projectWriteAccessBindings, projectWriteAccessCondition } from "../../../../../lib/project-write-access";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { douyinLookupTarget, fetchTikHubWorkAuthor, TikHubError } from "../../../../../lib/tikhub-metadata";
import { readEffectiveTikHubKey } from "../../../../../lib/tikhub-settings";
import { metadataLockAvailable, staleMetadataLockBefore } from "../../../../../lib/video-metadata-refresh";

type Source = {
  source_url: string;
  platform_work_id: string | null;
  platform_author_sec_uid: string | null;
  platform_author_uid: string | null;
  author_name: string | null;
};

const sourceScope = `id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL
  AND platform='douyin' AND source_type='url' AND source_url IS NOT NULL
  AND EXISTS (SELECT 1 FROM video_analyses report WHERE report.video_id=videos.id
    AND report.organization_id=videos.organization_id AND report.project_id=videos.project_id AND ${hasSavedReport})`;

function identified(authorName: string | null, secUid: string | null) {
  // A uid-only row may already be linked to a sec_uid by another work in the space.
  return Response.json({ authorName, ...(secUid ? { accountKey: "sec:" + secUid } : {}) });
}

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再识别作品账号。", 401);
  try {
    const body = await readBoundedJson(request, 4096, "请求内容过大。") as { organizationId?: unknown; projectId?: unknown } | null;
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "请选择公司与企业空间。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("ACCESS_DENIED", "无权补齐这个空间的作品账号。", 403);

    const { videoId } = await context.params;
    const db = getD1();
    const ids = [videoId, organizationId, projectId];
    const getSource = () => db.prepare(`SELECT source_url,platform_work_id,author_name,platform_author_sec_uid,platform_author_uid
      FROM videos WHERE ${sourceScope}`).bind(...ids).first<Source>();
    const video = await getSource();
    if (!video) return apiError("VIDEO_NOT_FOUND", "这个空间没有可识别的抖音分析作品。", 404);
    if (video.platform_author_sec_uid || video.platform_author_uid) return identified(video.author_name, video.platform_author_sec_uid);
    const lookup = { sourceUrl: video.source_url, platformWorkId: video.platform_work_id };
    const expected = douyinLookupTarget(lookup);
    const apiKey = await readEffectiveTikHubKey(organizationId);
    if (!apiKey) return apiError("TIKHUB_KEY_MISSING", "请在系统设置中配置 TikHub 抖音数据采集密钥。", 503);

    const lock = crypto.randomUUID();
    const scope = { organizationId, projectId, userId: access.userId };
    const guards = `${sourceScope} AND source_url=? AND platform_work_id IS ?
      AND platform_author_sec_uid IS NULL AND platform_author_uid IS NULL AND ${projectWriteAccessCondition}`;
    const guardValues = [...ids, video.source_url, video.platform_work_id, ...projectWriteAccessBindings(scope)];
    const reserved = await db.prepare(`UPDATE videos SET metadata_request_id=?,metadata_lock_acquired_at=?
      WHERE ${guards} AND ${metadataLockAvailable}`).bind(lock, new Date().toISOString(), ...guardValues, staleMetadataLockBefore()).run();
    if (!reserved.meta.changes) {
      // Another request may have completed between the initial read and the reservation.
      const currentAccess = await getProjectAccess(identity.authSubject, organizationId, projectId);
      if (!currentAccess || !canWriteProjectAccess(currentAccess)) return apiError("ACCESS_DENIED", "这个空间的权限已变化，请刷新。", 403);
      const current = await getSource();
      if (current && (current.platform_author_sec_uid || current.platform_author_uid)) return identified(current.author_name, current.platform_author_sec_uid);
      return apiError("VIDEO_AUTHOR_BUSY", "作品资料正在更新或已变更，请稍后刷新。", 409);
    }

    let saved = false;
    try {
      const author = await fetchTikHubWorkAuthor({ ...lookup, apiKey });
      if (!author.platformWorkId || (expected.id && author.platformWorkId !== expected.id)) throw new TikHubError("workMismatch");
      if (!author.authorSecUid && !author.authorUid) return apiError("VIDEO_AUTHOR_UNKNOWN", "本次作品详情没有提供可识别的作者标识。", 422);
      const updated = await db.prepare(`UPDATE videos SET platform_author_sec_uid=?,platform_author_uid=?,author_name=COALESCE(?,author_name),
        platform_work_id=?,metadata_request_id=NULL,metadata_lock_acquired_at=NULL,updated_at=?,updated_by=?
        WHERE ${guards} AND metadata_request_id=?`)
        .bind(author.authorSecUid, author.authorUid, author.authorName, author.platformWorkId, new Date().toISOString(), access.userId,
          ...guardValues, lock).run();
      if (!updated.meta.changes) return apiError("VIDEO_AUTHOR_CONFLICT", "作品或空间权限已变化，请刷新。", 409);
      saved = true;
      return identified(author.authorName ?? video.author_name, author.authorSecUid);
    } finally {
      if (!saved) await db.prepare(`UPDATE videos SET metadata_request_id=NULL,metadata_lock_acquired_at=NULL
        WHERE id=? AND organization_id=? AND project_id=? AND metadata_request_id=?`).bind(...ids, lock).run();
    }
  } catch (error) {
    if (error instanceof RequestBodyError || error instanceof OrganizationSettingsError) return apiError(error.code, error.message, error.status);
    if (error instanceof TikHubError) return apiError("VIDEO_AUTHOR_UNAVAILABLE", error.message, 502);
    return errorResponse(error);
  }
}
