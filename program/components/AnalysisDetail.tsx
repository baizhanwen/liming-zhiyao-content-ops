"use client";
import { SplitWorkspace } from "./SplitWorkspace";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scopedFetch, rememberCurrentScope } from "../lib/client-scope";
import { readApiError, formatClientDate } from "../lib/client-format";
import { analysisReportView, editableReportSegments, reportModuleNames, unifiedReportMarkdown } from "../lib/analysis-report-view";
import { manuscriptAssetForVersion, prefersStoredManuscript, scriptCaptions, manuscriptParagraphs } from "../lib/manuscript-view";
import { ManuscriptCard, useManuscriptAsset } from "./ExtractedManuscript";
import { ModuleHeader } from "./ModuleHeader";
import { UnifiedReportContent } from "./UnifiedReportContent";
import { contentMetricRows, contentTimeLabel } from "../lib/content-analysis-presentation";
import { type UnifiedModuleKey } from "../lib/unified-report";
import { useAnalysisProfile } from "./useAnalysisProfile";
import type { AnalysisProfile } from "../lib/analysis-profile";
import { normalizeVisualAnalysisMode, type VisualAnalysisMode } from "../lib/visual-analysis-mode";
import { VisualAnalysisModeSelect, visualAnalysisModeLabels } from "./VisualAnalysisModeSelect";
import { readVisualSamplingLevel, visualSamplingLevelLabels, type VisualSamplingLevel } from "../lib/visual-sampling-level";
import { VisualSamplingLevelSelect } from "./VisualSamplingLevelSelect";
import { analysisExecutionModeLabels, normalizeAnalysisExecutionMode, type AnalysisExecutionMode } from "../lib/analysis-execution-mode";
import { AnalysisExecutionModeSelect } from "./AnalysisExecutionModeSelect";
import { AnalysisCollectionModeSelect } from "./AnalysisCollectionModeSelect";
import type { AnalysisCollectionMode } from "../lib/analysis-collection-mode";
import { reportRecoverySummary, type ModuleRecoveryFeedback } from "../lib/analysis-recovery-view";
import { structureDraftHref } from "../lib/studio-links";
import { VideoPlatformMetadata, useVideoCover, type VideoPlatformInfo, type VideoMetricSnapshot } from "./VideoPlatformMetadata";
import type { PlatformComments } from "../lib/video-platform-comments";
import "./analysis-cleanup.css";

