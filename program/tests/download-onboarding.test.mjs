import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const account = {
  companyName: "下载版测试公司",
  administratorName: "下载版管理员",
  email: "download-admin@example.invalid",
  password: "synthetic-download-password",
  confirmation: "synthetic-download-password",
};

function fixture(t, configuration = {}) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: {
    DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "0", FIRST_RUN_REQUIRE_SETUP_CODE: "0", ...configuration,
  } });
  return f;
}

function setupRequest(payload = account, hostname = "127.0.0.1") {
  return new Request(`http://${hostname}/api/first-run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

test("download installation creates a real password account without any activation code", async t => {
  const f = fixture(t), setup = f.load("app/api/first-run/route.ts");
  const before = await (await setup.GET()).json();
  assert.equal(before.setupRequired, true);
  assert.equal(before.setupCodeRequired, false);
  assert.equal(before.setupCodeConfigured, false);
  const created = await setup.POST(setupRequest());
  assert.equal(created.status, 201);
  const { installation } = await created.json();
  const credential = f.sqlite.prepare("SELECT * FROM local_credentials WHERE user_id = ?").get(installation.userId);
  assert.ok(credential.password_hash);
  assert.notEqual(credential.password_hash, account.password);

  const session = f.load("app/api/auth/session/route.ts");
  const login = await session.POST(new Request("http://127.0.0.1/api/auth/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  }));
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, installation.userId);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /liming_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  const identity = await f.load("lib/local-auth.ts").readLocalSessionIdentity(new Request("http://127.0.0.1/", { headers: { cookie } }));
  assert.equal(identity.email, account.email);
  assert.equal((await (await setup.GET()).json()).setupRequired, false);
  assert.equal((await setup.POST(setupRequest())).status, 409);
});

test("activation-free setup remains local-only and validates the administrator password", async t => {
  const f = fixture(t), setup = f.load("app/api/first-run/route.ts");
  const remote = await setup.POST(setupRequest(account, "192.168.1.20"));
  assert.equal(remote.status, 403);
  assert.equal((await remote.json()).error.code, "FIRST_RUN_LOCAL_ONLY");
  const mismatched = await setup.POST(setupRequest({ ...account, confirmation: "different-password" }));
  assert.equal(mismatched.status, 400);
  const tooShort = await setup.POST(setupRequest({ ...account, password: "short", confirmation: "short" }));
  assert.equal(tooShort.status, 400);
  assert.equal((await tooShort.json()).error.code, "FIRST_RUN_PASSWORD_INVALID");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  assert.equal((await setup.POST(setupRequest())).status, 201);
});

test("activation-free concurrent setup creates exactly one installation and no losing accounts", async t => {
  const f = fixture(t), setup = f.load("app/api/first-run/route.ts");
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => setup.POST(setupRequest({
    ...account, email: `download-${index}@example.invalid`,
  }))));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 7);
  for (const table of ["users", "local_credentials", "organizations", "organization_members", "organization_settings", "audit_logs", "installation_settings"]) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
  }
});

test("commercial installations still require a valid code when the new policy is absent", async t => {
  const f = runtimeFixture(t), firstRun = f.load("lib/first-run.ts");
  const status = await firstRun.readFirstRunStatus();
  assert.equal(status.setupCodeRequired, true);
  await assert.rejects(firstRun.initializeCommercialInstallation({ ...account, setupCode: "wrong-code" }), /FIRST_RUN_CODE_INVALID/);
  await f.initialize();
});

test("only an explicit zero disables setup codes and a hash still works for commercial deliveries", async t => {
  const setupCode = "synthetic-hash-only-activation";
  const f = fixture(t, {
    FIRST_RUN_REQUIRE_SETUP_CODE: "1",
    FIRST_RUN_SETUP_CODE_HASH: createHash("sha256").update(setupCode).digest("hex"),
  });
  const firstRun = f.load("lib/first-run.ts");
  assert.equal((await firstRun.readFirstRunStatus()).setupCodeRequired, true);
  await assert.rejects(firstRun.initializeCommercialInstallation({ ...account, setupCode: "" }), /FIRST_RUN_CODE_INVALID/);
  await firstRun.initializeCommercialInstallation({ ...account, setupCode });
});

test("commercial packages without a configured code remain closed", async t => {
  const f = fixture(t, { FIRST_RUN_REQUIRE_SETUP_CODE: "" }), firstRun = f.load("lib/first-run.ts");
  assert.equal((await firstRun.readFirstRunStatus()).setupCodeRequired, true);
  await assert.rejects(firstRun.initializeCommercialInstallation({ ...account, setupCode: "" }), /FIRST_RUN_CODE_NOT_CONFIGURED/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});
