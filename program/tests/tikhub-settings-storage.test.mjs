import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  const env = { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", MODEL_SETTINGS_ENCRYPTION_KEY: "ab".repeat(32), TIKHUB_API_KEY: "synthetic-default" };
  f.mockModule("cloudflare:workers", { env });
  const { organizationId: org, userId: user } = await f.initialize();
  return { ...f, org, user, env, store: f.load("lib/tikhub-settings.ts") };
}

test("TikHub org overrides are bound to the organization and stay out of public settings and audit", async t => {
  const { org, user, store, env, sqlite } = await fixture(t);
  const secret = "synthetic-private-tikhub";
  assert.deepEqual(await store.readTikHubSettings(org), { apiKeyConfigured: true, source: "environment", version: 0, updatedAt: null });
  await store.saveTikHubSettings(org, user, { apiKey: "  " }, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM organization_tikhub_settings").get().n, 0);
  const saved = await store.saveTikHubSettings(org, user, { apiKey: secret }, 0);
  assert.equal(saved.source, "organization");
  assert.equal(await store.readEffectiveTikHubKey(org), secret);
  assert.equal((await store.saveTikHubSettings(org, user, {}, 1)).version, 1);
  const row = sqlite.prepare("SELECT * FROM organization_tikhub_settings").get();
  assert.match(row.encrypted_key, /^v1\./);
  const audits = sqlite.prepare("SELECT * FROM audit_logs WHERE action = 'tikhub.settings_updated'").all();
  assert.equal(audits.length, 1);
  assert.doesNotMatch(JSON.stringify([saved, row, audits]), /synthetic-private-tikhub|synthetic-default/);

  const other = crypto.randomUUID();
  sqlite.prepare("INSERT INTO organizations (id,name,slug,status,created_by,created_at,updated_at) VALUES(?,?,?,'active',?,?,?)")
    .run(other, "other", "other", user, saved.updatedAt, saved.updatedAt);
  assert.equal(await store.readEffectiveTikHubKey(other), env.TIKHUB_API_KEY);
  sqlite.prepare("INSERT INTO organization_tikhub_settings (organization_id, version, encrypted_key, updated_by, updated_at) VALUES (?,1,?,?,?)")
    .run(other, row.encrypted_key, user, saved.updatedAt);
  await assert.rejects(store.readEffectiveTikHubKey(other), { code: "TIKHUB_KEY_UNREADABLE" });
  const restored = await store.saveTikHubSettings(org, user, { clearApiKey: true }, 1);
  assert.equal(restored.version, 2);
  assert.equal(restored.source, "environment");
  assert.equal(await store.readEffectiveTikHubKey(org), env.TIKHUB_API_KEY);
  env.TIKHUB_API_KEY = "";
  assert.equal((await store.readTikHubSettings(org)).source, "none");
  assert.equal(await store.readEffectiveTikHubKey(org), "");
});

test("TikHub key updates enforce versions and recheck active admin authority in the write", async t => {
  const { org, user, store, sqlite, db } = await fixture(t);
  const save = (key, version) => store.saveTikHubSettings(org, user, { apiKey: key }, version);
  const parallel = await Promise.allSettled([save("synthetic-A", 0), save("synthetic-B", 0)]);
  assert.equal(parallel.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(parallel.find(result => result.status === "rejected").reason.code, "TIKHUB_SETTINGS_CONFLICT");
  const oldKey = await store.readEffectiveTikHubKey(org);
  const run = db.batch.bind(db);
  db.batch = statements => {
    sqlite.prepare("UPDATE organization_members SET status = 'removed' WHERE organization_id=? AND user_id=?").run(org,user);
    return run(statements);
  };
  await assert.rejects(save("synthetic-rejected", 1), { code: "ADMIN_REQUIRED" });
  assert.equal(await store.readEffectiveTikHubKey(org), oldKey);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='tikhub.settings_updated'").get().n, 1);
});

test("the shared credential reader opens v1 envelopes created for existing model settings", async t => {
  const { load } = await fixture(t);
  const cipher = "v1.AwMDAwMDAwMDAwMD./XK+M9RJkcYR7CFtCoZrSXSWsrFw/tZlYRpLazCi/YAUogxyEMU1lgU1";
  const { unsealCredential } = load("lib/organization-settings-credential.ts");
  assert.equal(await unsealCredential(cipher, "legacy-organization", "analysisText",
    { provider: "fixture", baseUrl: "https://models.example.invalid/v1" }), "synthetic-legacy-model-key");
});
