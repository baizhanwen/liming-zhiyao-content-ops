export type SegmentRetryTarget = {
  windowKey: string;
  index: number;
  startMs: number;
  endMs: number;
};

export type SegmentRetryResult = {
  checkpointJson: string;
  target: SegmentRetryTarget;
};

export function resetSegmentForRetry(checkpointJson: unknown, segmentKey: string): SegmentRetryResult | null {
  if (typeof checkpointJson !== "string" || !checkpointJson.trim()) return null;
  if (typeof segmentKey !== "string" || !/^[0-9a-f]{64}$/i.test(segmentKey.trim())) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(checkpointJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const progress = (parsed as Record<string, unknown>).segment_progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const rows = (progress as Record<string, unknown>).segments;
  if (!Array.isArray(rows)) return null;

  const wantedKey = segmentKey.trim().toLowerCase();
  const row = rows.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const windowKey = (candidate as Record<string, unknown>).window_key;
    return typeof windowKey === "string" && windowKey.toLowerCase() === wantedKey;
  }) as Record<string, unknown> | undefined;
  if (!row || (row.status !== "pending" && row.status !== "in_progress" && row.status !== "failed")) return null;
  const index = row.index;
  const startMs = row.start_ms;
  const endMs = row.end_ms;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0 || typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) return null;

  row.status = "pending";
  row.parse_status = "pending";
  delete row.report;
  delete row.error;
  delete row.finish_reason;
  delete row.model_provider;
  delete row.model_name;
  return {
    checkpointJson: JSON.stringify(parsed),
    target: { windowKey: String(row.window_key), index, startMs, endMs },
  };
}