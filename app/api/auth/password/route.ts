import { ensureUser } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { setLocalPassword, validateLocalPassword } from "../../../../lib/local-auth";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请登录后再设置局域网密码。", 401);
  try {
    const payload = await request.json() as { password?: string; confirmation?: string };
    const password = payload.password ?? "";
    const invalid = validateLocalPassword(password);
    if (invalid) return apiError("INVALID_PASSWORD", invalid, 400);
    if (password !== payload.confirmation) return apiError("PASSWORD_MISMATCH", "两次输入的密码不一致。", 400);
    const user = await ensureUser(identity);
    await setLocalPassword(user.id, password);
    return Response.json({ configured: true, email: user.email });
  } catch (error) { return errorResponse(error); }
}
