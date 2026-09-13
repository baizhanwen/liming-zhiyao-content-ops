import { analyzerReadinessError, readAnalyzerReadiness } from "./analyzer-readiness";
import { checkOrganizationQuota } from "./operations";
import { apiError } from "./api-response";

export async function checkNewAnalysisAvailability(input: { organizationId: string; userId: string; requiresBrowser: boolean; uploadBytes?: number }) {
  const readiness = analyzerReadinessError(await readAnalyzerReadiness(input.organizationId), input.requiresBrowser);
  if (readiness) return apiError(readiness.code, readiness.message, 503);
  const [analysis, storage] = await Promise.all([
    checkOrganizationQuota(input.organizationId, input.userId, "analyses"),
    input.uploadBytes === undefined ? null : checkOrganizationQuota(input.organizationId, input.userId, "storageBytes", input.uploadBytes),
  ]);
  if (!analysis.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务已达到 ${analysis.limit} 次套餐上限。`, 429, { usage: analysis.current, limit: analysis.limit });
  if (storage && !storage.allowed) return apiError("STORAGE_QUOTA_EXCEEDED", "本次上传会超过公司的媒体存储配额。", 429, { usage: storage.current, limit: storage.limit });
  return null;
}
