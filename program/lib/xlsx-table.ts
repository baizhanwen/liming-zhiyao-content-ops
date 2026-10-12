import { openBoundedZip } from "./bounded-zip";
import { excelSerialDate } from "./import-date";

const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_XML_ELEMENTS = 100_000;
const MAX_COLUMNS = 256;
const MAX_CELLS = 100_000;
const MAX_PHYSICAL_ROWS = 10_000;
const MAX_CELL_TEXT = 32_767;

function elements(root: Document | Element, name: string) {
  return Array.from(root.getElementsByTagNameNS("*", name));
}
async function xml(blob: Blob | undefined, name: string, signal?: AbortSignal) {
  if (!blob) throw new Error("Excel 文件缺少" + name);
  const text = await blob.text();
  signal?.throwIfAborted();
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "<") continue;
    const endToken = text.startsWith("<![CDATA[", index) ? "]]>" : text.startsWith("<!--", index) ? "-->" : text.startsWith("<?", index) ? "?>" : null;
    if (endToken) { const end = text.indexOf(endToken, index + 2); if (end >= 0) { index = end + endToken.length - 1; continue; } }
    if (/^<!\s*(DOCTYPE|ENTITY)\b/i.test(text.slice(index, index + 20))) throw new Error("Excel XML 含不支持的实体声明，请重新导出文件。");
    if (text[index + 1] !== "/" && ++count > MAX_XML_ELEMENTS) throw new Error("Excel XML 结构过多，请拆分数据或清除多余格式后重新导出。");
  }
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("Excel 文件中的" + name + "无法解析");
  return document;
}
function coordinate(reference: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(reference);
  if (!match) throw new Error("Excel 单元格坐标无效。");
  const column = Array.from(match[1].toUpperCase()).reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]);
  if (column >= 16_384 || row > 1_048_576) throw new Error("Excel 单元格坐标超出工作表范围。");
  return { column, row };
}
function cellText(cell: Element) {
  const text = elements(cell, "t").filter(item => {
    for (let parent = item.parentElement; parent && parent !== cell; parent = parent.parentElement) if (parent.localName === "rPh") return false;
    return true;
  }).map(item => item.textContent || "").join("");
  if (text.length > MAX_CELL_TEXT) throw new Error("Excel 单元格文本过长，请按模板拆分内容。");
  return text;
}
function sheetPath(target: string) {
  if (!target || target.includes("\\") || target.includes(":") || target.includes("?") || target.includes("#")) throw new Error("Excel 首个工作表关联无效。");
  const parts = (target.startsWith("/") ? target.slice(1) : "xl/" + target).split("/"), resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!resolved.length) throw new Error("Excel 工作表关联超出文件范围。"); resolved.pop(); }
    else resolved.push(part);
  }
  return resolved.join("/");
}

