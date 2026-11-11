"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scopedFetch, rememberCurrentScope } from "../lib/client-scope";
import { readApiError, formatClientDate } from "../lib/client-format";
import { analysisReportView, reportModuleNames, unifiedReportMarkdown } from "../lib/analysis-report-view";
import { manuscriptAssetForVersion, prefersStoredManuscript, scriptCaptions, manuscriptParagraphs } from "../lib/manuscript-view";
import { ManuscriptCard, useManuscriptAsset } from "./ExtractedManuscript";
import { UnifiedReportContent } from "./UnifiedReportContent";
import { contentMetricRows, contentTimeLabel } from "../lib/content-analysis-presentation";
import { type UnifiedModuleKey } from "../lib/unified-report";
import { useAnalysisProfile } from "./useAnalysisProfile";
import type { AnalysisProfile } from "../lib/analysis-profile";

type Analysis = { id: string; schema_version: string; analysis_job_id: string | null; report: unknown; created_at: string; model_name: string | null };
type Job = { id: string; status: string; progress: number; current_stage: string | null; error_message?: string | null; analysis_profile: string; module_retry?: { available: boolean; failedModuleKeys: string[] } };
type RawSegment = { startMs: number; endMs: number; text: string };
type Detail = {
  video: { id: string; title: string | null; filename: string | null; source_url: string | null; media_url: string | null; content_type: string | null; is_shared_reference?: boolean; media_binding?: string };
  job: Job | null; latestJob?: Job | null; analysis: Analysis | null; analyses?: Analysis[];
  transcript: { full_text: string; language: string; segments: unknown; created_at: string; source: string } | null;
  original_asr_segments?: unknown;
  assets: Array<{ id: string; analysis_job_id: string | null; kind: string; url: string; filename: string; created_at: string }>;
  canWrite: boolean;
};
type Props = { videoId: string; organizationId: string; projectId: string; libraryEntryId?: string; initialAnalysisId?: string };
const busyStates = new Set(["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "retrying"]);
function rawSegments(value: unknown): RawSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => row && typeof row === "object" && typeof row.text === "string" ? [{
    startMs: Number(row.start_ms ?? row.startMs ?? 0), endMs: Number(row.end_ms ?? row.endMs ?? 0), text: row.text,
  }] : []);
}
async function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement("textarea"); field.value = value; document.body.appendChild(field); field.select();
  const copied = document.execCommand("copy"); field.remove(); if (!copied) throw new Error("复制失败，请使用导出。");
}

