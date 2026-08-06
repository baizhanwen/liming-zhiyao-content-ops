import { ensureUser, getD1, getMediaBucket, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { douyinCookieObjectKey, MAX_DOUYIN_COOKIE_BYTES, sanitizeDouyinCookieSnapshot } from "../../../../lib/douyin-cookie-snapshot";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新抖音 Cookie。", 401);
  try {
    const organizationId = request.headers.get("x-organization-id")?.trim() ?? "";
    const projectId = request.headers.get("x-project-id")?.trim() ?? "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以更新抖音 Cookie。", 403);

    const form = await request.formData(); const file = form.get("file");
    if (!(file instanceof File)) return apiError("COOKIE_FILE_REQUIRED", "请选择从抖音网站导出的 cookies.txt。", 400);
    if (file.size <= 0 || file.size > MAX_DOUYIN_COOKIE_BYTES) return apiError("INVALID_COOKIE_FILE_SIZE", "Cookie 文件大小需要在 1 字节至 1 MB 之间。", 413);
    const imported = sanitizeDouyinCookieSnapshot(await file.text());
    const user = await ensureUser(identity); const now = new Date().toISOString(); const key = douyinCookieObjectKey(organizationId);
    await getMediaBucket().put(key, imported.contents, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { organizationId, updatedAt: now, cookieCount: String(imported.count) },
    });
    await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analyzer.cookies_updated', 'analyzer_settings', ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, projectId, user.id, organizationId, JSON.stringify({ cookieCount: imported.count, filename: file.name }), now).run();
    return Response.json({ configured: true, updatedAt: now, cookieCount: imported.count }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && /Cookie|cookies\.txt|抖音/.test(error.message)) return apiError("INVALID_COOKIE_FILE", error.message, 400);
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再清除抖音 Cookie。", 401);
  try {
    const organizationId = request.headers.get("x-organization-id")?.trim() ?? "";
    const projectId = request.headers.get("x-project-id")?.trim() ?? "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以清除抖音 Cookie。", 403);

    const user = await ensureUser(identity); const now = new Date().toISOString(); const key = douyinCookieObjectKey(organizationId);
    const existed = Boolean(await getMediaBucket().head(key));
    await getMediaBucket().delete(key);
    await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analyzer.cookies_deleted', 'analyzer_settings', ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, projectId, user.id, organizationId, JSON.stringify({ existed }), now).run();
    return Response.json({ configured: false, deleted: existed }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
