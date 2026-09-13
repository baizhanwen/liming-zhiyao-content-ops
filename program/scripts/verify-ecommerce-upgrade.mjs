import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// Run only after stopping the local app and analyzer. All migration writes go
// to a restored copy. Original state is read for byte-for-byte backup checks.
const root = fileURLToPath(new URL("..", import.meta.url));
const backupPath = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && backupPath.startsWith(path.join(root, "backups") + path.sep), "Select a backup inside this installation's backups directory");
const runDir = path.join(root, ".local", `ecup-${Date.now().toString(36)}`);
mkdirSync(runDir, { recursive: true });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(e => {
  assert.ok(!e.isSymbolicLink(), "Backup validation does not follow filesystem links");
  return e.isDirectory() ? walk(path.join(directory, e.name)) : [path.join(directory, e.name)];
});
function snapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return {
      integrity: db.prepare("PRAGMA integrity_check").all().map(row => ({ ...row })),
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all().map(row => ({ ...row })),
      tables: Object.fromEntries(tables.map(({ name, sql }) => {
        const statement = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`); statement.setReadBigInts(true);
        const rows = statement.all().map(row => JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)).sort();
        return [name, { rows: rows.length, schemaHash: sha(sql ?? ""), contentHash: sha(JSON.stringify(rows)) }];
      })),
    };
  } finally { db.close(); }
}
try {
  const contents = Object.fromEntries(Object.entries(unzipSync(readFileSync(backupPath))).map(([name, bytes]) => [name.replaceAll("\\", "/"), bytes]));
  assert.ok(contents["manifest.json"], "Backup manifest missing");
  for (const [name, bytes] of Object.entries(contents)) {
    if (name.endsWith("/")) continue;
    const destination = path.resolve(runDir, name);
    assert.ok(destination.startsWith(runDir + path.sep), "Backup path escapes restore directory");
    mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, bytes);
  }
  const restoredState = path.join(runDir, "state"), originalState = path.join(root, ".wrangler/state");
  const originals = walk(originalState), restored = walk(restoredState);
  assert.equal(restored.length, originals.length, "Backup must restore every state file");
  // SQLite shared-memory indexes can change even during read-only inspection.
  // DB/WAL bytes and all media files must match; recovered SQL is checked below.
  const durableFiles = originals.filter(file => !file.endsWith(".sqlite-shm"));
  for (const file of durableFiles) assert.equal(sha(readFileSync(path.join(restoredState, path.relative(originalState, file)))), sha(readFileSync(file)), "Restored state differs from original");
  console.log(JSON.stringify({ check: "backup-restored-all-state-files", count: restored.length, runDir }));

  const configDir = path.join(path.dirname(backupPath), path.basename(backupPath, ".zip") + "-config");
  mkdirSync(configDir, { recursive: true });
  const configs = [".dev.vars", ".env", ".env.local", "wrangler.local.jsonc", ...readdirSync(path.join(root, ".local")).filter(name => /cookie.*\.txt$/i.test(name)).map(name => `.local/${name}`)].filter(file => existsSync(path.join(root, file)));
  const configHashes = {};
  for (const file of configs) {
    const destination = path.join(configDir, file); mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
    configHashes[file] = sha(readFileSync(destination));
    assert.equal(configHashes[file], sha(readFileSync(path.join(root, file))));
  }
  writeFileSync(path.join(configDir, "manifest.json"), JSON.stringify({ private: true, files: configHashes }, null, 2));
  const d1Directory = "v3/d1/miniflare-D1DatabaseObject";
  const databases = readdirSync(path.join(restoredState, d1Directory)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
  assert.equal(databases.length, 1, "Identify the business D1 explicitly if this installation contains multiple databases");
  const relativeDb = path.join(d1Directory, databases[0]);
  const before = snapshot(path.join(restoredState, relativeDb));
  assert.deepEqual(before.integrity, [{ integrity_check: "ok" }]);
  assert.ok(!before.tables.ecommerce_tasks, "This rehearsal expects the pre-ecommerce baseline");
  writeFileSync(path.join(runDir, "before.json"), JSON.stringify(before, null, 2));
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.local.jsonc", "--persist-to", restoredState], {
    cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", MINIFLARE_REGISTRY_PATH: path.join(runDir, "registry") },
  });
  writeFileSync(path.join(runDir, "migration.log"), (result.stdout ?? "") + (result.stderr ?? ""));
  assert.equal(result.status, 0, `Migration failed; inspect ${path.join(runDir, "migration.log")}`);
  const after = snapshot(path.join(restoredState, relativeDb));
  assert.deepEqual(after.integrity, [{ integrity_check: "ok" }]);
  assert.deepEqual(after.foreignKeys, before.foreignKeys, "Migration introduces foreign key violations");
  const preserved = Object.keys(before.tables).filter(name => !["d1_migrations", "_cf_METADATA"].includes(name));
  for (const name of preserved) assert.deepEqual(after.tables[name], before.tables[name], `Existing data/schema changed: ${name}`);
  // Wrangler advances its internal metadata counter when executing SQL.
  // Its schema remains fixed; all business table rows are compared above.
  assert.equal(after.tables._cf_METADATA.schemaHash, before.tables._cf_METADATA.schemaHash);
  const added = Object.keys(after.tables).filter(name => !before.tables[name]);
  assert.equal(added.length, 13); assert.ok(added.every(name => name.startsWith("ecommerce_") && after.tables[name].rows === 0));
  // Recovery proof: re-extract the original database and its WAL sidecars;
  // opening that backup still recovers the exact pre-upgrade data and schema.
  const recoveredDir = path.join(runDir, "recovered"); mkdirSync(recoveredDir);
  const sourceEntry = "state/" + relativeDb.split(path.sep).join("/");
  for (const suffix of ["", "-wal", "-shm"]) if (contents[sourceEntry + suffix]) writeFileSync(path.join(recoveredDir, databases[0] + suffix), contents[sourceEntry + suffix]);
  assert.deepEqual(snapshot(path.join(recoveredDir, databases[0])), before);
  assert.deepEqual(snapshot(path.join(originalState, relativeDb)), before, "Rehearsal must not migrate the live database");
  const report = { passed: true, backupPath, configDir, originalState, relativeDb, restoredFiles: restored.length, byteMatchedFiles: durableFiles.length, transientSharedMemoryFiles: originals.length - durableFiles.length, preservedTables: preserved, addedTables: added, before, after, recoveryMatchesBaseline: true, liveDatabaseUnchanged: true };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, preservedTables: preserved.length, addedTables: added.length, runDir }));
} catch (error) {
  writeFileSync(path.join(runDir, "failure.json"), JSON.stringify({ error: error.message }, null, 2));
  console.error(JSON.stringify({ passed: false, error: error.message, runDir })); process.exitCode = 1;
}
