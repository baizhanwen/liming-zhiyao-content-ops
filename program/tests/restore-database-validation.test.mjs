import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
const root = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "lz-rdb-")), installation = path.join(directory, "app");
  mkdirSync(path.join(installation, "scripts"), { recursive: true }); mkdirSync(path.join(installation, ".local"));
  for (const name of ["backup-local.ps1", "restore-local.ps1", "local-state-maintenance.ps1", "analyzer-instance-lock.ps1", "verify-state-databases.mjs"]) {
    if (existsSync(path.join(root, "scripts", name))) cpSync(path.join(root, "scripts", name), path.join(installation, "scripts", name));
  }
  writeFileSync(path.join(installation, ".local/app.port"), "59997");
  const state = path.join(installation, ".wrangler/state"), database = path.join(state, "v3/d1/miniflare-D1DatabaseObject/test.sqlite");
  mkdirSync(path.dirname(database), { recursive: true });
  const create = () => { const db = new DatabaseSync(database); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('synthetic','original');"); db.close(); };
  create();
  const run = (script, input = "") => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { cwd: installation, env: { ...process.env, RESTORE_DB_INSTALL: installation }, encoding: "utf8", input, windowsHide: true, timeout: 60000 });
  const backup = () => { const r = run("& (Join-Path $env:RESTORE_DB_INSTALL 'scripts/backup-local.ps1')"); assert.equal(r.status, 0, r.stderr || r.stdout); return readdirSync(path.join(installation, "backups")).filter(n => n.endsWith('.zip')).sort().at(-1); };
  const restore = zip => run(`& (Join-Path $env:RESTORE_DB_INSTALL 'scripts/restore-local.ps1') -BackupPath (Join-Path $env:RESTORE_DB_INSTALL 'backups/${zip}')`, "RESTORE\n");
  return { directory, installation, state, database, run, backup, restore };
}
for (const [name, corrupt] of [
  ["non-SQLite bytes", f => writeFileSync(f.database, "synthetic corrupt database")],
  ["truncated SQLite page", f => writeFileSync(f.database, readFileSync(f.database).subarray(0, 700))],
  ["empty database", f => writeFileSync(f.database, Buffer.alloc(0))],
  ["foreign-key violation", f => { const db = new DatabaseSync(f.database); db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE children(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id)); INSERT INTO children VALUES ('synthetic-orphan','missing');"); db.close(); }],
  ["corrupt R2 metadata", f => { const metadata = path.join(f.state, "v3/r2/miniflare-R2BucketObject/bucket.sqlite"); mkdirSync(path.dirname(metadata), { recursive: true }); writeFileSync(metadata, "synthetic corrupt R2 metadata"); }],
]) test(`matching archive hashes cannot authorize restoring ${name}`, { skip: process.platform !== "win32" }, () => {
  const f = fixture(), original = readFileSync(f.database); corrupt(f); const zip = f.backup();
  // Archive has correct hashes for its bad source. Restore must protect the healthy destination.
  writeFileSync(f.database, original);
  const restored = f.restore(zip); assert.notEqual(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout + restored.stderr, /database validation|SQLite|integrity|foreign.key|empty schema/i);
  assert.deepEqual(readFileSync(f.database), original);
  assert.equal(readdirSync(path.dirname(f.state)).some(name => name.startsWith("state-before-restore-")), false);
});
test("valid database and R2 metadata restore without changing configuration", { skip: process.platform !== "win32" }, () => {
  const f = fixture(), original = readFileSync(f.database);
  const metadata = path.join(f.state, "v3/r2/miniflare-R2BucketObject/bucket.sqlite"); mkdirSync(path.dirname(metadata), { recursive: true });
  const r2 = new DatabaseSync(metadata); r2.exec("CREATE TABLE objects (key TEXT PRIMARY KEY); INSERT INTO objects VALUES ('synthetic-object');"); r2.close();
  writeFileSync(path.join(f.installation, ".dev.vars"), "SYNTHETIC_SECRET=retained");
  const zip = f.backup(), db = new DatabaseSync(f.database); db.exec("UPDATE projects SET name='later';"); db.close();
  const result = f.restore(zip); assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(f.database), original); assert.equal(readFileSync(path.join(f.installation, ".dev.vars"), "utf8"), "SYNTHETIC_SECRET=retained");
});
test("WAL-only committed rows are checked and restored without checkpointing source bytes", { skip: process.platform !== "win32" }, () => {
  const f = fixture(), writer = new DatabaseSync(f.database);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO projects VALUES ('wal-only','committed');");
    const wal = f.database + "-wal", walBytes = readFileSync(wal); assert.ok(walBytes.length);
    const captured = ["", "-wal", "-shm"].filter(suffix => existsSync(f.database + suffix)).map(suffix => [suffix, readFileSync(f.database + suffix)]);
    const result = f.run(". (Join-Path $env:RESTORE_DB_INSTALL 'scripts/local-state-maintenance.ps1'); Assert-ExtractedStateDatabases (Join-Path $env:RESTORE_DB_INSTALL '.wrangler/state')");
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.deepEqual(readFileSync(wal), walBytes);
    writer.close();
    // Reconstruct a coherent stopped-process snapshot with committed data only in WAL.
    for (const [suffix, bytes] of captured) writeFileSync(f.database + suffix, bytes);
    const zip = f.backup();
    const later = new DatabaseSync(f.database); later.exec("DELETE FROM projects WHERE id='wal-only';"); later.close();
    const restored = f.restore(zip); assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    const db = new DatabaseSync(f.database); assert.equal(db.prepare("SELECT name FROM projects WHERE id='wal-only'").get().name, "committed"); db.close();
  } finally { try { writer.close(); } catch { /* already closed after archive */ } }
});
test("missing Node runtime cannot replace the destination state", { skip: process.platform !== "win32" }, () => {
  const f = fixture(), zip = f.backup(), original = readFileSync(f.database);
  const result = f.run(`
function Test-Path {
    param([string]$LiteralPath, [string]$PathType)
    if ($LiteralPath -match 'node\\.exe$') { return $false }
    if ($PathType) { return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
    return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath
}
& (Join-Path $env:RESTORE_DB_INSTALL 'scripts/restore-local.ps1') -BackupPath (Join-Path $env:RESTORE_DB_INSTALL 'backups/${zip}')
`, "RESTORE\n");
  assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /Database validation requires Node/i); assert.deepEqual(readFileSync(f.database), original);
});
