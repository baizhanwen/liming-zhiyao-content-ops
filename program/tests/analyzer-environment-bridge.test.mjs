import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import { createAnalyzerEnvironmentBridge } from "../scripts/analyzer-environment-bridge.mjs";

const token = "synthetic-runtime-token-00000000000000000000";
const key = "synthetic-provider-key-must-not-leak";

async function bridge(t, run) {
  const server = createAnalyzerEnvironmentBridge({
    root: "/synthetic-private-checkout", persist: false,
    configuration: () => ({ LOCAL_RUNTIME_TOKEN: token, ANALYZER_LLM_API_KEY: key }), run,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/environment`;
  return {
    base,
    get: (headers = {}) => fetch(base, { headers: { authorization: `Bearer ${token}`, ...headers } }),
    post: (body, headers = {}) => fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

function status() {
  return { code: 0, result: { ready: true, workerRunning: false, checks: [{ id: "fixture", label: "合成运行条件", status: "ready" }], modelCache: "/synthetic-private-checkout/private-cache", pid: 999 } };
}

test("loopback environment control rejects missing credentials, browser origins and foreign Hosts", async t => {
  const f = await bridge(t, async () => status());
  assert.equal((await fetch(f.base)).status, 401);
  assert.equal((await f.get({ authorization: "Bearer wrong-token" })).status, 401);
  assert.equal((await f.get({ origin: "http://127.0.0.1:3000" })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const outgoing = request(f.base, { headers: { host: "attacker.invalid:3001", authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode); });
    outgoing.once("error", reject); outgoing.end();
  });
  assert.equal(foreignHostStatus, 403);
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.doesNotMatch(JSON.stringify(body), /private-cache|\bpid\b|synthetic-runtime-token/);
});

test("only fixed environment actions are accepted, with no command or path inputs", async t => {
  const calls = [];
  const f = await bridge(t, async action => { calls.push(action); return status(); });
  for (const body of [{ action: "exec" }, { action: "setup", command: "not-permitted" }, { action: "start", path: "/another-checkout" }, [], null]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.deepEqual(calls, []);
});

test("synthetic long-running setup admits one job, exposes real state transitions and redacts logs", async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const f = await bridge(t, async (action, options) => {
    calls.push(action);
    if (action === "status") return status();
    options.onLine(`private-key=${key} Bearer ${token} /synthetic-private-checkout/model-cache`);
    await pending;
    return { code: 0, result: { ready: true } };
  });
  const started = await f.post({ action: "setup" });
  assert.equal(started.status, 202);
  const running = await started.json();
  assert.equal(running.job.status, "running");
  assert.match(running.job.logTail[0], /已隐藏/);
  assert.doesNotMatch(JSON.stringify(running), /synthetic-provider-key|synthetic-runtime-token|synthetic-private-checkout/);
  assert.equal((await f.post({ action: "setup" })).status, 409);
  assert.equal(calls.filter(action => action === "setup").length, 1);
  finish();
  let complete;
  for (let index = 0; index < 20; index += 1) {
    complete = await (await f.get()).json();
    if (complete.job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(complete.job.id, running.job.id);
  assert.equal(complete.job.status, "succeeded");
  assert.deepEqual(calls.filter(action => action !== "status"), ["setup", "start"]);
});

test("failed runtime subprocesses stay failed rather than claiming successful installation", async t => {
  const f = await bridge(t, async action => action === "status" ? status() : { code: 1, result: { ready: false } });
  const response = await f.post({ action: "setup" });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.job.status, "failed");
  assert.match(body.job.error, /没有完成/);
});

test("repair of a running analyzer handles stopRequired internally before setup and restart", async t => {
  const calls = [];
  let setupCalls = 0;
  const f = await bridge(t, async action => {
    if (action === "status") return status();
    calls.push(action);
    if (action === "setup" && setupCalls++ === 0) return { code: 1, result: { stopRequired: true, ready: false } };
    return { code: 0, result: { ready: true, workerRunning: action === "start" } };
  });
  const response = await f.post({ action: "setup" });
  assert.equal(response.status, 202);
  let body;
  for (let index = 0; index < 20; index += 1) {
    body = await (await f.get()).json();
    if (body.job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(body.job.status, "succeeded");
  assert.deepEqual(calls, ["setup", "stop", "setup", "start"]);
});
