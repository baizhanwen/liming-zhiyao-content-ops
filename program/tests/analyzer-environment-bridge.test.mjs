import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { createAnalyzerEnvironmentBridge, runRuntimeCommand } from "../scripts/analyzer-environment-bridge.mjs";
import { runtimeInstallationId, runtimeSourceId } from "../scripts/local-runtime-identity.mjs";

const token = "synthetic-runtime-token-00000000000000000000";
const key = "synthetic-provider-key-must-not-leak";
const privateRoot = path.resolve(os.tmpdir(), "synthetic-private-checkout");

async function bridge(t, run) {
  const server = createAnalyzerEnvironmentBridge({
    root: privateRoot, persist: false,
    configuration: () => ({ LOCAL_RUNTIME_TOKEN: token, ANALYZER_LLM_API_KEY: key }), run,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/environment`;
  const identityHeaders = { "x-liming-installation": runtimeInstallationId(privateRoot), "x-liming-source": runtimeSourceId(privateRoot) };
  return {
    base,
    get: (headers = {}) => fetch(base, { headers: { authorization: `Bearer ${token}`, ...identityHeaders, ...headers } }),
    post: (body, headers = {}) => fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, ...identityHeaders, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

function status() {
  return { code: 0, result: { ready: true, workerRunning: false, checks: [{ id: "fixture", label: "合成运行条件", status: "ready" }], modelCache: path.join(privateRoot, "private-cache"), pid: 999 } };
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

test("an optional GPU warning stays nonblocking through the runtime bridge and Web snapshot", async t => {
  const input = { ready: true, workerRunning: false, checks: [{
    id: "whisper_timing_gpu", label: "Whisper GPU 时间定位", status: "warning", required: false,
    message: "上次 GPU 验证失败：CUDA_LIBRARY_UNAVAILABLE；CPU 分析可用。",
  }] };
  const runtime = await bridge(t, async () => ({ code: 0, result: input }));
  const bridged = await (await runtime.get()).json();
  assert.equal(bridged.ready, true);
  assert.equal(bridged.checks[0].status, "warning");
  assert.equal(bridged.checks[0].required, false);
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: {
    LOCAL_RUNTIME_URL: new URL("/", runtime.base).href, LOCAL_RUNTIME_TOKEN: token,
    LOCAL_RUNTIME_INSTALLATION_ID: runtimeInstallationId(privateRoot), LOCAL_RUNTIME_SOURCE_ID: runtimeSourceId(privateRoot),
  } });
  const snapshot = await f.load("lib/analyzer-environment.ts").requestAnalyzerEnvironment();
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.checks, input.checks);
});

function renderEnvironmentPanel(snapshot) {
  let stateIndex = 0;
  const hooks = { ...React, useState: initial => [stateIndex++ === 0 ? snapshot : initial, () => {}],
    useEffect() {}, useCallback: callback => callback };
  const source = ts.transpileModule(readFileSync(new URL("../components/EnvironmentSetupPanel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const require = name => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return jsx;
    if (name.endsWith(".module.css")) return { default: {} };
    if (name === "../lib/client-scope") return { scopedFetch: () => { throw new Error("SSR must not request services"); } };
    if (name === "../lib/client-scope-request") return { isScopeCancellation: () => false };
    if (name === "../lib/client-format") return { readApiError: () => "synthetic error" };
    throw new Error("Unexpected panel dependency: " + name);
  };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  return renderToStaticMarkup(React.createElement(loaded.exports.EnvironmentSetupPanel, { organizationId: "synthetic", canManage: true }));
}

test("the settings panel distinguishes usable CPU from historical or failed GPU inference", () => {
  const snapshot = { available: true, ready: true, workerRunning: false, checks: [{
    id: "whisper_timing_gpu", label: "Whisper GPU 时间定位", status: "warning", required: false,
    message: "上次 Whisper GPU 实际转写验证失败；CPU 分析仍可用。",
  }] };
  const warning = renderEnvironmentPanel(snapshot);
  assert.match(warning, /分析环境可用，GPU 状态见下方/);
  assert.match(warning, /上次 Whisper GPU 实际转写验证失败/);
  assert.doesNotMatch(warning, /Whisper GPU 时间定位 · 未安装/);
  assert.match(warning, /541 MiB/);
  assert.match(warning, /「重新检查」只检测/);
  assert.match(warning, /下载完成后仍需实际转写验证/);
  snapshot.job = { id: "synthetic", action: "setup", status: "running", startedAt: "2026-11-15T00:00:00Z", logTail: [
    JSON.stringify({ phase: "cuda_runtime_download", downloaded_bytes: 1048576, total_bytes: 566698679 }),
    JSON.stringify({ phase: "cuda_runtime_prepared" }),
  ] };
  const downloading = renderEnvironmentPanel(snapshot);
  assert.match(downloading, /正在下载 GPU 运行库：1 \/ 541 MiB/);
  assert.match(downloading, /GPU 运行库文件已准备，继续验证实际转写/);
  delete snapshot.job;
  snapshot.checks[0] = { ...snapshot.checks[0], status: "ready", message: "上次已通过 CUDA 实际转写验证；当前未重新运行 GPU 探测。" };
  assert.match(renderEnvironmentPanel(snapshot), /上次已通过 CUDA 实际转写验证/);
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
    options.onLine(`private-key=${key} Bearer ${token} ${path.join(privateRoot, "model-cache")}`);
    await pending;
    return { code: 0, result: { ready: true, workerRunning: action === "start" } };
  });
  const started = await f.post({ action: "setup" });
  assert.equal(started.status, 202);
  const running = await started.json();
  assert.equal(running.job.status, "running");
  assert.match(running.job.logTail[0], /已隐藏/);
  assert.match(running.job.logTail[0], /\[本项目\]/);
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

test("one-click setup requires verified models and a connected worker", async t => {
  for (const ready of [false, true]) {
    const calls = [];
    const f = await bridge(t, async action => {
      calls.push(action);
      if (action === "status") return { ...status(), code: 1 };
      return { code: 0, result: { ready, workerRunning: false } };
    });
    const response = await f.post({ action: "setup" });
    const state = await response.json();
    assert.equal(state.ready, false);
    assert.equal(state.job.status, "failed");
    assert.equal(calls.includes("start"), ready);
  }
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


test("runtime subprocesses force UTF-8 and preserve split Chinese progress packets", async () => {
  let observed;
  const lines = [];
  const children = new Set();
  const result = await runRuntimeCommand("status", {
    root: privateRoot, children, onLine: line => lines.push(line),
    spawnProcess(command, args, options) {
      observed = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        const packet = Buffer.from(JSON.stringify({ ready: false, message: "仍需准备中文模型", checks: [] }) + "\n", "utf8");
        const split = packet.indexOf(Buffer.from("中", "utf8")) + 1;
        child.stdout.write(packet.subarray(0, split));
        child.stdout.end(packet.subarray(split)); child.stderr.end();
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    },
  });
  assert.equal(observed.options.env.PYTHONUTF8, "1");
  assert.equal(observed.options.env.PYTHONIOENCODING, "utf-8");
  assert.equal(observed.args.at(-1), "status");
  assert.equal(result.code, 0);
  assert.equal(result.result.message, "仍需准备中文模型");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\uFFFD/u);
  assert.equal(children.size, 0);
});