export function AnalysisDetail({ videoId, organizationId, projectId, libraryEntryId, initialAnalysisId }: Props) {
  const [snapshot, setSnapshot] = useState<{ url: string; data: Detail } | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(initialAnalysisId || ""), [action, setAction] = useState("");
  const [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<RawSegment[]>([]);
  const [profile, setProfile] = useAnalysisProfile("standard");
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null), seekRef = useRef<number | null>(null);
  const generation = useRef(0);
  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ organizationId, projectId });
    if (libraryEntryId) params.set("libraryEntryId", libraryEntryId);
    if (selectedId) params.set("analysisId", selectedId);
    return `/api/videos/${encodeURIComponent(videoId)}?${params}`;
  }, [videoId, organizationId, projectId, libraryEntryId, selectedId]);
  const detail = snapshot?.url === requestUrl ? snapshot.data : null;
  const activeUrl = useRef(requestUrl);
  const load = useCallback(async () => {
    if (activeUrl.current !== requestUrl) return;
    const current = ++generation.current;
    try {
      const response = await scopedFetch(requestUrl);
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as Detail;
      if (current === generation.current) { setSnapshot({ url: requestUrl, data: body }); setError(""); }
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "报告暂时无法读取。"); }
    finally { if (current === generation.current) setLoading(false); }
  }, [requestUrl]);
  useEffect(() => {
    rememberCurrentScope(organizationId, projectId);
    activeUrl.current = requestUrl;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void load(); });
    return () => { mounted = false; generation.current += 1; activeUrl.current = ""; };
  }, [requestUrl, organizationId, projectId, load]);
  const latestJob = detail?.latestJob ?? detail?.job;
  const running = Boolean(latestJob && busyStates.has(latestJob.status));
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => void load(), 3_000); return () => window.clearInterval(timer); }, [running, load]);
  const analysis = detail?.analysis ?? null;
  const manuscriptAsset = manuscriptAssetForVersion(detail?.assets ?? [], analysis, Boolean(selectedId));
  const asset = useManuscriptAsset(manuscriptAsset?.url);
  const stored = detail?.transcript ?? null;
  const preferStored = prefersStoredManuscript(stored, manuscriptAsset, analysis, Boolean(selectedId));
  const savedBackup = Boolean(asset.result?.error && manuscriptAsset && stored?.created_at && stored.created_at >= manuscriptAsset.created_at);
  const storedRows = useMemo(() => rawSegments(stored?.segments), [stored?.segments]);
  const asrBeforeEdit = useMemo(() => rawSegments(detail?.original_asr_segments), [detail?.original_asr_segments]);
  const manuscript = (preferStored || savedBackup) && stored
    ? { basis: stored.source === "manual" ? "manual" as const : "audio" as const, segments: storedRows, originals: asrBeforeEdit }
    : asset.result?.data ?? null;
  const hasManuscript = Boolean(preferStored || manuscriptAsset);
  const view = useMemo(() => analysis ? analysisReportView(analysis.schema_version, analysis.report) : null, [analysis]);
  const reportOriginal = useMemo(() => view?.unified?.canonical.segments.map(row => ({ startMs: row.start_ms, endMs: row.end_ms, text: row.original_text })) ?? storedRows, [view, storedRows]);
  const sourceSegments = asset.result?.data?.basis === "audio" ? asset.result.data.originals
    : asrBeforeEdit.length ? asrBeforeEdit : manuscript?.basis === "audio" ? manuscript.segments : reportOriginal;
  const editableSegments = hasManuscript ? manuscript?.segments ?? [] : sourceSegments;
  const captionRows = hasManuscript ? manuscript?.segments ?? [] :
    view?.unified?.canonical.status === "completed" ? view.unified.canonical.segments.map(row => ({ startMs: row.start_ms, endMs: row.end_ms, text: row.text })) : sourceSegments;
  const captionTrack = scriptCaptions(captionRows);
  const visibleOriginal = sourceSegments.filter(row => !query.trim() || row.text.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  const title = detail?.video.title || detail?.video.filename || "视频分析";
  const heading = title.replace(/\s+#[^\s#]+.*$/u, "").replace(/\s*-\s*抖音\s*$/u, "").trim() || title;
  const versions = detail?.analyses?.length ? detail.analyses : analysis ? [analysis] : [];
  const failedKeys = detail?.job?.module_retry?.failedModuleKeys ?? [];
  const canRetry = Boolean(detail?.canWrite && detail.job?.module_retry?.available && !running);
  const canEdit = Boolean(detail?.canWrite && !detail.video.is_shared_reference && !running);

  function locate(milliseconds: number) {
    if (!detail?.video.media_url) return;
    const seconds = Math.max(0, milliseconds / 1000); seekRef.current = seconds;
    const player = mediaRef.current;
    if (player && player.readyState > 0) { player.currentTime = seconds; seekRef.current = null; void player.play().catch(() => {}); }
    document.getElementById("report-media")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function loadedMetadata() {
    if (mediaRef.current && seekRef.current !== null) { mediaRef.current.currentTime = seekRef.current; seekRef.current = null; }
  }
  async function runAction(name: string, operation: () => Promise<void>) {
    setAction(name); setNotice("");
    try { await operation(); await load(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : "操作未完成。"); }
    finally { setAction(""); }
  }
  async function retryModule(module: UnifiedModuleKey | "canonical") {
    if (!detail?.job || !canRetry) return;
    await runAction(module, async () => {
      const response = await scopedFetch(`/api/analysis-jobs/${encodeURIComponent(detail.job!.id)}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, moduleKeys: [module] }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setNotice("已开始补充这一部分，成功结果和已有取证将复用。");
    });
  }
  async function extractManuscript() {
    await runAction("extract", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, task: "transcript" }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSelectedId(""); setNotice("已开始从原片重新提取口播稿。");
    });
  }
  async function reanalyze() {
    await runAction("reanalyze", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, analysisProfile: profile }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSelectedId(""); setNotice("新分析已进入队列，原报告仍保留。");
    });
  }
  async function saveTranscript(reanalyzeAfter: boolean) {
    await runAction("transcript", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/transcript`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId,
          language: detail?.transcript?.language || "zh-CN", segments: draft, reanalyze: reanalyzeAfter, analysisProfile: profile }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setEditing(false); setSelectedId(""); setNotice(reanalyzeAfter ? "人工校正版已保存，分析已进入队列。" : "人工校正版已保存。");
    });
  }
  async function copyScript() {
    if (!view?.script.length) return;
    await runAction("copy", async () => { await copyText(view.script.join("\n\n")); setNotice("完整口播稿已复制。"); });
  }
  function exportMarkdown() {
    if (!view || (hasManuscript && !manuscript)) return;
    const href = URL.createObjectURL(new Blob([unifiedReportMarkdown(title, view, manuscript ? paragraphs : undefined)], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = `${title.slice(0, 60).replace(/[\\/:*?"<>|]/g, "-")}-分析报告.md`; anchor.click(); URL.revokeObjectURL(href);
  }

  const paragraphs = manuscript ? manuscriptParagraphs(manuscript.segments) : [];
  const currentManuscript = hasManuscript ? <ManuscriptCard canCopy={paragraphs.length > 0} onCopy={async () => {
    try { await copyText(paragraphs.join("\n\n")); setNotice("口播稿已复制。"); }
    catch { setNotice("复制失败，请选中稿件复制。"); }
  }}>
    {manuscript ? <div className="report-manuscript">{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      : asset.result?.error ? <p role="alert">{asset.result.error} <button type="button" onClick={asset.retry}>重新读取</button></p>
      : <p role="status">正在读取口播稿…</p>}
  </ManuscriptCard> : undefined;
  if (!detail && (loading || snapshot?.url !== requestUrl && !error)) return <div className="management-state" role="status">正在载入报告…</div>;
  if (!detail) return <div className="management-state error-state"><strong>报告暂时无法读取</strong><p>{error}</p><button type="button" onClick={() => void load()}>重新读取</button></div>;
  return <div className="unified-analysis-page">
    <header className="report-page-header"><div><Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>← 视频分析</Link><h1 title={title}>{heading}</h1><div className="report-version-line"><span className={`report-status ${view?.complete ? "complete" : "partial"}`}>{!analysis ? "等待报告" : view?.legacy ? "历史报告" : view?.complete ? "分析已完成" : "部分结果可用"}</span>{analysis && <time>{formatClientDate(analysis.created_at)}</time>}{versions.length > 1 && <label>报告版本<select aria-label="报告版本" value={selectedId || analysis?.id || ""} disabled={Boolean(action)} onChange={event => { setEditing(false); setNotice(""); setSelectedId(event.target.value); }}>{versions.map(row => <option key={row.id} value={row.id}>{formatClientDate(row.created_at)} · {row.schema_version === "analysis.v11" ? "新版分析" : "历史报告"}</option>)}</select></label>}{selectedId && <button type="button" disabled={Boolean(action)} onClick={() => { setEditing(false); setNotice(""); setSelectedId(""); }}>查看最新</button>}</div></div><div className="report-primary-actions"><a className="secondary-button" href="#report-script">查看口播稿</a>{canEdit && <button type="button" disabled={Boolean(action)} onClick={() => void extractManuscript()}>仅提取口播稿</button>}<button type="button" disabled={!view || Boolean(action) || (hasManuscript && !manuscript)} onClick={exportMarkdown}>导出报告</button></div></header>
    {notice && <div className="report-notice" role="status">{notice}</div>}{error && <div className="inline-alert" role="alert">{error}</div>}
    {latestJob?.status === "failed" && <div className="inline-alert" role="alert">{latestJob.error_message || "最近一次任务执行失败。"}</div>}
    {running && <div className="report-running" role="status"><span className="report-running-dot" /><strong>{latestJob?.current_stage || "正在分析"}</strong><span>{latestJob?.progress ?? 0}%</span><button type="button" onClick={() => void load()}>刷新</button></div>}
    {view?.invalid && <div className="inline-alert" role="alert">这份报告没有完整通过格式检查。请查看原稿或重试未完成的部分。</div>}
    <div className="report-workspace"><aside className="report-source-column" id="report-media"><div className="report-player">{detail.video.media_url ? detail.video.content_type?.startsWith("audio/") ? <audio ref={node => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url} onLoadedMetadata={loadedMetadata}><track kind="captions" srcLang="zh" label="中文" src={captionTrack} /></audio> : <video ref={node => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url} onLoadedMetadata={loadedMetadata}><track kind="captions" srcLang="zh" label="中文" src={captionTrack} /></video> : <div className="report-source-link"><strong>原视频</strong>{detail.video.source_url ? <a href={detail.video.source_url} target="_blank" rel="noreferrer">打开原平台查看 ↗</a> : <span>暂时没有可播放的原片</span>}</div>}</div>{detail.video.media_binding === "video" && selectedId && <small className="report-source-note">播放此素材保存的原片，当前历史版本没有独立原片副本。</small>}{view?.content && <dl className="report-media-facts">{contentMetricRows(view.content).filter(([label]) => ["原始时长", "显示画幅", "转写有效字符", "检测切换次数"].includes(label)).filter(([, value]) => value !== "未取得" && value !== "无法判断").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      <nav className="report-section-nav" aria-label="报告内容">{(view?.unified?.canonical.status === "failed" ? [] : Object.entries(reportModuleNames)).map(([key, name]) => <a key={key} href={`#report-${key}`}>{name}</a>)}<a href="#report-script">完整口播稿</a></nav>
      {canEdit && <details className="report-rerun"><summary>重新分析</summary><label>分析档位<select value={profile} onChange={event => setProfile(event.target.value as AnalysisProfile)}><option value="standard">标准模式</option><option value="max">最高能力</option></select></label><p>会保留原报告，并按当前材料创建新的分析。</p><button type="button" disabled={Boolean(action)} onClick={() => void reanalyze()}>{action === "reanalyze" ? "正在创建…" : "创建新分析"}</button></details>}</aside>
      <main className="report-content-column">{view && !view.invalid ? <UnifiedReportContent manuscript={currentManuscript} view={view} assets={detail.assets} canLocate={Boolean(detail.video.media_url)} onLocate={locate} onCopyScript={() => void copyScript()} canCopyScript={Boolean(view.script.length && ["completed", "historical"].includes(view.scriptStatus))} failedModuleKeys={failedKeys} onRetry={canRetry ? key => void retryModule(key) : undefined} busy={Boolean(action)} /> : currentManuscript ?? (!running && <div className="report-empty"><h2>尚无可展示的分析</h2><p>原稿与素材仍保留，可以创建新的分析。</p></div>)}
        {analysis && !detail.video.is_shared_reference && <nav className="report-next-actions" aria-label="分析结果下一步"><Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&view=assets`}>素材中心</Link><Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&view=benchmark`}>对标内容库</Link>{detail.canWrite && <Link href={`/topics?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&sourceVideoId=${encodeURIComponent(videoId)}`}>从此分析创建选题 →</Link>}</nav>}
        <details className="report-original"><summary>核对原始转写</summary><div className="report-original-tools"><label>查找原文<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索词句" /></label>{canEdit && !editing && <button type="button" disabled={!editableSegments.length || Boolean(action)} onClick={() => { setDraft(editableSegments.map(row => ({ ...row }))); setEditing(true); }}>人工校正</button>}</div>{editing ? <div className="transcript-editor">{draft.map((row, index) => <label key={index}><span>{contentTimeLabel(row.startMs)}</span><textarea value={row.text} maxLength={2000} onChange={event => setDraft(current => current.map((item, offset) => offset === index ? { ...item, text: event.target.value } : item))} /></label>)}<div className="report-edit-actions"><button type="button" disabled={Boolean(action)} onClick={() => setEditing(false)}>取消</button><button type="button" disabled={Boolean(action)} onClick={() => void saveTranscript(false)}>保存校正版</button><button type="button" disabled={Boolean(action)} onClick={() => void saveTranscript(true)}>保存并重新分析</button></div></div> : <ol>{visibleOriginal.map((row, index) => <li key={index}>{detail.video.media_url ? <button type="button" onClick={() => locate(row.startMs)}>{contentTimeLabel(row.startMs)}</button> : <time>{contentTimeLabel(row.startMs)}</time>}<p>{row.text}</p></li>)}</ol>}</details>
      </main></div>
  </div>;
}
