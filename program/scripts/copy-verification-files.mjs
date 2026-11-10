import assert from "node:assert/strict";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

// Node 22's native cpSync directory/overwrite fast paths mishandle non-ASCII
// Windows paths. Use the Unicode-safe file operations for acceptance copies,
// including rollback over an existing installation. Never follow links.
export function copyVerificationFiles(source, destination) {
  const metadata = lstatSync(source);
  assert.ok(!metadata.isSymbolicLink(), "Verification copies must not follow source links");
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing) assert.ok(!existing.isSymbolicLink(), "Verification copies must not follow destination links");
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyVerificationFiles(path.join(source, name), path.join(destination, name));
    return;
  }
  assert.ok(metadata.isFile(), "Verification copies only accept files and directories");
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, metadata.mode & 0o777);
}