type Analysis = { id: string; schema_version: string; analysis_job_id: string | null; report: unknown; created_at: string; model_name: string | null };
type Job = { id: string; status: string; progress: number; current_stage: string | null; error_code?: string | null; error_message?: string | null; analysis_profile: string; visual_analysis_mode?: VisualAnalysisMode; visual_sampling_level?: VisualSamplingLevel | null; execution_mode?: AnalysisExecutionMode; collection_mode?: AnalysisCollectionMode; module_retry?: { available: boolean; failedModuleKeys: string[] } };
type RawSegment = { startMs: number; endMs: number; text: string };
type Detail = {
  video: VideoPlatformInfo & { source_type?: string; id: string; title: string | null; filename: string | null; source_url: string | null; media_url: string | null; content_type: string | null; is_shared_reference?: boolean; media_binding?: string };
  metrics?: VideoMetricSnapshot[];
  platform_comments?: PlatformComments | null;
  job: Job | null; latestJob?: Job | null; analysis: Analysis | null; analyses?: Analysis[];
  transcript: { full_text: string; language: string; segments: unknown; created_at: string; source: string } | null;
  original_asr_segments?: unknown;
  assets: Array<{ id: string; analysis_job_id: string | null; kind: string; url: string; filename: string; created_at: string }>;
  canWrite: boolean;
  canCreateFromStructure?: boolean;
};
type Props = { videoId: string; organizationId: string; projectId: string; libraryEntryId?: string; initialAnalysisId?: string; sourceView?: "videos" | "benchmark" | "assets" };
const busyStates = new Set(["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "retrying"]);
const sourceViewLabels = { videos: "分析任务", benchmark: "空间对标", assets: "公司素材" };
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
function recordedVisualAnalysisMode(analysis: Analysis | null, job: Job | null): VisualAnalysisMode {
  const report = analysis?.report;
  const meta = report && typeof report === "object" && "analysis_meta" in report ? report.analysis_meta : null;
  if (meta && typeof meta === "object" && "visual_analysis_mode" in meta) return normalizeVisualAnalysisMode(meta.visual_analysis_mode);
  return normalizeVisualAnalysisMode(!analysis || analysis.analysis_job_id === job?.id ? job?.visual_analysis_mode : undefined);
}
function recordedVisualSamplingLevel(analysis: Analysis | null, job: Job | null): VisualSamplingLevel | null {
  const report = analysis?.report;
  const meta = report && typeof report === "object" && "analysis_meta" in report ? report.analysis_meta : null;
  if (meta && typeof meta === "object" && "visual_sampling_level" in meta) return readVisualSamplingLevel(meta.visual_sampling_level);
  return readVisualSamplingLevel(!analysis || analysis.analysis_job_id === job?.id ? job?.visual_sampling_level : undefined);
}

function recordedExecutionMode(analysis: Analysis | null, job: Job | null): AnalysisExecutionMode {
  const report = analysis?.report;
  const meta = report && typeof report === "object" && "analysis_meta" in report ? report.analysis_meta : null;
  if (analysis) return normalizeAnalysisExecutionMode(meta && typeof meta === "object" && "execution_mode" in meta ? meta.execution_mode : undefined);
  return normalizeAnalysisExecutionMode(job?.execution_mode);
}

export function AnalysisDetail({ videoId, organizationId, projectId, libraryEntryId, initialAnalysisId, sourceView = "videos" }: Props) {
  const [snapshot, setSnapshot] = useState<{ url: string; data: Detail; receivedAt: number } | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(initialAnalysisId || ""), [action, setAction] = useState("");
  const [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<RawSegment[]>([]);
  const [profile, setProfile] = useAnalysisProfile("standard");
  const [visualModeSelection, setVisualModeSelection] = useState<{ scope: string; value: VisualAnalysisMode } | null>(null);
  const [samplingLevelSelection, setSamplingLevelSelection] = useState<{ scope: string; value: VisualSamplingLevel } | null>(null);
  const [executionModeSelection, setExecutionModeSelection] = useState<{ scope: string; value: AnalysisExecutionMode } | null>(null);
  const [collectionModeSelection, setCollectionModeSelection] = useState<{ scope: string; value: AnalysisCollectionMode } | null>(null);
  const [moduleFeedback, setModuleFeedback] = useState<(ModuleRecoveryFeedback & { scope: string }) | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null), seekRef = useRef<number | null>(null);
  const generation = useRef(0);
  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ organizationId, projectId });
    if (libraryEntryId) params.set("libraryEntryId", libraryEntryId);
    if (selectedId) params.set("analysisId", selectedId);
    return `/api/videos/${encodeURIComponent(videoId)}?${params}`;
  }, [videoId, organizationId, projectId, libraryEntryId, selectedId]);
  const detail = snapshot?.url === requestUrl ? snapshot.data : null;
  const coverState = useVideoCover(detail?.video, detail?.assets.find(asset => asset.kind === "keyframe")?.url);
  const activeUrl = useRef(requestUrl);
  const load = useCallback(async () => {
    if (activeUrl.current !== requestUrl) return false;
    const current = ++generation.current;
    try {
      const response = await scopedFetch(requestUrl);
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as Detail;
      if (current === generation.current) { setSnapshot({ url: requestUrl, data: body, receivedAt: Date.now() }); setError(""); return true; }
      return false;
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "报告暂时无法读取。"); return false; }
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
  const waitingForMetadata = Boolean(detail?.video.metadata_status === "refreshing" && snapshot && snapshot.receivedAt < Date.parse(detail.video.metadata_attempted_at || "") + 120_000);
  const justSubmitted = Boolean(detail?.video.source_type === "url" && !detail.video.metadata_status && snapshot && snapshot.receivedAt < Date.parse(detail.video.created_at || "") + 15_000);
  useEffect(() => { if (!running && !waitingForMetadata && !justSubmitted) return; const timer = window.setInterval(() => void load(), 3_000); return () => window.clearInterval(timer); }, [running, waitingForMetadata, justSubmitted, load]);
  const analysis = detail?.analysis ?? null;
  const reportVisualMode = recordedVisualAnalysisMode(analysis, detail?.job ?? null);
  const visualAnalysisMode = visualModeSelection?.scope === requestUrl ? visualModeSelection.value : analysis || detail?.job ? reportVisualMode : "vision_only";
  const reportSamplingLevel = recordedVisualSamplingLevel(analysis, detail?.job ?? null);
  const visualSamplingLevel = samplingLevelSelection?.scope === requestUrl ? samplingLevelSelection.value : reportSamplingLevel ?? "quick";
  const reportExecutionMode = recordedExecutionMode(analysis, detail?.job ?? null);
  const executionMode = executionModeSelection?.scope === requestUrl ? executionModeSelection.value : "controlled_parallel";
  const collectionMode = collectionModeSelection?.scope === requestUrl ? collectionModeSelection.value : "anonymous";
  const isUrlSource = Boolean(detail?.video.source_url && detail?.video.source_type !== "upload");
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
  const editableSegments = hasManuscript ? manuscript?.segments ?? [] : editableReportSegments(view) ?? sourceSegments;
  const captionRows = hasManuscript ? manuscript?.segments ?? [] :
    view?.unified && ["completed", "original", "needs_review"].includes(view.unified.canonical.status) ? view.unified.canonical.segments.map(row => ({ startMs: row.start_ms, endMs: row.end_ms, text: view.unified?.version === "unified-report.v2" && "review_status" in row && row.review_status === "needs_review" ? `【待核对】${row.original_text}` : row.text })) : sourceSegments;
  const captionTrack = scriptCaptions(captionRows);
  const visibleOriginal = sourceSegments.filter(row => !query.trim() || row.text.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  const title = detail?.video.title || detail?.video.filename || "视频分析";
  const heading = title.replace(/\s+#[^\s#]+.*$/u, "").replace(/\s*-\s*抖音\s*$/u, "").trim() || title;
  const versions = detail?.analyses?.length ? detail.analyses : analysis ? [analysis] : [];
  const failedKeys = detail?.job?.module_retry?.failedModuleKeys ?? [];
  const canRetry = Boolean(detail?.canWrite && detail.job?.module_retry?.available && !running);
  const canEdit = Boolean(detail?.canWrite && !detail.video.is_shared_reference && !running);
  const recoverySummary = analysis?.analysis_job_id === latestJob?.id ? reportRecoverySummary(view) : null;
  const visibleModuleFeedback = moduleFeedback?.scope === requestUrl && moduleFeedback.tone !== "success" ? moduleFeedback : undefined;

  async function refreshMetadata() {
    if (!detail?.canWrite || action || !isUrlSource) return;
    setAction("metadata");
    setNotice("");
    try {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/metadata`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const result = await response.json() as { status: string; message?: string };
      if (activeUrl.current === requestUrl) {
        coverState.retry();
        if (result.status === "available") setNotice(result.message || "作品数据已更新。");
      }
    } catch (reason) {
      if (activeUrl.current === requestUrl) setNotice(reason instanceof Error ? reason.message : "作品数据更新失败。");
    } finally {
      await load();
      setAction("");
    }
  }
  function locate(milliseconds: number) {
    if (!detail?.video.media_url) return;
    const seconds = Math.max(0, milliseconds / 1000); seekRef.current = seconds;
    const player = mediaRef.current;
    if (player && player.readyState > 0) { player.currentTime = seconds; seekRef.current = null; void player.play().catch(() => {}); }
    player?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }
  function loadedMetadata() {
    if (mediaRef.current && seekRef.current !== null) { mediaRef.current.currentTime = seekRef.current; seekRef.current = null; }
  }
  async function runAction(name: string, operation: () => Promise<void>) {
    setAction(name); setNotice("");
    try {
      await operation();
      if (!await load()) setModuleFeedback(current => current?.scope === requestUrl && current.module === name && current.tone === "success"
        ? { ...current, tone: "error", message: "恢复请求已受理，但状态刷新失败。请刷新报告核对，不必再次提交。" } : current);
    }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : "操作未完成。"); }
    finally { setAction(""); }
  }
  async function retryModule(module: UnifiedModuleKey | "canonical", reviewSegmentIds?: string[]) {
    if (!detail?.job || !canRetry) return;
    setModuleFeedback({ scope: requestUrl, module, tone: "pending", message: "正在提交模块恢复请求…" });
    await runAction(module, async () => {
      try {
        const response = await scopedFetch(`/api/analysis-jobs/${encodeURIComponent(detail.job!.id)}/retry`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, moduleKeys: [module], ...(reviewSegmentIds?.length ? { reviewSegmentIds } : {}) }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const result = await response.json() as { job?: Partial<Job> };
        if (result.job?.id === detail.job!.id && typeof result.job.status === "string") {
          const updatedJob = result.job;
          setSnapshot(current => current?.url === requestUrl ? { ...current, data: {
            ...current.data,
            job: current.data.job && current.data.job.id === updatedJob.id ? { ...current.data.job, ...updatedJob } : current.data.job,
            latestJob: current.data.latestJob && current.data.latestJob.id === updatedJob.id ? { ...current.data.latestJob, ...updatedJob } : current.data.latestJob,
          } } : current);
        }
        const message = module === "canonical" ? "口播核对请求已受理，等待主机接手；已有画面和未受影响结果将复用。" : "模块补充请求已受理，等待主机接手；已有取证和未受影响结果将复用，相关综合结论会同步更新。";
        setModuleFeedback({ scope: requestUrl, module, tone: "success", message });
      } catch (reason) {
        setModuleFeedback({ scope: requestUrl, module, tone: "error", message: reason instanceof Error ? reason.message : "模块恢复请求未能确认，请刷新状态核对。" });
        throw reason;
      }
    });
  }
  async function extractManuscript() {
    await runAction("extract", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, task: "transcript", visualAnalysisMode: analysis || detail?.job ? reportVisualMode : "vision_only", visualSamplingLevel: reportSamplingLevel ?? "quick", executionMode, ...(detail?.video?.source_url && detail?.video?.source_type !== "upload" ? { collectionMode } : {}) }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSelectedId(""); setNotice("已开始从原片重新提取口播稿。");
    });
  }
  async function reanalyze() {
    await runAction("reanalyze", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, analysisProfile: profile, visualAnalysisMode, visualSamplingLevel, executionMode, ...(detail?.video?.source_url && detail?.video?.source_type !== "upload" ? { collectionMode } : {}) }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSelectedId(""); setNotice("新分析已进入队列，原报告仍保留。");
    });
  }
  async function saveTranscript(reanalyzeAfter: boolean) {
    await runAction("transcript", async () => {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/transcript`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId,
          language: detail?.transcript?.language || "zh-CN", segments: draft, reanalyze: reanalyzeAfter, analysisProfile: profile, visualAnalysisMode, visualSamplingLevel, executionMode, ...(detail?.video?.source_url && detail?.video?.source_type !== "upload" ? { collectionMode } : {}) }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setEditing(false); setSelectedId(""); setNotice(reanalyzeAfter ? "人工校正版已保存，分析已进入队列。" : "人工校正版已保存。");
    });
  }
  async function copyScript() {
    if (!view?.script.length) return;
    await runAction("copy", async () => { await copyText(view.script.join("\n\n")); setNotice(view.reviews.length ? "完整口播稿已复制，待核对原文和时间标记已保留。" : "完整口播稿已复制。"); });
  }
  function exportMarkdown() {
    if (!view || (hasManuscript && !manuscript)) return;
    const href = URL.createObjectURL(new Blob([unifiedReportMarkdown(title, view, manuscript ? paragraphs : undefined)], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = `${title.slice(0, 60).replace(/[\\/:*?"<>|]/g, "-")}-分析报告.md`; anchor.click(); URL.revokeObjectURL(href);
  }
  async function exportJson() {
    if (!detail || action || activeUrl.current !== requestUrl) return;
    const sourceUrl = requestUrl;
    const params = new URLSearchParams(sourceUrl.slice(sourceUrl.indexOf("?") + 1));
    params.set("export", "json");
    const exportUrl = `${sourceUrl.slice(0, sourceUrl.indexOf("?"))}?${params}`;
    setAction("export-json"); setNotice("");
    let href: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const response = await scopedFetch(exportUrl, { method: "GET" });
      if (!response.ok) throw new Error(await readApiError(response));
      const blob = await response.blob();
      if (activeUrl.current !== sourceUrl) return;
      const safeTitle = Array.from(title).slice(0, 40).join("").replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").replace(/[. ]+$/u, "") || "视频分析";
      const version = selectedId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 48) || "latest";
      const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
      href = URL.createObjectURL(blob);
      anchor = document.createElement("a"); anchor.href = href;
      anchor.download = `${safeTitle}-分析诊断-${version}-${timestamp}.json`;
      document.body.appendChild(anchor); anchor.click();
      setNotice("诊断 JSON 已导出。");
    } catch (reason) {
      if (activeUrl.current === sourceUrl) setNotice(reason instanceof Error ? reason.message : "诊断 JSON 暂时无法导出。");
    } finally {
      anchor?.remove();
      if (href) { const downloadUrl = href; window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000); }
      setAction(current => current === "export-json" ? "" : current);
    }
  }

  const paragraphs = manuscript ? manuscriptParagraphs(manuscript.segments) : [];
  const backLink = `/analysis?${new URLSearchParams({ view: sourceView, organizationId, projectId })}`;
  const currentManuscript = hasManuscript ? <ManuscriptCard canCopy={paragraphs.length > 0} onCopy={async () => {
    try { await copyText(paragraphs.join("\n\n")); setNotice("口播稿已复制。"); }
    catch { setNotice("复制失败，请选中稿件复制。"); }
  }}>
    {manuscript ? <div className="report-manuscript">{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      : asset.result?.error ? <p role="alert">{asset.result.error} <button type="button" onClick={asset.retry}>重新读取</button></p>
      : <p role="status">正在读取口播稿…</p>}
  </ManuscriptCard> : undefined;
  if (!detail && (loading || snapshot?.url !== requestUrl && !error)) return <><ModuleHeader title="视频分析" /><div className="management-state" role="status">正在载入报告…</div></>;
  if (!detail) return <><ModuleHeader title="视频分析" /><div className="management-state error-state" role="alert"><strong>报告暂时无法读取</strong><p>{error}</p><button type="button" onClick={() => void load()}>重新读取</button> <Link href={backLink}>返回{sourceViewLabels[sourceView]}</Link></div></>;
  return <>
    <ModuleHeader title={heading} titleHint={title} />
    <div className="unified-analysis-page">
    <div className="report-page-header">
      <div className="report-version-line">
        <Link href={backLink}>← {sourceViewLabels[sourceView]}</Link>
        <span className={`report-status ${view?.complete && !view.reviews.length ? "complete" : "partial"}`}>{!analysis ? "等待报告" : view?.legacy ? "历史报告" : view?.complete ? view.reviews.length ? `分析完成，${view.reviews.length}处口播待核对` : "分析已完成" : "部分结果可用"}</span>{analysis && <time>{formatClientDate(analysis.created_at)}</time>}{(analysis || detail.job) && <span className="report-visual-mode">{visualAnalysisModeLabels[reportVisualMode]}</span>}{(analysis || detail.job) && <span className="report-sampling-level">{reportSamplingLevel ? `画面档位：${visualSamplingLevelLabels[reportSamplingLevel]}` : "历史采样"}</span>}{(analysis || detail.job) && <span className="report-execution-mode">{analysisExecutionModeLabels[reportExecutionMode]}</span>}{versions.length > 1 && <label>报告版本<select aria-label="报告版本" value={selectedId || analysis?.id || ""} disabled={Boolean(action)} onChange={event => { setEditing(false); setNotice(""); setSelectedId(event.target.value); }}>{versions.map(row => <option key={row.id} value={row.id}>{formatClientDate(row.created_at)} · {["analysis.v11", "analysis.v12"].includes(row.schema_version) ? "新版分析" : "历史报告"}</option>)}</select></label>}{selectedId && <button type="button" disabled={Boolean(action)} onClick={() => { setEditing(false); setNotice(""); setSelectedId(""); }}>查看最新</button>}
      </div>
      <div className="report-primary-actions">{analysis && (detail.canCreateFromStructure ?? detail.canWrite) && <a className="primary-button" href={structureDraftHref({ organizationId, projectId, videoId, analysisId: analysis.id, libraryEntryId })}>用这个结构写文案</a>}<a className="secondary-button" href="#report-script">查看口播稿</a>{canEdit && <button type="button" disabled={Boolean(action)} onClick={() => void extractManuscript()}>仅提取口播稿</button>}<button type="button" disabled={!view || Boolean(action) || (hasManuscript && !manuscript)} onClick={exportMarkdown}>导出报告</button><button type="button" disabled={!detail || Boolean(action)} onClick={() => void exportJson()}>{action === "export-json" ? "正在导出…" : "导出 JSON"}</button></div>
    </div>
    {notice && <div className="report-notice" role="status">{notice}</div>}{error && <div className="inline-alert" role="alert">{error}</div>}
    {recoverySummary && <div className="report-recovery-summary" role="status"><p>{recoverySummary}</p>{canRetry && <p>可在未完成部分点击“只补这一部分”，复用已有取证与未受影响结果。</p>}</div>}{latestJob?.status === "failed" && (!recoverySummary || latestJob.error_code !== "ANALYSIS_PARTIAL") && <div className="inline-alert" role="alert">{latestJob.error_message || "最近一次任务执行失败。"}</div>}
    {running && <div className="report-running" role="status"><span className="report-running-dot" /><strong>{latestJob?.current_stage || "正在分析"}</strong><span>{latestJob?.progress ?? 0}%</span><button type="button" onClick={() => void load()}>刷新</button></div>}
    {view?.invalid && <div className="inline-alert" role="alert">这份报告没有完整通过格式检查。请查看原稿或重试未完成的部分。</div>}
    <SplitWorkspace className="report-workspace">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users can focus and scroll the media pane independently. */}
      <aside className="report-source-column" id="report-media" aria-label="视频资料与作品数据" tabIndex={0}><div className="report-player">{detail.video.media_url ? detail.video.content_type?.startsWith("audio/") ? <audio ref={node => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url} onLoadedMetadata={loadedMetadata}><track kind="captions" srcLang="zh" label="中文" src={captionTrack} /></audio> : <video ref={node => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url} poster={coverState.cover?.url} onLoadedMetadata={loadedMetadata}><track kind="captions" srcLang="zh" label="中文" src={captionTrack} /></video> : <div className="report-source-link"><strong>原视频</strong>{detail.video.source_url ? <a href={detail.video.source_url} target="_blank" rel="noreferrer">打开原平台查看 ↗</a> : <span>暂时没有可播放的原片</span>}</div>}</div>{detail.video.media_binding === "video" && selectedId && <small className="report-source-note">播放此素材保存的原片，当前历史版本没有独立原片副本。</small>}{view?.content && <dl className="report-media-facts">{contentMetricRows(view.content).filter(([label]) => ["原始时长", "显示画幅", "转写有效字符", "检测切换次数"].includes(label)).filter(([, value]) => value !== "未取得" && value !== "无法判断").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {(isUrlSource || Boolean(detail.metrics?.length)) && <VideoPlatformMetadata
        video={detail.video} snapshots={detail.metrics ?? []} coverState={coverState}
        platformComments={isUrlSource && detail.video.platform === "douyin" ? detail.platform_comments : null}
        busy={action === "metadata" || waitingForMetadata} disabled={Boolean(action) || waitingForMetadata} onRefresh={isUrlSource && detail.canWrite && !detail.video.is_shared_reference ? refreshMetadata : undefined}
      />}
      <nav className="report-section-nav" aria-label="报告内容">{(view?.unified?.version === "unified-report.v1" && view.unified.canonical.status === "failed" ? [] : Object.entries(reportModuleNames)).map(([key, name]) => <a key={key} href={`#report-${key}`}>{name}</a>)}<a href="#report-script">完整口播稿</a></nav>
      {canEdit && <details className="report-rerun"><summary>重新分析</summary>{isUrlSource && <><AnalysisCollectionModeSelect value={collectionMode} onChange={value => setCollectionModeSelection({ scope: requestUrl, value })} disabled={Boolean(action)} />{collectionMode === "cookie" && <p>使用当前公司的 Cookie。需要上传或更新时，<Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>前往视频分析页管理</Link>。</p>}</>}<label>分析档位<select value={profile} onChange={event => setProfile(event.target.value as AnalysisProfile)}><option value="standard">标准模式</option><option value="max">最高能力</option></select></label><VisualAnalysisModeSelect value={visualAnalysisMode} onChange={value => setVisualModeSelection({ scope: requestUrl, value })} disabled={Boolean(action)} /><VisualSamplingLevelSelect value={visualSamplingLevel} onChange={value => setSamplingLevelSelection({ scope: requestUrl, value })} disabled={Boolean(action)} /><AnalysisExecutionModeSelect value={executionMode} onChange={value => setExecutionModeSelection({ scope: requestUrl, value })} disabled={Boolean(action)} /><p>会保留原报告，并按当前材料创建新的分析。更换画面方式或档位会重新取得画面依据；仅重试失败模块时保留原方式、档位与处理方式。</p><button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void reanalyze()}>{action === "reanalyze" ? "正在创建…" : "创建新分析"}</button></details>}</aside>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Allow keyboard scrolling of the independently scrollable report. */}
      <main className="report-content-column" aria-label="分析报告与口播稿" tabIndex={0}>{view && !view.invalid ? <UnifiedReportContent manuscript={currentManuscript} view={view} assets={detail.assets} canLocate={Boolean(detail.video.media_url)} onLocate={locate} onCopyScript={() => void copyScript()} canCopyScript={Boolean(view.script.length && ["completed", "original", "needs_review", "historical"].includes(view.scriptStatus))} failedModuleKeys={failedKeys} retryFeedback={visibleModuleFeedback} onRetry={canRetry ? (key, ids) => void retryModule(key, ids) : undefined} busy={Boolean(action)} /> : currentManuscript ?? (!running && <div className="report-empty"><h2>尚无可展示的分析</h2><p>原稿与素材仍保留，可以创建新的分析。</p></div>)}
        {analysis && !detail.video.is_shared_reference && <nav className="report-next-actions" aria-label="分析结果下一步">
          <Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&view=assets`}>公司素材</Link><Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&view=benchmark`}>空间对标</Link>
        </nav>}
        <details className="report-original"><summary>核对原始转写</summary><div className="report-original-tools"><label>查找原文<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索词句" /></label>{canEdit && !editing && <button type="button" disabled={!editableSegments.length || Boolean(action)} onClick={() => { setDraft(editableSegments.map(row => ({ ...row }))); setEditing(true); }}>人工校正</button>}</div>{editing ? <div className="transcript-editor">{draft.map((row, index) => <label key={index}><span>{contentTimeLabel(row.startMs)}</span><textarea value={row.text} maxLength={2000} onChange={event => setDraft(current => current.map((item, offset) => offset === index ? { ...item, text: event.target.value } : item))} /></label>)}<div className="report-edit-actions"><button type="button" disabled={Boolean(action)} onClick={() => setEditing(false)}>取消</button><button type="button" disabled={Boolean(action)} onClick={() => void saveTranscript(false)}>保存校正版</button><button type="button" disabled={Boolean(action)} onClick={() => void saveTranscript(true)}>保存并重新分析</button></div></div> : <ol>{visibleOriginal.map((row, index) => <li key={index}>{detail.video.media_url ? <button type="button" onClick={() => locate(row.startMs)}>{contentTimeLabel(row.startMs)}</button> : <time>{contentTimeLabel(row.startMs)}</time>}<p>{row.text}</p></li>)}</ol>}</details>
      </main></SplitWorkspace>
    </div>
  </>;
}
