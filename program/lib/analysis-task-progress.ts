/** Safe observations adapted from Skill Collect. Reads never write activity. */
export const PHASE_DETAILS = {
  loading_models: "正在准备本任务并初始化本地分析模型；首次使用可能需要下载",
  queued: "任务已排队，等待本机工作线程接手", public_page: "正在读取公开页面，查找指定视频的原片来源",
  resolving_share: "正在通过项目浏览器确认抖音分享跳转", browser: "正在读取公开页面和媒体；网页流量不代表原片已下载完成",
  validating_media: "正在核对媒体完整性、视频身份和音视频轨道", merging_media: "正在本机整理并合并音视频轨道",
  audio_chunks: "正在本机规范化媒体并准备音频", frames: "正在本机准备抽样画面",
  model_transcription: "正在等待语音转写结果；服务内部进度不可测量", transcription_complete: "已取得实际返回的语音转写结果",
  model_vision: "正在识别关键帧文字与画面；仅展示已完成的处理数量", vision_complete: "已取得实际返回的画面分析",
  model_analysis: "正在等待内容分析结果；模型内部生成进度不可测量", retry_wait: "正在等待重试",
  saving: "正在保存分析结果与证据", complete: "分析结果已保存", failed: "当前分析已停止，请查看任务错误后重试", cancelled: "任务已取消，后续步骤不会继续",
} as const;
export type ProgressPhase = keyof typeof PHASE_DETAILS;
const METRIC_KEYS = new Set(["completed", "total", "requests", "downloaded_bytes", "proxy_connections", "proxy_bytes", "media_responses", "complete_bound_media", "transcribed_chunks", "total_chunks", "sampled_frames", "total_frames", "files_read", "files_total", "retry_attempt", "max_attempts", "ocr_completed", "ocr_total", "vision_batches_completed", "vision_batches_total", "candidates_checked", "candidates_total"]);
export type SafeProgressObservation = { phase: ProgressPhase; metrics: Record<string, number> };
const STAGE_PHASES: Record<string, ProgressPhase> = { pending: "queued", queued: "loading_models", downloading: "public_page", processing: "audio_chunks", transcribing: "model_transcription", extracting: "saving", analyzing: "model_analysis", completed: "complete", partial: "complete", failed: "failed", cancelled: "cancelled" };
const ACTIVE = new Set(["queued", "downloading", "processing", "transcribing", "extracting", "analyzing"]);
export function safeProgressObservation(value: unknown): SafeProgressObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.phase !== "string" || !Object.hasOwn(PHASE_DETAILS, event.phase)) return null;
  const source = event.metrics && typeof event.metrics === "object" && !Array.isArray(event.metrics) ? event.metrics as Record<string, unknown> : event;
  const metrics: Record<string, number> = {};
  for (const key of [...METRIC_KEYS].sort()) { const number = source[key]; if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) metrics[key] = number; }
  return { phase: event.phase as ProgressPhase, metrics };
}
function storedObservation(json: unknown) { try { return typeof json === "string" ? safeProgressObservation(JSON.parse(json)) : null; } catch { return null; } }
export function nextTaskProgress(job: { status: string; progress_json?: unknown; stage_started_at?: string | null; last_progress_at?: string | null }, status: string, observation: SafeProgressObservation | null, now: string) {
  const previous = storedObservation(job.progress_json);
  const next = observation ?? (status === job.status ? previous : null) ?? { phase: STAGE_PHASES[status] ?? "queued", metrics: {} };
  const changed = job.status !== status || (observation !== null && JSON.stringify(previous) !== JSON.stringify(next));
  const stageChanged = job.status !== status || (observation !== null && previous?.phase !== next.phase);
  return { progressJson: JSON.stringify(next), lastProgressAt: changed ? now : job.last_progress_at ?? null, stageStartedAt: stageChanged ? now : job.stage_started_at ?? null, changed };
}
export type AnalysisTaskProgressRow = {
  status: string; created_at?: unknown; updated_at?: unknown; completed_at?: unknown; started_at?: unknown; stage_started_at?: unknown;
  last_progress_at?: unknown; last_heartbeat_at?: unknown; lease_expires_at?: unknown; lease_owner?: unknown; attempt_count?: unknown; progress_json?: unknown;
};
function timestamp(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
function seconds(start: string | null, end: string | null): number | null { return start && end ? Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000)) : null; }
export function taskProgressSnapshot(job: AnalysisTaskProgressRow, observedAt = new Date().toISOString()) {
  const active = ACTIVE.has(job.status); const pending = job.status === "pending";
  const queuedAt = pending ? timestamp(job.last_progress_at) ?? (job.attempt_count === 0 ? timestamp(job.created_at) : null) : null;
  const startedAt = timestamp(job.started_at); const stageStartedAt = timestamp(job.stage_started_at);
  const finishedAt = active || pending ? null : timestamp(job.completed_at) ?? timestamp(job.updated_at);
  const lastHeartbeatAt = timestamp(job.last_heartbeat_at); const lastProgressAt = timestamp(job.last_progress_at);
  const lease = timestamp(job.lease_expires_at);
  const workerActive = active && Boolean(job.lease_owner && lease && lease > observedAt && lastHeartbeatAt && Date.parse(observedAt) - Date.parse(lastHeartbeatAt) < 45_000);
  const recorded = storedObservation(job.progress_json);
  const phase: ProgressPhase = active && recorded ? recorded.phase : STAGE_PHASES[job.status] ?? "queued";
  // An abandoned lease cannot accrue imaginary processing time while offline.
  const end = active ? (lease && lease < observedAt ? lease : observedAt) : finishedAt;
  const waitingOn = pending ? "queue" : phase === "loading_models" ? "local_media" : !active ? "none" : ({ downloading: "source", processing: "local_media", transcribing: phase === "model_vision" ? "vision_service" : "transcription_service", extracting: "local_media", analyzing: "text_service" } as Record<string, string>)[job.status] ?? "none";
  return { observedAt, workerActive, queuedAt, startedAt, stageStartedAt, finishedAt, lastHeartbeatAt, lastProgressAt,
    elapsedSeconds: seconds(startedAt, end), stageElapsedSeconds: seconds(stageStartedAt, end), activityAgeSeconds: seconds(lastProgressAt, observedAt),
    executionCount: typeof job.attempt_count === "number" && Number.isSafeInteger(job.attempt_count) && job.attempt_count > 0 ? job.attempt_count : null,
    phase, detail: PHASE_DETAILS[phase], waitingOn, metrics: active && recorded ? recorded.metrics : {} };
}
