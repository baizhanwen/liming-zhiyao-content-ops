import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const organizationId = "00000000-0000-4000-8000-000000000001";
const origin = "http://127.0.0.1:3000";

function fixture(t) {
  const f = runtimeFixture(t);
  const calls = [];
  let signedIn = true;
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => signedIn ? { authSubject: "local-owner" } : null });
  f.mock("lib/analyzer-environment.ts", {
    AnalyzerEnvironmentError: class extends Error {},
    isLocalEnvironmentRequest: request => ["127.0.0.1", "localhost"].includes(new URL(request.url).hostname),
    requestAnalyzerEnvironment: async action => { calls.push(action); return { available: true, ready: true, workerRunning: false, checks: [] }; },
  });
  return { ...f, calls, signOut: () => { signedIn = false; }, route: f.load("app/api/analyzer-environment/route.ts") };
}

function post(body, requestOrigin = origin, url = origin) {
  return new Request(`${url}/api/analyzer-environment`, { method: "POST", headers: { "content-type": "application/json", ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
}

test("environment management requires a signed-in company administrator on the local host", async t => {
  const f = fixture(t);
  const read = new Request(`${origin}/api/analyzer-environment?organizationId=${organizationId}`);
  f.signOut();
  assert.equal((await f.route.GET(read)).status, 401);
  assert.deepEqual(f.calls, []);
});

test("non-admin and remote host requests cannot reach local runtime controls", async t => {
  const f = fixture(t);
  f.identity.role = "employee";
  assert.equal((await f.route.POST(post({ organizationId, action: "setup" }))).status, 403);
  f.identity.role = "admin";
  assert.equal((await f.route.POST(post({ organizationId, action: "setup" }, "http://192.0.2.1:3000", "http://192.0.2.1:3000"))).status, 403);
  assert.deepEqual(f.calls, []);
});

test("mutations require the current application Origin and a strict action payload", async t => {
  const f = fixture(t);
  assert.equal((await f.route.POST(post({ organizationId, action: "setup" }, "https://attacker.invalid"))).status, 403);
  assert.equal((await f.route.POST(post({ organizationId, action: "setup" }, ""))).status, 403);
  assert.equal((await f.route.POST(post({ organizationId, action: "setup", command: "not-allowed" }))).status, 400);
  assert.deepEqual(f.calls, []);
  const response = await f.route.POST(post({ organizationId, action: "check" }));
  assert.equal(response.status, 202);
  assert.deepEqual(f.calls, ["check"]);
  assert.equal((await response.json()).ready, true);
});
