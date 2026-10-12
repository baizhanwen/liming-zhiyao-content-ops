import { Unzip, UnzipInflate, unzipSync, type UnzipFileInfo } from "fflate";

export async function openBoundedZip(file: Blob, options: { maximumBytes: number; maximumFiles: number; label: string; signal?: AbortSignal }) {
  const fail = (message: string): never => { throw new Error(`${options.label}${message}，未读取数据；请重新导出或分批整理。`); };
  options.signal?.throwIfAborted();
  if (file.size > options.maximumBytes) fail("压缩文件大小超限");
  const bytes = new Uint8Array(await file.arrayBuffer());
  options.signal?.throwIfAborted();
  if (bytes.length > options.maximumBytes) fail("压缩文件大小超限");
  const directory = new Map<string, UnzipFileInfo>();
  try {
    unzipSync(bytes, { filter(info) {
      const parts = info.name.split("/");
      if (!info.name || info.name.length > 512 || info.name.startsWith("/") || info.name.includes("\\") || info.name.includes(":") || parts.some(part => part === "." || part === "..") || Array.from(info.name).some(char => char.charCodeAt(0) < 32)) fail("包含异常文件名");
      if (directory.has(info.name)) fail("包含重复文件名");
      if (directory.size >= options.maximumFiles) fail("内部文件数量超限");
      if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0 || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > bytes.length) fail("文件大小声明无效");
      directory.set(info.name, info); return false;
    } });
  } catch (error) { if (error instanceof Error && error.message.startsWith(options.label)) throw error; fail(" ZIP 损坏或格式不支持"); }

  async function read(names: Map<string, number>, maximumTotal: number) {
    options.signal?.throwIfAborted();
    let total = 0;
    for (const [name, maximum] of names) {
      const info = directory.get(name);
      if (!info) fail("缺少必要内容");
      if (![0, 8].includes(info!.compression)) fail("包含不支持的压缩方式");
      if (info!.originalSize > maximum) fail("所需内容展开大小超限");
      total += info!.originalSize;
      if (total > maximumTotal) fail("所需文件的展开总量超限");
    }
    const result = new Map<string, Blob>(), seen = new Set<string>();
    let streamError: Error | null = null, lastYield = Date.now();
    const unzip = new Unzip(entry => {
      const info = directory.get(entry.name);
      if (!info || seen.has(entry.name)) fail("目录与实际文件不一致");
      seen.add(entry.name);
      // Unselected compressed content is skipped, never inflated.
      if (!names.has(entry.name)) return;
      if (entry.compression !== info!.compression || entry.originalSize != null && entry.originalSize !== info!.originalSize || entry.size != null && entry.size !== info!.size) fail("目录与实际文件大小不一致");
      const parts: BlobPart[] = []; let expanded = 0;
      entry.ondata = (error, chunk, final) => {
        if (streamError) return;
        if (error) { streamError = new Error(`${options.label}解压失败，未读取数据。`); return; }
        expanded += chunk.length;
        if (expanded > info!.originalSize) { streamError = new Error(`${options.label}实际展开量超过声明大小，未读取数据。`); return; }
        parts.push(Uint8Array.from(chunk).buffer);
        if (final) {
          if (expanded !== info!.originalSize) { streamError = new Error(`${options.label}文件不完整，未读取数据。`); return; }
          result.set(entry.name, new Blob(parts));
        }
      };
      entry.start();
    });
    unzip.register(UnzipInflate);
    try {
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        options.signal?.throwIfAborted();
        unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
        if (streamError) throw streamError;
        if (Date.now() - lastYield >= 16) { await new Promise(resolve => setTimeout(resolve, 0)); lastYield = Date.now(); }
      }
    } catch (error) { if (options.signal?.aborted || error instanceof Error && error.message.startsWith(options.label)) throw error; fail(" ZIP 损坏或格式不支持"); }
    options.signal?.throwIfAborted();
    if (result.size !== names.size) fail("所需文件不完整");
    return result;
  }
  return { directory, read };
}
