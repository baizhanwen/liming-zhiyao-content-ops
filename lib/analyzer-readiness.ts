import { env } from "cloudflare:workers";
import { getD1, getMediaBucket } from "../db/runtime";
import { douyinCookieObjectKey } from "./douyin-cookie-snapshot";

export type BrowserLoginStatus = "logged_in" | "not_logged_in" | "unavailable" | "disabled" | "checking" | "unknown";

type WorkerPresence = {
  last_seen_at: string | null;
  browser_auth_status: Exclude<BrowserLoginStatus, "checking"> | null;
  browser_auth_browser: string | null;
  browser_auth_checked_at: string | null;
  browser_auth_message: string | null;
};

export async function readAnalyzerReadiness(organizationId: string) {
  const runtime = env as typeof env & {
    ANALYZER_SERVICE_TOKEN?: string; ANALYZER_LLM_API_KEY?: string; ANALYZER_LLM_BASE_URL?: string;
    ANALYZER_LLM_MODEL?: string; ANALYZER_LLM_PROVIDER?: string; ANALYZER_YTDLP_COOKIE_FILE?: string;
  };
  const [worker, cookieSnapshot] = await Promise.all([
    getD1().prepare(`
      SELECT last_seen_at, browser_auth_status, browser_auth_browser, browser_auth_checked_at, browser_auth_message
      FROM analyzer_workers WHERE status = 'online' ORDER BY last_seen_at DESC LIMIT 1
    `).first<WorkerPresence>(),
    getMediaBucket().head(douyinCookieObjectKey(organizationId)),
  ]);
  const now = Date.now();
  const token = runtime.ANALYZER_SERVICE_TOKEN?.trim() ?? "";
  const lastWorkerHeartbeat = worker?.last_seen_at ?? null;
  const analyzerOnline = Boolean(lastWorkerHeartbeat && new Date(lastWorkerHeartbeat).getTime() >= now - 45_000);
  const browserCheckFresh = Boolean(worker?.browser_auth_checked_at && new Date(worker.browser_auth_checked_at).getTime() >= now - 120_000);
  const browserLoginStatus: BrowserLoginStatus = browserCheckFresh
    ? worker?.browser_auth_status ?? "unknown"
    : analyzerOnline ? "checking" : "unknown";
  const browserLoginDetected = browserLoginStatus === "logged_in";
  const uploadedCookieConfigured = Boolean(cookieSnapshot);
  const configuredCookieFile = Boolean(runtime.ANALYZER_YTDLP_COOKIE_FILE?.trim());
  const cookieFileConfigured = uploadedCookieConfigured || configuredCookieFile;
  const publicLinkAuthenticationMode = cookieFileConfigured ? "cookie_file" as const : browserLoginDetected ? "browser" as const : "none" as const;

  return {
    checkedAt: new Date(now).toISOString(),
    credentialConfigured: Boolean(token && !/change-me|replace-with/i.test(token)),
    modelConfigured: Boolean(runtime.ANALYZER_LLM_API_KEY?.trim() && runtime.ANALYZER_LLM_BASE_URL?.trim() && runtime.ANALYZER_LLM_MODEL?.trim() && runtime.ANALYZER_LLM_PROVIDER?.trim()),
    publicLinkCookieConfigured: browserLoginDetected || cookieFileConfigured,
    publicLinkAuthenticationMode,
    browserLoginStatus,
    browserLoginDetected,
    browserLoginBrowser: worker?.browser_auth_browser ?? null,
    browserLoginCheckedAt: worker?.browser_auth_checked_at ?? null,
    browserLoginMessage: worker?.browser_auth_message ?? null,
    cookieUpdatedAt: cookieSnapshot?.customMetadata?.updatedAt ?? null,
    analyzerOnline,
    lastWorkerHeartbeat,
  };
}

export function analyzerReadinessError(readiness: Awaited<ReturnType<typeof readAnalyzerReadiness>>, requireCookie: boolean) {
  if (!readiness.credentialConfigured) return { code: "ANALYZER_CREDENTIAL_REQUIRED", message: "分析服务凭据尚未配置。" };
  if (!readiness.modelConfigured) return { code: "ANALYZER_MODEL_REQUIRED", message: "结构分析模型尚未配置。" };
  if (!readiness.analyzerOnline) return { code: "ANALYZER_OFFLINE", message: "后台分析服务尚未就绪，请稍候再试。" };
  if (requireCookie && !readiness.publicLinkCookieConfigured) return { code: "DOUYIN_LOGIN_REQUIRED", message: "请先从视频分析页面上传抖音 Cookie；本地模式也可使用分析主机浏览器登录态。" };
  return null;
}
