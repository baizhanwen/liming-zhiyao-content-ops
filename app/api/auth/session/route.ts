import { ensureUser, getD1 } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { createLocalSession, revokeLocalSession, verifyLocalLogin } from "../../../../lib/local-auth";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请登录后继续。", 401);
  try {
    const user = await ensureUser(identity);
    return Response.json({ user: { id: user.id, email: user.email, displayName: user.display_name || user.email } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { email?: string; password?: string };
    const email = payload.email?.trim().toLowerCase() ?? "";
    const password = payload.password ?? "";
    if (!email || !password) return apiError("LOGIN_REQUIRED", "请输入邮箱和密码。", 400);
    const user = await verifyLocalLogin(email, password);
    if (!user) return apiError("LOGIN_FAILED", "邮箱或密码不正确。", 401);
    const membership = await getD1().prepare("SELECT 1 AS allowed FROM organization_members WHERE user_id = ? AND status = 'active' LIMIT 1").bind(user.user_id).first();
    if (!membership) return apiError("ACCOUNT_UNAVAILABLE", "该账号尚未加入有效的公司空间。", 403);
    const cookie = await createLocalSession(user.user_id, request);
    return Response.json({ user: { id: user.user_id, email: user.email, displayName: user.display_name || user.email } }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    return Response.json({ signedOut: true }, { headers: { "set-cookie": await revokeLocalSession(request), "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

