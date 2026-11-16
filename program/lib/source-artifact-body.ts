import { createHash } from "node:crypto";

export const SOURCE_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
const SOURCE_CHUNK_BYTES = 64 * 1024;
const SOURCE_YIELD_BYTES = 1024 * 1024;

async function yieldSourceTransfer() {
  // Awaiting reads or writes that are already ready only drains microtasks in
  // workerd. Yield a real event turn so control/heartbeat requests can run.
  if (typeof scheduler !== "undefined" && typeof scheduler.wait === "function") await scheduler.wait(0);
  else await new Promise<void>(resolve => setTimeout(resolve, 0));
}

export class SourceArtifactBodyError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export function sourceArtifactLength(request: Request, maximumBytes = SOURCE_ARTIFACT_MAX_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared === null) throw new SourceArtifactBodyError("ARTIFACT_LENGTH_REQUIRED", "原片保存需要明确的 Content-Length。请更新分析服务后重试。", 411);
  if (!/^\d+$/.test(declared)) throw new SourceArtifactBodyError("INVALID_ARTIFACT_LENGTH", "原片长度声明无效。", 400);
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length > maximumBytes) throw new SourceArtifactBodyError("ARTIFACT_TOO_LARGE", "原片超过大小限制。", 413);
  if (length <= 0 || !request.body) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片不能为空。", 413);
  return length;
}

/** Bounded output and cooperative scheduling; never duplicate the complete file. */
function boundedSourceBody(request: Request, length: number, maximumBytes: number) {
  if (!request.body) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片不能为空。", 413);
  const reader = request.body.getReader(), hash = createHash("sha256");
  let sizeBytes = 0, finished = false, released = false, cancelled = false, sha256: string | null = null;
  let failure: unknown = null;
  let incomingBytes = 0, pending: Uint8Array | null = null, offset = 0, yieldedBytes = 0, operations = 0;
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  const abortReason = () => request.signal.reason ?? new DOMException("Source upload aborted", "AbortError");
  const onAbort = () => { void cancel(abortReason()); };
  const release = () => {
    if (!released) { released = true; pending = null; request.signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
  };
  const cancel = async (reason?: unknown) => {
    if (released) return;
    cancelled = true; pending = null;
    if (reason !== undefined && failure === null) failure = reason;
    try { output?.error(reason ?? new DOMException("Source upload cancelled", "AbortError")); } catch { /* Already closed. */ }
    try { await reader.cancel(reason); } catch { /* Preserve the upload failure. */ }
    finally { release(); }
  };
  const checkAbort = () => {
    if (cancelled || request.signal.aborted) throw failure ?? abortReason();
  };
  const cooperate = async (bytes: number) => {
    yieldedBytes += bytes; operations += 1;
    if (yieldedBytes >= SOURCE_YIELD_BYTES || operations >= 64) {
      yieldedBytes = 0; operations = 0;
      await yieldSourceTransfer();
      checkAbort();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    async pull(controller) {
      try {
        checkAbort();
        while (pending === null) {
          const { done, value } = await reader.read();
          checkAbort();
          if (done) {
            if (sizeBytes !== length) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片传输不完整，实际大小与声明不一致。", 413);
            sha256 = hash.digest("hex"); finished = true; release(); controller.close(); return;
          }
          if (!(value instanceof Uint8Array)) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片传输内容无效。", 413);
          incomingBytes += value.byteLength;
          if (incomingBytes > maximumBytes || incomingBytes > length) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片实际大小超过声明或保存上限。", 413);
          if (!value.byteLength) { await cooperate(0); continue; }
          pending = value; offset = 0;
        }
        const chunk = pending.subarray(offset, Math.min(offset + SOURCE_CHUNK_BYTES, pending.byteLength));
        offset += chunk.byteLength;
        if (offset === pending.byteLength) pending = null;
        hash.update(chunk); sizeBytes += chunk.byteLength;
        await cooperate(chunk.byteLength);
        checkAbort();
        controller.enqueue(chunk);
      } catch (error) {
        if (failure === null) failure = error;
        try { controller.error(error); } catch { /* An abort already errored it. */ }
        await cancel(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  return { stream, cancel, failure: () => failure, receipt: () => {
    if (!finished || sha256 === null) throw new SourceArtifactBodyError("INVALID_ARTIFACT_SIZE", "原片尚未完整传输。", 413);
    return { sizeBytes, sha256 };
  } };
}

/** Used only to verify an idempotent replay when the remaining quota is full. */
export async function hashSourceArtifactBody(request: Request, length: number, maximumBytes = SOURCE_ARTIFACT_MAX_BYTES) {
  const body = boundedSourceBody(request, length, maximumBytes), reader = body.stream.getReader();
  try {
    while (!(await reader.read()).done) { /* Hashing happens before each bounded chunk is released. */ }
    return body.receipt();
  } finally { reader.releaseLock(); await body.cancel(); }
}

/** R2 receives a known-length native stream while hashing stays incremental. */
export async function storeSourceArtifactBody(request: Request, length: number, bucket: Pick<R2Bucket, "put">,
  key: string, options: R2PutOptions, maximumBytes = SOURCE_ARTIFACT_MAX_BYTES) {
  const body = boundedSourceBody(request, length, maximumBytes), abort = new AbortController();
  const fixed = new FixedLengthStream(length, { highWaterMark: 64 * 1024 });
  const stop = (reason: unknown) => {
    abort.abort(reason);
    void fixed.readable.cancel(reason).catch(() => {});
    void body.cancel(reason).catch(() => {});
  };
  const onAbort = () => stop(request.signal.reason ?? new DOMException("Source upload aborted", "AbortError"));
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const pump = body.stream.pipeTo(fixed.writable, { signal: abort.signal });
  const store = Promise.resolve().then(() => {
    if (abort.signal.aborted) throw abort.signal.reason;
    return bucket.put(key, fixed.readable, options);
  }).then(value => {
    if (!value) throw new Error("MEDIA_OBJECT_NOT_WRITTEN");
    return value;
  }).catch(error => {
    // An early storage rejection may not have acquired a reader. Cancel the
    // fixed stream too, so a backpressured write cannot strand the pump.
    stop(error);
    throw error;
  });
  const [stored, streamed] = await Promise.allSettled([store, pump]);
  try {
    if (body.failure()) throw body.failure();
    // EOF releases the source reader before R2 necessarily acknowledges its
    // write. A disconnected request in that interval is not a saved receipt.
    if (abort.signal.aborted || request.signal.aborted) throw abort.signal.reason ?? request.signal.reason;
    if (stored.status === "rejected") throw stored.reason;
    if (streamed.status === "rejected") throw streamed.reason;
    return body.receipt();
  } finally { request.signal.removeEventListener("abort", onAbort); await body.cancel(); }
}
