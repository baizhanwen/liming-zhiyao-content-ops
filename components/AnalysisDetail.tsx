"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Video = { id: string; source_type: "url" | "upload"; source_url: string | null; media_url: string | null; title: string | null; author_name: string | null; duration_sec: number | null; status: string; content_type: string | null; filename: string | null };
type Job = { status: string; progress: number; current_stage: string | null; error_code: string | null; error_message: string | null; completed_at: string | null };
type Transcript = { id: string; version: number; language: string; source: string; full_text: string; confidence: number | null; segments: unknown };
type Analysis = { schema_version: string; report: unknown; confidence: number | null; model_provider: string | null; model_name: string | null; prompt_version: string | null; created_at: string };
type Metric = { source: string; plays: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null; followers_gained: number | null; collected_at: string };
type EventRow = { event_type: string; from_status: string | null; to_status: string | null; progress: number | null; created_at: string };
type Asset = { id: string; kind: "keyframe" | "subtitle" | "report"; filename: string; content_type: string; size_bytes: number; url: string };
type DetailResponse = { video: Video; job: Job | null; transcript: Transcript | null; analysis: Analysis | null; metrics: Metric[]; assets: Asset[]; events: EventRow[]; canWrite: boolean };
type Segment = { startMs: number; endMs: number; text: string };
type Evidence = { startMs: number | null; text: string; source: string; confidence: number | null };

const sectionNames: Record<string, string> = { summary: "核心结论", hook: "开场钩子", structure: "内容结构", audience: "目标受众", visual: "画面表达", visuals: "画面表达", language: "语言与节奏", highlights: "有效亮点", risks: "风险与缺口", recommendations: "复用建议", evidence: "证据" };
const eventNames: Record<string, string> = { claimed: "任务已领取", heartbeat: "任务心跳", stage_changed: "阶段推进", completed: "分析完成", failed: "分析失败", lease_expired: "租约过期" };

