import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalyzerEnvironmentBridge, runRuntimeCommand } from "../scripts/analyzer-environment-bridge.mjs";
import { localRuntimeEndpoint, probeLocalRuntimeBridge, selectLocalRuntimeUrl, waitForLocalRuntimeBridge } from "../scripts/local-runtime-endpoint.mjs";
import { runtimeInstallationId, runtimeSourceId } from "../scripts/local-runtime-identity.mjs";
import { prepareRuntimeConfiguration } from "../scripts/prepare-runtime-configuration.mjs";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const token = "synthetic-shared-token-000000000000000000000000";

function directory(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lmzy-runtime-identity-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

test("taxonomy changes invalidate source identity while customer state does not", t => {
  const root = directory(t);
  const resource = path.join(root, "services/analyzer/liming_analyzer/resources");
  mkdirSync(resource, { recursive: true });
  writeFileSync(path.join(resource, "video-taxonomy.v1.json"), "{}");
  const first = runtimeSourceId(root);
  writeFileSync(path.join(root, ".dev.vars"), "SYNTHETIC=private-state");
  assert.equal(runtimeSourceId(root), first);
  writeFileSync(path.join(resource, "video-taxonomy.v1.json"), '{"version":"changed"}');
  assert.notEqual(runtimeSourceId(root), first);
});

test("each unified-analysis producer, reader and API change invalidates the running source identity", t => {
  const root = directory(t);
  const files = [
    "services/analyzer/liming_analyzer/canonical_transcript.py", "services/analyzer/liming_analyzer/content_module_protocol.py",
    "services/analyzer/liming_analyzer/unified_analysis.py", "services/analyzer/liming_analyzer/providers.py",
    "services/analyzer/liming_analyzer/pipeline.py", "services/analyzer/liming_analyzer/api_client.py",
    "services/analyzer/liming_analyzer/artifacts.py", "services/analyzer/liming_analyzer/model_calls.py",
    "services/analyzer/liming_analyzer/minimax_vision.py", "services/analyzer/liming_analyzer/visual.py",
    "lib/unified-report.ts", "lib/analysis-report-view.ts", "lib/analysis-module-retry.ts", "lib/analysis-media.ts",
    "lib/analysis-quality.ts", "lib/material-analysis-state.ts", "lib/video-content-analysis.ts", "lib/script-rewrite.ts", "lib/video-knowledge-atom-state.ts",
    "app/api/internal/analysis-jobs/[jobId]/complete/route.ts", "app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts",
    "app/api/internal/analysis-jobs/[jobId]/model-calls/route.ts", "app/api/analysis-jobs/[jobId]/retry/route.ts",
    "app/api/videos/[videoId]/route.ts", "app/api/videos/[videoId]/media/route.ts", "app/api/video-library/[entryId]/media/route.ts",
    "app/api/video-library/content-comparison/route.ts", "components/AnalysisDetail.tsx", "components/UnifiedReportContent.tsx",
  ];
  let previous = runtimeSourceId(root);
  for (const filename of files) {
    const target = path.join(root, filename); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "synthetic source change\n");
    const next = runtimeSourceId(root); assert.notEqual(next, previous, filename); previous = next;
  }
  mkdirSync(path.join(root, ".local"));
  writeFileSync(path.join(root, ".local/customer-state.json"), '{"private":"synthetic"}');
  assert.equal(runtimeSourceId(root), previous, "Customer state is not executable source");
});

async function bridge(t, root, calls = []) {
  const configuration = { LOCAL_RUNTIME_TOKEN: token };
  const server = createAnalyzerEnvironmentBridge({ root, configuration: () => configuration, persist: false, run: async action => {
    calls.push(action); return { code: 0, result: { ready: true, processRunning: true, workerRunning: false, restartRequired: true, checks: [] } };
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  configuration.LOCAL_RUNTIME_URL = `http://127.0.0.1:${server.address().port}`;
  return configuration;
}

test("copied credentials cannot control another installation or an outdated bridge", async t => {
  const root = directory(t), other = directory(t), calls = [];
  const configuration = await bridge(t, root, calls);
  const headers = { authorization: `Bearer ${token}`, "x-liming-installation": runtimeInstallationId(other), "x-liming-source": runtimeSourceId(root), "content-type": "application/json" };
  const endpoint = new URL("/environment", configuration.LOCAL_RUNTIME_URL);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "stop" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "RUNTIME_INSTALLATION_MISMATCH");
  assert.deepEqual(calls, []);
  headers["x-liming-installation"] = runtimeInstallationId(root);
  headers["x-liming-source"] = "a".repeat(64);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "stop" }) })).status, 409);
  assert.deepEqual(calls, []);
  assert.equal(await probeLocalRuntimeBridge(root, configuration), true);
  assert.equal(await probeLocalRuntimeBridge(other, configuration), false);
});

