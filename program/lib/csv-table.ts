import Papa from "papaparse";

export const CSV_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 500, MAX_RECORDS = 10_000, MAX_COLUMNS = 256, MAX_CELL_TEXT = 32_767;
const CHUNK_CHARACTERS = 64 * 1024;
const MAX_RECORD_CHARACTERS = 1024 * 1024;

function readBytes(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let reader: FileReader | undefined, settled = false;
    const finish = (error?: unknown, bytes?: ArrayBuffer) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      if (reader) reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error); else resolve(bytes!);
    };
    const abort = () => { finish(signal?.reason || new DOMException("读取已取消", "AbortError")); reader?.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (typeof FileReader !== "undefined") {
      reader = new FileReader();
      reader.onload = () => reader?.result instanceof ArrayBuffer ? finish(undefined, reader.result) : finish(new Error("CSV 文件读取不完整，请重新选择。"));
      reader.onerror = () => finish(new Error("CSV 文件读取失败，请重新选择。"));
      reader.onabort = () => finish(new DOMException("读取已取消", "AbortError"));
      try { reader.readAsArrayBuffer(file); } catch (error) { finish(error); }
    } else {
      // Node fixtures use Blob.arrayBuffer; browsers use cancellable FileReader.
      file.arrayBuffer().then(bytes => finish(undefined, bytes), finish);
    }
  });
}

export async function readCsvTable(file: File, options: { signal?: AbortSignal; requiredHeaders?: string[]; oneOfHeaders?: string[] } = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error("CSV 文件为空或大小无效，请重新选择。");
  if (file.size > CSV_MAX_BYTES) throw new Error("CSV 文件超过 20 MiB，请拆分文件后重试。");
  const bytes = await readBytes(file, signal);
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size || bytes.byteLength > CSV_MAX_BYTES) throw new Error("CSV 文件读取长度不一致，请重新选择。");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("CSV 不是有效 UTF-8，请使用“CSV UTF-8”重新导出，或使用 XLSX 文件。"); }
  if (text.includes("\0")) throw new Error("CSV 含无效空字符，请使用“CSV UTF-8”重新导出。");
  signal?.throwIfAborted();
  return new Promise<Array<Record<string, string>>>((resolve, reject) => {
    const rows: Array<Record<string, string>> = [];
    let headers: string[] | undefined, records = 0, chunks = 0, parser: Papa.Parser | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown, handle = parser) => {
      if (settled) return;
      settled = true; cleanup(); reject(error); handle?.abort();
    };
    const abort = () => fail(signal?.reason || new DOMException("解析已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      Papa.parse<string[]>(text, {
        header: false, dynamicTyping: false, skipEmptyLines: false, chunkSize: CHUNK_CHARACTERS,
        // Ignore blank records while guessing, but count them in the real parse.
        delimiter: (input: string) => Papa.parse<string[]>(input, { preview: 10, skipEmptyLines: "greedy" }).meta.delimiter,
        step: (result, handle) => {
          parser = handle;
          if (settled) return;
          try {
            signal?.throwIfAborted();
            if (++records > MAX_RECORDS) throw new Error("CSV 记录过多（含空记录），请清除多余空行或拆分文件。");
            if (result.errors.length) throw new Error(`CSV 第 ${records} 条记录格式无效，请核对引号和分隔符后重新导出。`);
            const values = result.data;
            if (values.length > MAX_COLUMNS) throw new Error("CSV 列数超过 256，请按模板整理后重试。");
            if (values.some(value => value.length > MAX_CELL_TEXT)) throw new Error(`CSV 第 ${records} 条记录的单元格文本过长，请拆分内容。`);
            if (values.every(value => !value.trim())) return;
            if (!headers) {
              headers = values.map(value => value.replace(/^\uFEFF/, "").trim());
              const seen = new Set<string>();
              for (const name of headers.filter(Boolean)) {
                if (seen.has(name)) throw new Error(`CSV 表头“${name.slice(0, 80)}”重复，请保留一列后重试。`);
                seen.add(name);
              }
              for (const name of options.requiredHeaders || []) if (!seen.has(name)) throw new Error(`CSV 缺少必需表头“${name}”，请使用对应模板。`);
              if (options.oneOfHeaders?.length && !options.oneOfHeaders.some(name => seen.has(name))) throw new Error(`CSV 至少需要 ${options.oneOfHeaders.join(" 或 ")} 表头，请使用对应模板。`);
              return;
            }
            if (values.length !== headers.length) throw new Error(`CSV 第 ${records} 条记录的字段数与表头不一致，请修正后重试。`);
            if (rows.length >= MAX_ROWS) throw new Error("单次最多导入 500 行，请拆分文件后重试。");
            const entries: Array<[string, string]> = [];
            headers.forEach((name, index) => {
              if (!name && values[index].trim()) throw new Error(`CSV 第 ${records} 条记录有数据却没有列名，请补齐表头。`);
              if (name) entries.push([name, values[index]]);
            });
            rows.push(Object.fromEntries(entries));
          } catch (error) { fail(error, handle); }
        },
        chunk: (result: Papa.ParseResult<string[]>, handle: Papa.Parser) => {
          parser = handle;
          if (settled) return;
          // Papa retains an incomplete quoted record across chunks. Bound it to
          // avoid repeatedly rescanning a malformed multi-megabyte record.
          const end = Math.min(text.length, ++chunks * CHUNK_CHARACTERS);
          if (end - result.meta.cursor > MAX_RECORD_CHARACTERS) { fail(new Error("CSV 单条记录过长或引号未闭合，请缩短内容并核对引号。"), handle); return; }
          handle.pause();
          timer = setTimeout(() => { timer = undefined; if (!settled) handle.resume(); }, 0);
        },
        complete: () => {
          if (settled) return;
          settled = true; cleanup();
          if (!headers || !rows.length) reject(new Error("CSV 文件没有可导入的数据行。")); else resolve(rows);
        },
        error: (error: Error) => fail(new Error(error.message || "CSV 解析失败，请重新导出。")),
      });
    } catch (error) { fail(error); }
  });
}
