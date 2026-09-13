import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("LAN identity headers are disabled unless a trusted proxy is explicit", async () => {
  const [auth, example] = await Promise.all([
    readFile(new URL("../lib/request-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../.dev.vars.example", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /TRUST_FORWARDED_IDENTITY\?\.trim\(\) === "1"/);
  assert.match(example, /TRUST_FORWARDED_IDENTITY=0/);
});

test("local login locks repeated failures and clears the counter after success", async () => {
  const [auth, session, migration] = await Promise.all([
    readFile(new URL("../lib/local-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_local_auth_hardening.sql", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /loginFailureLimit = 5/);
  assert.match(auth, /loginLockSeconds = 15 \* 60/);
  assert.match(session, /recordLocalLoginFailure/);
  assert.match(session, /clearLocalLoginFailures/);
  assert.match(migration, /local_login_attempts/);
});

test("password changes require the current password and revoke old sessions", async () => {
  const [route, operations] = await Promise.all([
    readFile(new URL("../app/api/auth/password/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/SystemOperations.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /verifyLocalPasswordForUser/);
  assert.match(route, /CURRENT_PASSWORD_INVALID/);
  assert.match(route, /revokeAllLocalSessions/);
  assert.match(operations, /currentPassword/);
});
