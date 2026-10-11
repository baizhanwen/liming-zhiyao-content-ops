import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Check copies: SQLite may recover WAL/SHM while opening a database. Never let
// validation checkpoint or rewrite the archive's extracted state or live state.
const state = path.resolve(process.argv[2] || "");
let scratch;
function removeValidationScratch() {
  const resolved = path.resolve(scratch), parent = path.resolve(path.dirname(state));
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith("dbv-") || lstatSync(resolved).isSymbolicLink()) throw new Error("Invalid validation cleanup path.");
  rmSync(resolved, { recursive: true, force: true });
}
try {
  if (!process.argv[2] || !lstatSync(state).isDirectory() || lstatSync(state).isSymbolicLink()) throw new Error("State directory is unavailable or a filesystem link.");
  const databases = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Database paths cannot be filesystem links.");
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("Database paths cannot be filesystem links.");
      if (item.isDirectory()) visit(filename);
      else if (item.name.endsWith(".sqlite")) databases.push(filename);
    }
  }
  visit(path.join(state, "v3/d1")); visit(path.join(state, "v3/r2"));
  if (!databases.some(filename => filename.startsWith(path.join(state, "v3/d1") + path.sep))) throw new Error("Local D1 database is missing.");
  scratch = mkdtempSync(path.join(path.dirname(state), "dbv-"));
  for (const [index, filename] of databases.entries()) {
    const directory = path.join(scratch, String(index)); mkdirSync(directory);
    const clone = path.join(directory, "check.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(filename + suffix)) {
        if (lstatSync(filename + suffix).isSymbolicLink()) throw new Error("Database companions cannot be filesystem links.");
        copyFileSync(filename + suffix, clone + suffix);
      }
    }
    let db;
    try {
      db = new DatabaseSync(clone, { readOnly: true });
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed.");
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error("SQLite database has an empty schema.");
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite foreign-key check failed.");
    } finally { db?.close(); }
  }
  console.log(`Database validation passed: ${databases.length} database(s).`);
} catch (error) {
  // Do not print rows, configuration contents or source SQL.
  console.error(`Database validation failed: ${error.message}`); process.exitCode = 1;
} finally {
  if (scratch) {
    try { removeValidationScratch(); }
    catch (error) { console.error(`Database validation cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
