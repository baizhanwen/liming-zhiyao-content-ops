import { getD1 } from "../db/runtime";
import { readEffectiveModelRuntime } from "./model-settings";

export type BrowserLoginStatus = "logged_in" | "not_logged_in" | "unavailable" | "disabled" | "checking" | "unknown";

type WorkerPresence = {
  last_seen_at: string | null;
  browser_auth_status: Exclude<BrowserLoginStatus, "checking"> | null;
  browser_auth_browser: string | null;
  browser_auth_checked_at: string | null;
  browser_auth_message: string | null;
};

export async function readAnalyzerReadiness(organizationId: string) {
  const runtime = await readEffectiveModelRuntime(organizationId);
  const worker = await getD1().prepare(`
      SELECT last_seen_at, browser_auth_status, browser_auth_browser, browser_auth_checked_at, browser_auth_message
      FROM analyzer_workers WHERE status = 'online' ORDER BY last_seen_at DESC LIMIT 1
    `).first<WorkerPresence>();
  const now = Date.now();
  const token = runtime.ANALYZER_SERVICE_TOKEN?.trim() ?? "";
  const lastWorkerHeartbeat = worker?.last_seen_at ?? null;
  const analyzerOnline = Boolean(lastWorkerHeartbeat && new Date(lastWorkerHeartbeat).getTime() >= now - 45_000);
  const browserCheckFresh = Boolean(worker?.browser_auth_checked_at && new Date(worker.browser_auth_checked_at).getTime() >= now - 120_000);
  const browserLoginStatus: BrowserLoginStatus = browserCheckFresh
    ? worker?.browser_auth_status ?? "unknown"
    : analyzerOnline ? "checking" : "unknown";
  const browserLoginDetected = browserLoginStatus === "logged_in";
  // Skill Collect owns a fresh anonymous Chromium context for every capture.
  // Legacy Cookie configuration is intentionally not read or required here.
  const publicLinkAuthenticationMode = "anonymous" as const;

  return {
    checkedAt: new Date(now).toISOString(),
    credentialConfigured: Boolean(token && !/change-me|replace-with/i.test(token)),
    modelConfigured: Boolean(runtime.ANALYZER_LLM_API_KEY?.trim() && runtime.ANALYZER_LLM_BASE_URL?.trim() && runtime.ANALYZER_LLM_MODEL?.trim() && runtime.ANALYZER_LLM_PROVIDER?.trim()),
    publicLinkCookieConfigured: false,
    publicLinkAuthenticationMode,
    browserLoginStatus,
    browserLoginDetected,
    browserLoginBrowser: worker?.browser_auth_browser ?? null,
    browserLoginCheckedAt: worker?.browser_auth_checked_at ?? null,
    browserLoginMessage: worker?.browser_auth_message ?? null,
    cookieUpdatedAt: null,
    analyzerOnline,
    lastWorkerHeartbeat,
  };
}

export function analyzerReadinessError(readiness: Awaited<ReturnType<typeof readAnalyzerReadiness>>, _requireCookie: boolean) {
  // Retain the upload/link call contract; neither needs personal authentication.
  void _requireCookie;
  if (!readiness.credentialConfigured) return { code: "ANALYZER_CREDENTIAL_REQUIRED", message: "分析服务凭据尚未配置。" };
  if (!readiness.modelConfigured) return { code: "ANALYZER_MODEL_REQUIRED", message: "结构分析模型尚未配置。" };
  if (!readiness.analyzerOnline) return { code: "ANALYZER_OFFLINE", message: "后台分析服务尚未就绪，请稍候再试。" };
  return null;
}
