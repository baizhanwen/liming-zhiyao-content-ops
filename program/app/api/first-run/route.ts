import { apiError, errorResponse } from "../../../lib/api-response";
import { initializeCommercialInstallation, isLoopbackUrl, readFirstRunStatus } from "../../../lib/first-run";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await readFirstRunStatus();
    return Response.json({ ...status, loopbackRequired: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isLoopbackUrl(request.url)) return apiError("FIRST_RUN_LOCAL_ONLY", "首次开通只能在主机电脑上通过 127.0.0.1 完成。", 403);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const password = typeof payload.password === "string" ? payload.password : "";
    const confirmation = typeof payload.confirmation === "string" ? payload.confirmation : "";
    if (password !== confirmation) return apiError("PASSWORD_MISMATCH", "两次输入的密码不一致。", 400);
    const installation = await initializeCommercialInstallation({
      companyName: typeof payload.companyName === "string" ? payload.companyName : "",
      administratorName: typeof payload.administratorName === "string" ? payload.administratorName : "",
      email: typeof payload.email === "string" ? payload.email : "",
      password,
      setupCode: typeof payload.setupCode === "string" ? payload.setupCode : "",
    });
    return Response.json({ initialized: true, installation }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "FIRST_RUN_NOT_AVAILABLE") return apiError("FIRST_RUN_NOT_AVAILABLE", "当前安装不需要首次设置。", 404);
    if (message === "FIRST_RUN_ALREADY_COMPLETED") return apiError("FIRST_RUN_ALREADY_COMPLETED", "首次开通已经完成，请直接登录。", 409);
    if (message === "FIRST_RUN_CODE_NOT_CONFIGURED") return apiError("FIRST_RUN_CODE_NOT_CONFIGURED", "交付包没有配置一次性初始化码，请联系软件提供方。", 503);
    if (message === "FIRST_RUN_CODE_INVALID") return apiError("FIRST_RUN_CODE_INVALID", "一次性初始化码不正确。", 403);
    if (message === "FIRST_RUN_COMPANY_INVALID") return apiError("FIRST_RUN_COMPANY_INVALID", "公司名称需要 2 至 80 个字符。", 400);
    if (message === "FIRST_RUN_NAME_INVALID") return apiError("FIRST_RUN_NAME_INVALID", "管理员姓名需要 2 至 80 个字符。", 400);
    if (message === "FIRST_RUN_EMAIL_INVALID") return apiError("FIRST_RUN_EMAIL_INVALID", "请输入有效的管理员邮箱。", 400);
    if (message.startsWith("FIRST_RUN_PASSWORD_INVALID:")) return apiError("FIRST_RUN_PASSWORD_INVALID", message.slice("FIRST_RUN_PASSWORD_INVALID:".length), 400);
    return errorResponse(error);
  }
}
