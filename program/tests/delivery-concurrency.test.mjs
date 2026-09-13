import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

test("one setup code accepts exactly one concurrent installation and leaves no losing users", async t => {
  const f = runtimeFixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.initialize(i)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  for (const result of results.filter(r => r.status === "rejected")) assert.equal(result.reason.message, "FIRST_RUN_ALREADY_COMPLETED");
  for (const table of ["users", "local_credentials", "organizations", "organization_members", "organization_settings", "audit_logs"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
  assert.equal((await f.load("lib/first-run.ts").readFirstRunStatus()).setupRequired, false);
});

test("failed setup rolls back the marker and can be retried", async t => {
  const f = runtimeFixture(t);
  f.sqlite.exec("CREATE TRIGGER test_fail_setup BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
  await assert.rejects(f.initialize(), /injected audit failure/);
  for (const table of ["users", "organizations", "installation_settings"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  f.sqlite.exec("DROP TRIGGER test_fail_setup");
  await f.initialize();
});

test("setup is closed if either completion evidence remains, and accepts a legacy zero marker", async t => {
  const f = runtimeFixture(t);
  f.sqlite.exec("INSERT INTO installation_settings VALUES ('setup_completed', '1', '2026-01-01')");
  assert.equal((await f.load("lib/first-run.ts").readFirstRunStatus()).setupRequired, false);
  await assert.rejects(f.initialize(), /FIRST_RUN_ALREADY_COMPLETED/);
  f.sqlite.exec("UPDATE installation_settings SET value = '0'");
  await f.initialize();
  f.sqlite.exec("DELETE FROM installation_settings");
  assert.equal((await f.load("lib/first-run.ts").readFirstRunStatus()).setupRequired, false);
});

test("concurrent login failures are counted and lock the normalized email", async t => {
  const f = runtimeFixture(t), auth = f.load("lib/local-auth.ts");
  await Promise.all(Array.from({ length: 10 }, (_, i) => auth.recordLocalLoginFailure(i % 2 ? "TEST@example.invalid" : "test@example.invalid")));
  const row = f.sqlite.prepare("SELECT * FROM local_login_attempts").get();
  assert.equal(row.failed_count, 10);
  assert.ok(await auth.readLocalLoginLock("test@example.invalid"));
  await auth.recordLocalLoginFailure("test@example.invalid");
  assert.equal(f.sqlite.prepare("SELECT locked_until FROM local_login_attempts").get().locked_until, row.locked_until);
});

test("expired login locks restart counting, older successful requests cannot erase new failures", async t => {
  const f = runtimeFixture(t), auth = f.load("lib/local-auth.ts");
  f.sqlite.exec("INSERT INTO local_login_attempts VALUES ('test@example.invalid', 8, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')");
  await auth.recordLocalLoginFailure("test@example.invalid");
  const row = f.sqlite.prepare("SELECT * FROM local_login_attempts").get();
  assert.equal(row.failed_count, 1);
  assert.equal(row.locked_until, null);
  await auth.clearLocalLoginFailures("test@example.invalid", "2020-01-02T00:00:00.000Z");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM local_login_attempts").get().n, 1);
  await auth.clearLocalLoginFailures("test@example.invalid", new Date(Date.now() + 1000).toISOString());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM local_login_attempts").get().n, 0);
  await Promise.all(Array.from({ length: 5 }, () => auth.recordLocalLoginFailure("test@example.invalid")));
  await auth.clearLocalLoginFailures("test@example.invalid");
  assert.ok(await auth.readLocalLoginLock("test@example.invalid"));
});

async function projectFixture(t) {
  const f = runtimeFixture(t), installation = await f.initialize();
  f.identity.userId = installation.userId;
  f.sqlite.prepare("UPDATE organization_settings SET project_quota = 1 WHERE organization_id = ?").run(installation.organizationId);
  const routes = f.load("app/api/projects/route.ts");
  const request = (method, data) => new Request("http://localhost/api/projects", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: installation.organizationId, ...data }) });
  return { ...f, installation, create: name => routes.POST(request("POST", { name })), change: (projectId, status) => routes.PATCH(request("PATCH", { projectId, status })) };
}

test("concurrent project creation consumes one remaining slot and audits only the winner", async t => {
  const f = await projectFixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.create(`Project ${i}`)));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 429).length, 11);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.created'").get().n, 1);
});

test("archived restoration competes for capacity without preventing changes to existing active projects", async t => {
  const f = await projectFixture(t);
  const first = (await (await f.create("First project")).json()).project.id;
  assert.equal((await f.change(first, "archived")).status, 200);
  const second = (await (await f.create("Second project")).json()).project.id;
  assert.equal((await f.change(first, "active")).status, 429);
  assert.equal((await f.change(second, "paused")).status, 200);
  assert.equal((await f.change(second, "archived")).status, 200);
  const restores = await Promise.all([f.change(first, "active"), f.change(second, "draft")]);
  assert.deepEqual(restores.map(r => r.status).sort(), [200, 429]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE status != 'archived'").get().n, 1);
  assert.equal((await f.change("missing-project", "active")).status, 404);
  f.identity.role = "member";
  assert.equal((await f.create("Forbidden project")).status, 403);
  assert.equal((await f.change(first, "archived")).status, 403);
});
