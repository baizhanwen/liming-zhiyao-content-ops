import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const url = "http://local.test/api/tikhub-settings";

test("only a signed-in company admin can read or change TikHub settings through the settings page", async t => {
  const f = runtimeFixture(t);
  const { organizationId, userId } = await f.initialize();
  const env = { MODEL_SETTINGS_ENCRYPTION_KEY: "ad".repeat(32), TIKHUB_API_KEY: "fixture-server" };
  f.mockModule("cloudflare:workers", { env });
  let signedIn = true, role = "admin";
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => signedIn ? { authSubject: "test-owner" } : null });
  f.runtime.getOrganizationAccess = async (_sub, org) => org === organizationId ? { organizationRole: role, userId } : null;
  const route = f.load("app/api/tikhub-settings/route.ts");
  const get = (id = organizationId) => route.GET(new Request(url + "?organizationId=" + id));
  const put = (patch, headers = {}) => route.PUT(new Request(url, {
    method: "PUT",
    headers: { origin: "http://local.test", "content-type": "application/json", ...headers },
    body: JSON.stringify({ organizationId, version: 0, apiKey: "fixture-company", ...patch }),
  }));

  const current = await get();
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "no-store");
  assert.deepEqual(await current.json(), { apiKeyConfigured: true, source: "environment", version: 0, updatedAt: null, canManage: true });
  assert.equal((await get("outside-company")).status, 403);
  assert.equal((await put({ organizationId: "outside-company" })).status, 403);
  assert.equal((await put({}, { origin: "https://other.invalid" })).status, 403);
  assert.equal((await put({}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await put({ apiKey: "a".repeat(21000) })).status, 413);
  assert.equal((await put({ version: -1 })).status, 400);
  role = "member";
  assert.equal((await get()).status, 403);
  assert.equal((await put({})).status, 403);
  signedIn = false;
  assert.equal((await get()).status, 401);
  assert.equal((await put({})).status, 401);
  role = "admin";
  signedIn = true;

  const saved = await put({});
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  const settings = await saved.json();
  assert.deepEqual(Object.keys(settings).sort(), ["apiKeyConfigured", "canManage", "source", "updatedAt", "version"]);
  assert.equal(settings.source, "organization");
  assert.equal(settings.version, 1);
  assert.equal((await put({})).status, 409);
  assert.deepEqual(await (await get()).json(), settings);
  assert.doesNotMatch(JSON.stringify(settings), /fixture-server|fixture-company/);
});
