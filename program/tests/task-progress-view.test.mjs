import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedSeconds, initialTaskRefresh, taskMetricItems, taskProgressView } from "../lib/task-progress-view.ts";

const snapshotAt = Date.parse("2026-11-10T04:00:00Z");
const task = {
  id: "job-fixture", status: "analyzing", current_stage: "结构化分析",
  taskProgress: {observedAt: "2026-11-10T04:00:00Z", elapsedSeconds: 75, stageElapsedSeconds: 65,
    activityAgeSeconds: 20, executionCount: 2, phase: "model_analysis", waitingOn: "text_service", workerActive: true},
};
const connected = {...initialTaskRefresh, lastSuccessAt: snapshotAt};

test("execution clocks briefly extrapolate each task snapshot while progress age remains independent", () => {
  const view = taskProgressView(task, connected, snapshotAt, snapshotAt + 4000);
  assert.equal(view.elapsed, 79);
  assert.equal(view.stageElapsed, 69);
  assert.equal(view.activityAge, 24);
  assert.equal(view.fresh, true);
  assert.equal(view.waitingLabel, "文字服务");
  const stale = taskProgressView(task, connected, snapshotAt, snapshotAt + 30000);
  assert.equal(stale.elapsed, 87);
  assert.equal(stale.stageElapsed, 77);
  assert.equal(stale.activityAge, 50);
  assert.equal(stale.stale, true);
});

test("first failed read freezes clocks without jumping back; repeated failures do not add time", () => {
  const disconnected = {...connected, error: "暂不可用", failureStartedAt: snapshotAt + 5000, failures: 1};
  for (const after of [5000, 60000, 180000]) {
    const view = taskProgressView(task, disconnected, snapshotAt, snapshotAt + after);
    assert.equal(view.elapsed, 80);
    assert.equal(view.stageElapsed, 70);
    assert.equal(view.activityAge, 20 + after / 1000);
  }
});

test("a refreshed list cannot advance an old or newly created task's missing snapshot", () => {
  const anotherTaskRead = {...connected, lastSuccessAt: snapshotAt + 60000};
  const view = taskProgressView(task, anotherTaskRead, snapshotAt, snapshotAt + 65000);
  assert.equal(view.elapsed, 87);
  assert.equal(view.fresh, false);
  assert.equal(view.stale, true);
  const justCreated = taskProgressView({...task, taskProgress: null}, anotherTaskRead, null, snapshotAt + 65000);
  assert.equal(justCreated.elapsed, null);
  assert.equal(justCreated.stageElapsed, null);
  assert.equal(justCreated.activityAge, null);
  assert.equal(justCreated.executionCount, null);
});

test("terminal and unknown states cannot keep execution clocks running", () => {
  for (const status of ["completed", "partial", "failed", "cancelled", "unknown"]) {
    const view = taskProgressView({...task, status}, connected, snapshotAt, snapshotAt + 60000);
    assert.equal(view.elapsed, 75);
    assert.equal(view.stageElapsed, 65);
    assert.equal(view.noActivity, false);
  }
  assert.equal(taskProgressView({...task, status: "cancelled"}, connected, snapshotAt, snapshotAt).heading, "已取消后续处理");
});

test("queued retries hide old phase counters and use observed queue time", () => {
  const queued = {...task, status: "pending", created_at: "2026-11-10T02:00:00Z", taskProgress: {...task.taskProgress, queuedAt: "2026-11-10T03:59:30Z", elapsedSeconds: null, startedAt: null, stageElapsedSeconds: null, metrics: {transcribed_chunks: 9}}};
  const view = taskProgressView(queued, connected, snapshotAt, snapshotAt + 4000);
  assert.equal(view.elapsed, 34);
  assert.equal(view.stageElapsed, null);
  assert.equal(view.phase, "");
  assert.deepEqual(view.metricItems, []);
  assert.equal(view.waitingLabel, null);
  assert.equal(view.noActivity, false);
  const withoutQueueTime = taskProgressView({...queued, taskProgress: {...queued.taskProgress, queuedAt: null}}, connected, snapshotAt, snapshotAt + 4000);
  assert.equal(withoutQueueTime.elapsed, null);
  assert.equal(withoutQueueTime.executionCount, 2);
});

