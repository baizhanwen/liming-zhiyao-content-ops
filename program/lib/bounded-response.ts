export async function readBoundedResponseBytes(response: Response, maximum: number, message: string) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) { await response.body?.cancel().catch(() => {}); throw new Error(message); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), parts: BlobPart[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) throw new Error(message);
      parts.push(Uint8Array.from(value).buffer);
    }
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
