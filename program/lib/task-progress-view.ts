// Adapted from baizhanwen/liming-zhiyao-skill-collect frontend/src/TaskProgress.tsx (MIT).
// Keep server observations distinct from browser refreshes and liveness heartbeats.
export type TaskRefreshState = {
  pending: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  error: string | null;
  failures: number;
  failureStartedAt: number | null;
};

export const initialTaskRefresh: TaskRefreshState = {
  pending: false, lastSuccessAt: null, lastAttemptAt: null, error: null, failures: 0, failureStartedAt: null,
};

export type TaskProgressSnapshot = {
  observedAt?: string | null;
  queuedAt?: string | null;
  workerActive?: boolean;
  startedAt?: string | null;
  stageStartedAt?: string | null;
  finishedAt?: string | null;
  lastHeartbeatAt?: string | null;
  lastProgressAt?: string | null;
  elapsedSeconds?: number | null;
  stageElapsedSeconds?: number | null;
  activityAgeSeconds?: number | null;
  executionCount?: number | null;
  phase?: string | null;
  detail?: string | null;
  waitingOn?: string | null;
  metrics?: Record<string, unknown> | null;
};

export type TaskProgressTask = {
  id: string;
  status: string;
  current_stage?: string | null;
  title?: string | null;
  created_at?: string | null;
  taskProgress?: TaskProgressSnapshot | null;
};

export const taskProgressPhases: Record<string, string> = {
  loading_models: "本地模型加载",
  public_page: "读取公开页面", resolving_share: "浏览器解析分享跳转", browser: "浏览器读取媒体",
  validating_media: "核对原片与音画轨道", merging_media: "整理 / 合并音视频", audio_chunks: "分段音轨",
  frames: "准备抽样画面", model_transcription: "等待转写结果", model_vision: "等待画面分析结果",
  model_analysis: "等待文字服务响应", transcription_complete: "已收到音频转写", vision_complete: "已收到画面分析",
  retry_wait: "等待有限重试", saving: "保存结果", complete: "处理完成",
};

const stageNames: Record<string, string> = {
  pending: "等待后台接手", queued: "准备分析环境", downloading: "获取媒体", processing: "处理媒体",
  transcribing: "语音转写与画面提取", extracting: "整理字幕与关键帧", analyzing: "结构化分析",
  completed: "生成报告", partial: "生成报告", failed: "处理失败", cancelled: "取消后续处理",
};
const activeStatuses = new Set(["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing"]);
const terminalStatuses = new Set(["completed", "partial", "failed", "cancelled"]);

