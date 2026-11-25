import { ensureUser, getD1 } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { clearLocalLoginFailures, createLocalSession, hasLocalDevSignOut, localDevSignOutPreference, readLocalLoginLock, recordLocalLoginFailure, revokeLocalSession, verifyLocalLogin } from "../../../../lib/local-auth";
import { localDevelopmentIdentity, readRequestIdentity } from "../../../../lib/request-auth";

async function canResumeLocalDevelopment(request: Request) {
  const owner = localDevelopmentIdentity(request);
  if (!owner || !hasLocalDevSignOut(request)) return false;
  const eligible = await getD1().prepare(`
    SELECT 1 AS allowed FROM users u WHERE u.auth_subject = ? AND u.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.user_id = u.id)
  `).bind(owner.authSubject).first();
  return Boolean(eligible);
}

export async function GET(request: Request) {
  try {
    const identity = await readRequestIdentity(request);
    if (!identity) return Response.json({
      error: { code: "AUTH_REQUIRED", message: "请登录后继续。" },
      localDevLoginAvailable: await canResumeLocalDevelopment(request),
    }, { status: 401, headers: { "cache-control": "no-store" } });
    const user = await ensureUser(identity);
    return Response.json({ user: { id: user.id, email: user.email, displayName: user.display_name || user.email } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { mode?: string; email?: string; password?: string };
    if (payload.mode === "local-dev") {
      if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        || !await canResumeLocalDevelopment(request) || await readRequestIdentity(request)) {
        return apiError("LOCAL_LOGIN_UNAVAILABLE", "当前不能使用本机免密登录，请使用邮箱和密码。", 403);
      }
      return Response.json({ signedIn: true }, { headers: { "set-cookie": localDevSignOutPreference(request, false), "cache-control": "no-store" } });
    }
    const email = payload.email?.trim().toLowerCase() ?? "";
    const password = payload.password ?? "";
    if (!email || !password) return apiError("LOGIN_REQUIRED", "请输入邮箱和密码。", 400);
    const attemptStartedAt = new Date().toISOString();
    const lockedSeconds = await readLocalLoginLock(email);
    if (lockedSeconds) return apiError("LOGIN_TEMPORARILY_LOCKED", `登录失败次数过多，请在 ${Math.ceil(lockedSeconds / 60)} 分钟后重试。`, 429, { retryAfterSeconds: lockedSeconds });
    const user = await verifyLocalLogin(email, password);
    if (!user) {
      const retryAfterSeconds = await recordLocalLoginFailure(email);
      if (retryAfterSeconds) return apiError("LOGIN_TEMPORARILY_LOCKED", "登录失败次数过多，账号已临时锁定 15 分钟。", 429, { retryAfterSeconds });
      return apiError("LOGIN_FAILED", "邮箱或密码不正确。", 401);
    }
    const concurrentLock = await readLocalLoginLock(email);
    if (concurrentLock) return apiError("LOGIN_TEMPORARILY_LOCKED", "登录失败次数过多，请稍后重试。", 429, { retryAfterSeconds: concurrentLock });
    await clearLocalLoginFailures(email, attemptStartedAt);
    const membership = await getD1().prepare("SELECT 1 AS allowed FROM organization_members WHERE user_id = ? AND status = 'active' LIMIT 1").bind(user.user_id).first();
    if (!membership) return apiError("ACCOUNT_UNAVAILABLE", "该账号尚未加入有效的公司空间。", 403);
    const cookie = await createLocalSession(user.user_id, request);
    return Response.json({ user: { id: user.user_id, email: user.email, displayName: user.display_name || user.email } }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", await revokeLocalSession(request));
    if (localDevelopmentIdentity(request)) headers.append("set-cookie", localDevSignOutPreference(request, true));
    return Response.json({ signedOut: true }, { headers });
  } catch (error) { return errorResponse(error); }
}
