import assert from "node:assert/strict";
import test from "node:test";
import { createTaskSnapshotReader } from "../lib/task-snapshot-reader.ts";

test("overlapping refreshes share one read and failures retain the last successful snapshot", async () => {
  let resolveRead, rejectRead, calls = 0, clock = 1_000;
  const data = [], states = [];
  const reader = createTaskSnapshotReader({
    read: () => { calls++; return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }); },
    onData: (value, at) => data.push([value, at]), onConnection: (state) => states.push(state), now: () => clock,
  });
  const first = reader.refresh();
  assert.equal(first, reader.refresh());
  await Promise.resolve();
  resolveRead({ id: "first" });
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(data, [[{ id: "first" }, 1_000]]);
  clock = 3_000;
  const second = reader.refresh();
  await Promise.resolve();
  rejectRead(new Error("offline"));
  await assert.rejects(second, /offline/);
  assert.equal(data.length, 1);
  assert.equal(states.at(-1).lastSuccessAt, 1_000);
  assert.equal(states.at(-1).failureStartedAt, 3_000);
  clock = 5_000;
  const third = reader.refresh();
  await Promise.resolve();
  rejectRead(new Error("offline again"));
  await assert.rejects(third);
  assert.equal(states.at(-1).failureStartedAt, 3_000);
  assert.equal(states.at(-1).failures, 2);
  reader.dispose();
});

test("switching scope aborts old reads and ignores late data", async () => {
  let finish, signal;
  const data = [], states = [];
  const reader = createTaskSnapshotReader({ read: (input) => { signal = input; return new Promise((resolve) => { finish = resolve; }); }, onData: (value) => data.push(value), onConnection: (value) => states.push(value) });
  const request = reader.refresh();
  await Promise.resolve();
  reader.dispose();
  assert.equal(signal.aborted, true);
  finish({ privateScope: "old" });
  await request;
  assert.deepEqual(data, []);
  assert.equal(states.length, 1);
});

test("a hung response times out, aborts, and releases the reader for retry", async () => {
  const signals = [], states = [], data = [];
  let calls = 0;
  const reader = createTaskSnapshotReader({ timeoutMs: 10, read: (signal) => { signals.push(signal); return ++calls === 1 ? new Promise(() => {}) : Promise.resolve("recovered"); }, onData: (value) => data.push(value), onConnection: (value) => states.push(value) });
  await assert.rejects(reader.refresh(), /读取超时/);
  assert.equal(signals[0].aborted, true);
  await reader.refresh();
  assert.deepEqual(data, ["recovered"]);
  assert.equal(states.at(-1).error, null);
  assert.equal(states.at(-1).failures, 0);
  reader.dispose();
});

test("a mutation invalidates an older list read before fresh data can replace its acknowledgement", async () => {
  const resolutions = [], data = [];
  const reader = createTaskSnapshotReader({ read: () => new Promise((resolve) => resolutions.push(resolve)), onData: (value) => data.push(value), onConnection: () => {} });
  const stale = reader.refresh();
  await Promise.resolve();
  reader.invalidate();
  const fresh = reader.refresh();
  await Promise.resolve();
  resolutions[0]("running-before-cancel");
  await stale;
  assert.deepEqual(data, []);
  resolutions[1]("cancelled-after-action");
  await fresh;
  assert.deepEqual(data, ["cancelled-after-action"]);
  reader.dispose();
});