test("occupied old endpoint is isolated while the current installation can reuse its own bridge", async t => {
  const first = directory(t), second = directory(t);
  const configuration = await bridge(t, first);
  assert.equal(await selectLocalRuntimeUrl(first, configuration), configuration.LOCAL_RUNTIME_URL);
  const independentUrl = await selectLocalRuntimeUrl(second, configuration);
  assert.notEqual(independentUrl, configuration.LOCAL_RUNTIME_URL);
  assert.equal(localRuntimeEndpoint(independentUrl).hostname, "127.0.0.1");
  await waitForLocalRuntimeBridge(first, configuration, null, 1000);
  await assert.rejects(waitForLocalRuntimeBridge(second, configuration, { exitCode: 1 }, 1000), /版本不匹配/);
});

test("source changes invalidate a running bridge without terminating it", async t => {
  const root = directory(t), calls = [];
  const configuration = await bridge(t, root, calls);
  assert.equal(await probeLocalRuntimeBridge(root, configuration), true);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/analyzer_local_runtime.py"), "# synthetic upgraded source\n");
  assert.equal(await probeLocalRuntimeBridge(root, configuration), false);
  assert.notEqual(await selectLocalRuntimeUrl(root, configuration), configuration.LOCAL_RUNTIME_URL);
  assert.deepEqual(calls, []);
});

test("copied configuration keeps encryption and provider keys but gets its own installation identity", async t => {
  const first = directory(t), second = directory(t);
  const template = "LOCAL_RUNTIME_TOKEN=" + token + "\nMODEL_SETTINGS_ENCRYPTION_KEY=" + "b".repeat(64) + "\nANALYZER_SERVICE_TOKEN=synthetic-existing-service-token\nANALYZER_LLM_API_KEY=synthetic-existing-provider-key\n";
  writeFileSync(path.join(first, ".dev.vars.example"), template);
  writeFileSync(path.join(second, ".dev.vars.example"), template);
  await prepareRuntimeConfiguration(first);
  copyFileSync(path.join(first, ".dev.vars"), path.join(second, ".dev.vars"));
  await prepareRuntimeConfiguration(second);
  const output = readFileSync(path.join(second, ".dev.vars"), "utf8");
  assert.match(output, new RegExp("LOCAL_RUNTIME_INSTALLATION_ID=" + runtimeInstallationId(second)));
  assert.doesNotMatch(output, new RegExp(runtimeInstallationId(first)));
  assert.ok(output.includes("MODEL_SETTINGS_ENCRYPTION_KEY=" + "b".repeat(64)));
  assert.ok(output.includes("ANALYZER_LLM_API_KEY=synthetic-existing-provider-key"));
});

test("environment API uses the selected loopback port and passes both identities", async t => {
  const root = directory(t), f = runtimeFixture(t);
  const configuration = await bridge(t, root);
  f.mockModule("cloudflare:workers", { env: { ...configuration, LOCAL_RUNTIME_INSTALLATION_ID: runtimeInstallationId(root), LOCAL_RUNTIME_SOURCE_ID: runtimeSourceId(root) } });
  const api = f.load("lib/analyzer-environment.ts");
  const snapshot = await api.requestAnalyzerEnvironment();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.workerRunning, false);
  assert.equal(snapshot.processRunning, true);
  assert.equal(snapshot.restartRequired, true);
});

test("environment API rejects unsafe endpoints before dispatch", async t => {
  for (const url of ["https://127.0.0.1:3001", "http://192.0.2.1:3001", "http://user@127.0.0.1:3001", "http://127.0.0.1:3001/foreign", "http://127.0.0.1:80"]) {
    const f = runtimeFixture(t);
    f.mockModule("cloudflare:workers", { env: { LOCAL_RUNTIME_URL: url, LOCAL_RUNTIME_TOKEN: token, LOCAL_RUNTIME_INSTALLATION_ID: "a".repeat(64), LOCAL_RUNTIME_SOURCE_ID: "b".repeat(64) } });
    assert.equal((await f.load("lib/analyzer-environment.ts").requestAnalyzerEnvironment()).available, false);
  }
});

test("runtime command forwards the actual app address to the shared Windows controller", async () => {
  let observed;
  await runRuntimeCommand("start", { root: "/synthetic-root", baseUrl: "http://127.0.0.1:31999", spawnProcess(command, args, options) {
    observed = { command, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stdout.end('{"ready":true,"workerRunning":true}\n'); child.stderr.end(); setImmediate(() => child.emit("close", 0, null)); });
    return child;
  } });
  assert.deepEqual(observed.args.slice(-3), ["start", "--base-url", "http://127.0.0.1:31999"]);
  assert.equal(observed.options.env.ANALYZER_BASE_URL, "http://127.0.0.1:31999");
});
