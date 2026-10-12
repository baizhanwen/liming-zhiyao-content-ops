export class RequestBodyError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

// Give small overflows a chance to finish their transport without buffering or
// parsing them. Unlimited draining would make a size rejection a slow request.
async function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>, maximumBytes: number) {
  let bytes = 0, finished = false;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 1000);
  try {
    while (bytes <= maximumBytes) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      bytes += value.byteLength;
    }
  } catch { /* The header already establishes a size rejection. */ }
  finally {
    clearTimeout(timer);
    if (!finished) void reader.cancel().catch(() => {});
  }
}

// Wrap the original stream rather than making a second complete body copy.
// Content-Length is only an early check; actual bytes always enforce the limit.
async function boundedBody(request: Request, maximumBytes: number, sizeMessage: string) {
  const declared = request.headers.get("content-length");
  const tooLarge = () => new RequestBodyError("REQUEST_BODY_TOO_LARGE", sizeMessage, 413);
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maximumBytes) {
    if (request.body) {
      const reader = request.body.getReader();
      try { await discardReader(reader, maximumBytes + 64 * 1024); }
      finally { reader.releaseLock(); }
    }
    throw tooLarge();
  }
  if (!request.body) throw new RequestBodyError("REQUEST_BODY_REQUIRED", "缺少请求内容，请重新提交。", 400);
  const reader = request.body.getReader();
  let bytes = 0, exceeded = false, released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const dispose = () => { if (!released) { void reader.cancel().catch(() => {}); release(); } };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { release(); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes > maximumBytes) {
          exceeded = true;
          // Keep the overflow out of the parser, but allow a small remaining
          // transport tail to finish so chunked clients can receive their 413.
          await discardReader(reader, 64 * 1024 - (bytes - maximumBytes));
          release(); controller.error(tooLarge()); return;
        }
        controller.enqueue(value);
      } catch (error) { release(); controller.error(error); }
    },
    cancel(reason) { const result = reader.cancel(reason); release(); return result; },
  }, { highWaterMark: 0 });
  return { stream, exceeded: () => exceeded, tooLarge, dispose };
}

export async function readBoundedFormData(request: Request, maximumBytes: number, sizeMessage: string) {
  const body = await boundedBody(request, maximumBytes, sizeMessage);
  try { return await new Response(body.stream, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData(); }
  catch {
    body.dispose();
    if (body.exceeded()) throw body.tooLarge();
    throw new RequestBodyError("INVALID_MULTIPART", "上传内容不完整或格式无效，请重新选择文件后提交。", 400);
  }
}

export async function readBoundedJson(request: Request, maximumBytes: number, sizeMessage: string): Promise<unknown> {
  const body = await boundedBody(request, maximumBytes, sizeMessage);
  try { return await new Response(body.stream).json(); }
  catch {
    body.dispose();
    if (body.exceeded()) throw body.tooLarge();
    throw new RequestBodyError("INVALID_JSON", "请求内容不是有效 JSON，请检查后重新提交。", 400);
  }
}
