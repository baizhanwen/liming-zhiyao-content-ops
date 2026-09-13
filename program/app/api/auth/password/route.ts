import { ensureUser } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { hasLocalPassword, revokeAllLocalSessions, setLocalPassword, validateLocalPassword, verifyLocalPasswordForUser } from "../../../../lib/local-auth";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请登录后再设置局域网密码。", 401);
  try {
    const payload = await request.json() as { currentPassword?: string; password?: string; confirmation?: string };
    const password = payload.password ?? "";
    const invalid = validateLocalPassword(password);
    if (invalid) return apiError("INVALID_PASSWORD", invalid, 400);
    if (password !== payload.confirmation) return apiError("PASSWORD_MISMATCH", "两次输入的密码不一致。", 400);
    const user = await ensureUser(identity);
    const configured = await hasLocalPassword(user.id);
    if (configured && !(await verifyLocalPasswordForUser(user.id, payload.currentPassword ?? ""))) {
      return apiError("CURRENT_PASSWORD_INVALID", "当前密码不正确，未修改密码。", 403);
    }
    await setLocalPassword(user.id, password);
    await revokeAllLocalSessions(user.id);
    return Response.json({ configured: true, email: user.email, sessionsRevoked: true });
  } catch (error) { return errorResponse(error); }
}
