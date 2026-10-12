import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { reviewImport, recoverImport } from "../scripts/recover-performance-imports.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const tables = ["performance_import_batches", "publication_metric_snapshots", "platform_works", "platform_metric_import_batches", "platform_metric_snapshots", "platform_metric_import_errors", "audit_logs"];

async function fixture(t, kind) {
  const f = runtimeFixture(t), owner = await f.initialize(), project = crypto.randomUUID(), now = new Date().toISOString();
  f.identity.userId = owner.userId;
  function seed(table, values) {
    const columns = f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const data = { id: crypto.randomUUID(), organization_id: owner.organizationId, project_id: project, created_by: owner.userId, updated_by: owner.userId, imported_by: owner.userId, created_at: now, updated_at: now, ...values };
    const entries = Object.entries(data).filter(([key]) => columns.includes(key));
    f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([key]) => key)}) VALUES(${entries.map(() => "?")})`).run(...entries.map(([,value]) => value));
    return data.id;
  }
  seed("projects", { id: project, name: "Synthetic recovery", client_name: "Synthetic" });
  const body = { organizationId: owner.organizationId, projectId: project, source: "csv", rows: [] };
  if (kind === "standard") {
    const topic = seed("topic_ideas", { title: "Synthetic", angle: "Synthetic", source_type: "manual", status: "draft" });
    const content = seed("content_items", { topic_id: topic, title: "Synthetic", status: "published" });
    const version = seed("content_versions", { content_item_id: content, version: 1, generation_mode: "manual", pack_json: "{}", full_script: "Synthetic", short_script: "Synthetic" });
    const publication = seed("publication_records", { content_item_id: content, content_version_id: version, platform: "douyin", status: "published", published_at: now });
    body.rows = [0,1].map(i => ({ publicationId: publication, observedAt: `2026-10-12T01:0${i}:00.000Z`, views: i, likes: 0, comments: 0, shares: 0, saves: 0, followersGained: 0, leads: 0 }));
  } else {
    body.format = "douyin_16"; body.asOfAt = "2026-10-12T01:00:00.000Z";
    body.rows = [0,1].map(i => ({ platformWorkId: `synthetic-${i}`, title: `Synthetic ${i}`, publishedAt: now, views: i, likes: 0, comments: 0, shares: 0, saves: 0, homepageVisits: 0, followerDelta: 0 }));
  }
  f.runtime.getProjectAccess = async () => ({ organizationRole: "admin" }); f.runtime.canWriteProjectAccess = () => true;
  const invoke = () => f.load("app/api/performance/route.ts").POST(new Request("http://localhost/import", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await invoke()).status, 201);
  const batchTable = kind === "standard" ? tables[0] : tables[3], snapshotTable = kind === "standard" ? tables[1] : tables[4];
  const actual = f.sqlite.prepare(`SELECT id FROM ${batchTable}`).get().id;
  f.sqlite.prepare(`DELETE FROM ${snapshotTable} WHERE views=1`).run();
  f.sqlite.prepare(`UPDATE ${batchTable} SET status='processing',accepted_count=0,rejected_count=0,completed_at=NULL`).run();
  if (kind === "douyin") seed("platform_metric_import_errors", { import_batch_id: actual, row_number: 3, error_code: "OLD_WARNING", message: "Keep old warning", raw_json: '{"synthetic":true}' });
  const snapshot = () => Object.fromEntries(tables.map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return { ...f, owner, project, batch: actual, batchTable, snapshotTable, invoke, snapshot };
}

for (const kind of ["standard", "douyin"]) {
  test(`${kind}: stopped legacy batch recovers without deleting snapshots, works or warnings; retry fills gaps`, async t => {
    const f = await fixture(t, kind), before = f.snapshot(), review = reviewImport(f.sqlite, kind, f.batch);
    assert.equal((await f.invoke()).status, 409, "Legacy processing batch blocks the original-file retry");
    assert.deepEqual(f.snapshot(), before);
    assert.equal(review.savedSnapshots, 1); assert.equal(review.recoverable, true);
    const result = recoverImport(f.sqlite, { kind, id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic-verified-backup.zip" });
    assert.equal(result.status, "failed");
    for (const table of [f.snapshotTable, "platform_works", "platform_metric_import_errors"]) assert.deepEqual(f.snapshot()[table], before[table]);
    const changed = f.snapshot()[f.batchTable][0]; assert.equal(changed.accepted_count, 1); assert.equal(changed.rejected_count, 1);
    const audit = f.snapshot().audit_logs.find(row => row.action === "performance.import.recovered");
    assert.equal(audit.actor_user_id, f.owner.userId); assert.equal(JSON.parse(audit.metadata_json).execution, "offline-maintenance");
    assert.equal((await f.invoke()).status, 201); assert.equal(f.snapshot()[f.snapshotTable].length, 2);
    assert.deepEqual(f.snapshot()[f.snapshotTable].find(row => row.id === before[f.snapshotTable][0].id), before[f.snapshotTable][0]);
  });
  test(`${kind}: stale reviewed snapshot cannot be recovered`, async t => {
    const f = await fixture(t, kind), review = reviewImport(f.sqlite, kind, f.batch);
    f.sqlite.prepare(`UPDATE ${f.snapshotTable} SET views=9`).run(); const before = f.snapshot();
    assert.throws(() => recoverImport(f.sqlite, { kind, id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" }), /changed/);
    assert.deepEqual(f.snapshot(), before);
  });
  test(`${kind}: audit failure rolls back status and counts`, async t => {
    const f = await fixture(t, kind), review = reviewImport(f.sqlite, kind, f.batch), before = f.snapshot();
    f.sqlite.exec("CREATE TRIGGER recovery_fault BEFORE INSERT ON audit_logs WHEN NEW.action='performance.import.recovered' BEGIN SELECT RAISE(ABORT,'synthetic recovery fault'); END");
    assert.throws(() => recoverImport(f.sqlite, { kind, id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" }), /synthetic recovery fault/);
    assert.deepEqual(f.snapshot(), before);
  });
  test(`${kind}: non-admin or no longer processing batch cannot be changed`, async t => {
    const f = await fixture(t, kind), review = reviewImport(f.sqlite, kind, f.batch), before = f.snapshot();
    assert.throws(() => recoverImport(f.sqlite, { kind, id: f.batch, expectedHash: review.reviewHash, actorUserId: "foreign-user", backupPath: "synthetic.zip" }), /administrator/);
    assert.deepEqual(f.snapshot(), before);
    f.sqlite.prepare(`UPDATE ${f.batchTable} SET status='completed'`).run();
    assert.throws(() => recoverImport(f.sqlite, { kind, id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" }), /no longer processing/);
  });
}

test("scope mismatch and invalid counts are reported without automatic repairs", async t => {
  const f = await fixture(t, "douyin");
  f.sqlite.prepare("UPDATE platform_metric_snapshots SET project_id='synthetic-wrong'").run();
  const review = reviewImport(f.sqlite, "douyin", f.batch), before = f.snapshot(); assert.equal(review.recoverable, false);
  assert.throws(() => recoverImport(f.sqlite, { kind: "douyin", id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" }), /cannot be reconciled/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.prepare("UPDATE platform_metric_snapshots SET project_id=?").run(f.project);
  f.sqlite.prepare("UPDATE platform_metric_import_batches SET row_count=0").run(); assert.equal(reviewImport(f.sqlite, "douyin", f.batch).recoverable, false);
});

test("deactivated company administrator cannot execute offline recovery", async t => {
  const f = await fixture(t, "standard"); f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run();
  const review = reviewImport(f.sqlite, "standard", f.batch), before = f.snapshot();
  assert.throws(() => recoverImport(f.sqlite, { kind: "standard", id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" }), /administrator/);
  assert.deepEqual(f.snapshot(), before);
});

test("malformed historical error text is retained verbatim in recovery audit", async t => {
  const f = await fixture(t, "standard"); f.sqlite.prepare("UPDATE performance_import_batches SET errors_json='legacy damaged text'").run();
  const review = reviewImport(f.sqlite, "standard", f.batch);
  recoverImport(f.sqlite, { kind: "standard", id: f.batch, expectedHash: review.reviewHash, actorUserId: f.owner.userId, backupPath: "synthetic.zip" });
  const metadata = f.sqlite.prepare("SELECT metadata_json FROM audit_logs WHERE action='performance.import.recovered'").get();
  assert.equal(JSON.parse(metadata.metadata_json).previousErrorsJson, "legacy damaged text");
});

test("shipped PowerShell recovery previews, backs up, retains attachments and can restore the original processing batch", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, "douyin"), parent = path.join(root, ".local/pr"); mkdirSync(parent, { recursive: true });
  f.sqlite.prepare("UPDATE users SET display_name='合成管理员' WHERE id=?").run(f.owner.userId);
  f.sqlite.prepare("UPDATE platform_metric_import_batches SET original_filename='复盘合成.csv'").run();
  const installation = mkdtempSync(path.join(parent, "r-")), scripts = path.join(installation, "scripts"); mkdirSync(scripts);
  for (const name of ["recover-performance-imports.ps1", "recover-performance-imports.mjs", "local-state-maintenance.ps1", "analyzer-instance-lock.ps1", "verify-state-databases.mjs", "restore-local.ps1"]) copyFileSync(path.join(root, "scripts", name), path.join(scripts, name));
  const state = path.join(installation, ".wrangler/state"), filename = path.join(state, "v3/d1/app/fixture.sqlite"); mkdirSync(path.dirname(filename), { recursive: true });
  f.sqlite.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`);
  const media = path.join(state, "v3/r2/attachment.bin"); mkdirSync(path.dirname(media), { recursive: true }); writeFileSync(media, Buffer.from([0,1,255,42]));
  mkdirSync(path.join(installation, ".local")); writeFileSync(path.join(installation, ".local/app.port"), "59996");
  const run = (args, input = "") => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, args[0]), ...args.slice(1)], { cwd: installation, input, encoding: "utf8", windowsHide: true, timeout: 90000 });
  const before = readFileSync(filename), preview = run(["recover-performance-imports.ps1"]); assert.equal(preview.status, 0, preview.stderr); const reviewed = JSON.parse(preview.stdout).batches[0];
  assert.equal(reviewed.filename, "复盘合成.csv"); assert.equal(reviewed.administrators[0].display_name, "合成管理员");
  assert.deepEqual(readFileSync(filename), before, "Preview must not rewrite live SQLite bytes"); assert.equal(existsSync(path.join(installation, "backups")), false);
  const second = path.join(path.dirname(filename), "ambiguous.sqlite"); copyFileSync(filename, second);
  const ambiguous = run(["recover-performance-imports.ps1"]); assert.notEqual(ambiguous.status, 0); assert.match(ambiguous.stderr + ambiguous.stdout, /Exactly one application/); assert.deepEqual(readFileSync(filename), before); unlinkSync(second);
  const applied = run(["recover-performance-imports.ps1", "-Apply", "-Kind", "douyin", "-BatchId", f.batch, "-ExpectedHash", reviewed.reviewHash, "-ActorUserId", f.owner.userId]); assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  const backup = path.join(installation, "backups", readdirSync(path.join(installation, "backups")).find(name => name.endsWith(".zip")));
  const archive = unzipSync(readFileSync(backup)); assert.deepEqual(Buffer.from(archive["state/v3/d1/app/fixture.sqlite"]), before); assert.deepEqual(Buffer.from(archive["state/v3/r2/attachment.bin"]), readFileSync(media));
  const recovered = new DatabaseSync(filename); assert.equal(recovered.prepare("SELECT status FROM platform_metric_import_batches").get().status, "failed"); assert.equal(recovered.prepare("SELECT count(*) AS n FROM platform_metric_import_errors").get().n, 1); recovered.close();
  const replay = run(["recover-performance-imports.ps1", "-Apply", "-Kind", "douyin", "-BatchId", f.batch, "-ExpectedHash", reviewed.reviewHash, "-ActorUserId", f.owner.userId]); assert.notEqual(replay.status, 0);
  const restored = run(["restore-local.ps1", "-BackupPath", backup], "RESTORE\n"); assert.equal(restored.status, 0, restored.stderr);
  const original = new DatabaseSync(filename); assert.equal(original.prepare("SELECT status FROM platform_metric_import_batches").get().status, "processing"); assert.equal(original.prepare("SELECT count(*) AS n FROM platform_metric_snapshots").get().n, 1); original.close();
  writeFileSync(path.join(installation, ".local/recovery-test.json"), JSON.stringify({ passed: true, synthetic: true, backup, retainedSnapshots: 1, retainedErrors: 1, originalProcessingRestored: true, boundary: "Actual Windows PowerShell 5.1, local SQLite and ZIP; no business state or keys." }, null, 2));
});