export function formatElapsedSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value), days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60, remainder = seconds % 60;
  return days ? `${days}天${hours}小时` : hours ? `${hours}小时${minutes}分` : minutes ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function duration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function measuredTaskMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function secondsBetween(start: unknown, end: unknown): number | null {
  const from = timestamp(start), to = timestamp(end);
  return from == null || to == null ? null : Math.max(0, (to - from) / 1000);
}
function bytes(value: number): string {
  return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`;
}

export function taskMetricItems(metrics: Record<string, unknown> | null | undefined, phase: string): string[] {
  const values = metrics || {}, items: string[] = [];
  if (measuredTaskMetric(values.completed) && measuredTaskMetric(values.total) && values.total > 0) items.push(`${taskProgressPhases[phase] || "本步骤"}：${values.completed} / ${values.total}`);
  if (measuredTaskMetric(values.transcribed_chunks)) items.push(`已转写音频段：${values.transcribed_chunks}${measuredTaskMetric(values.total_chunks) ? ` / ${values.total_chunks}` : ""}`);
  if (measuredTaskMetric(values.sampled_frames)) items.push(`已准备抽样画面：${values.sampled_frames}${measuredTaskMetric(values.total_frames) ? ` / ${values.total_frames}` : ""}`);
  if (measuredTaskMetric(values.candidates_checked)) items.push(`已检查候选画面：${values.candidates_checked}${measuredTaskMetric(values.candidates_total) ? ` / ${values.candidates_total}` : ""}`);
  if (measuredTaskMetric(values.vision_batches_completed)) items.push(`已完成视觉分析批次：${values.vision_batches_completed}${measuredTaskMetric(values.vision_batches_total) ? ` / ${values.vision_batches_total}` : ""}`);
  if (measuredTaskMetric(values.downloaded_bytes)) items.push(`实际取回数据：${bytes(values.downloaded_bytes)}`);
  if (measuredTaskMetric(values.proxy_bytes)) items.push(`网页代理总流量：${bytes(values.proxy_bytes)}`);
  if (measuredTaskMetric(values.requests)) items.push(`已收到来源响应：${values.requests} 次`);
  if (measuredTaskMetric(values.media_responses)) items.push(`媒体响应：${values.media_responses} 次`);
  if (measuredTaskMetric(values.complete_bound_media)) items.push(`完整视频候选：${values.complete_bound_media}`);
  if (measuredTaskMetric(values.retry_attempt)) items.push(`本轮尝试：${values.retry_attempt}${measuredTaskMetric(values.max_attempts) ? ` / ${values.max_attempts}` : ""}`);
  return items;
}

export function taskProgressView(task: TaskProgressTask, connection: TaskRefreshState, snapshotAt: number | null, now: number) {
  // In this worker, queued means a claimed job preparing its local models;
  // pending alone means it is waiting for a worker to claim it.
  const live = task.taskProgress || {}, queued = task.status === "pending";
  const active = activeStatuses.has(task.status), terminal = terminalStatuses.has(task.status);
  const snapshotAge = snapshotAt == null ? null : Math.max(0, (now - snapshotAt) / 1000);
  const readAge = connection.lastSuccessAt == null ? null : Math.max(0, (now - connection.lastSuccessAt) / 1000);
  // A successful read for another task must not advance this task's snapshot.
  // The first failed read pins the same short estimate instead of resetting it.
  const extrapolation = Math.min(12, snapshotAt == null ? 0 : connection.error && connection.failureStartedAt != null
    ? Math.max(0, (connection.failureStartedAt - snapshotAt) / 1000) : snapshotAge || 0);
  const serverEnd = terminal ? live.finishedAt : live.observedAt;
  // created_at survives retries; only an explicit queue timestamp proves the
  // current wait duration. Never include a previous execution in this clock.
  const baseElapsed = queued ? secondsBetween(live.queuedAt, live.observedAt)
    : duration(live.elapsedSeconds) ?? secondsBetween(live.startedAt, serverEnd);
  const baseStageElapsed = duration(live.stageElapsedSeconds) ?? secondsBetween(live.stageStartedAt, serverEnd);
  const executionLive = active && !queued && live.workerActive === true;
  const elapsed = baseElapsed == null ? null : baseElapsed + (executionLive || queued ? extrapolation : 0);
  const stageElapsed = baseStageElapsed == null ? null : baseStageElapsed + (executionLive ? extrapolation : 0);
  // Real progress ages independently of connection freshness. Heartbeats and
  // client refreshes never reset it; the elapsed execution clock does freeze.
  const baseActivityAge = duration(live.activityAgeSeconds) ?? secondsBetween(live.lastProgressAt, live.observedAt);
  const activityAge = baseActivityAge == null ? null : baseActivityAge + (snapshotAge || 0);
  const phase = queued ? "" : live.phase || "";
  const stage = phase === "loading_models" ? taskProgressPhases.loading_models : task.current_stage || stageNames[task.status] || "状态待读取";
  const heading = queued ? "任务正在排队" : task.status === "cancelled" ? "已取消后续处理"
    : task.status === "failed" ? "任务失败" : task.status === "partial" ? "报告已生成，部分能力待补全"
    : task.status === "completed" ? "处理已完成" : active ? `当前阶段：${stage}` : "正在读取任务状态";
  const detail = String(live.detail || (queued ? "等待后台接手，不会重复提交任务。" : "等待下一条已保存的阶段记录。")).replace(/工作线程/g, "后台");
  const fresh = !connection.error && readAge != null && readAge < 12 && snapshotAge != null && snapshotAge < 12;
  const stale = snapshotAge != null && snapshotAge >= 12;
  const workerLabel = active && !queued
    ? typeof live.workerActive !== "boolean" ? "暂未确认后台执行状态；当前记录没有实时后台信息。"
      : live.workerActive ? "近期收到后台心跳；等待本步骤的下一条真实进展。"
      : "暂未确认后台执行状态，请结合最近刷新和阶段记录查看。"
    : null;
  return {
    active, terminal, queued, elapsed, stageElapsed, activityAge, phase, stage, heading, detail, fresh, stale,
    readAge, snapshotAge, workerLabel, executionCount: measuredTaskMetric(live.executionCount) ? live.executionCount : null,
    metricItems: queued ? [] : taskMetricItems(live.metrics, phase),
    noActivity: active && !queued && activityAge != null && activityAge >= 60,
    waitingLabel: active && !queued && ({model_transcription: "transcription_service", model_vision: "vision_service", model_analysis: "text_service"} as Record<string, string>)[phase] === live.waitingOn
      ? ({transcription_service: "转写服务", vision_service: "视觉服务", text_service: "文字服务"} as Record<string, string>)[live.waitingOn || ""] || null : null,
  };
}
