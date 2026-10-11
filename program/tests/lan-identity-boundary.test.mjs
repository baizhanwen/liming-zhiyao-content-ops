import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import test from "node:test";

function loadAuth(env, session = null) {
  const source = ts.transpileModule(readFileSync(new URL("../lib/request-auth.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const require = name => {
    if (name === "cloudflare:workers") return { env };
    if (name === "./local-auth") return { readLocalSessionIdentity: async () => session };
    throw new Error(`Unexpected auth dependency: ${name}`);
  };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  return loaded.exports.readRequestIdentity;
}

test("LAN requests cannot acquire local owner identity by selecting a loopback Host", async () => {
  for (const lan of [{ LAN_MODE: "1" }, { LAN_ACCESS_ORIGIN: "http://192.168.1.10:3000" }]) {
    const readIdentity = loadAuth({ ...lan, LOCAL_DEV_AUTH: "1", DELIVERY_MODE: "0", LOCAL_DEV_USER_ID: "local-owner" });
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "192.168.1.10"]) {
      assert.equal(await readIdentity(new Request(`http://${hostname}:3000/api/projects`)), null, `Anonymous LAN request with ${hostname} acquired owner identity`);
    }
  }
});

test("LAN ignores forwarded identity even if a stale proxy setting is enabled", async () => {
  const readIdentity = loadAuth({ LAN_MODE: "1", TRUST_FORWARDED_IDENTITY: "1", LOCAL_DEV_AUTH: "1" });
  const request = new Request("http://localhost:3000/api/projects", { headers: { "oai-authenticated-user-id": "local-owner", "oai-authenticated-user-email": "owner@example.invalid" } });
  assert.equal(await readIdentity(request), null);
});

test("LAN retains real password sessions, and loopback-only development retains local identity", async () => {
  const session = { authSubject: "signed-in-member", email: "member@example.invalid", displayName: "member" };
  assert.deepEqual(await loadAuth({ LAN_MODE: "1", LOCAL_DEV_AUTH: "1" }, session)(new Request("http://localhost:3000/api/projects")), session);
  const readLocal = loadAuth({ LOCAL_DEV_AUTH: "1", LOCAL_DEV_USER_ID: "local-owner" });
  assert.equal((await readLocal(new Request("http://127.0.0.1:3000/api/projects"))).authSubject, "local-owner");
  assert.equal(await readLocal(new Request("http://192.168.1.10:3000/api/projects")), null);
  assert.equal(await loadAuth({ DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "1" })(new Request("http://localhost:3000/api/projects")), null);
});
