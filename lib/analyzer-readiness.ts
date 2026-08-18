import { env } from "cloudflare:workers";
import { getD1, getMediaBucket } from "../db/runtime";
import { douyinCookieObjectKey } from "./douyin-cookie-snapshot";

export async function readAnalyzerReadiness(organizationId: string) {
  const runtime = env as typeof env & {
    ANALYZER_SERVICE_TOKEN?: string; ANALYZER_LLM_API_KEY?: string; ANALYZER_LLM_BASE_URL?: string;
    ANALYZER_LLM_MODEL?: string; ANALYZER_LLM_PROVIDER?: string; ANALYZER_YTDLP_COOKIES_FROM_BROWSER?: string;
    ANALYZER_YTDLP_COOKIE_FILE?: string;
  };
  const [worker, cookieSnapshot] = await Promise.all([
    getD1().prepare("SELECT MAX(last_seen_at) AS value FROM analyzer_workers WHERE status = 'online'").first<{ value: string | null }>(),
    getMediaBucket().head(douyinCookieObjectKey(organizationId)),
  ]);
  const token = runtime.ANALYZER_SERVICE_TOKEN?.trim() ?? "";
  const lastWorkerHeartbeat = worker?.value ?? null;
  return {
    checkedAt: new Date().toISOString(),
    credentialConfigured: Boolean(token && !/change-me|replace-with/i.test(token)),
    modelConfigured: Boolean(runtime.ANALYZER_LLM_API_KEY?.trim() && runtime.ANALYZER_LLM_BASE_URL?.trim() && runtime.ANALYZER_LLM_MODEL?.trim() && runtime.ANALYZER_LLM_PROVIDER?.trim()),
    publicLinkCookieConfigured: Boolean(cookieSnapshot || runtime.ANALYZER_YTDLP_COOKIE_FILE?.trim() || runtime.ANALYZER_YTDLP_COOKIES_FROM_BROWSER?.trim()),
    cookieUpdatedAt: cookieSnapshot?.customMetadata?.updatedAt ?? null,
    // Active jobs refresh presence every eight seconds, while idle workers claim
    // every four seconds. Forty-five seconds tolerates brief local scheduling or
    // antivirus pauses without presenting a healthy worker as disconnected.
    analyzerOnline: Boolean(lastWorkerHeartbeat && new Date(lastWorkerHeartbeat).getTime() >= Date.now() - 45_000),
    lastWorkerHeartbeat,
  };
}

export function analyzerReadinessError(readiness: Awaited<ReturnType<typeof readAnalyzerReadiness>>, requireCookie: boolean) {
  if (!readiness.credentialConfigured) return { code: "ANALYZER_CREDENTIAL_REQUIRED", message: "分析服务凭据尚未配置。" };
  if (!readiness.modelConfigured) return { code: "ANALYZER_MODEL_REQUIRED", message: "结构分析模型尚未配置。" };
  if (!readiness.analyzerOnline) return { code: "ANALYZER_OFFLINE", message: "后台分析服务尚未就绪，请稍候再试。" };
  if (requireCookie && !readiness.publicLinkCookieConfigured) return { code: "DOUYIN_COOKIE_REQUIRED", message: "请先在视频分析页更新抖音 Cookie。" };
  return null;
}
