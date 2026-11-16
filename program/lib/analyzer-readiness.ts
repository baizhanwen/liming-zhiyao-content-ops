import { supportsConfiguredVision } from "./vision-capabilities";
import type { VisualAnalysisMode } from "./visual-analysis-mode";
import { env } from "cloudflare:workers";
import { getD1, getMediaBucket } from "../db/runtime";
import { douyinCookieObjectKey } from "./douyin-cookie-snapshot";
import { readEffectiveModelRuntime } from "./model-settings";

export type BrowserLoginStatus = "logged_in" | "not_logged_in" | "unavailable" | "disabled" | "checking" | "unknown";

type WorkerPresence = {
  last_seen_at: string | null;
  browser_auth_status: Exclude<BrowserLoginStatus, "checking"> | null;
  browser_auth_browser: string | null;
  browser_auth_checked_at: string | null;
  browser_auth_message: string | null;
};

async function readUploadedCookieStatus(organizationId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => getMediaBucket().head(douyinCookieObjectKey(organizationId))),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
    ]);
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function readAnalyzerReadiness(organizationId: string, workerOnly = false, includeCookieStatus = true) {
  const runtime = workerOnly ? env as Record<string, string> : await readEffectiveModelRuntime(organizationId);
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
  // A missing or temporarily unavailable optional snapshot must not block anonymous capture.
  const cookie = includeCookieStatus ? await readUploadedCookieStatus(organizationId) : null;
  const uploadedCookieConfigured = Boolean(cookie && cookie.size > 0);
  // Anonymous remains the default; only an explicitly selected Cookie task
  // uses the current organization's uploaded snapshot.
  const publicLinkAuthenticationMode = "anonymous" as const;

  return {
    checkedAt: new Date(now).toISOString(),
    credentialConfigured: Boolean(token && !/change-me|replace-with/i.test(token)),
    visualModelConfigured: !workerOnly && supportsConfiguredVision(runtime),
    modelConfigured: Boolean(runtime.ANALYZER_LLM_API_KEY?.trim() && runtime.ANALYZER_LLM_BASE_URL?.trim() && runtime.ANALYZER_LLM_MODEL?.trim() && runtime.ANALYZER_LLM_PROVIDER?.trim()),
    publicLinkCookieConfigured: false,
    uploadedCookieConfigured,
    publicLinkAuthenticationMode,
    browserLoginStatus,
    browserLoginDetected,
    browserLoginBrowser: worker?.browser_auth_browser ?? null,
    browserLoginCheckedAt: worker?.browser_auth_checked_at ?? null,
    browserLoginMessage: worker?.browser_auth_message ?? null,
    cookieUpdatedAt: uploadedCookieConfigured ? cookie?.customMetadata?.updatedAt ?? null : null,
    analyzerOnline,
    lastWorkerHeartbeat,
  };
}

export function analyzerReadinessError(readiness: Awaited<ReturnType<typeof readAnalyzerReadiness>>, requireCookie: boolean, workerOnly = false, visualAnalysisMode: VisualAnalysisMode = "hybrid") {
  if (!readiness.credentialConfigured) return { code: "ANALYZER_CREDENTIAL_REQUIRED", message: "分析服务凭据尚未配置。" };
  if (!workerOnly && !readiness.modelConfigured) return { code: "ANALYZER_MODEL_REQUIRED", message: "结构分析模型尚未配置。" };
  if (!workerOnly && visualAnalysisMode === "vision_only" && !readiness.visualModelConfigured) return { code: "ANALYZER_VISION_MODEL_REQUIRED", message: "纯视觉模式需要配置支持图片输入的视觉模型，请先在设置中完成配置。" };
  if (!readiness.analyzerOnline) return { code: "ANALYZER_OFFLINE", message: "后台分析服务尚未就绪，请稍候再试。" };
  if (requireCookie && !readiness.uploadedCookieConfigured) return { code: "ANALYZER_COOKIE_REQUIRED", message: "Cookie 采集需要先在当前公司上传抖音 Cookie。" };
  return null;
}
