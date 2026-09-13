import assert from "node:assert/strict";
import test from "node:test";

test("segment progress summary counts completed, failed and remaining work without exposing checkpoint text", async () => {
  const { summarizeSegmentProgress } = await import("../lib/analysis-segment-progress.ts");
  const keyA = "a".repeat(64); const keyB = "b".repeat(64);
  assert.deepEqual(summarizeSegmentProgress(JSON.stringify({ segment_progress: { window_keys: [keyA, keyB], segments: [{ window_key: keyA, index: 0, start_ms: 0, end_ms: 1000, status: "completed", attempts: 1 }, { window_key: keyB, index: 1, start_ms: 1000, end_ms: 2000, status: "in_progress", attempts: 2, report: { secret: "do-not-return" } }] } })), { total: 2, completed: 1, failed: 0, inProgress: 1, remaining: 1, segments: [{ windowKey: keyA, index: 0, startMs: 0, endMs: 1000, status: "completed", attempts: 1, error: null }, { windowKey: keyB, index: 1, startMs: 1000, endMs: 2000, status: "in_progress", attempts: 2, error: null }] });
  assert.equal(summarizeSegmentProgress("not-json"), null);
});

test("single segment retry resets only a retryable segment and preserves completed work", async () => {
  const { resetSegmentForRetry } = await import("../lib/analysis-segment-retry.ts");
  const completedKey = "c".repeat(64); const failedKey = "d".repeat(64);
  const checkpoint = JSON.stringify({ segment_progress: { window_keys: [completedKey, failedKey], segments: [
    { window_key: completedKey, index: 0, start_ms: 0, end_ms: 1000, status: "completed", attempts: 1, report: { keep: true } },
    { window_key: failedKey, index: 1, start_ms: 1000, end_ms: 2000, status: "failed", attempts: 1, error: "model failed", parse_status: "error" },
  ] } });
  const result = resetSegmentForRetry(checkpoint, failedKey);
  assert.ok(result);
  assert.deepEqual(result.target, { windowKey: failedKey, index: 1, startMs: 1000, endMs: 2000 });
  const updated = JSON.parse(result.checkpointJson);
  assert.equal(updated.segment_progress.segments[0].status, "completed");
  assert.equal(updated.segment_progress.segments[0].report.keep, true);
  assert.equal(updated.segment_progress.segments[1].status, "pending");
  assert.equal(updated.segment_progress.segments[1].parse_status, "pending");
  assert.equal("error" in updated.segment_progress.segments[1], false);
  assert.equal(resetSegmentForRetry(checkpoint, completedKey), null);
  assert.equal(resetSegmentForRetry(checkpoint, "not-a-segment"), null);
  assert.equal(resetSegmentForRetry(JSON.stringify({ segment_progress: { segments: [{ window_key: failedKey, index: 1, start_ms: 0, end_ms: 1, status: "unknown" }] } }), failedKey), null);
});