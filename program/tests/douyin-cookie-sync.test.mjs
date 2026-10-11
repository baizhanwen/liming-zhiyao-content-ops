import assert from "node:assert/strict";
import test from "node:test";
import { isDouyinDomain, isLocalAnalysisUrl, sameBinding, serializeCookies, snapshotHash } from "../tools/douyin-cookie-sync/sync-core.mjs";
import { sanitizeDouyinCookieSnapshot } from "../lib/douyin-cookie-snapshot.ts";

const session = { domain: ".douyin.com", hostOnly: false, path: "/", secure: true, session: true, httpOnly: true, name: "sessionid", value: "synthetic-login" };

test("browser snapshots retain HttpOnly and session cookies in a worker-compatible Netscape file", async () => {
  const snapshot = serializeCookies([
    session,
    { ...session, domain: "www.douyin.com", hostOnly: true, name: "detail", session: false, expirationDate: 2000 },
    { ...session, domain: ".douyin.com.attacker.test", name: "unrelated" },
    { ...session, name: "expired", session: false, expirationDate: 999 },
    { ...session, name: "partitioned", partitionKey: { topLevelSite: "https://example.com" } },
  ], 1000);
  assert.equal(snapshot.count, 2);
  assert.match(snapshot.contents, /#HttpOnly_\.douyin.com\tTRUE\t\/\tTRUE\t0\tsessionid/);
  assert.match(snapshot.contents, /#HttpOnly_www.douyin.com\tFALSE\t\/\tTRUE\t2000\tdetail/);
  assert.equal(sanitizeDouyinCookieSnapshot(snapshot.contents).count, 2);
  assert.doesNotMatch(snapshot.contents, /unrelated|expired|partitioned/);
  assert.equal(await snapshotHash(snapshot.contents), await snapshotHash(serializeCookies([session, { ...session, domain: "www.douyin.com", hostOnly: true, name: "detail", session: false, expirationDate: 2000 }].reverse(), 1000).contents));
});

test("sync requires a live login and rejects delimiters that could inject cookie rows", () => {
  assert.throws(() => serializeCookies([]), /登录抖音/);
  assert.throws(() => serializeCookies([{ ...session, name: "uid_tt" }]), /登录抖音/);
  assert.throws(() => serializeCookies([{ ...session, session: false, expirationDate: 1 }]), /登录抖音/);
  assert.throws(() => serializeCookies([{ ...session, value: "a\nb" }]), /格式异常/);
});

test("bindings pin the local origin, company, project and application user", () => {
  assert.equal(isLocalAnalysisUrl("http://127.0.0.1:3210/analysis?tab=videos"), true);
  assert.equal(isLocalAnalysisUrl("http://localhost:3000/analysis/"), true);
  for (const value of ["https://127.0.0.1/analysis", "http://192.168.0.2:3000/analysis", "http://127.0.0.1.attacker.test/analysis", "http://127.0.0.1:3000/settings", "http://user@localhost/analysis"]) assert.equal(isLocalAnalysisUrl(value), false);
  assert.equal(isDouyinDomain(".iesdouyin.com"), true);
  assert.equal(isDouyinDomain("douyin.com.attacker.test"), false);
  const binding = { origin: "http://127.0.0.1:3000", organizationId: "a", projectId: "p", userId: "u" };
  assert.equal(sameBinding(binding, { ...binding, organizationName: "renamed" }), true);
  for (const key of ["origin", "organizationId", "projectId", "userId"]) assert.equal(sameBinding(binding, { ...binding, [key]: "different" }), false);
});
