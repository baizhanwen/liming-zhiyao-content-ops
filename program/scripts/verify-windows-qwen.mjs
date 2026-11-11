// Runs on a fresh Windows machine. Only the shipped setup action installs the analyzer.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32", "This acceptance check requires native Windows.");
const root = process.cwd();
const out = path.join(root, ".local/verification/windows-qwen");
mkdirSync(out, { recursive: true });
let origin;
let sessionCookie;
const fixture = "https://isv-data.oss-cn-hangzhou.aliyuncs.com/ics/MaaS/ASR/test_audio/asr_example_zh.wav";
const audioHash = "a1bd32dc78493c123f9625a66deee562aed2895f53fbc39f2cca3be7e6f4f20f";
const reference = "欢迎大家来体验达摩院推出的语音识别模型";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { revision: process.env.GITHUB_SHA, zipSha256: process.env.ACCEPTANCE_ZIP_SHA256, windows: os.release(), cpu: os.cpus()[0].model,
  cores: os.availableParallelism(), memoryGiB: Math.round(os.totalmem() / 2 ** 30), startedAt: new Date().toISOString(), fixture, audioHash, reference };
const record = () => writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2));
const freeGiB = () => { const disk = statfsSync(root); return Math.round(disk.bavail * disk.bsize / 2 ** 30); };
const jsonPost = data => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
async function api(url, options = {}) {
  const response = await fetch(origin + url, { ...options, headers: { origin, ...(sessionCookie ? { cookie: sessionCookie } : {}), ...options.headers }, signal: AbortSignal.timeout(90_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(url + " HTTP " + response.status + " " + text.slice(0, 650));
  return JSON.parse(text);
}
async function waitUntil(name, timeoutMs, intervalMs, check) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + name);
}

async function install(browser, organizationId) {
  const url = "/api/analyzer-environment?organizationId=" + organizationId;
  const initial = await api(url);
  assert.equal(initial.ready, false, "A clean source installation must require analyzer setup.");
  assert.equal(initial.workerRunning, false);
  assert.equal(existsSync("services/analyzer/.venv"), false);
  assert.equal(existsSync(".local/model-cache/models-ready.json"), false);
  report.before = { ready: initial.ready, workerRunning: initial.workerRunning, freeGiB: freeGiB() };
  record();

  const page = await browser.newPage();
  const separator = sessionCookie.indexOf("=");
  await page.context().addCookies([{ name: sessionCookie.slice(0, separator), value: sessionCookie.slice(separator + 1), url: origin, httpOnly: true }]);
  await page.goto(origin + "/settings", { waitUntil: "domcontentloaded", timeout: 120_000 });
  const setup = page.getByRole("button", { name: "一键配置环境并启动", exact: true });
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === "/api/analyzer-environment" && r.request().method() === "POST", { timeout: 150_000 }),
    setup.click({ timeout: 150_000 }),
  ]);
  assert.equal(response.status(), 202, await response.text());
  assert.deepEqual(response.request().postDataJSON(), { organizationId, action: "setup" });
  report.setup = { control: "一键配置环境并启动", action: "setup", responseStatus: response.status() };
  await page.close();
  let previous = "";
  const status = await waitUntil("one-click setup and worker heartbeat", 85 * 60_000, 12_000, async () => {
    const state = await api(url);
    const log = state.job?.logTail || [];
    const last = log.at(-1) || state.job?.status;
    if (last && last !== previous) { console.log(last, "free GiB:", freeGiB()); previous = last; }
    if (state.job?.status === "failed") throw new Error([state.job.error, ...log].join("\n"));
    return state.job?.status === "succeeded" && state.ready && state.workerRunning && state;
  });
  const marker = JSON.parse(readFileSync(".local/model-cache/models-ready.json"));
  assert.equal(marker.asrBackend, "sherpa-onnx");
  assert.equal(marker.asrModel, "Qwen3-ASR-1.7B");
  assert.equal(marker.asrVerified, true);
  report.after = { ready: status.ready, workerRunning: status.workerRunning, checks: status.checks.map(({ id, label, status }) => ({ id, label, status })),
    model: marker.asrModel, backend: marker.asrBackend, verified: marker.asrVerified, freeGiB: freeGiB(), at: new Date().toISOString() };
  console.log("Windows one-click setup ready:", report.after.model, report.after.backend);
  record();
}

