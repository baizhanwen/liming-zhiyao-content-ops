import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { MATERIAL_MAX_ARCHIVE_BYTES, MATERIAL_MAX_ARCHIVE_FILES, MATERIAL_MAX_ASSETS_PER_ENTRY, MATERIAL_MAX_ENTRIES, MATERIAL_MAX_MANIFEST_BYTES, MATERIAL_MAX_MEDIA_BYTES } from "./material-transfer-limits";

type ArchiveEntry = { assets?: Array<{ blobName: string }> };
type ArchiveManifest = { format: string; version: number; entries: ArchiveEntry[] };
type DirectoryEntry = { name: string; size: number; originalSize: number; compression: number };

function invalid(message: string): never { throw new Error(message); }
function validName(name: string) {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in ZIP member names before extraction.
  return name === "manifest.json" || name === "media/" || /^media\/[^/\\\x00-\x1f]{1,200}$/.test(name) && !["media/.", "media/.."].includes(name);
}

export async function readMaterialResponse(response: Response, maximum: number, message: string) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) { await response.body?.cancel().catch(() => {}); return invalid(message); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), parts: BlobPart[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) return invalid(message);
      parts.push(Uint8Array.from(value).buffer);
    }
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function materialManifestFiles(value: unknown) {
  if (!value || typeof value !== "object") return invalid("迁移包清单格式不正确。");
  const manifest = value as ArchiveManifest;
  if (manifest.format !== "liming-video-library-package" || manifest.version !== 1 || !Array.isArray(manifest.entries)) return invalid("请选择本系统导出的素材中心迁移包。");
  if (!manifest.entries.length || manifest.entries.length > MATERIAL_MAX_ENTRIES) return invalid("每包须包含 1 到 100 条素材，请分批迁移。");
  const names = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || entry.assets != null && !Array.isArray(entry.assets)) return invalid("迁移包附件清单格式不正确。");
    if ((entry.assets?.length ?? 0) > MATERIAL_MAX_ASSETS_PER_ENTRY) return invalid("单条素材最多 120 个附件，请分批迁移或使用完整备份。");
    const entryNames = new Set<string>();
    for (const asset of entry.assets ?? []) {
      const name = asset?.blobName;
      if (typeof name !== "string" || !name || !validName(`media/${name}`) || entryNames.has(name)) return invalid("迁移包附件名称无效或同条素材内重复。");
      entryNames.add(name); names.add(name);
    }
  }
  return { manifest, names };
}

export async function readMaterialArchive(file: Blob) {
  if (file.size > MATERIAL_MAX_ARCHIVE_BYTES) return invalid("迁移 ZIP 过大，未解压或上传；请分批导出，媒体合计最多 750 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MATERIAL_MAX_ARCHIVE_BYTES) return invalid("迁移 ZIP 过大，未解压或上传。");
  const directory = new Map<string, DirectoryEntry>();
  let mediaBytes = 0;
  // filter=false reads directory metadata without allocating expanded files.
  try {
    unzipSync(bytes, { filter(info) {
      if (!validName(info.name) || directory.has(info.name)) return invalid("迁移 ZIP 文件名无效或重复，未上传。");
      if (directory.size >= MATERIAL_MAX_ARCHIVE_FILES) return invalid("迁移 ZIP 文件数量超限，请分批迁移。");
      if (![0, 8].includes(info.compression) || !Number.isSafeInteger(info.originalSize) || info.originalSize < 0) return invalid("迁移 ZIP 的压缩方式或文件大小无效。");
      if (info.name === "manifest.json") {
        if (info.originalSize > MATERIAL_MAX_MANIFEST_BYTES) return invalid("迁移包清单超过 20000000 字节，未解压或上传。");
      } else {
        if (info.name.endsWith("/") && info.originalSize !== 0) return invalid("迁移 ZIP 目录记录无效。");
        mediaBytes += info.originalSize;
        if (mediaBytes > MATERIAL_MAX_MEDIA_BYTES) return invalid("迁移包解压后的媒体超过 750 MiB，未解压或上传；请分批迁移。");
      }
      directory.set(info.name, info); return false;
    } });
  } catch (error) { throw new Error(error instanceof Error && error.message.includes("迁移") ? error.message : "迁移 ZIP 损坏或格式不支持，未上传。"); }
  if (!directory.has("manifest.json")) return invalid("迁移包缺少 manifest.json。");

  const files = new Map<string, Blob>(), seen = new Set<string>();
  let streamError: Error | null = null, lastYield = Date.now();
  const unzip = new Unzip(entry => {
    const expected = directory.get(entry.name);
    if (!expected || seen.has(entry.name) || entry.compression !== expected.compression || entry.originalSize != null && entry.originalSize !== expected.originalSize || entry.size != null && entry.size !== expected.size) return invalid("迁移 ZIP 目录与实际文件不一致，未上传。");
    seen.add(entry.name);
    const parts: BlobPart[] = []; let expanded = 0;
    entry.ondata = (error, chunk, final) => {
      if (streamError) return;
      if (error) { streamError = new Error("迁移 ZIP 解压失败，未上传。"); return; }
      expanded += chunk.length;
      if (expanded > expected.originalSize) { streamError = new Error("迁移 ZIP 实际展开量超过声明大小，未上传。"); return; }
      parts.push(Uint8Array.from(chunk).buffer);
      if (final) {
        if (expanded !== expected.originalSize) { streamError = new Error("迁移 ZIP 文件不完整，未上传。"); return; }
        files.set(entry.name, new Blob(parts));
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small compressed chunks also bound the temporary output from a forged
    // size declaration. Yield during long archives so the UI can paint.
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
      if (streamError) throw streamError;
      if (Date.now() - lastYield >= 16) { await new Promise(resolve => setTimeout(resolve, 0)); lastYield = Date.now(); }
    }
  } catch (error) { throw new Error(error instanceof Error && error.message.includes("迁移") ? error.message : "迁移 ZIP 损坏或格式不支持，未上传。"); }
  if (files.size !== directory.size) return invalid("迁移 ZIP 文件不完整，未上传。");
  let parsed: unknown;
  try { parsed = JSON.parse(await files.get("manifest.json")!.text()); } catch { return invalid("迁移包清单不是有效 JSON，未上传。"); }
  const { manifest, names } = materialManifestFiles(parsed);
  for (const name of names) if (!files.has(`media/${name}`)) return invalid(`迁移包缺少媒体文件 ${name}，未上传。`);
  for (const name of files.keys()) if (name.startsWith("media/") && name !== "media/" && !names.has(name.slice(6))) return invalid("迁移 ZIP 含清单以外的媒体文件，未上传。");
  return { manifest, files };
}
