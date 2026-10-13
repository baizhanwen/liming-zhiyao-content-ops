export class ModelDeadlineError extends Error {}

/** Covers headers and body together; abort is a cleanup signal, not the deadline. */
export async function withModelRequestDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("模型请求时限配置无效。");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve,reject) => {
    timer = setTimeout(() => {
      reject(new ModelDeadlineError("模型请求超过总时限。"));
      controller.abort();
    },timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal),deadline]); }
  finally { clearTimeout(timer!); }
}