async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "分析结果暂时无法读取。"; }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function timeLabel(ms: number) { const total = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function vttTime(ms: number) { const total = Math.max(0, ms); const hours = Math.floor(total / 3_600_000); const minutes = Math.floor(total % 3_600_000 / 60_000); const seconds = Math.floor(total % 60_000 / 1000); return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`; }
function dateLabel(value: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function numberLabel(value: number | null) { return value === null ? "—" : new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }

function normalizeSegments(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item); if (!row || typeof row.text !== "string") return [];
    const startMs = typeof row.start_ms === "number" ? row.start_ms : typeof row.startMs === "number" ? row.startMs : typeof row.start === "number" ? row.start * 1000 : 0;
    const endMs = typeof row.end_ms === "number" ? row.end_ms : typeof row.endMs === "number" ? row.endMs : typeof row.end === "number" ? row.end * 1000 : startMs;
    return [{ startMs, endMs, text: row.text }];
  });
}

function normalizeEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item); if (!row) return [];
    const text = typeof row.text === "string" ? row.text : typeof row.evidence === "string" ? row.evidence : typeof row.quote === "string" ? row.quote : null;
    if (!text) return [];
    const startMs = typeof row.start_ms === "number" ? row.start_ms : typeof row.startMs === "number" ? row.startMs : typeof row.time_ms === "number" ? row.time_ms : null;
    const confidence = typeof row.confidence === "number" ? row.confidence : null;
    const source = typeof row.source === "string" ? row.source : startMs === null ? "分析产物" : "时间轴原文";
    return [{ startMs, text, source, confidence }];
  });
}

function renderValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
  const record = asRecord(value); if (!record) return "暂无内容";
  return Object.entries(record).map(([key, item]) => `${sectionNames[key] ?? key}：${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

export function AnalysisDetail({ videoId, organizationId, projectId }: { videoId: string; organizationId: string; projectId: string }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false); const [savingTranscript, setSavingTranscript] = useState(false); const [draftSegments, setDraftSegments] = useState<Segment[]>([]); const [editMessage, setEditMessage] = useState("");
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const requestUrl = useMemo(() => `/api/videos/${encodeURIComponent(videoId)}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`, [organizationId, projectId, videoId]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(requestUrl);
      if (!response.ok) { setError(await readError(response)); return; }
      setDetail(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分析结果暂时无法读取。");
    } finally { setLoading(false); }
  }, [requestUrl]);
  useEffect(() => {
    let active = true;
    fetch(requestUrl).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      return response.json() as Promise<DetailResponse>;
    }).then((body) => { if (active) { setDetail(body); setLoading(false); } }).catch((reason) => { if (active) { setError(reason instanceof Error ? reason.message : "分析结果暂时无法读取。"); setLoading(false); } });
    return () => { active = false; };
  }, [requestUrl]);
  const segments = useMemo(() => normalizeSegments(detail?.transcript?.segments), [detail?.transcript?.segments]);
  const captionTrack = useMemo(() => `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n${segments.map((segment, index) => `${index + 1}\n${vttTime(segment.startMs)} --> ${vttTime(Math.max(segment.endMs, segment.startMs + 500))}\n${segment.text.replaceAll("\n", " ")}\n`).join("\n")}`)}`, [segments]);
  const report = asRecord(detail?.analysis?.report); const reportSections = report ? Object.entries(report).filter(([key]) => key !== "evidence") : [];
  const evidence = normalizeEvidence(report?.evidence);
  const keyframes = detail?.assets.filter((asset) => asset.kind === "keyframe") ?? [];
  const coverFrame = keyframes[0] ?? null;
  const latestMetric = detail?.metrics[0] ?? null;
  function seek(startMs: number) { if (!mediaRef.current) return; mediaRef.current.currentTime = startMs / 1000; void mediaRef.current.play(); }
  function startTranscriptEdit() {
    if (!detail?.transcript) return;
    setDraftSegments(segments.length ? segments : [{ startMs: 0, endMs: Math.max(500, (detail.video.duration_sec ?? 1) * 1000), text: detail.transcript.full_text }]);
    setEditMessage(""); setEditingTranscript(true);
  }
  async function saveTranscript(reanalyze: boolean) {
    setSavingTranscript(true); setEditMessage("");
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, language: detail?.transcript?.language || "zh-CN", segments: draftSegments, reanalyze }) });
      if (!response.ok) { setEditMessage(await readError(response)); return; }
      setEditingTranscript(false); setEditMessage(reanalyze ? "校正版已保存，新的结构分析任务已经进入队列。" : "校正版已保存。随时可以再次编辑并重新分析。"); await load();
    } catch (reason) {
      setEditMessage(reason instanceof Error ? reason.message : "校正版没有保存成功，请稍后重试。");
    } finally { setSavingTranscript(false); }
  }

  if (loading) return <div className="management-state" role="status">正在读取分析结果…</div>;
  if (error || !detail) return <div className="management-state error-state"><strong>暂时无法查看分析详情</strong><p>{error}</p><Link href="/analysis">返回视频分析</Link></div>;
  const isAudio = detail.video.content_type?.startsWith("audio/");
  return <div className="analysis-detail-layout">
    <section className="detail-primary">
      <article className="panel media-review-panel">
        <div className="panel-heading"><div><p className="section-kicker">原始媒体与时间轴</p><h2>{detail.video.title || detail.video.filename || "待提取视频标题"}</h2></div><span className={`status ${detail.job?.status === "completed" ? "success" : detail.job?.status === "failed" ? "danger" : "neutral"}`}>{detail.job?.current_stage || detail.video.status}</span></div>
        <div className="media-review-grid"><div className={`media-player-shell${!detail.video.media_url && detail.video.source_url && coverFrame ? " has-external-cover" : ""}`}>
          {detail.video.media_url && isAudio && <audio ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default /></audio>}
          {detail.video.media_url && !isAudio && <video ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default />浏览器不支持视频播放。</video>}
          {!detail.video.media_url && detail.video.source_url && <div className={`external-media${coverFrame ? " has-cover" : ""}`}>
            {coverFrame && <span className="external-media-cover" style={{ backgroundImage: `url(${JSON.stringify(coverFrame.url)})` }} role="img" aria-label={`${detail.video.title || "该视频"}的本地分析封面`} />}
            <div className="external-media-content"><span aria-hidden="true">↗</span><strong>{coverFrame ? "查看原始视频" : "公开视频来源"}</strong><p>{coverFrame ? "封面取自本地分析关键帧，原视频仍通过平台链接核对。" : "平台内容保持外链，不在页面中绕过平台限制嵌入。"}</p><a href={detail.video.source_url} target="_blank" rel="noreferrer">打开原始抖音链接</a></div>
          </div>}
        </div><div className={`transcript-timeline${editingTranscript ? " editing" : ""}`}>
          <div className="timeline-heading"><div><strong>时间轴文案</strong><span>{detail.transcript ? `${detail.transcript.source === "manual" ? "人工校正版" : "ASR 原稿"} · 版本 ${detail.transcript.version} · 置信度 ${detail.transcript.confidence ?? "—"}` : "等待转写"}</span></div>{detail.transcript && detail.canWrite && !editingTranscript && <button type="button" onClick={startTranscriptEdit}>校正转写</button>}</div>
          {editingTranscript ? <div className="transcript-editor"><p>逐段修正错别字和专有名词，时间点会继续保留用于证据定位。</p>{draftSegments.map((segment, index) => <label key={`${segment.startMs}-${index}`}><time>{timeLabel(segment.startMs)}</time><textarea value={segment.text} maxLength={2000} onChange={(event) => setDraftSegments((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} aria-label={`${timeLabel(segment.startMs)} 的转写内容`} /></label>)}<div className="transcript-editor-actions"><button type="button" onClick={() => setEditingTranscript(false)} disabled={savingTranscript}>取消</button><button type="button" onClick={() => saveTranscript(false)} disabled={savingTranscript}>仅保存校正版</button><button className="primary" type="button" onClick={() => saveTranscript(true)} disabled={savingTranscript}>{savingTranscript ? "正在保存…" : "保存并重新分析"}</button></div>{editMessage && <div className="inline-alert" role="alert">{editMessage}</div>}</div> : segments.length > 0 ? <ol>{segments.map((segment, index) => <li key={`${segment.startMs}-${index}`}><button type="button" onClick={() => seek(segment.startMs)} disabled={!detail.video.media_url}><time>{timeLabel(segment.startMs)}</time><span>{segment.text}</span></button></li>)}</ol> : <div className="timeline-empty">{detail.transcript?.full_text || "转写完成后，这里会按时间点展示原文。"}</div>}
          {!editingTranscript && editMessage && <div className="transcript-save-message" role="status">{editMessage}</div>}
        </div></div>
        {keyframes.length > 0 && <div className="keyframe-strip"><div className="timeline-heading"><strong>镜头关键帧</strong><span>{keyframes.length} 个可追溯画面</span></div><div>{keyframes.map((asset, index) => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><span className="keyframe-image" style={{ backgroundImage: `url(${JSON.stringify(asset.url)})` }} role="img" aria-label={`关键帧 ${index + 1}`} /><span>{asset.filename}</span></a>)}</div></div>}
      </article>

      <article className="panel report-panel"><div className="panel-heading"><div><p className="section-kicker">结构化分析与证据</p><h2>{detail.analysis ? `报告 ${detail.analysis.schema_version}` : "尚未生成结构化报告"}</h2></div>{detail.analysis && <span className="confidence-chip">整体置信度 {detail.analysis.confidence ?? "—"}</span>}</div>
        {reportSections.length > 0 ? <div className="report-sections">{reportSections.map(([key, value]) => <section key={key}><h3>{sectionNames[key] ?? key}</h3><p>{renderValue(value)}</p></section>)}</div> : <div className="list-empty">分析服务完成结构化输出后，结论、证据与复用建议会显示在这里。</div>}
        {evidence.length > 0 && <div className="evidence-list"><h3>结论证据</h3>{evidence.map((item, index) => <button type="button" key={`${item.startMs}-${index}`} onClick={() => item.startMs !== null && seek(item.startMs)} disabled={item.startMs === null || !detail.video.media_url}><span>{item.startMs === null ? "证据" : timeLabel(item.startMs)}</span><strong>{item.text}</strong><small>{item.source} · 置信度 {item.confidence ?? "—"}</small></button>)}</div>}
        {detail.analysis && <footer className="report-provenance"><span>模型：{[detail.analysis.model_provider, detail.analysis.model_name].filter(Boolean).join(" / ") || "规则与适配器"}</span><span>提示词版本：{detail.analysis.prompt_version || "—"}</span><span>生成：{dateLabel(detail.analysis.created_at)}</span><Link href={`/topics?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&sourceVideoId=${encodeURIComponent(videoId)}`}>从此分析创建选题 →</Link></footer>}
      </article>
    </section>

    <aside className="detail-sidebar">
      <article className="panel metric-panel"><div className="panel-heading"><div><p className="section-kicker">指标快照</p><h2>{latestMetric ? (latestMetric.source === "public" ? "公开指标" : latestMetric.source === "client_backend" ? "客户后台指标" : "人工回填指标") : "等待指标"}</h2></div></div>{latestMetric ? <dl><div><dt>播放</dt><dd>{numberLabel(latestMetric.plays)}</dd></div><div><dt>点赞</dt><dd>{numberLabel(latestMetric.likes)}</dd></div><div><dt>评论</dt><dd>{numberLabel(latestMetric.comments)}</dd></div><div><dt>收藏</dt><dd>{numberLabel(latestMetric.favorites)}</dd></div><div><dt>分享</dt><dd>{numberLabel(latestMetric.shares)}</dd></div><div><dt>涨粉</dt><dd>{numberLabel(latestMetric.followers_gained)}</dd></div></dl> : <p className="sidebar-empty">暂无可追溯指标快照。</p>}</article>
      <article className="panel trace-panel"><div className="panel-heading"><div><p className="section-kicker">任务追踪</p><h2>处理记录</h2></div><button type="button" onClick={load}>刷新</button></div>{detail.events.length > 0 ? <ol>{detail.events.map((event, index) => <li key={`${event.created_at}-${index}`}><i aria-hidden="true" /><div><strong>{eventNames[event.event_type] ?? event.event_type}</strong><span>{event.to_status || event.from_status || "状态记录"}{event.progress !== null ? ` · ${event.progress}%` : ""}</span><time>{dateLabel(event.created_at)}</time></div></li>)}</ol> : <p className="sidebar-empty">尚无处理事件。</p>}</article>
      {detail.job?.error_message && <article className="inline-alert" role="alert"><strong>{detail.job.error_code || "分析失败"}</strong><p>{detail.job.error_message}</p></article>}
    </aside>
  </div>;
}
