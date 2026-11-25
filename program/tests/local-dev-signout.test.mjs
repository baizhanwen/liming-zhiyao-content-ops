import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const localOrigin = "http://127.0.0.1:3000";
const sessionPath = "/api/auth/session";
const markerName = "liming_local_signed_out";
const signedOutCookie = markerName + "=1";
const testPassword = "synthetic-password-only";

// The shared database fixture normally injects an always-authenticated identity.
// Exercise the real resolver with the same in-memory database as the API routes.
async function authFixture(t, { password = false, settings = {} } = {}) {
  const fixture = runtimeFixture(t);
  const { email } = await fixture.initialize();
  const owner = fixture.sqlite.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!password) fixture.sqlite.prepare("DELETE FROM local_credentials WHERE user_id = ?").run(owner.id);
  fixture.runtime.ensureUser = async identity =>
    fixture.sqlite.prepare("SELECT * FROM users WHERE auth_subject = ? AND status = 'active'").get(identity.authSubject);
  const env = { LOCAL_DEV_AUTH: "1", DELIVERY_MODE: "0", LOCAL_DEV_USER_ID: owner.auth_subject, LOCAL_DEV_USER_EMAIL: email, ...settings };
  fixture.mockModule("cloudflare:workers", { env });
  const authSource = readFileSync(new URL("../lib/request-auth.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(authSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const authModule = { exports: {} };
  const require = name => {
    if (name === "cloudflare:workers") return { env };
    return fixture.load("lib/" + name + ".ts");
  };
  new Function("require", "module", "exports", outputText)(require, authModule, authModule.exports);
  fixture.mock("lib/request-auth.ts", authModule.exports);
  return {
    owner, localAuth: fixture.load("lib/local-auth.ts"), session: fixture.load("app/api/auth/session/route.ts"),
    organizations: fixture.load("app/api/organizations/route.ts"),
  };
}

function request({ method = "GET", path = sessionPath, cookie, origin = localOrigin, payload, headers = {} } = {}) {
  const options = { method, headers: new Headers(headers) };
  if (cookie) options.headers.set("cookie", cookie);
  if (method !== "GET" && !options.headers.has("origin")) options.headers.set("origin", origin);
  if (payload) {
    options.headers.set("content-type", "application/json");
    options.body = JSON.stringify(payload);
  }
  return new Request(new URL(path, origin), options);
}

function responseCookie(response, name) {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith(name + "="));
}

test("signing out clears the real session and requires an explicit local return for a passwordless development owner", async t => {
  const { owner, localAuth, session, organizations } = await authFixture(t);
  assert.equal((await session.GET(request())).status, 200);
  const token = (await localAuth.createLocalSession(owner.id, request())).split(";")[0];
  assert.ok(await localAuth.readLocalSessionIdentity(request({ cookie: token })));
  const logout = await session.DELETE(request({ method: "DELETE", cookie: token }));
  assert.equal(logout.status, 200);
  assert.match(responseCookie(logout, "liming_session") ?? "", /Max-Age=0/i);
  const marker = responseCookie(logout, markerName) ?? "";
  assert.equal(marker.split(";")[0], signedOutCookie);
  assert.match(marker, /;\s*HttpOnly\b/i);
  assert.match(marker, /;\s*Path=\/(?:;|$)/i);
  assert.equal(await localAuth.readLocalSessionIdentity(request({ cookie: token })), null);

  for (let refresh = 0; refresh < 2; refresh++) {
    const status = await session.GET(request({ cookie: signedOutCookie }));
    assert.equal(status.status, 401);
    assert.equal((await status.json()).localDevLoginAvailable, true);
    assert.equal((await organizations.GET(request({ path: "/api/organizations", cookie: signedOutCookie }))).status, 401);
  }
  const resume = await session.POST(request({ method: "POST", cookie: signedOutCookie, payload: { mode: "local-dev" } }));
  assert.equal(resume.status, 200);
  assert.match(responseCookie(resume, markerName) ?? "", /Max-Age=0/i);
  const resumed = await session.GET(request());
  assert.equal((await resumed.json()).user.id, owner.id);
  assert.equal((await organizations.GET(request({ path: "/api/organizations" }))).status, 200);
});

test("a signed-out owner with a configured password can return using that password only", async t => {
  const { owner, session, localAuth, organizations } = await authFixture(t, { password: true });
  const status = await session.GET(request({ cookie: signedOutCookie }));
  assert.equal(status.status, 401);
  assert.notEqual((await status.json()).localDevLoginAvailable, true);
  const resume = await session.POST(request({ method: "POST", cookie: signedOutCookie, payload: { mode: "local-dev" } }));
  assert.ok([401, 403].includes(resume.status));
  assert.equal(responseCookie(resume, markerName), undefined);

  const passwordLogin = password => session.POST(request({ method: "POST", cookie: signedOutCookie, payload: { email: owner.email, password } }));
  assert.equal((await passwordLogin("incorrect-password")).status, 401);
  const successful = await passwordLogin(testPassword);
  assert.equal(successful.status, 200);
  const newToken = responseCookie(successful, "liming_session")?.split(";")[0];
  assert.match(newToken ?? "", /^liming_session=.+/);
  const cookie = [newToken, signedOutCookie].join("; ");
  assert.equal((await localAuth.readLocalSessionIdentity(request({ cookie }))).email, owner.email);
  assert.equal((await organizations.GET(request({ path: "/api/organizations", cookie }))).status, 200);
});

for (const [label, origin, settings] of [
  ["local password mode", localOrigin, { LOCAL_DEV_AUTH: "0" }],
  ["delivery", localOrigin, { DELIVERY_MODE: "1" }],
  ["LAN listener", localOrigin, { LAN_MODE: "1" }],
  ["configured LAN origin", localOrigin, { LAN_ACCESS_ORIGIN: "http://192.168.1.20:3000" }],
  ["non-loopback address", "http://192.168.1.20:3000", {}],
]) test(label + " does not offer or accept development login", async t => {
  const { session } = await authFixture(t, { settings });
  const status = await session.GET(request({ cookie: signedOutCookie, origin }));
  assert.equal(status.status, 401);
  assert.notEqual((await status.json()).localDevLoginAvailable, true);
  const resume = await session.POST(request({ method: "POST", cookie: signedOutCookie, origin, payload: { mode: "local-dev" } }));
  assert.ok([401, 403].includes(resume.status));
  assert.equal(resume.headers.has("set-cookie"), false);
});

for (const [label, origin, contentType] of [
  ["cross-origin", "https://unrelated.example.invalid", "application/json"],
  ["non-JSON", localOrigin, "text/plain"],
]) test("explicit local re-entry rejects a " + label + " POST", async t => {
  const { session } = await authFixture(t);
  const response = await session.POST(new Request(new URL(sessionPath, localOrigin), {
    method: "POST", headers: { cookie: signedOutCookie, origin, "content-type": contentType },
    body: JSON.stringify({ mode: "local-dev" }),
  }));
  assert.ok([401, 403].includes(response.status));
  assert.equal(response.headers.has("set-cookie"), false);
});
