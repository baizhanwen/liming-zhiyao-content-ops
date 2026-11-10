import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyVerificationFiles } from "../scripts/copy-verification-files.mjs";

test("verification copying preserves Chinese paths and binary bytes on first install and rollback", t => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "liming-copy-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "原始 程序"), target = path.join(temporary, "客户 install");
  mkdirSync(path.join(source, "脚本"), { recursive: true });
  const bytes = Buffer.from([0, 1, 255, 0, 13, 10]);
  writeFileSync(path.join(source, "脚本", "数据.bin"), bytes);
  writeFileSync(path.join(source, ".dev.vars"), "SYNTHETIC_VALUE=中文\n");
  copyVerificationFiles(source, target);
  assert.deepEqual(readFileSync(path.join(target, "脚本", "数据.bin")), bytes);
  assert.equal(readFileSync(path.join(target, ".dev.vars"), "utf8"), "SYNTHETIC_VALUE=中文\n");
  writeFileSync(path.join(target, "脚本", "数据.bin"), "changed after install");
  copyVerificationFiles(source, target);
  assert.deepEqual(readFileSync(path.join(target, "脚本", "数据.bin")), bytes);
  assert.deepEqual(readFileSync(path.join(source, "脚本", "数据.bin")), bytes);
});
