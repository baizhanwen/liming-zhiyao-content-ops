"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Video = { id: string; source_type: "url" | "upload"; source_url: string | null; media_url: string | null; title: string | null; author_name: string | null; duration_sec: number | null; status: string; content_type: string | null; filename: string | null; is_shared_reference?: boolean };
type Job = { status: string; progress: number; current_stage: string | null; error_code: string | null; error_message: string | null; completed_at: string | null };
type Transcript = { id: string; version: number; language: string; source: string; full_text: string; confidence: number | null; segments: unknown };
type Analysis = { id: string; schema_version: string; report: unknown; confidence: number | null; model_provider: string | null; model_name: string | null; prompt_version: string | null; created_at: string };
type Metric = { source: string; plays: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null; followers_gained: number | null; collected_at: string };
type EventRow = { event_type: string; from_status: string | null; to_status: string | null; progress: number | null; created_at: string };
type Asset = { id: string; kind: "keyframe" | "subtitle" | "report"; filename: string; content_type: string; size_bytes: number; url: string };
type DetailResponse = { video: Video; job: Job | null; transcript: Transcript | null; analysis: Analysis | null; analyses?: Analysis[]; metrics: Metric[]; assets: Asset[]; events: EventRow[]; canWrite: boolean };
type Segment = { startMs: number; endMs: number; text: string };
type Evidence = { startMs: number | null; text: string; source: string; confidence: number | null };
type InsightEvidenceLink = { section: string; itemIndex: number; evidenceText: string };
const sectionNames: Record<string, string> = {
  summary: "核心结论", hook: "开场钩子", hook_analysis: "钩子拆解", viral_points: "传播爆点",
  structure: "内容结构", audience: "目标受众", rhythm_analysis: "节奏设计", emotion_curve: "情绪曲线",
  conversion_design: "转化设计", visual: "画面表达", visuals: "画面表达", language: "语言与节奏",
  highlights: "有效亮点", risks: "风险与缺口", recommendations: "复用建议", spoken_script: "整理后的口播稿", evidence: "证据",
};
const reportSectionOrder = ["summary", "hook", "hook_analysis", "viral_points", "audience", "structure", "rhythm_analysis", "emotion_curve", "conversion_design", "highlights", "recommendations", "visual", "visuals", "language", "risks"];
const analysisProfileNames: Record<string, string> = { max: "最高能力", economy: "历史经济模式", standard: "历史标准模式", deep: "历史深度模式", shared: "共享分析" };
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeInsightEvidenceLinks(value: unknown): InsightEvidenceLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    if (!row || typeof row.section !== "string" || typeof row.item_index !== "number" || typeof row.evidence_text !== "string") return [];
    return [{ section: row.section, itemIndex: row.item_index, evidenceText: row.evidence_text }];
  });
}

function analysisVersionLabel(analysis: Analysis) {
  const report = asRecord(analysis.report); const meta = asRecord(report?.analysis_meta);
  const profile = analysisProfileNames[String(meta?.analysis_profile)] || "默认模式";
  const model = [analysis.model_provider, analysis.model_name].filter(Boolean).join(" / ") || "规则分析";
  return `${dateLabel(analysis.created_at)} · ${model} · ${profile}`;
}

function renderValue(value: unknown, key = "") {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item, index) => `${key === "structure" ? `${index + 1}.` : "•"} ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
  const record = asRecord(value); if (!record) return "暂无内容";
  return Object.entries(record).map(([key, item]) => `${sectionNames[key] ?? key}：${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const helper = document.createElement("textarea"); helper.value = value; helper.style.position = "fixed"; helper.style.opacity = "0";
  document.body.appendChild(helper); helper.select(); const copied = document.execCommand("copy"); helper.remove();
  if (!copied) throw new Error("copy failed");
}

