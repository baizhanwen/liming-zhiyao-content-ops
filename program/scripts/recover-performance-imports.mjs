import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kinds = {
  standard: { batch: "performance_import_batches", snapshot: "publication_metric_snapshots" },
  douyin: { batch: "platform_metric_import_batches", snapshot: "platform_metric_snapshots" },
};
export function reviewImport(db, kind, id) {
  const tables = kinds[kind];
  if (!tables) throw new Error("Choose standard or douyin.");
  const batch = db.prepare(`SELECT * FROM ${tables.batch} WHERE id=?`).get(id);
  if (!batch || batch.status !== "processing") throw new Error("Batch is missing or no longer processing; nothing changed.");
  const snapshots = db.prepare(`SELECT * FROM ${tables.snapshot} WHERE import_batch_id=? ORDER BY id`).all(id);
  const parents = kind === "standard"
    ? db.prepare("SELECT p.*,c.organization_id AS content_org,c.project_id AS content_project FROM publication_records p LEFT JOIN content_items c ON c.id=p.content_item_id WHERE p.id IN (SELECT publication_id FROM publication_metric_snapshots WHERE import_batch_id=?) ORDER BY p.id").all(id)
    : db.prepare("SELECT * FROM platform_works WHERE id IN (SELECT work_id FROM platform_metric_snapshots WHERE import_batch_id=?) ORDER BY id").all(id);
  const errors = kind === "douyin" ? db.prepare("SELECT * FROM platform_metric_import_errors WHERE import_batch_id=? ORDER BY id").all(id) : [];
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(batch.project_id);
  const problems = [];
  if (!project || project.organization_id !== batch.organization_id) problems.push("Batch project scope is invalid.");
  if (!Number.isSafeInteger(batch.row_count) || batch.row_count < 1 || batch.row_count > 500 || snapshots.length > batch.row_count) problems.push("Batch row count cannot be reconciled.");
  for (const row of [...snapshots, ...errors]) {
    if (row.organization_id !== batch.organization_id || row.project_id !== batch.project_id) problems.push("Saved row scope differs from the batch.");
  }
  for (const row of snapshots) {
    const parent = parents.find(p => p.id === row[kind === "standard" ? "publication_id" : "work_id"]);
    if (!parent || parent.organization_id !== batch.organization_id || parent.project_id !== batch.project_id
      || (kind === "standard" && (parent.content_item_id !== row.content_item_id || parent.content_org !== batch.organization_id || parent.content_project !== batch.project_id))
      || (kind === "douyin" && (parent.platform !== "douyin" || row.platform !== "douyin" || row.as_of_at !== batch.as_of_at))) problems.push("Saved row association requires manual review.");
  }
  if (kind === "douyin" && batch.platform !== "douyin") problems.push("Unsupported platform.");
  const hash = createHash("sha256").update(JSON.stringify({ kind, batch, snapshots, parents, errors, project })).digest("hex");
  const administrators = db.prepare("SELECT u.id,u.display_name FROM users u JOIN organization_members m ON m.user_id=u.id WHERE m.organization_id=? AND m.role='admin' AND m.status='active' AND u.status='active' ORDER BY u.id").all(batch.organization_id);
  return { kind, id, organizationId: batch.organization_id, projectId: batch.project_id, filename: batch.original_filename, createdAt: batch.created_at, inputRows: batch.row_count, savedSnapshots: snapshots.length, savedErrors: errors.length, reviewHash: hash, recoverable: problems.length === 0, problems: [...new Set(problems)], administrators };
}