async function fetchPublicAudio() {
  const wav = path.join(out, "public-sample.wav");
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(fixture, { signal: AbortSignal.timeout(60_000) });
      assert.ok(response.ok, "Public audio HTTP " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(bytes), audioHash);
      writeFileSync(wav, bytes);
      lastError = undefined;
      break;
    } catch (error) { lastError = error; await delay(2_000); }
  }
  if (lastError) throw lastError;
  return wav;
}

const probeText = "大家好欢迎使用语音识别";
const probeFile = path.join(root, "resources/media-tools/asr-check-zh.wav");
function fixtureVideo(name, sequence) {
  const python = path.join(root, "services/analyzer/.venv/Scripts/python.exe");
  const merged = path.join(out, name + ".wav");
  const concatenate = [
    "import sys, wave",
    "with wave.open(sys.argv[1], 'wb') as dest:",
    "    dest.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))",
    "    for item in sys.argv[2:]:",
    "        with wave.open(item, 'rb') as source:",
    "            assert source.getparams()[:3] == (1, 2, 16000)",
    "            dest.writeframes(source.readframes(source.getnframes()))",
    "            dest.writeframes(bytes(9600))",  // 300 ms pause between utterances
    "with wave.open(sys.argv[1], 'rb') as source: print(source.getnframes() / 16000)",
  ].join("\n");
  const duration = Number(execFileSync(python, ["-c", concatenate, merged, ...sequence.map(item => item.file)], { encoding: "utf8" }));
  const query = "import sys;sys.path.insert(0,'scripts');from analyzer_local_runtime import resolve_media_tools;print(resolve_media_tools()['ffmpeg'])";
  const ffmpeg = execFileSync(python, ["-c", query], { encoding: "utf8" }).trim();
  const video = path.join(out, name + ".mp4");
  execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10",
    "-i", merged, "-t", String(duration), "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-c:a", "aac", video], { stdio: "inherit" });
  return { bytes: readFileSync(video), duration, expected: sequence.map(item => item.text).join("") };
}

const decodeMessage = "Qwen3-ASR-1.7B sherpa-onnx transcription completed";
function completedDecodes() {
  // Windows PowerShell 5 can redirect stderr as UTF-16LE.
  return ["analyzer.log", "analyzer-error.log"].flatMap(file => {
    const log = path.join(root, ".local/logs", file);
    if (!existsSync(log)) return [];
    const lines = readFileSync(log, "utf8").replaceAll("\0", "").replace(/\s+/g, " ");
    return [...lines.matchAll(/Qwen3-ASR-1\.7B sherpa-onnx transcription completed \(windows=(\d+)\)/g)].map(match => Number(match[1]));
  });
}

