export function apiError(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...details } }, { status });
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status = message.includes("D1 binding") || message.includes("R2 binding") ? 503 : 500;
  return apiError(status === 503 ? "DATABASE_UNAVAILABLE" : "INTERNAL_ERROR", status === 503 ? "数据服务暂不可用，请稍后重试。" : "服务暂时无法完成请求。", status);
}
