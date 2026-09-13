export type SegmentProgressItem = {
  windowKey: string;
  index: number;
  startMs: number;
  endMs: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  attempts: number;
  error: string | null;
};

export type SegmentProgressSummary = {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  remaining: number;
  segments: SegmentProgressItem[];
};

export function summarizeSegmentProgress(checkpointJson: unknown): SegmentProgressSummary | null {
  if (typeof checkpointJson !== "string" || !checkpointJson.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(checkpointJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const progress = (parsed as Record<string, unknown>).segment_progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const rows = (progress as Record<string, unknown>).segments;
  const keys = (progress as Record<string, unknown>).window_keys;
  const total = Array.isArray(keys) ? keys.length : Array.isArray(rows) ? rows.length : 0;
  if (!Array.isArray(rows) || total <= 0) return null;
  const segments = rows.flatMap((row): SegmentProgressItem[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as Record<string, unknown>;
    const windowKey = typeof item.window_key === "string" && /^[0-9a-f]{64}$/i.test(item.window_key) ? item.window_key : "";
    const status = item.status;
    if (!windowKey || (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "failed")) return [];
    const index = typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0 ? item.index : -1;
    const startMs = typeof item.start_ms === "number" && Number.isFinite(item.start_ms) && item.start_ms >= 0 ? item.start_ms : -1;
    const endMs = typeof item.end_ms === "number" && Number.isFinite(item.end_ms) && item.end_ms >= startMs ? item.end_ms : -1;
    if (index < 0 || startMs < 0 || endMs < 0) return [];
    const attempts = typeof item.attempts === "number" && Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0;
    return [{ windowKey, index, startMs, endMs, status, attempts, error: status === "failed" ? "分段处理失败，可单独重试。" : null }];
  });
  const completed = segments.filter((segment) => segment.status === "completed").length;
  const failed = segments.filter((segment) => segment.status === "failed").length;
  const inProgress = segments.filter((segment) => segment.status === "in_progress").length;
  return { total, completed, failed, inProgress, remaining: Math.max(0, total - completed), segments };
}