async function transcribe(scope, name, { bytes, duration, expected }) {
  const title = "Windows ASR acceptance " + name;
  const blobName = "media-1";
  const entry = { library: { category: "other", tags: [], notes: null },
    video: { platform: "upload", sourceType: "upload", sourceHash: hash(bytes), title, sourceMediaBlobName: blobName },
    assets: [{ blobName, kind: "source_video", filename: "speech.mp4", contentType: "video/mp4" }], transcripts: [], analyses: [], metrics: [] };
  const form = new FormData();
  for (const [key, value] of Object.entries(scope)) form.set(key, value);
  form.set("manifest", JSON.stringify({ format: "liming-video-library-package", version: 1, entries: [entry] }));
  form.append("media", new Blob([bytes], { type: "video/mp4" }), blobName);
  const imported = await api("/api/video-library/transfer", { method: "POST", body: form });
  assert.equal(imported.imported, 1);
  const query = "?" + new URLSearchParams(scope);
  const videos = await api("/api/videos" + query);
  const videoId = videos.videos.find(video => video.title === title)?.id;
  assert.ok(videoId);
  const route = "/api/videos/" + videoId;
  const before = await api(route + query);
  assert.equal(before.transcript, null);
  assert.equal(before.analyses.length, 0);
  const decodesBefore = completedDecodes().length;
  const { job } = await api(route + "/reanalyze", jsonPost({ ...scope, task: "transcript" }));
  let previous = "";
  const result = await waitUntil("the queued manuscript to be saved", 14 * 60_000, 3_000, async () => {
    const data = await api(route + query);
    const current = data.latestJob || data.job;
    assert.equal(current?.id, job.id);
    if (current.status !== previous) { console.log("Worker job", current.status, current.current_stage); previous = current.status; }
    if (["partial", "failed", "cancelled"].includes(current.status)) throw new Error(JSON.stringify({ status: current.status, stage: current.current_stage, error: current.error_message }));
    return current.status === "completed" && data;
  });
  const transcript = result.transcript;
  assert.equal(transcript?.source, "asr");
  assert.equal(result.analyses.length, 0);
  const extraction = { name, durationSeconds: duration, expected, jobId: job.id, status: "completed", text: transcript.full_text, source: transcript.source,
    segments: transcript.segments, generatedAnalyses: result.analyses.length, at: new Date().toISOString() };
  report.extractions.push(extraction);
  record();
  const decodes = completedDecodes().slice(decodesBefore);
  assert.equal(decodes.length, 1, "The worker must report Qwen decoding every voiced window of this task.");
  extraction.workerEvidence = decodeMessage + " (windows=" + decodes[0] + ")";
  assert.ok(decodes[0] >= (duration > 32 ? 3 : 1), "Actual worker decode count must span the expected audio windows.");
  record();
  assert.equal(transcript.full_text.replace(/[\p{P}\p{Z}\s]/gu, ""), expected);
  assert.ok(Array.isArray(transcript.segments) && transcript.segments.length > 0);
  let previousEnd = 0;
  for (const segment of transcript.segments) {
    assert.ok(Number.isFinite(segment.start_ms) && segment.start_ms >= previousEnd && segment.end_ms > segment.start_ms && segment.end_ms <= duration * 1000 + 200);
    previousEnd = segment.end_ms;
  }
  assert.ok(previousEnd > duration * 1000 - 2700, "The last timed segment must cover the final utterance.");
  console.log("Worker saved transcript:", transcript.full_text);
}

let browser;
const log = openSync(path.join(out, "web.log"), "w");
const web = spawn("cmd.exe", ["/d", "/c", "start-local.bat"], { cwd: root, stdio: ["ignore", log, log] });
closeSync(log);
try {
  const first = await waitUntil("the packaged web app", 6 * 60_000, 2_000, async () => {
    if (web.exitCode !== null) throw new Error("Packaged start-local.bat exited with " + web.exitCode);
    if (!existsSync(".local/app.port")) return null;
    const port = Number(readFileSync(".local/app.port", "utf8").trim());
    if (!(port > 0 && port <= 65535)) return null;
    origin = "http://127.0.0.1:" + port;
    try { return await api("/api/first-run"); } catch { return null; }
  });
  assert.equal(first.setupRequired, true);
  assert.equal(first.setupCodeRequired, false);
  const email = "acceptance@example.invalid";
  const password = randomBytes(24).toString("hex");
  const firstRun = await api("/api/first-run", jsonPost({ companyName: "Windows ASR verification",
    administratorName: "Windows acceptance", email, password, confirmation: password }));
  const organizationId = firstRun.installation.organizationId;
  const login = await fetch(origin + "/api/auth/session", jsonPost({ email, password }));
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie, "Packaged login did not return a session.");
  const { project } = await api("/api/projects", jsonPost({ organizationId, name: "Windows transcription" }));
  const { chromium } = await import(pathToFileURL(process.env.ACCEPTANCE_PLAYWRIGHT).href);
  browser = await chromium.launch({ channel: "msedge" });
  await install(browser, organizationId);
  const publicSample = { file: await fetchPublicAudio(), text: reference };
  const probeSample = { file: probeFile, text: probeText };
  const scope = { organizationId, projectId: project.id };
  report.extractions = [];
  await transcribe(scope, "single", fixtureVideo("single", [publicSample]));
  const long = fixtureVideo("multi", [probeSample, publicSample, publicSample, probeSample, publicSample, probeSample, probeSample, publicSample]);
  assert.ok(long.duration > 32);
  await transcribe(scope, "multi", long);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  record();
  await browser?.close();
  if (web.exitCode === null) { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(web.pid)], { stdio: "ignore" }); } catch { /* The server may already have exited. */ } }
}
