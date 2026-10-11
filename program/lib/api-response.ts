export function apiError(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...details } }, { status });
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("ANALYSIS_USER_QUEUE_FULL")) return apiError("ANALYSIS_USER_QUEUE_FULL", "你已有 10 条未结束的分析任务（跨项目累计），请等待完成后再提交。本批已成功提交的任务会继续处理。", 429);
  if (message.includes("ANALYSIS_HOST_QUEUE_FULL")) return apiError("ANALYSIS_HOST_QUEUE_FULL", "主机已有 50 条未结束的分析任务，请等待队列释放名额后再提交。本批已成功提交的任务会继续处理。", 429);
  if (message.includes("ANALYZER_STOPPING")) return apiError("ANALYZER_STOPPING", "上一轮分析正在释放资源，请稍后再重试。", 409);
  const status = message.includes("D1 binding") || message.includes("R2 binding") ? 503 : 500;
  return apiError(status === 503 ? "DATABASE_UNAVAILABLE" : "INTERNAL_ERROR", status === 503 ? "数据服务暂不可用，请稍后重试。" : "服务暂时无法完成请求。", status);
}
