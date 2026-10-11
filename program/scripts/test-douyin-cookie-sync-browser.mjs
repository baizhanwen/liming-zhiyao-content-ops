/* global chrome */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sanitizeDouyinCookieSnapshot } from "../lib/douyin-cookie-snapshot.ts";

// An isolated Edge profile and synthetic cookies exercise the real extension APIs.
// No personal browser profile or running application's data is used.
const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.ECOMMERCE_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs")).href);
let applicationUser = "fixture-user";
let allowed = true;
let updatedAt = null;
let writes = 0;
let receivedSnapshot = "";
let delayUpload = false;
let releaseUpload;
let uploadStarted;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/analysis") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><html lang="zh-CN"><title>Sync fixture</title><div class="analysis-toolbar"><select id="org"><option value="fixture-org">测试公司</option><option value="other-org">其他公司</option></select><select id="project"><option value="fixture-project">测试空间</option></select></div></html>');
    return;
  }
  if (url.pathname === "/api/auth/session") {
    response.writeHead(applicationUser ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ user: { id: applicationUser } }));
    return;
  }
  if (url.pathname === "/api/videos") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: { canManageCookies: allowed, cookieUpdatedAt: updatedAt } }));
    return;
  }
  if (url.pathname === "/api/analyzer/cookies" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const parsed = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"] } }).formData();
    receivedSnapshot = await parsed.get("file").text();
    const snapshot = sanitizeDouyinCookieSnapshot(receivedSnapshot);
    assert.equal(request.headers["x-organization-id"], "fixture-org");
    assert.equal(request.headers["x-project-id"], "fixture-project");
    if (delayUpload) { uploadStarted(); await new Promise(resolve => { releaseUpload = resolve; }); }
    writes += 1;
    updatedAt = new Date(Date.now() + writes).toISOString();
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ updatedAt, cookieCount: snapshot.count }));
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  const extension = path.join(root, "tools/douyin-cookie-sync");
  context = await chromium.launchPersistentContext("", {
    executablePath: process.env.ECOMMERCE_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const workerErrors = [];
  worker.on("console", message => { if (message.type() === "error") workerErrors.push(message.text()); });
  const app = await context.newPage();
  await app.goto(`${origin}/analysis`);
  await context.addCookies([
    { name: "sessionid", value: "synthetic-login", domain: ".douyin.com", path: "/", httpOnly: true, secure: true },
    { name: "unrelated", value: "never-export", domain: ".example.com", path: "/" },
  ]);
  const popup = await context.newPage();
  await popup.goto(new URL("popup.html", worker.url()).href);
  const send = async message => { await app.bringToFront(); return popup.evaluate(message => chrome.runtime.sendMessage(message), message); };
  const inspect = async () => worker.evaluate(() => chrome.storage.local.get("syncState"));
  const preview = await send({ type: "PREVIEW" });
  assert.equal(preview.ok, true, preview.message);
  assert.equal(preview.binding.organizationName, "测试公司");
  const first = await send({ type: "BIND", binding: preview.binding });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.state.error, "", first.state.error);
  assert.equal(writes, 1);
  assert.match(receivedSnapshot, /#HttpOnly_\.douyin.com/);
  assert.doesNotMatch(receivedSnapshot, /never-export|unrelated/);
  assert.doesNotMatch(JSON.stringify(await inspect()), /synthetic-login/);
  assert.equal(await app.evaluate(() => document.body.textContent.includes("synthetic-login")), false);

  // Re-import popup UI after bringing the app to the front: real popup focus leaves that tab active.
  await popup.evaluate(async () => { await import(chrome.runtime.getURL("popup.mjs?browser-test")); });
  assert.equal(await popup.locator("#status").textContent(), "自动同步已开启");
  assert.match(await popup.locator("#bound").textContent(), /测试公司/);

  const tick = async () => {
    await worker.evaluate(async () => { await chrome.alarms.create("liming-cookie-check", { when: Date.now() + 100 }); });
    await new Promise(resolve => setTimeout(resolve, 1200));
  };
  await tick();
  assert.equal(writes, 1, "unchanged cookies should not upload twice");

  await app.locator("#org").selectOption("other-org");
  const changedScope = await send({ type: "SYNC" });
  assert.match(changedScope.state.error, /绑定/);
  assert.equal(writes, 1);
  await app.locator("#org").selectOption("fixture-org");
  await tick();
  assert.equal((await inspect()).syncState.error, "", "restoring an unchanged binding clears its previous error");
  assert.equal(writes, 1);

  applicationUser = "different-user";
  assert.match((await send({ type: "SYNC" })).state.error, /绑定/);
  assert.equal(writes, 1);
  applicationUser = "fixture-user";
  allowed = false;
  assert.match((await send({ type: "SYNC" })).state.error, /权限/);
  assert.equal(writes, 1);
  allowed = true;
  applicationUser = "";
  assert.match((await send({ type: "SYNC" })).state.error, /重新登录/);
  assert.equal(writes, 1);
  applicationUser = "fixture-user";

  updatedAt = null;
  await tick();
  assert.equal(writes, 2, "a manually cleared snapshot is restored on the next automatic check");
  await context.addCookies([{ name: "sessionid", value: "rotated-synthetic-login", domain: ".douyin.com", path: "/", httpOnly: true, secure: true }]);
  assert.ok(await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const alarm = await chrome.alarms.get("liming-cookie-changed");
      if (alarm) return alarm;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }));
  await tick();
  assert.equal(writes, 3);
  assert.match(receivedSnapshot, /rotated-synthetic-login/);

  // Pausing must wait for an outstanding upload, so subsequent manual clearing stays cleared.
  delayUpload = true;
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const inFlight = send({ type: "SYNC" });
  await started;
  const unbinding = send({ type: "UNBIND" });
  releaseUpload();
  await inFlight;
  const paused = await unbinding;
  assert.equal(paused.state.enabled, false);
  assert.equal((await inspect()).syncState.enabled, false);
  assert.equal(await worker.evaluate(() => chrome.alarms.get("liming-cookie-check")), undefined);
  const pausedWrites = writes;
  await send({ type: "SYNC" });
  assert.equal(writes, pausedWrites);
  assert.deepEqual(workerErrors, []);
  console.log("PASS: real Edge extension binds, uploads HttpOnly cookies, deduplicates, handles rotation, pins company/user/permissions and pauses safely.");
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