export async function readFirstWorksheet(file: File, options: { maximumBytes?: number; maximumRows?: number; signal?: AbortSignal; dateHeaders?: string[]; offsetMinutes?: number } = {}) {
  const maximumRows = options.maximumRows ?? 500, maximumBytes = options.maximumBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 500 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 20 * 1024 * 1024) throw new Error("Excel 读取范围无效。");
  if (file.size > maximumBytes) throw new Error(`Excel 文件不能超过 ${maximumBytes / 1024 / 1024} MiB，请拆分文件后重试。`);
  const archive = await openBoundedZip(file, { maximumBytes, maximumFiles: 4096, label: "Excel", signal: options.signal });
  const metadata = await archive.read(new Map([["xl/workbook.xml", MAX_METADATA_BYTES], ["xl/_rels/workbook.xml.rels", MAX_METADATA_BYTES]]), 2 * MAX_METADATA_BYTES);
  const workbook = await xml(metadata.get("xl/workbook.xml"), "工作簿", options.signal), relationships = await xml(metadata.get("xl/_rels/workbook.xml.rels"), "工作表关系", options.signal);
  const properties = elements(workbook, "workbookPr");
  if (properties.length > 1) throw new Error("Excel 工作簿日期属性重复，请重新导出。");
  const dateFlag = properties[0]?.getAttribute("date1904")?.trim();
  if (dateFlag != null && !["0", "1", "false", "true"].includes(dateFlag)) throw new Error("Excel 日期系统属性无效，请重新导出。");
  const date1904 = dateFlag === "1" || dateFlag === "true";
  const sheet = elements(workbook, "sheet")[0];
  const id = sheet?.getAttribute("r:id") || sheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const matches = elements(relationships, "Relationship").filter(item => item.getAttribute("Id") === id);
  if (!id || matches.length !== 1 || matches[0].getAttribute("TargetMode") === "External") throw new Error("Excel 首个工作表关联缺失、重复或指向外部，请重新导出。");
  const path = sheetPath(matches[0].getAttribute("Target") || "");
  const needed = new Map([[path, MAX_XML_BYTES]]);
  if (archive.directory.has("xl/sharedStrings.xml")) needed.set("xl/sharedStrings.xml", MAX_XML_BYTES);
  const content = await archive.read(needed, 2 * MAX_XML_BYTES);
  const sharedDocument = content.has("xl/sharedStrings.xml") ? await xml(content.get("xl/sharedStrings.xml"), "共享文本", options.signal) : null;
  const sharedStrings = sharedDocument ? elements(sharedDocument, "si").map(cellText) : [];
  if (sharedStrings.length > MAX_CELLS) throw new Error("Excel 共享文本数量过多，请分批整理。");
  const document = await xml(content.get(path), "首个工作表", options.signal), rawRows = elements(document, "row");
  if (rawRows.length > MAX_PHYSICAL_ROWS) throw new Error("Excel 格式行过多，请清除空行格式或拆分文件。");
  let cells = 0, previousRow = 0;
  const rows: Map<number, unknown>[] = [];
  for (const row of rawRows) {
    const rowReference = row.getAttribute("r");
    if (rowReference != null && !/^[1-9]\d*$/.test(rowReference)) throw new Error("Excel 行坐标无效。");
    const rowNumber = rowReference == null ? previousRow + 1 : Number(rowReference);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= previousRow || rowNumber > 1_048_576) throw new Error("Excel 行坐标重复、乱序或无效。");
    previousRow = rowNumber;
    const values = new Map<number, unknown>(), columns = new Set<number>(); let nextColumn = 0;
    for (const cell of elements(row, "c")) {
      if (++cells > MAX_CELLS) throw new Error("Excel 单元格数量过多，请分批整理。");
      const reference = cell.getAttribute("r"), position = reference ? coordinate(reference) : { column: nextColumn, row: rowNumber };
      if (position.column >= 16_384 || position.row !== rowNumber || columns.has(position.column)) throw new Error("Excel 单元格坐标重复或与行不一致。");
      columns.add(position.column); nextColumn = position.column + 1;
      const type = cell.getAttribute("t"), valueElement = elements(cell, "v")[0], raw = valueElement?.textContent || "";
      if (elements(cell, "f").length && !valueElement) throw new Error("Excel 公式没有保存计算结果，请在 Excel 中重新计算并保存，或粘贴为值后再导入。");
      let value: unknown;
      if (type === "s") {
        const index = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) throw new Error("Excel 共享文本索引无效，未将缺失文本替换为空值。");
        value = sharedStrings[index];
      } else if (type === "inlineStr") value = cellText(cell);
      else if (type === "str" || type === "d") value = raw;
      else if (type === "e") throw new Error("Excel 含错误单元格，请修正后再导入。");
      else if (type === "b") { if (raw !== "0" && raw !== "1") throw new Error("Excel 布尔单元格值无效。"); value = raw === "1"; }
      else if (!type || type === "n") { if (raw && !Number.isFinite(Number(raw))) throw new Error("Excel 数值单元格无效。"); value = raw === "" ? "" : Number(raw); }
      else throw new Error("Excel 单元格类型不支持，请重新导出或粘贴为值。");
      if (typeof value === "string" && value.length > MAX_CELL_TEXT) throw new Error("Excel 单元格文本过长，请按模板拆分内容。");
      if (value !== "") {
        if (String(value ?? "").trim() && position.column >= MAX_COLUMNS) throw new Error("Excel 导入表最多 256 列，请整理为模板列后重新导入。");
        values.set(position.column, value);
      }
    }
    if (Array.from(values.values()).some(value => String(value ?? "").trim())) rows.push(values);
    if (rows.length > maximumRows + 1) throw new Error(`单次最多导入 ${maximumRows} 行，请拆分文件后重试。`);
  }
  if (rows.length < 2) throw new Error("Excel 首个工作表没有可导入的数据行");
  const headers = new Map<number, string>(), names = new Set<string>();
  for (const [column, value] of rows[0]) {
    const header = String(value ?? "").replace(/^\uFEFF/, "").trim();
    if (!header) continue;
    if (names.has(header)) throw new Error(`Excel 表头“${header}”重复，请保留唯一字段后再导入。`);
    names.add(header); headers.set(column, header);
  }
  return rows.slice(1).map(row => {
    for (const [column, value] of row) if (!headers.has(column) && String(value ?? "").trim()) throw new Error("Excel 数据列没有对应表头，未忽略这些数据。请补全首行表头。");
    return Object.fromEntries(Array.from(headers, ([column, header]) => {
      const value = row.get(column) ?? "";
      return [header, options.dateHeaders?.includes(header) && typeof value === "number" ? excelSerialDate(value, date1904, options.offsetMinutes ?? 0) : value];
    }));
  });
}