test("server timestamps support measured legacy facts without comparing server and browser clocks", () => {
  const shiftedBrowser = snapshotAt + 300000;
  const legacy = {...task, taskProgress: {observedAt: "2026-11-10T04:00:00Z", startedAt: "2026-11-10T03:59:00Z", stageStartedAt: "2026-11-10T03:59:40Z", lastProgressAt: "2026-11-10T03:59:40Z", workerActive: true}};
  const view = taskProgressView(legacy, {...connected, lastSuccessAt: shiftedBrowser}, shiftedBrowser, shiftedBrowser + 4000);
  assert.equal(view.elapsed, 64);
  assert.equal(view.stageElapsed, 24);
  assert.equal(view.activityAge, 24);
});

test("metric rendering uses only finite measured integer counters and never arbitrary payload fields", () => {
  assert.deepEqual(taskMetricItems({completed: 1, total: 3, transcribed_chunks: 2, total_chunks: 3, downloaded_bytes: 2097152,
    proxy_bytes: Infinity, sampled_frames: -1, retry_attempt: 1.5, key: "private-fixture", detail: "private-fixture"}, "model_analysis"),
  ["等待文字服务响应：1 / 3", "已转写音频段：2 / 3", "实际取回数据：2.0 MB"]);
  assert.deepEqual(taskMetricItems({completed: NaN, total: 0, transcribed_chunks: "3", requests: Number.MAX_SAFE_INTEGER + 1}, "unknown"), []);
  assert.deepEqual(taskMetricItems({candidates_checked: 3, candidates_total: 4, vision_batches_completed: 1, vision_batches_total: 2, ocr_completed: 3, ocr_total: 4}, "model_vision"),
    ["已检查候选画面：3 / 4", "已完成视觉分析批次：1 / 2"]);
  assert.equal(formatElapsedSeconds(NaN), "—");
  assert.equal(formatElapsedSeconds(-1), "—");
  assert.equal(formatElapsedSeconds(61), "1分1秒");
});

test("slow-step hint reflects real progress rather than lease renewal or successful polling", () => {
  const idle = {...task, taskProgress: {...task.taskProgress, activityAgeSeconds: 65}};
  const view = taskProgressView(idle, connected, snapshotAt, snapshotAt + 1000);
  assert.equal(view.noActivity, true);
  assert.equal(view.activityAge, 66);
  assert.equal(view.fresh, true);
  assert.match(view.workerLabel, /心跳/);
  assert.doesNotMatch(view.workerLabel, /模型.*生成|处理成功/);
});

test("offline and unknown workers do not advance execution clocks between repeated snapshots", () => {
  for (const workerActive of [false, undefined]) {
    const offline = {...task, taskProgress: {...task.taskProgress, workerActive}};
    for (const after of [0, 4000, 12000, 60000]) {
      const view = taskProgressView(offline, connected, snapshotAt, snapshotAt + after);
      assert.equal(view.elapsed, 75);
      assert.equal(view.stageElapsed, 65);
    }
  }
});

test("claimed queued jobs show local preparation and running clocks rather than queue wait", () => {
  const preparing = {...task, status: "queued", taskProgress: {...task.taskProgress, phase: "loading_models", waitingOn: "transcription_service", metrics: {candidates_checked: 2, candidates_total: 5}}};
  const view = taskProgressView(preparing, connected, snapshotAt, snapshotAt + 4000);
  assert.equal(view.queued, false);
  assert.equal(view.active, true);
  assert.equal(view.elapsed, 79);
  assert.equal(view.stageElapsed, 69);
  assert.equal(view.stage, "本地模型加载");
  assert.equal(view.heading, "当前阶段：本地模型加载");
  assert.equal(view.waitingLabel, null);
  assert.deepEqual(view.metricItems, ["已检查候选画面：2 / 5"]);
});

test("model service waiting labels require the matching measured phase", () => {
  for (const phase of ["loading_models", "audio_chunks", "frames", "transcription_complete"]) {
    assert.equal(taskProgressView({...task, taskProgress: {...task.taskProgress, phase}}, connected, snapshotAt, snapshotAt).waitingLabel, null);
  }
});
