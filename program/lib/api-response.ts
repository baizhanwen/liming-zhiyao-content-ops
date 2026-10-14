import { ProjectWriteAccessChangedError } from "./project-write-access.ts";

export function apiError(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...details } }, { status });
}

export function errorResponse(error: unknown) {
  if (error instanceof ProjectWriteAccessChangedError) return apiError(error.code, error.message, 403);
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (error instanceof Error && "code" in error && error.code === "CONTENT_OPERATION_STATUS_UNKNOWN") return apiError(error.code, error.message, 503);
  if (error instanceof Error && "code" in error && error.code === "REPORT_WRITE_STATUS_UNKNOWN") return apiError("REPORT_WRITE_STATUS_UNKNOWN", message, 503);
  if (error instanceof Error && "code" in error && error.code === "REFERENCE_WRITE_STATUS_UNKNOWN") return apiError(error.code, message, 503);
  if (message.includes("PERFORMANCE_RESULT_CAPACITY_EXCEEDED")) return apiError("PERFORMANCE_RESULT_CAPACITY_EXCEEDED", "该周期压缩后的统计数据仍超过当前处理预算，本次没有生成或更新报告。请缩短周期，或联系管理员核对空间规模；不会显示截断结果。", 422);
  if (message.includes("ANALYSIS_MONTHLY_QUOTA_EXCEEDED")) return apiError("ANALYSIS_QUOTA_EXCEEDED", "本月分析任务额度已用完，或其他成员已先提交。请刷新用量后再操作；本次没有新建分析任务。", 429);
  if (message.includes("MEDIA_STORAGE_QUOTA_EXCEEDED")) return apiError("STORAGE_QUOTA_EXCEEDED", "公司媒体存储额度已用完或已调整，本次附件未入库。请让管理员核对存储用量后再操作。", 429);
  if (message.includes("MEDIA_SIZE_INVALID")) return apiError("INVALID_MEDIA_SIZE", "附件大小记录无效，本次未保存。", 400);
  if (message.includes("ORGANIZATION_CAPACITY_INVALID")) return apiError("CAPACITY_UNAVAILABLE", "公司的额度配置无效，已停止新增任务或附件。请联系管理员核对配置。", 503);
  if (message.includes("ANALYSIS_USER_QUEUE_FULL")) return apiError("ANALYSIS_USER_QUEUE_FULL", "你已有 10 条未结束的分析任务（跨项目累计），请等待完成后再提交。本批已成功提交的任务会继续处理。", 429);
  if (message.includes("ANALYSIS_HOST_QUEUE_FULL")) return apiError("ANALYSIS_HOST_QUEUE_FULL", "主机已有 50 条未结束的分析任务，请等待队列释放名额后再提交。本批已成功提交的任务会继续处理。", 429);
  if (message.includes("ANALYZER_STOPPING")) return apiError("ANALYZER_STOPPING", "上一轮分析正在释放资源，请稍后再重试。", 409);
  const status = message.includes("D1 binding") || message.includes("R2 binding") ? 503 : 500;
  return apiError(status === 503 ? "DATABASE_UNAVAILABLE" : "INTERNAL_ERROR", status === 503 ? "数据服务暂不可用，请稍后重试。" : "服务暂时无法完成请求。", status);
}