// Called only by the stopped-installation PowerShell wrapper. The hash binds the
// operator's reviewed batch and saved relationships; a transaction rechecks it.
export function recoverImport(db, { kind, id, expectedHash, actorUserId, backupPath }) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || !actorUserId || !backupPath) throw new Error("Review hash, administrator and verified backup are required.");
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    const review = reviewImport(db, kind, id);
    if (review.reviewHash !== expectedHash) throw new Error("Batch or saved relationships changed; preview again. Nothing changed.");
    if (!review.recoverable) throw new Error("Saved data cannot be reconciled; preserve the backup and request manual review.");
    if (!review.administrators.some(user => user.id === actorUserId)) throw new Error("An active administrator of this company is required.");
    const now = new Date().toISOString(), marker = randomUUID(), table = kinds[kind].batch;
    const batch = db.prepare(`SELECT errors_json FROM ${table} WHERE id=?`).get(id);
    let previousErrors;
    try { previousErrors = batch.errors_json ? JSON.parse(batch.errors_json) : []; } catch { previousErrors = null; }
    // Retain even malformed old error text verbatim in the recovery audit.
    const errors = Array.isArray(previousErrors) ? previousErrors : [];
    errors.push(kind === "standard"
      ? { row: 0, reason: "管理员停服核对并保留已有快照；请用原文件重试补齐，关系不明时先人工核对。" }
      : { row: 0, code: "INTERRUPTED_IMPORT_RECOVERED", message: "管理员停服核对并保留已有快照；请用原文件和原截至时间重试补齐。" });
    db.prepare(`UPDATE ${table} SET status='failed',accepted_count=?,rejected_count=?,errors_json=?,completed_at=? WHERE id=? AND status='processing'`).run(review.savedSnapshots, review.inputRows - review.savedSnapshots, JSON.stringify(errors), now, id);
    db.prepare("INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(marker, review.organizationId, review.projectId, actorUserId, "performance.import.recovered", kind === "standard" ? "performance_import" : "platform_metric_import", id, JSON.stringify({ execution: "offline-maintenance", kind, reviewHash: expectedHash, backupPath, previousStatus: "processing", previousErrorsJson: batch.errors_json, retainedSnapshots: review.savedSnapshots, retainedErrors: review.savedErrors, nextStatus: "failed" }), now);
    db.exec("COMMIT");
    return { recovered: true, ...review, status: "failed", auditId: marker, backupPath };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function findDatabase(state) {
  const databases = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) throw new Error("State paths cannot be filesystem links.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("State paths cannot be filesystem links.");
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith(".sqlite")) {
        let db;
        try {
          db = new DatabaseSync(filename, { readOnly: true });
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='performance_import_batches'").get()) databases.push(filename);
        } finally { db?.close(); }
      }
    }
  }
  visit(state);
  if (databases.length !== 1) throw new Error("Exactly one application D1 database is required; no automatic database selection.");
  return databases[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let db, scratch;
  try {
    const [state, mode, kind, id, expectedHash, actorUserId, backupPath] = process.argv.slice(2);
    if (!state || !["preview", "apply"].includes(mode)) throw new Error("Use recover-performance-imports.ps1 in the stopped installation.");
    const filename = findDatabase(path.resolve(state, "v3/d1"));
    for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(filename + suffix) && lstatSync(filename + suffix).isSymbolicLink()) throw new Error("Database companions cannot be filesystem links.");
    if (mode === "preview") {
      scratch = mkdtempSync(path.join(os.tmpdir(), "lz-pimport-review-"));
      const clone = path.join(scratch, "review.sqlite");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(filename + suffix)) copyFileSync(filename + suffix, clone + suffix);
      db = new DatabaseSync(clone, { readOnly: true });
      const reviews = kind && id ? [reviewImport(db, kind, id)] : Object.entries(kinds).flatMap(([key, table]) => db.prepare(`SELECT id FROM ${table.batch} WHERE status='processing' ORDER BY created_at,id`).all().map(row => reviewImport(db, key, row.id)));
      console.log(JSON.stringify({ mode, batches: reviews }, null, 2));
    } else {
      if (!existsSync(backupPath || "")) throw new Error("Recovery backup is missing.");
      db = new DatabaseSync(filename);
      console.log(JSON.stringify(recoverImport(db, { kind, id, expectedHash, actorUserId, backupPath }), null, 2));
    }
  } catch (error) { console.error(`Import recovery failed: ${error.message}`); process.exitCode = 1; }
  finally {
    db?.close();
    if (scratch && path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith("lz-pimport-review-")) rmSync(scratch, { recursive: true, force: true });
  }
}