function safeFilename(value: string) { return (value.replace(/[<>:"/\\|?*]/g, "-").trim().slice(0, 60) || "视频分析"); }
function downloadText(filename: string, value: string, contentType: string) {
  const url = URL.createObjectURL(new Blob([value], { type: `${contentType};charset=utf-8` }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function highlightedText(value: string, query: string) {
  const clean = query.trim(); if (!clean) return value;
  const index = value.toLocaleLowerCase("zh-CN").indexOf(clean.toLocaleLowerCase("zh-CN")); if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + clean.length)}</mark>{value.slice(index + clean.length)}</>;
}

export function AnalysisDetail({ videoId, organizationId, projectId, libraryEntryId }: { videoId: string; organizationId: string; projectId: string; libraryEntryId?: string }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false); const [savingTranscript, setSavingTranscript] = useState(false); const [draftSegments, setDraftSegments] = useState<Segment[]>([]); const [editMessage, setEditMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState(""); const [transcriptQuery, setTranscriptQuery] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(""); const [compareAnalysisId, setCompareAnalysisId] = useState("");
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const requestUrl = useMemo(() => `/api/videos/${encodeURIComponent(videoId)}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}${libraryEntryId ? `&libraryEntryId=${encodeURIComponent(libraryEntryId)}` : ""}`, [organizationId, projectId, videoId, libraryEntryId]);
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
  const analysisVersions = detail?.analyses?.length ? detail.analyses : detail?.analysis ? [detail.analysis] : [];
  const analysis = analysisVersions.find((item) => item.id === selectedAnalysisId) ?? analysisVersions[0] ?? null;
  const effectiveCompareAnalysisId = compareAnalysisId !== analysis?.id && analysisVersions.some((item) => item.id === compareAnalysisId) ? compareAnalysisId : "";
  const compareAnalysis = analysisVersions.find((item) => item.id === effectiveCompareAnalysisId) ?? null;
  const segments = useMemo(() => normalizeSegments(detail?.transcript?.segments), [detail?.transcript?.segments]);
  const transcriptVtt = useMemo(() => `WEBVTT\n\n${segments.map((segment, index) => `${index + 1}\n${vttTime(segment.startMs)} --> ${vttTime(Math.max(segment.endMs, segment.startMs + 500))}\n${segment.text.replaceAll("\n", " ")}\n`).join("\n")}`, [segments]);
  const captionTrack = useMemo(() => `data:text/vtt;charset=utf-8,${encodeURIComponent(transcriptVtt)}`, [transcriptVtt]);
  const visibleSegments = useMemo(() => { const query = transcriptQuery.trim().toLocaleLowerCase("zh-CN"); return query ? segments.filter((segment) => segment.text.toLocaleLowerCase("zh-CN").includes(query)) : segments; }, [segments, transcriptQuery]);
  const report = asRecord(analysis?.report); const analysisMeta = asRecord(report?.analysis_meta); const spokenScript = normalizeStringList(report?.spoken_script); const reportSections = report ? Object.entries(report).filter(([key]) => key !== "evidence" && key !== "analysis_meta" && key !== "spoken_script" && key !== "insight_evidence").sort(([left], [right]) => { const leftIndex = reportSectionOrder.indexOf(left); const rightIndex = reportSectionOrder.indexOf(right); return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex); }) : [];
  const evidence = normalizeEvidence(report?.evidence);
  const insightEvidenceLinks = normalizeInsightEvidenceLinks(report?.insight_evidence);
  const compareReport = asRecord(compareAnalysis?.report);
  const comparisonKeys = ["summary", "hook", "viral_points", "recommendations"];
  const keyframes = detail?.assets.filter((asset) => asset.kind === "keyframe") ?? [];
  const coverFrame = keyframes[0] ?? null;
  const latestMetric = detail?.metrics[0] ?? null;
  function seek(startMs: number) { if (!mediaRef.current) return; mediaRef.current.currentTime = startMs / 1000; void mediaRef.current.play(); }
  function locateTimepoint(startMs: number) {
    if (detail.video.media_url) { seek(startMs); return; }
    if (detail.video.source_url) window.open(detail.video.source_url, "_blank", "noopener,noreferrer");
  }
  function locateEvidence(item: Evidence) {
    if (item.startMs !== null && (detail.video.media_url || detail.video.source_url)) { locateTimepoint(item.startMs); return; }
    const index = evidence.findIndex((candidate) => candidate === item || candidate.text === item.text);
    const target = index >= 0 ? document.getElementById(`analysis-evidence-${index}`) : null;
    target?.scrollIntoView({ behavior: "smooth", block: "center" }); target?.focus({ preventScroll: true });
  }
  function evidenceForInsight(section: string, itemIndex: number) {
    const link = insightEvidenceLinks.find((item) => item.section === section && item.itemIndex === itemIndex);
    return link ? evidence.find((item) => item.text === link.evidenceText) ?? null : null;
  }
  function renderReportSection(value: unknown, key: string) {
    if (!Array.isArray(value)) return <p>{renderValue(value, key)}</p>;
    const items = value.filter((item): item is string => typeof item === "string");
    if (!items.some((_item, index) => evidenceForInsight(key, index))) return <p>{renderValue(value, key)}</p>;
    return <ol className="linked-insight-list">{items.map((item, index) => { const linked = evidenceForInsight(key, index); return <li key={`${key}-${index}`}><button type="button" onClick={() => linked && locateEvidence(linked)} disabled={!linked}><span>{item}</span>{linked && <time>{linked.startMs === null ? "查看原文证据" : `${timeLabel(linked.startMs)} 定位证据`}</time>}</button></li>; })}</ol>;
  }
  async function copySpokenScript() {
    if (!spokenScript.length) return;
    setCopyMessage("");
    try {
      await copyText(spokenScript.join("\n\n"));
      setCopyMessage("整理后的口播稿已复制，可以直接进入内容生产继续修改。");
    } catch { setCopyMessage("口播稿复制失败，请重新点击一次。"); }
  }
  async function copyReport() {
    if (!reportSections.length && !spokenScript.length) return;
    setCopyMessage("");
    try {
      const sections = reportSections.map(([key, value]) => `${sectionNames[key] ?? key}\n${renderValue(value, key)}`);
      if (spokenScript.length) sections.splice(1, 0, `${sectionNames.spoken_script}\n${spokenScript.join("\n\n")}`);
      await copyText(sections.join("\n\n"));
      setCopyMessage("分析报告已复制，可以直接粘贴到文档或群聊。" );
    } catch { setCopyMessage("复制没有成功，请重新点击一次。" ); }
  }
  function exportMarkdown() {
    const title = detail?.video.title || detail?.video.filename || "视频分析";
    const lines = [`# ${title}`, "", `- 生成时间：${dateLabel(analysis?.created_at ?? null)}`, `- 模型：${[analysis?.model_provider, analysis?.model_name].filter(Boolean).join(" / ") || "规则与适配器"}`];
    if (spokenScript.length) lines.push("", `## ${sectionNames.spoken_script}`, "", spokenScript.join("\n\n"));
    for (const [key, value] of reportSections) lines.push("", `## ${sectionNames[key] ?? key}`, "", renderValue(value, key));
    if (evidence.length) { lines.push("", "## 结论证据", ""); for (const item of evidence) lines.push(`- ${item.startMs === null ? "[证据]" : `[${timeLabel(item.startMs)}]`} ${item.text}（${item.source}）`); }
    if (segments.length) { lines.push("", "## 时间轴转写", ""); for (const segment of segments) lines.push(`- [${timeLabel(segment.startMs)}] ${segment.text}`); }
    downloadText(`${safeFilename(title)}-分析报告.md`, `${lines.join("\n")}\n`, "text/markdown"); setCopyMessage("Markdown 报告已下载到浏览器下载目录。" );
  }
  function exportTranscript() {
    const title = detail?.video.title || detail?.video.filename || "视频分析";
    downloadText(`${safeFilename(title)}-时间轴字幕.vtt`, transcriptVtt, "text/vtt"); setEditMessage("时间轴字幕已下载到浏览器下载目录。" );
  }
  async function reanalyze() {
    setReanalyzing(true); setCopyMessage("");
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }) });
      if (!response.ok) { setCopyMessage(await readError(response)); return; }
      setCopyMessage("最高能力重新分析任务已创建，可返回视频分析页查看进度。");
    } catch (reason) { setCopyMessage(reason instanceof Error ? reason.message : "重新分析任务没有创建成功。"); }
    finally { setReanalyzing(false); }
  }
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
    <nav className="analysis-detail-nav" aria-label="分析结果快捷导航"><a href="#analysis-media">媒体与转写</a><a href="#analysis-report">结构化报告</a><a href="#analysis-trace">处理记录</a></nav>
    <section className="detail-primary">
      <article className="panel media-review-panel" id="analysis-media">
        <div className="panel-heading"><div><p className="section-kicker">原始媒体与时间轴</p><h2>{detail.video.title || detail.video.filename || "待提取视频标题"}</h2></div><span className={`status ${detail.job?.status === "completed" ? "success" : detail.job?.status === "failed" ? "danger" : "neutral"}`}>{detail.job?.current_stage || detail.video.status}</span></div>
        <div className="media-review-grid"><div className={`media-player-shell${!detail.video.media_url && detail.video.source_url && coverFrame ? " has-external-cover" : ""}`}>
          {detail.video.media_url && isAudio && <audio ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default /></audio>}
          {detail.video.media_url && !isAudio && <video ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default />浏览器不支持视频播放。</video>}
          {!detail.video.media_url && detail.video.source_url && <div className={`external-media${coverFrame ? " has-cover" : ""}`}>
            {coverFrame && <span className="external-media-cover" style={{ backgroundImage: `url(${JSON.stringify(coverFrame.url)})` }} role="img" aria-label={`${detail.video.title || "该视频"}的本地分析封面`} />}
            <div className="external-media-content"><span aria-hidden="true">↗</span><strong>{coverFrame ? "查看原始视频" : "公开视频来源"}</strong><p>{coverFrame ? "封面取自本地分析关键帧，原视频仍通过平台链接核对。" : "平台内容保持外链，不在页面中绕过平台限制嵌入。"}</p><a href={detail.video.source_url} target="_blank" rel="noreferrer">打开原始抖音链接</a></div>
          </div>}
        </div><div className={`transcript-timeline${editingTranscript ? " editing" : ""}`}>
          <div className="timeline-heading"><div><strong>时间轴文案</strong><span>{detail.transcript ? `${detail.transcript.source === "manual" ? "人工校正版" : "ASR 原稿"} · 版本 ${detail.transcript.version} · 置信度 ${detail.transcript.confidence ?? "—"}` : "等待转写"}</span></div><div className="timeline-actions">{segments.length > 0 && !editingTranscript && <label className="transcript-search"><span className="sr-only">搜索转写内容</span><input type="search" value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder="搜索转写…" /></label>}{segments.length > 0 && !editingTranscript && <button type="button" onClick={exportTranscript}>导出字幕</button>}{detail.transcript && detail.canWrite && !editingTranscript && <button type="button" onClick={startTranscriptEdit}>校正转写</button>}</div></div>
          {!editingTranscript && transcriptQuery.trim() && <p className="transcript-match-count" role="status">找到 {visibleSegments.length} 个匹配片段</p>}
          {editingTranscript ? <div className="transcript-editor"><p>逐段修正错别字和专有名词，时间点会继续保留用于证据定位。</p>{draftSegments.map((segment, index) => <label key={`${segment.startMs}-${index}`}><time>{timeLabel(segment.startMs)}</time><textarea value={segment.text} maxLength={2000} onChange={(event) => setDraftSegments((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} aria-label={`${timeLabel(segment.startMs)} 的转写内容`} /></label>)}<div className="transcript-editor-actions"><button type="button" onClick={() => setEditingTranscript(false)} disabled={savingTranscript}>取消</button><button type="button" onClick={() => saveTranscript(false)} disabled={savingTranscript}>仅保存校正版</button><button className="primary" type="button" onClick={() => saveTranscript(true)} disabled={savingTranscript}>{savingTranscript ? "正在保存…" : "保存并重新分析"}</button></div>{editMessage && <div className="inline-alert" role="alert">{editMessage}</div>}</div> : visibleSegments.length > 0 ? <ol>{visibleSegments.map((segment, index) => { const canLocate = Boolean(detail.video.media_url || detail.video.source_url); const label = `${timeLabel(segment.startMs)} ${detail.video.media_url ? "跳转播放" : detail.video.source_url ? "打开原视频核对" : "时间点"}`; return <li key={`${segment.startMs}-${index}`}><button type="button" onClick={() => locateTimepoint(segment.startMs)} disabled={!canLocate} aria-label={label} title={label}><time>{timeLabel(segment.startMs)}</time><span>{highlightedText(segment.text, transcriptQuery)}</span></button></li>; })}</ol> : segments.length > 0 && transcriptQuery.trim() ? <div className="timeline-empty">没有找到包含“{transcriptQuery.trim()}”的转写片段。</div> : <div className="timeline-empty">{detail.transcript?.full_text || "转写完成后，这里会按时间点展示原文。"}</div>}
          {!editingTranscript && editMessage && <div className="transcript-save-message" role="status">{editMessage}</div>}
        </div></div>
        {keyframes.length > 0 && <div className="keyframe-strip"><div className="timeline-heading"><strong>镜头关键帧</strong><span>{keyframes.length} 个可追溯画面</span></div><div>{keyframes.map((asset, index) => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><span className="keyframe-image" style={{ backgroundImage: `url(${JSON.stringify(asset.url)})` }} role="img" aria-label={`关键帧 ${index + 1}`} /><span>{asset.filename}</span></a>)}</div></div>}
      </article>

      <article className="panel report-panel" id="analysis-report"><div className="panel-heading"><div><p className="section-kicker">结构化分析与证据</p><h2>{analysis ? `报告 ${analysis.schema_version}` : "尚未生成结构化报告"}</h2></div>{analysis && <div className="report-heading-actions"><span className="confidence-chip">整体置信度 {analysis.confidence ?? "—"}</span><button type="button" onClick={copyReport}>复制报告</button><button type="button" onClick={exportMarkdown}>导出 Markdown</button></div>}</div>
        {copyMessage && <p className="report-copy-message" role="status">{copyMessage}</p>}
        {analysisVersions.length > 0 && <div className="analysis-version-toolbar"><label><span>当前查看</span><select value={analysis?.id || ""} onChange={(event) => { const id = event.target.value; setSelectedAnalysisId(id); setCompareAnalysisId((current) => current === id ? "" : current); }}>{analysisVersions.map((item) => <option key={item.id} value={item.id}>{analysisVersionLabel(item)}</option>)}</select></label><label><span>对比版本</span><select value={effectiveCompareAnalysisId} onChange={(event) => setCompareAnalysisId(event.target.value)} disabled={analysisVersions.length < 2}><option value="">{analysisVersions.length < 2 ? "重新分析后可对比" : "选择另一份报告"}</option>{analysisVersions.filter((item) => item.id !== analysis?.id).map((item) => <option key={item.id} value={item.id}>{analysisVersionLabel(item)}</option>)}</select></label><p>人工校正时间轴并重新分析后，旧报告会保留在这里，不会被覆盖。</p></div>}
        {analysis && compareAnalysis && compareAnalysis.id !== analysis.id && <section className="analysis-comparison-panel"><div><div><span>版本对比</span><h3>快速核对两个模型或两次分析的差异</h3></div><button type="button" onClick={() => setCompareAnalysisId("")}>关闭对比</button></div><div className="comparison-headings"><strong>{analysisVersionLabel(analysis)}</strong><strong>{analysisVersionLabel(compareAnalysis)}</strong></div>{comparisonKeys.map((key) => <article key={key}><h4>{sectionNames[key] ?? key}</h4><div><p>{report?.[key] === undefined ? "该版本未生成此项" : renderValue(report[key], key)}</p><p>{compareReport?.[key] === undefined ? "该版本未生成此项" : renderValue(compareReport[key], key)}</p></div></article>)}</section>}
        {analysisMeta && <div className="analysis-cost-summary"><div><small>{typeof analysisMeta.actual_total_tokens === "number" ? "实际模型消耗" : "模型输入预估"}</small><strong>{numberLabel(typeof analysisMeta.actual_total_tokens === "number" ? analysisMeta.actual_total_tokens : typeof analysisMeta.estimated_model_input_tokens === "number" ? analysisMeta.estimated_model_input_tokens : null)} Token</strong>{typeof analysisMeta.actual_total_tokens === "number" && <span>输入 {numberLabel(typeof analysisMeta.actual_input_tokens === "number" ? analysisMeta.actual_input_tokens : null)} · 输出 {numberLabel(typeof analysisMeta.actual_output_tokens === "number" ? analysisMeta.actual_output_tokens : null)}</span>}</div><div><small>分析覆盖率</small><strong>{typeof analysisMeta.coverage_percent === "number" ? `${analysisMeta.coverage_percent}%` : "—"}</strong>{typeof analysisMeta.analyzed_segments === "number" && typeof analysisMeta.source_segments === "number" && <span>{analysisMeta.analyzed_segments} / {analysisMeta.source_segments} 个片段</span>}</div><div><small>长视频处理</small><strong>{analysisMeta.processing_mode === "segmented" ? "分段分析后汇总" : typeof analysisMeta.duration_minutes === "number" ? `${analysisMeta.duration_minutes} 分钟` : "单次分析"}</strong><span>{analysisMeta.processing_mode === "segmented" && typeof analysisMeta.segment_analysis_count === "number" ? `${analysisMeta.segment_analysis_count} 个时间段 · ${analysisMeta.analysis_passes} 次调用` : typeof analysisMeta.chunk_count === "number" ? `${analysisMeta.chunk_count} 个证据窗口` : ""}</span></div><div><small>预算策略</small><strong>{analysisMeta.mode === "budgeted" ? "预算内抽样" : "完整分析"}</strong><span>{analysisProfileNames[String(analysisMeta.analysis_profile)] || "标准模式"}{typeof analysisMeta.maximum_total_tokens === "number" ? ` · 总上限 ${numberLabel(analysisMeta.maximum_total_tokens)}` : typeof analysisMeta.maximum_source_tokens === "number" ? ` · 输入上限 ${numberLabel(analysisMeta.maximum_source_tokens)}` : ""}</span></div></div>}
        {detail.canWrite && !detail.video.is_shared_reference && <div className="analysis-rerun-bar"><div><strong>按最高能力重新分析</strong><span>保留原视频；有人工校正版时优先沿用校正版。新任务不再允许降低能力档位。</span></div><span className="capability-badge">最高能力</span><button type="button" disabled={reanalyzing} onClick={reanalyze}>{reanalyzing ? "正在创建…" : "重新分析"}</button></div>}
        {spokenScript.length > 0 && <section className="spoken-script-panel"><div><div><span>语义整理成稿</span><h3>可以直接修改和使用的口播稿</h3></div><button type="button" onClick={copySpokenScript}>复制口播稿</button></div><article>{spokenScript.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</article><small>内容仅整理自原始转写；已去除重复、语气词和无效停顿，不额外补写事实。</small></section>}
        {reportSections.length > 0 ? <div className="report-sections">{reportSections.map(([key, value]) => <section className={key === "summary" || key === "recommendations" ? "report-section-wide" : undefined} key={key}><h3>{sectionNames[key] ?? key}</h3>{renderReportSection(value, key)}</section>)}</div> : <div className="list-empty">分析服务完成结构化输出后，结论、证据与复用建议会显示在这里。</div>}
        {evidence.length > 0 && <div className="evidence-list"><h3>结论证据</h3>{evidence.map((item, index) => { const canLocate = item.startMs !== null && Boolean(detail.video.media_url || detail.video.source_url); const label = item.startMs === null ? "证据没有时间点" : `${timeLabel(item.startMs)} ${detail.video.media_url ? "跳转播放" : detail.video.source_url ? "打开原视频核对" : "时间点"}`; return <button id={`analysis-evidence-${index}`} type="button" key={`${item.startMs}-${index}`} onClick={() => item.startMs !== null && locateTimepoint(item.startMs)} disabled={!canLocate} aria-label={label} title={label}><span>{item.startMs === null ? "证据" : timeLabel(item.startMs)}</span><strong>{item.text}</strong><small>{item.source} · 置信度 {item.confidence ?? "—"}</small></button>; })}</div>}
        {analysis && <footer className="report-provenance"><span>模型：{[analysis.model_provider, analysis.model_name].filter(Boolean).join(" / ") || "规则与适配器"}</span><span>提示词版本：{analysis.prompt_version || "—"}</span><span>生成：{dateLabel(analysis.created_at)}</span>{detail.video.is_shared_reference ? <span>共享素材 · 原分析只读</span> : <nav className="report-next-actions" aria-label="分析结果下一步"><Link href="/analysis?view=assets">素材中心</Link><Link href="/analysis?view=benchmark">对标内容库</Link><Link href={`/topics?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&sourceVideoId=${encodeURIComponent(videoId)}`}>从此分析创建选题 →</Link></nav>}</footer>}
      </article>
    </section>

    <aside className="detail-sidebar">
      <article className="panel metric-panel"><div className="panel-heading"><div><p className="section-kicker">指标快照</p><h2>{latestMetric ? (latestMetric.source === "public" ? "公开指标" : latestMetric.source === "client_backend" ? "客户后台指标" : "人工回填指标") : "等待指标"}</h2></div></div>{latestMetric ? <dl><div><dt>播放</dt><dd>{numberLabel(latestMetric.plays)}</dd></div><div><dt>点赞</dt><dd>{numberLabel(latestMetric.likes)}</dd></div><div><dt>评论</dt><dd>{numberLabel(latestMetric.comments)}</dd></div><div><dt>收藏</dt><dd>{numberLabel(latestMetric.favorites)}</dd></div><div><dt>分享</dt><dd>{numberLabel(latestMetric.shares)}</dd></div><div><dt>涨粉</dt><dd>{numberLabel(latestMetric.followers_gained)}</dd></div></dl> : <p className="sidebar-empty">暂无可追溯指标快照。</p>}</article>
      <article className="panel trace-panel" id="analysis-trace"><div className="panel-heading"><div><p className="section-kicker">任务追踪</p><h2>处理记录</h2></div><button type="button" onClick={load}>刷新</button></div>{detail.events.length > 0 ? <ol>{detail.events.map((event, index) => <li key={`${event.created_at}-${index}`}><i aria-hidden="true" /><div><strong>{eventNames[event.event_type] ?? event.event_type}</strong><span>{event.to_status || event.from_status || "状态记录"}{event.progress !== null ? ` · ${event.progress}%` : ""}</span><time>{dateLabel(event.created_at)}</time></div></li>)}</ol> : <p className="sidebar-empty">尚无处理事件。</p>}</article>
      {detail.job?.error_message && <article className="inline-alert" role="alert"><strong>{detail.job.error_code || "分析失败"}</strong><p>{detail.job.error_message}</p></article>}
    </aside>
  </div>;
}
