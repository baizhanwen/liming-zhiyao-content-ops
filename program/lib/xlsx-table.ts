import { strFromU8, unzipSync } from "fflate";

function xml(bytes: Uint8Array | undefined, name: string) {
  if (!bytes) throw new Error("Excel 文件缺少" + name);
  const document = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  if (document.querySelector("parsererror")) throw new Error("Excel 文件中的" + name + "无法解析");
  return document;
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  return Array.from(letters).reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export async function readFirstWorksheet(file: File) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const sharedDocument = archive["xl/sharedStrings.xml"] ? xml(archive["xl/sharedStrings.xml"], "共享文本") : null;
  const sharedStrings = sharedDocument ? Array.from(sharedDocument.getElementsByTagName("si")).map((item) => Array.from(item.getElementsByTagName("t")).map((text) => text.textContent || "").join("")) : [];
  const workbook = xml(archive["xl/workbook.xml"], "工作簿");
  const sheetElement = workbook.getElementsByTagName("sheet")[0];
  const relationshipId = sheetElement?.getAttribute("r:id") || sheetElement?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const relationships = xml(archive["xl/_rels/workbook.xml.rels"], "工作表关系");
  const relationship = Array.from(relationships.getElementsByTagName("Relationship")).find((item) => item.getAttribute("Id") === relationshipId);
  const target = relationship?.getAttribute("Target")?.replace(/^\//, "") || "worksheets/sheet1.xml";
  const sheetPath = target.startsWith("xl/") ? target : "xl/" + target.replace(/^\.\//, "");
  const sheet = xml(archive[sheetPath], "首个工作表");
  const rows = Array.from(sheet.getElementsByTagName("row")).map((row) => {
    const values: unknown[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const index = columnIndex(cell.getAttribute("r") || "A1"); const type = cell.getAttribute("t");
      const inline = Array.from(cell.getElementsByTagName("t")).map((item) => item.textContent || "").join("");
      const raw = cell.getElementsByTagName("v")[0]?.textContent || "";
      values[index] = type === "s" ? sharedStrings[Number(raw)] ?? "" : type === "inlineStr" ? inline : type === "b" ? raw === "1" : raw === "" ? "" : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    return values;
  });
  if (rows.length < 2) throw new Error("Excel 首个工作表没有可导入的数据行");
  const headers = rows[0].map((value) => String(value ?? "").replace(/^\uFEFF/, "").trim());
  return rows.slice(1).filter((row) => row.some((value) => String(value ?? "").trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}
