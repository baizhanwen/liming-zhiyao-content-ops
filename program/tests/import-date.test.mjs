import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { importDate, importDateInput, excelSerialDate } from "../lib/import-date.ts";
import { metricNumberCell, signedMetricNumberCell } from "../lib/performance-import.ts";
test("Excel date systems resolve the same 2026 calendar day", () => {
  assert.equal(excelSerialDate(46308), "2026-10-13T00:00:00.000Z");
  assert.equal(excelSerialDate(44846,true), excelSerialDate(46308));
  assert.equal(excelSerialDate(44846.5,true,480), "2026-10-13T04:00:00.000Z");
});
test("Excel historical serial boundaries and fake leap day are explicit", () => {
  assert.equal(excelSerialDate(1), "1900-01-01T00:00:00.000Z");
  assert.equal(excelSerialDate(59), "1900-02-28T00:00:00.000Z");
  assert.equal(excelSerialDate(61), "1900-03-01T00:00:00.000Z");
  assert.equal(excelSerialDate(0,true), "1904-01-01T00:00:00.000Z");
  for (const value of [60,60.5]) assert.throws(() => excelSerialDate(value), /不存在/);
  for (const value of [-1,NaN,Infinity,2958466]) assert.throws(() => excelSerialDate(value), /无效|范围/);
});
test("real leap days, slash and Chinese calendar formats are validated", () => {
  for (const value of ["2024-02-29", "2024/2/29", "2024年2月29日"]) assert.equal(importDate(value), "2024-02-29T00:00:00.000Z");
  for (const value of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-00-10", "2026-13-01", "2026-01-00", "2026-01-01T24:00:00Z", "2026-01-01T10:60:00Z", "2026-01-01T10:00:60Z"]) assert.throws(() => importDate(value), /不存在/);
});
test("explicit offsets override the selected timezone and normalize instants", () => {
  assert.equal(importDate("2026-10-13T09:00:00+08:00"), "2026-10-13T01:00:00.000Z");
  assert.equal(importDate("2026-10-13T01:00:00Z",480), "2026-10-13T01:00:00.000Z");
  assert.equal(importDate("2026-10-13T01:00:00.12Z"), "2026-10-13T01:00:00.120Z");
  assert.equal(importDate("2026-10-13T01:00:00-03:30"), "2026-10-13T04:30:00.000Z");
});
test("date-only, naive clock and serial values honor the selected timezone", () => {
  assert.equal(importDate("2026-10-13",480), "2026-10-12T16:00:00.000Z");
  assert.equal(importDate("2026/10/13 09:00:00",480), "2026-10-13T01:00:00.000Z");
  assert.equal(importDate(46308.5,480), "2026-10-13T04:00:00.000Z");
  assert.equal(importDate("46308.5"), "2026-10-13T12:00:00.000Z");
});
test("ambiguous short dates, timestamps and invalid timezone offsets are refused", () => {
  for (const value of ["10/13/26", "13/10/2026", "20261013", "1e3", "", true, null, "2026-10-13Z", "2026-10-13T01:00:00+14:01", "2026-10-13T01:00:00+08:99"]) assert.throws(() => importDate(value));
  assert.throws(() => importDate("2026-10-13",841), /时区/);
});
test("cutoff clock display and edits preserve the same instant", () => {
  const value="2026-10-13T01:30:00.000Z";
  assert.equal(importDateInput(value,480), "2026-10-13T09:30");
  assert.equal(importDate(importDateInput(value,480),480), value);
});
test("two computer timezones produce identical results with the same selection", () => {
  const run=zone=>spawnSync(process.execPath,["--input-type=module","-e",'import {importDate} from "./lib/import-date.ts";process.stdout.write(importDate("2026-10-13 09:00:00",480));'],{encoding:"utf8",env:{...process.env,TZ:zone},windowsHide:true});
  const first=run("UTC"),second=run("America/New_York");assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);assert.equal(first.stdout,second.stdout);
});
test("fractional counters cannot silently round or exceed safe integer precision", () => {
  for (const value of [1.4,"0.4",Number.MAX_SAFE_INTEGER+1]) assert.throws(() => metricNumberCell(value), /整数/);
  assert.throws(() => signedMetricNumberCell(-1.4), /整数/);
  assert.equal(signedMetricNumberCell("-4"),-4);assert.equal(metricNumberCell("1,804"),1804);
});
