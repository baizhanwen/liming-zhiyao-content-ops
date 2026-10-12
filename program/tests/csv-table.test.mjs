import assert from "node:assert/strict";
import test from "node:test";
import { readCsvTable, CSV_MAX_BYTES } from "../lib/csv-table.ts";
const file = text => new File([text], "synthetic.csv", { type: "text/csv" });
const options = { requiredHeaders: ["作品名称", "发布时间", "播放量"] };
const header = "作品名称,发布时间,播放量\n";

test("UTF-8 BOM, whitespace headers and leading-zero text retain original values", async () => {
  assert.deepEqual(await readCsvTable(file('\ufeff 作品名称 , 发布时间 , 播放量 \r\n001,2026-10-13,0007\r\n'), options), [{ 作品名称: "001", 发布时间: "2026-10-13", 播放量: "0007" }]);
});
test("quoted commas, quotes and newlines are preserved", async () => {
  const rows = await readCsvTable(file(header + '"中文,\n""标题""",2026-10-13,7\n'), options);
  assert.equal(rows[0].作品名称, '中文,\n"标题"');
});
test("UTF-8 characters across parser chunks remain intact", async () => {
  const titles = Array.from({ length: 100 }, (_, i) => "中文😀".repeat(200) + i), text = header + titles.map(title => `${title},2026-10-13,7`).join("\n");
  assert.ok(text.length > 64 * 1024);
  const rows = await readCsvTable(file(text), options);
  assert.deepEqual(rows.map(row => row.作品名称), titles);
});
test("500 rows are accepted and 501 rows reject the entire file", async () => {
  const lines = Array.from({ length: 501 }, (_, i) => `作品${i},2026-10-13,7`);
  assert.equal((await readCsvTable(file(header + lines.slice(0,500).join("\n")), options)).length, 500);
  await assert.rejects(readCsvTable(file(header + lines.join("\n")), options), /最多导入 500/);
});
test("byte overflow is refused before any file read", async () => {
  let reads = 0;
  await assert.rejects(readCsvTable({ size: CSV_MAX_BYTES + 1, arrayBuffer() { reads++; throw new Error("must not read"); } }), /超过 20 MiB/);
  assert.equal(reads, 0);
});
test("actual size mismatch, empty input and UTF-8 errors are explicit", async () => {
  await assert.rejects(readCsvTable({ size: 1, arrayBuffer: async () => new ArrayBuffer(2) }), /长度不一致/);
  await assert.rejects(readCsvTable(file("")), /为空/);
  await assert.rejects(readCsvTable(new File([new Uint8Array([0xff,0xfe,0x61])], "bad.csv")), /有效 UTF-8/);
  await assert.rejects(readCsvTable(file(header + "bad\0title,2026-10-13,7")), /空字符/);
});
test("duplicate normalized headers reject rather than auto-renaming a metric", async () => {
  await assert.rejects(readCsvTable(file("作品名称,发布时间,播放量, 播放量 \n作品,2026-10-13,1,9"), options), /表头.*重复/);
});
test("required metric and association headers cannot silently disappear", async () => {
  await assert.rejects(readCsvTable(file("作品名称,发布时间\n作品,2026-10-13"), options), /缺少.*播放量/);
  await assert.rejects(readCsvTable(file("observed_at,views\n2026-10-13,7"), { requiredHeaders: ["observed_at","views"], oneOfHeaders: ["publication_id","external_url"] }), /至少需要/);
  assert.equal((await readCsvTable(file("external_url,observed_at,views\nhttps://example.invalid/v,2026-10-13,7"), { requiredHeaders: ["observed_at","views"], oneOfHeaders: ["publication_id","external_url"] })).length, 1);
});
test("too few or too many fields and damaged quotes reject all rows", async () => {
  for (const row of ["作品,2026-10-13", "作品,2026-10-13,1,2", '"作品,2026-10-13,1']) await assert.rejects(readCsvTable(file(header + "正常,2026-10-13,7\n" + row), options), /字段数|格式无效/);
});
test("blank unnamed columns can be skipped but data without a header is refused", async () => {
  assert.equal((await readCsvTable(file(header.trimEnd() + ",\n作品,2026-10-13,7,\n"), options)).length, 1);
  await assert.rejects(readCsvTable(file(header.trimEnd() + ",\n作品,2026-10-13,7,unknown\n"), options), /没有列名/);
});
test("column count, cell length and excess empty records are bounded", async () => {
  await assert.rejects(readCsvTable(file(Array.from({length:257},(_,i)=>"h"+i).join(",") + "\n")), /列数/);
  await assert.rejects(readCsvTable(file(header + "长".repeat(32768) + ",2026-10-13,7"), options), /单元格文本过长/);
  await assert.rejects(readCsvTable(file(header + "作品,2026-10-13,7\n" + "\n".repeat(10001)), options), /记录过多/);
});
test("multimegabyte unclosed record is stopped while chunks are still incomplete", async () => {
  await assert.rejects(readCsvTable(file(header + '"' + "x".repeat(2*1024*1024)), options), /单条记录过长|引号未闭合/);
});
test("semicolon and tab delimiters are still supported", async () => {
  for (const separator of [";","\t"]) assert.equal((await readCsvTable(file(header.trim().replaceAll(",", separator) + "\n" + ["作品","2026-10-13","7"].join(separator)), options)).length, 1);
});
test("blank records are skipped and no-data files have a clear error", async () => {
  assert.equal((await readCsvTable(file("\n  , , \n" + header + "作品,2026-10-13,7\n\n"), options)).length, 1);
  await assert.rejects(readCsvTable(file(header), options), /没有可导入/);
});
test("pre-cancelled input is never read", async () => {
  const controller = new AbortController(); controller.abort(); let reads = 0;
  await assert.rejects(readCsvTable({ size: 1, arrayBuffer() { reads++; return Promise.resolve(new ArrayBuffer(1)); } }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 0);
});
test("cancelling a pending read rejects immediately and late bytes cannot resolve it", async () => {
  const controller = new AbortController(); let release;
  const pending = readCsvTable({ size: 1, arrayBuffer: () => new Promise(resolve => { release = resolve; }) }, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: "AbortError" }); release(new ArrayBuffer(1));
});
test("chunk yields permit cancellation before the complete result is retained", async () => {
  const controller = new AbortController(), text = header + Array.from({length:500}, (_,i) => "中文".repeat(1000) + i + ",2026-10-13,7").join("\n");
  const pending = readCsvTable(file(text), { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
});
