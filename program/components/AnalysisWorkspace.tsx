"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";


import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { preferredOrganizationId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { analysisProfileBudgets, analysisProfileSegmentLimits, estimateAnalysisMaximumTokens, estimateMediaSourceTokens, estimateRepresentativeFrames, type AnalysisProfile } from "../lib/analysis-profile";
import { VideoLibraryWorkspace } from "./VideoLibraryWorkspace";
import { useAnalysisProfile } from "./useAnalysisProfile";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type UploadEstimate = { name: string; durationSeconds: number | null };
type Video = { id: string; platform: string; source_type: string; source_url: string | null; title: string | null; status: string; error_message: string | null; created_at: string; filename?: string | null; size_bytes?: number | null; is_reference?: number | boolean };
type Job = { id: string; video_id: string; status: string; analysis_profile: string; progress: number; current_stage: string | null; error_code: string | null; error_message: string | null; retry_count: number; lease_expires_at: string | null; checkpoint_stage: string | null; checkpoint_updated_at: string | null; resume_count: number; segment_progress?: { total: number; completed: number; failed: number; inProgress: number; remaining: number; segments: Array<{ windowKey: string; index: number; startMs: number; endMs: number; status: "pending" | "in_progress" | "completed" | "failed"; attempts: number; error: string | null }> } | null; created_at: string; updated_at: string };
type ServiceStatus = { checkedAt: string; credentialConfigured: boolean; modelConfigured: boolean; publicLinkCookieConfigured: boolean; publicLinkAuthenticationMode: "browser" | "cookie_file" | "none"; browserLoginStatus: "logged_in" | "not_logged_in" | "unavailable" | "disabled" | "checking" | "unknown"; browserLoginDetected: boolean; browserLoginBrowser: string | null; browserLoginCheckedAt: string | null; browserLoginMessage: string | null; cookieUpdatedAt: string | null; canManageCookies: boolean; analyzerOnline: boolean; lastWorkerHeartbeat: string | null };
type QueueStatus = { sampleCount: number; averageSeconds: number | null; waitingCount: number; runningCount: number };

const stages = ["媒体入库", "音频处理", "语音转写", "字幕与关键帧", "结构化分析", "生成报告"];
const statusLabels: Record<string, string> = { pending: "等待中", queued: "已排队", downloading: "获取媒体", processing: "处理媒体", transcribing: "语音转写", extracting: "提取画面", analyzing: "结构分析", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const activeJobStatuses = new Set(["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing"]);
const profileLabels: Record<string, string> = { standard: "标准模式", max: "最高能力", economy: "历史经济", deep: "历史深度" };
const errorGuidance: Record<string, string> = {
  ANALYSIS_PARTIAL: "报告已经生成；请查看质量验收中未通过的项目，配置缺失能力或修正来源后再重试。",
  DOUYIN_COOKIE_EXPIRED: "请先稍后重试；旧版下载错误可能被统一归为 Cookie 问题。持续失败时，在浏览器确认视频能播放，再更新抖音 Cookie。",
  DOUYIN_ACCESS_REJECTED: "先稍后重试。若同一链接持续失败，在浏览器确认能正常播放后再更新 Cookie；一次下载失败不足以判断登录过期。",
  DOUYIN_BROWSER_UNAVAILABLE: "分析主机浏览器登录信息无法读取，请在本页上传 cookies.txt；其他电脑浏览器中的登录态不会自动共享给主机。",
  DOUYIN_COOKIE_INVALID: "请在抖音网页重新导出 Netscape 格式的 cookies.txt 并上传。",
  SOURCE_NETWORK_FAILED: "下载已做一次短暂重试。请检查主机网络，稍后再试，无需仅因网络错误反复更换 Cookie。",
  SOURCE_RATE_LIMITED: "请暂停密集重试，稍后再试；持续出现时联系管理员检查抖音访问状态。",
  SOURCE_UNAVAILABLE: "请确认原链接在浏览器能正常播放，视频可能已删除或被设为不可访问。",
  SOURCE_DOWNLOAD_FAILED: "检查原视频是否仍可访问；抖音链接可先更新 Cookie 再重试。",
  MEDIA_PROCESSING_FAILED: "媒体格式处理失败，可重新上传 MP4、MP3 或 WAV 后再试。",
  TRANSCRIPTION_FAILED: "语音转写没有完成，可重试；持续失败时建议先转为清晰音频。",
  VISUAL_EXTRACTION_FAILED: "关键画面提取失败，可重试；纯音频建议直接使用音频上传。",
  MODEL_CONTEXT_LIMIT: "模型上下文仍然不足，建议拆分长视频后分别分析。",
  MODEL_OUTPUT_LIMIT: "报告压缩输出已经启用，请点击“从检查点继续”；不会重新下载或转写。",
  MODEL_OUTPUT_INVALID: "JSON 自动恢复已经启用，请点击“从检查点继续”；不会重新下载或转写。",
  MODEL_RATE_LIMITED: "模型服务正在限流，稍等几分钟后重试即可。",
  MODEL_EVIDENCE_MISMATCH: "引用自动校正已经启用，请点击“从检查点继续”；无需重新下载或转写。",
  MODEL_EVIDENCE_UNAVAILABLE: "没有可追溯的字幕或画面文字，建议上传带清晰语音的视频或音频。",
  MODEL_REQUEST_FAILED: "检查系统设置中的模型名称、地址和密钥后重试。",
  WORKER_PROCESSING_FAILED: "后台处理遇到未知错误，可先重试；再次失败时保留此错误信息。",
};

function visibleJobError(job: Job) {
  if (job.error_code && ["DOUYIN_ACCESS_REJECTED", "DOUYIN_BROWSER_UNAVAILABLE", "DOUYIN_COOKIE_INVALID", "SOURCE_NETWORK_FAILED", "SOURCE_RATE_LIMITED", "SOURCE_UNAVAILABLE"].includes(job.error_code)) return job.error_message;
  if (job.progress === 18 && (job.error_message?.includes("[WinError 2]") || job.error_message?.includes("executable was not found"))) {
    return "分析主机没有找到 FFmpeg/ffprobe 媒体运行时。";
  }
  if (job.error_message?.includes("本地浏览器登录态") || job.error_message?.includes("分析主机浏览器登录态")) {
    return "当前分析服务无法读取主机浏览器登录态；局域网账号请上传 Cookie 文件后重试。";
  }
  if (job.error_message?.includes("Invalid JSON") || job.error_message?.includes("json_invalid") || job.error_message?.includes("validation error for Report")) {
    return "模型返回的报告 JSON 格式不完整。";
  }
  if (job.error_message?.includes("max_tokens") || job.error_message?.includes("output is incomplete")) {
    return "模型报告超过了当前模式的输出长度。";
  }
  if (job.error_message?.includes("model report did not preserve exact source evidence")) {
    return "模型返回的引用格式未通过追溯校验。";
  }
  return job.error_message;
}

function guidanceForJob(job: Job) {
  if (job.progress === 18 && (job.error_message?.includes("[WinError 2]") || job.error_message?.includes("executable was not found"))) {
    return "请在运行局域网服务的主机上双击 tools\\setup-analyzer.bat 修复媒体运行时，重启局域网服务后再点重试。";
  }
  if (job.error_message?.includes("Invalid JSON") || job.error_message?.includes("json_invalid") || job.error_message?.includes("validation error for Report")) {
    return "JSON 自动恢复已经启用，请点击“从检查点继续”；不会重新下载或转写。";
  }
  if (job.error_message?.includes("max_tokens") || job.error_message?.includes("output is incomplete")) {
    return "报告压缩输出已经启用，请点击“从检查点继续”；不会重新下载或转写。";
  }
  if (job.error_message?.includes("model report did not preserve exact source evidence")) {
    return "引用自动校正已经启用，请点击“从检查点继续”；无需重新下载或转写。";
  }
  return job.error_code ? errorGuidance[job.error_code] || "" : "";
}

function durationLabel(seconds: number) {
  if (seconds < 60) return "不到 1 分钟";
  if (seconds < 3600) return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
  const hours = Math.floor(seconds / 3600); const minutes = Math.round(seconds % 3600 / 60);
  return minutes ? `约 ${hours} 小时 ${minutes} 分钟` : `约 ${hours} 小时`;
}

function queueLabel(job: Job, _jobs: Job[], queue: QueueStatus | null) {
  if (!activeJobStatuses.has(job.status)) return "";
  const expired = Boolean(job.lease_expires_at && job.lease_expires_at <= new Date().toISOString());
  if (job.status === "pending" || expired) {
    const counts = queue ? `：${queue.waitingCount} 个等待，${queue.runningCount} 个处理中` : "";
    return `${expired ? "等待服务恢复 · " : ""}主机共享队列${counts}（包含其他项目）`;
  }
  if (!queue?.averageSeconds || queue.sampleCount < 1) return "主机正在处理此任务";
  return `同项目近期单条处理耗时${durationLabel(queue.averageSeconds)}，排队时间另计`;
}



function readMediaDuration(file: File) {
  return new Promise<number | null>((resolve) => {
    const element = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    const timeout = window.setTimeout(() => finish(null), 8_000);
    element.preload = "metadata";
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? element.duration : null);
    element.onerror = () => finish(null);
    element.src = objectUrl;
  });
}

function VideoAnalysisWorkspace({ initialView = "videos" }: { initialView?: "videos" | "benchmark" | "assets" }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [videos, setVideos] = useState<Video[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const [service, setService] = useState<ServiceStatus | null>(null); const [uploadProgress, setUploadProgress] = useState(""); const [submitMessage, setSubmitMessage] = useState("");
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [cookieUpdating, setCookieUpdating] = useState(false); const [cookieDeleting, setCookieDeleting] = useState(false); const [cookieMessage, setCookieMessage] = useState(""); const cookieFileRef = useRef<HTMLInputElement>(null);
  const [jobActionId, setJobActionId] = useState("");
  const [analysisProfile, updateAnalysisProfile] = useAnalysisProfile();
  const [uploadEstimates, setUploadEstimates] = useState<UploadEstimate[]>([]);
  const [inspectingFiles, setInspectingFiles] = useState(false);

  const loadVideos = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) { setVideos([]); setJobs([]); return; }
    const response = await scopedFetch(`/api/videos?organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { videos: Video[]; jobs: Job[]; canWrite: boolean; service: ServiceStatus; queue: QueueStatus };
    setVideos(body.videos); setJobs(body.jobs); setCanWrite(body.canWrite); setService(body.service); setQueue(body.queue);
  }, []);

  const loadProjects = useCallback(async (orgId: string) => {
    const body = await loadClientProjects<Project>(orgId, "");
    setProjects(body.projects); const first = body.selected; setProjectId(first); rememberCurrentScope(orgId, first); await loadVideos(orgId, first);
  }, [loadVideos]);

  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const first = preferredOrganizationId(body.organizations); setOrganizationId(first); if (first) await loadProjects(first); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [loadProjects]);
  useEffect(() => {
    if (!organizationId || !projectId) return;
    const timer = window.setInterval(() => { void loadVideos(organizationId, projectId).catch(() => undefined); }, 4_000);
    return () => window.clearInterval(timer);
  }, [loadVideos, organizationId, projectId]);

  function appendCreated(body: { video: Video; job: Job }) { setVideos((current) => [body.video, ...current]); setJobs((current) => [body.job, ...current]); }

  async function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setError(""); setSubmitMessage(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      const response = await scopedFetch("/api/videos/from-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, url: form.get("url"), title: form.get("title"), analysisProfile }) });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { video: Video; job: Job; reused?: boolean }; appendCreated(body); formElement.reset();
      setSubmitMessage(body.reused ? "该视频已有分析记录，已直接复用到当前项目。" : "分析已经开始。页面会自动更新进度，完成后可直接查看结果。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "链接入库失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  }

  async function updateDouyinCookies(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget; const file = input.files?.[0]; if (!file) return;
    setCookieUpdating(true); setCookieMessage(""); setError("");
    try {
      if (file.size > 1024 * 1024) throw new Error("Cookie 文件不能超过 1 MB。");
      const form = new FormData(); form.set("file", file);
      const response = await scopedFetch("/api/analyzer/cookies", { method: "POST", headers: { "x-organization-id": organizationId, "x-project-id": projectId }, body: form });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { configured: boolean; updatedAt: string; cookieCount: number };
      setService((current) => current ? { ...current, publicLinkCookieConfigured: true, publicLinkAuthenticationMode: current.browserLoginDetected ? "browser" : "cookie_file", cookieUpdatedAt: body.updatedAt } : current);
      setCookieMessage(`Cookie 已更新，共导入 ${body.cookieCount} 条抖音记录。请删除下载目录中的原始 cookies.txt。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cookie 更新失败，请重新导出后再试。"); }
    finally { input.value = ""; setCookieUpdating(false); }
  }

  async function inspectUploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    setUploadEstimates([]);
    if (!files.length) return;
    setInspectingFiles(true);
    const estimates = await Promise.all(files.map(async (file) => ({ name: file.name, durationSeconds: await readMediaDuration(file) })));
    setUploadEstimates(estimates);
    setInspectingFiles(false);
  }

  async function deleteDouyinCookies() {
    if (!window.confirm(service?.browserLoginDetected ? "确定清除备用 Cookie 吗？后台抖音已登录，清除后仍可直接分析。" : "确定清除系统中保存的抖音 Cookie 吗？清除后需要登录后台抖音或重新上传 Cookie。")) return;
    setCookieDeleting(true); setCookieMessage(""); setError("");
    try {
      const response = await scopedFetch("/api/analyzer/cookies", { method: "DELETE", headers: { "x-organization-id": organizationId, "x-project-id": projectId } });
      if (!response.ok) throw new Error(await readError(response));
      setService((current) => current ? { ...current, publicLinkCookieConfigured: current.browserLoginDetected, publicLinkAuthenticationMode: current.browserLoginDetected ? "browser" : "none", cookieUpdatedAt: null } : current);
      setCookieMessage("系统中保存的抖音 Cookie 已清除。浏览器下载目录中的原始 cookies.txt 受系统保护，请手动删除。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cookie 清除失败，请稍后再试。"); }
    finally { setCookieDeleting(false); }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setError(""); setUploadProgress(""); const formElement = event.currentTarget; const fileInput = formElement.elements.namedItem("file") as HTMLInputElement | null; const files = Array.from(fileInput?.files ?? []);
    if (!files.length) { setError("请选择至少一个视频或音频文件。"); setSubmitting(false); return; }
    let completed = 0; const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      setUploadProgress(`正在上传 ${index + 1} / ${files.length}：${file.name}`);
      try {
        const form = new FormData(); form.set("file", file); form.set("analysisProfile", analysisProfile);
        const response = await scopedFetch("/api/videos/upload", { method: "POST", headers: { "x-organization-id": organizationId, "x-project-id": projectId }, body: form });
        if (!response.ok) failures.push(`${file.name}：${await readError(response)}`); else { appendCreated(await response.json()); completed += 1; }
      } catch (reason) { failures.push(`${file.name}：${reason instanceof Error ? reason.message : "网络请求失败"}`); }
    }
    if (completed) { formElement.reset(); setUploadEstimates([]); }
    setUploadProgress(`批量上传完成：成功 ${completed} 个，失败 ${failures.length} 个。`);
    if (failures.length) setError(failures.join("；")); setSubmitting(false);
  }

  async function retry(jobId: string, segmentKey?: string) {
    setError(""); setJobActionId(jobId);
    try {
      const response = await scopedFetch(`/api/analysis-jobs/${jobId}/retry`, { method: "POST", ...(segmentKey ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ segmentKey }) } : {}) });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { job: Job };
      setJobs((current) => current.map((job) => job.id === jobId ? { ...job, ...body.job } : job));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "任务重试失败，请稍后再试。"); }
    finally { setJobActionId(""); }
  }

  async function cancelJob(jobId: string) {
    setError(""); setJobActionId(jobId);
    try {
      const response = await scopedFetch(`/api/analysis-jobs/${jobId}/cancel`, { method: "POST" });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { job: Job };
      setJobs((current) => current.map((job) => job.id === jobId ? { ...job, ...body.job } : job));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "任务取消失败，请稍后再试。"); }
    finally { setJobActionId(""); }
  }

  if (loading) return <div className="management-state" role="status">正在载入视频分析空间…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入视频分析</strong><p>{error}</p><small>请确认本地身份已启用，并先创建公司与企业空间。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>视频、媒体文件和分析结果必须归属于明确的企业空间。</p><a className="primary-button link-button" href="/projects">前往企业空间</a></div>;
  const visibleVideos = videos.filter((video) => initialView !== "assets" || jobs.some((job) => job.video_id === video.id && (job.status === "completed" || job.status === "partial")));
  const baseServiceReady = Boolean(service?.analyzerOnline && service.credentialConfigured && service.modelConfigured);
  const linkAnalysisReady = Boolean(baseServiceReady && service?.publicLinkCookieConfigured);
  const linkButtonLabel = submitting ? "正在启动分析…" : !service?.credentialConfigured ? "分析服务凭据未配置" : !service?.modelConfigured ? "请先配置分析模型" : !service?.analyzerOnline ? "分析服务未连接" : !service?.publicLinkCookieConfigured ? service?.browserLoginStatus === "checking" ? "正在检测抖音登录" : service?.browserLoginStatus === "disabled" ? "请先上传 Cookie" : "请登录抖音或上传 Cookie" : "一键开始分析";
  const profileBudget = analysisProfileBudgets[analysisProfile];
  const profileDescription = analysisProfile === "standard"
    ? "推荐用于日常分析：32k 来源、6k 最终报告、最多 6 个分段；保留亮点、画面、语言和节奏等必需模块。"
    : "用于重要样本：64k 来源、12k 最终报告、最多 12 个分段；关键帧更密集，并采用主体 + 专项双阶段合成。";
  const shortVideoMaximumTokens = estimateAnalysisMaximumTokens(0, analysisProfile);
  const knownUploadDuration = uploadEstimates.reduce((total, item) => total + (item.durationSeconds ?? 0), 0);
  const unknownUploadDurations = uploadEstimates.filter((item) => item.durationSeconds === null).length;
  const estimatedUploadTokens = uploadEstimates.some((item) => item.durationSeconds !== null)
    ? uploadEstimates.reduce((total, item) => total + (item.durationSeconds === null ? 0 : estimateMediaSourceTokens(item.durationSeconds, analysisProfile)), 0)
    : null;
  const maximumUploadTokens = uploadEstimates.some((item) => item.durationSeconds !== null)
    ? uploadEstimates.reduce((total, item) => total + (item.durationSeconds === null ? 0 : estimateAnalysisMaximumTokens(item.durationSeconds, analysisProfile)), 0)
    : null;
  const estimatedUploadFrames = uploadEstimates.some((item) => item.durationSeconds !== null)
    ? uploadEstimates.reduce((total, item) => total + (item.durationSeconds === null ? 0 : estimateRepresentativeFrames(item.durationSeconds, analysisProfile)), 0)
    : null;

  return <div className={`analysis-layout${initialView === "videos" ? "" : " single-view"}`}>
    <section className="analysis-main">
      <div className="management-toolbar analysis-toolbar"><label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadVideos(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button type="button" onClick={() => loadVideos(organizationId, projectId)}>刷新状态</button></div>
      {error && <div className="inline-alert" role="alert">{error}</div>}{submitMessage && <div className="analysis-submit-notice" role="status">{submitMessage}</div>}
      {initialView === "videos" && service && <article className="panel analysis-readiness"><div><p className="section-kicker">分析服务就绪状态 · 分析前自动检查</p><h2>{linkAnalysisReady ? service.publicLinkAuthenticationMode === "browser" ? "检测到分析主机抖音已登录，无需 Cookie" : "抖音链接一键分析已就绪" : !service.credentialConfigured ? "分析服务凭据尚未配置" : !service.modelConfigured ? "请先完成结构分析模型配置" : !service.analyzerOnline ? "分析服务没有连接，请重新启动" : service.browserLoginStatus === "checking" ? "正在检测分析主机抖音登录状态" : service.browserLoginStatus === "disabled" ? "浏览器检测未启用，请上传 Cookie" : service.browserLoginStatus === "unavailable" ? "分析主机 Edge 登录信息不可读，可上传 Cookie" : "分析主机抖音未登录，可上传 Cookie"}</h2></div><dl><div><dt>自动分析服务</dt><dd className={service.analyzerOnline ? "ready" : "waiting"}>{service.analyzerOnline ? "运行中" : service.modelConfigured ? "未连接" : "等待模型配置"}</dd></div><div><dt>结构分析模型</dt><dd className={service.modelConfigured ? "ready" : "waiting"}>{service.modelConfigured ? "已配置" : "待配置"}</dd></div><div><dt>抖音登录方式</dt><dd className={service.publicLinkCookieConfigured ? "ready" : "waiting"}>{service.publicLinkAuthenticationMode === "browser" ? "分析主机浏览器" : service.publicLinkAuthenticationMode === "cookie_file" ? "Cookie 文件" : "尚未连接"}</dd></div><div><dt>服务心跳</dt><dd>{service.lastWorkerHeartbeat ? new Date(service.lastWorkerHeartbeat).toLocaleTimeString("zh-CN") : "尚未连接"}</dd></div></dl><div className="analysis-readiness-actions">{service.canManageCookies && <><input ref={cookieFileRef} className="sr-only" type="file" accept=".txt,text/plain" onChange={updateDouyinCookies} disabled={cookieUpdating || cookieDeleting} aria-label="选择抖音 cookies.txt" /><button type="button" disabled={cookieUpdating || cookieDeleting} onClick={() => cookieFileRef.current?.click()}>{cookieUpdating ? "正在更新…" : service.cookieUpdatedAt ? "更新 Cookie" : service.browserLoginDetected ? "导入 Cookie（优先）" : "选择 Cookie 文件"}</button>{service.cookieUpdatedAt && <button className="danger-action" type="button" disabled={cookieUpdating || cookieDeleting} onClick={deleteDouyinCookies}>{cookieDeleting ? "正在清除…" : "清除 Cookie"}</button>}<a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noreferrer">获取导出扩展</a></>}<Link href="/settings">系统设置 →</Link></div></article>}      {cookieMessage && <div className="analysis-submit-notice" role="status">{cookieMessage}</div>}
      {initialView === "videos" && <article className="panel pipeline-panel"><div className="panel-heading"><div><p className="section-kicker">异步分析流水线</p><h2>网页请求只负责入库，计算任务分阶段执行</h2></div><span className="status neutral">可重试 · 可追溯</span></div><ol>{stages.map((stage, index) => <li key={stage}><span>{index + 1}</span><strong>{stage}</strong>{index < stages.length - 1 && <i aria-hidden="true" />}</li>)}</ol></article>}
      <article className="panel video-list-panel">
        <div className="panel-heading"><div><p className="section-kicker">{initialView === "benchmark" ? "对标样本" : initialView === "assets" ? "分析资产" : "视频与任务"}</p><h2>{initialView === "assets" ? `${visibleVideos.length} 条内容已生成可用资产` : `${videos.length} 条内容已进入当前项目`}</h2></div>{initialView === "videos" && queue && <span className="queue-baseline">{queue.sampleCount ? `参考最近 ${queue.sampleCount} 次耗时` : "完成首个任务后显示预计时间"}</span>}</div>
        {visibleVideos.length === 0 ? <div className="list-empty">{initialView === "assets" ? "当前项目还没有已完成分析的可用资产。" : "提交一条抖音链接或上传本地媒体，开始建立分析样本。"}</div> : <div className="analysis-list">{visibleVideos.map((video) => {
          const job = jobs.find((item) => item.video_id === video.id); const partial = job?.status === "partial"; const failed = job?.status === "failed" || job?.status === "cancelled"; const retryable = partial || failed; const active = Boolean(job && activeJobStatuses.has(job.status));
          const stale = Boolean(job && active && job.lease_expires_at && new Date(job.lease_expires_at).getTime() <= new Date(service?.checkedAt || 0).getTime()); const timing = job ? queueLabel(job, jobs, queue) : ""; const guidance = job ? guidanceForJob(job) : ""; const errorMessage = job ? visibleJobError(job) : "";
          // @ts-expect-error The conditional JSX branch guarantees `job` exists before reading resume_count.
          return <article className="analysis-row" key={video.id}><span className={`media-kind ${video.source_type}`}>{video.source_type === "url" ? "链" : "媒"}</span><div className="analysis-copy"><strong>{video.title || "待提取视频标题"}</strong><small>{video.is_reference ? "复用公司素材库分析" : video.source_type === "url" ? "抖音公开链接" : `${video.filename || "本地媒体"} · ${video.size_bytes ? `${(video.size_bytes / 1024 / 1024).toFixed(1)} MB` : ""}`}</small><div className="job-stage"><span>{stale ? "任务心跳已过期，可以恢复" : job?.current_stage || "等待任务创建"}</span>{job && <div className="progress-track small"><i style={{ width: `${job.progress}%` }} /></div>}</div>{(job?.checkpoint_stage === "evidence_ready" || job?.checkpoint_stage === "segment_progress") && !["completed", "partial"].includes(job.status) && <small className="job-checkpoint">已保存分析检查点 · 重试会跳过已完成分段</small>}{job?.segment_progress && !["completed", "partial"].includes(job.status) && <small className="job-checkpoint">长视频分段：已完成 {job.segment_progress.completed} / {job.segment_progress.total} · 剩余 {job.segment_progress.remaining}{job.segment_progress.failed ? ` · 失败 ${job.segment_progress.failed}` : ""}</small>}{timing && !stale && <small className="job-timing">{timing}</small>}{errorMessage && <p>{errorMessage}</p>}{guidance && <p className="job-guidance"><strong>处理建议：</strong>{guidance}</p>}</div><div className="analysis-status"><span className={`status ${failed || stale ? "danger" : partial ? "warning" : job?.status === "completed" ? "success" : "neutral"}`}>{stale ? "待恢复" : statusLabels[job?.status || "pending"] || job?.status}</span><small>{job?.progress || 0}%</small>{job && <small className="job-profile">{profileLabels[job.analysis_profile || "standard"] || "历史模式"}</small>}{job?.resume_count > 0 && <small>已续跑 {job.resume_count} 次</small>}{(job?.status === "completed" || job?.status === "partial") && <Link href={`/analysis/${video.id}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>{initialView === "assets" ? "查看资产" : "查看结果"}</Link>}{job?.error_code && ["DOUYIN_COOKIE_EXPIRED", "DOUYIN_ACCESS_REJECTED", "DOUYIN_BROWSER_UNAVAILABLE", "DOUYIN_COOKIE_INVALID"].includes(job.error_code) && service?.canManageCookies && <button type="button" disabled={cookieUpdating} onClick={() => cookieFileRef.current?.click()}>更新 Cookie</button>}{stale && job && canWrite && !video.is_reference && <button type="button" disabled={jobActionId === job.id} onClick={() => retry(job.id)}>{(job.checkpoint_stage === "evidence_ready" || job.checkpoint_stage === "segment_progress") ? "从检查点继续" : "恢复"}</button>}{retryable && job && canWrite && !video.is_reference && <button type="button" disabled={jobActionId === job.id} onClick={() => retry(job.id)}>{(job.checkpoint_stage === "evidence_ready" || job.checkpoint_stage === "segment_progress") ? "从检查点继续" : "重试"}</button>}{(retryable || stale) && job && canWrite && !video.is_reference && job.segment_progress?.segments.filter((segment) => segment.status !== "completed").map((segment) => <button key={`${job.id}-${segment.windowKey}`} type="button" disabled={jobActionId === job.id} onClick={() => retry(job.id, segment.windowKey)}>重试第 {segment.index} 段</button>)}{active && !stale && job && canWrite && !video.is_reference && <button type="button" disabled={jobActionId === job.id} onClick={() => cancelJob(job.id)}>取消</button>}</div></article>;
        })}</div>}
      </article>
    </section>
    {canWrite && initialView === "videos" && <aside className="analysis-ingest"><article className="analysis-profile-panel"><label>分析档位<select value={analysisProfile} onChange={(event) => updateAnalysisProfile(event.target.value as AnalysisProfile)}><option value="standard">标准模式 · 推荐</option><option value="max">最高能力模式</option></select></label><p>{profileDescription}</p><div className="analysis-preflight-budget" aria-live="polite"><span>来源文本上限 <strong>{profileBudget.sourceTokens.toLocaleString()} Token</strong></span><span>最终报告上限 <strong>{profileBudget.outputTokens.toLocaleString()} Token</strong></span><span>最多分段 <strong>{analysisProfileSegmentLimits[analysisProfile]} 段</strong></span><span>10 分钟代表帧约 <strong>{estimateRepresentativeFrames(600, analysisProfile)} 张</strong></span><span>短视频总预算上限约 <strong>{shortVideoMaximumTokens.toLocaleString()} Token</strong></span></div></article><article className="create-panel"><p className="section-kicker">一键链接分析</p><h2>粘贴分享文案即可开始</h2><p>抖音链接需解析后才能取得时长；30 分钟以上会自动分段并汇总，报告会记录实际时长、调用次数和用量。</p><form className="stack-form" onSubmit={submitUrl}><label>抖音分享文案或链接<textarea name="url" required rows={4} maxLength={2000} placeholder="粘贴完整分享文案，或 https://v.douyin.com/..." /></label><label>内部备注（可选）<input name="title" maxLength={120} placeholder="例如：管理者选题参考" /></label><button className="primary-button" disabled={submitting || !linkAnalysisReady}>{linkButtonLabel}</button></form></article><article className="create-panel upload-panel"><p className="section-kicker">批量本地上传</p><h2>上传视频或音频</h2><p>选择文件后会先读取本地媒体时长并估算 Token；不会上传文件内容进行预检。单文件上限 50 MB。</p><form className="stack-form" onSubmit={uploadFile}><label className="file-drop">选择一个或多个媒体文件<input name="file" type="file" multiple required accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav" onChange={inspectUploadFiles} /><span>MP4、MOV、WebM、MP3、M4A、WAV</span></label>{(inspectingFiles || uploadEstimates.length > 0) && <div className="upload-cost-estimate" role="status"><strong>{inspectingFiles ? "正在读取媒体时长…" : `${uploadEstimates.length} 个文件 · ${knownUploadDuration > 0 ? durationLabel(knownUploadDuration) : "时长暂不可读"}`}</strong>{!inspectingFiles && <span>{estimatedUploadTokens !== null ? `本批来源预计约 ${estimatedUploadTokens.toLocaleString()} Token` : `将按${profileLabels[analysisProfile]}策略逐个任务保护`}{maximumUploadTokens !== null ? ` · 总预算上限约 ${maximumUploadTokens.toLocaleString()}` : ""}{estimatedUploadFrames !== null ? ` · 代表帧约 ${estimatedUploadFrames.toLocaleString()} 张` : ""}{unknownUploadDurations ? ` · ${unknownUploadDurations} 个文件将在后台确认时长` : ""}</span>}{knownUploadDuration >= 1_800 && <em>检测到 30 分钟以上媒体，将自动分段分析后汇总；输出总量仍受所选档位上限保护。</em>}</div>}<button className="secondary-button" disabled={submitting || inspectingFiles || !baseServiceReady}>{submitting ? "正在批量上传…" : inspectingFiles ? "正在估算…" : baseServiceReady ? "上传并自动分析" : "分析服务准备中…"}</button>{uploadProgress && <p className="upload-progress" role="status">{uploadProgress}</p>}</form></article></aside>}
  </div>;
}

export function AnalysisWorkspace({ initialView = "videos" }: { initialView?: "videos" | "benchmark" | "assets" }) {
  return initialView === "videos" ? <VideoAnalysisWorkspace initialView="videos" /> : <VideoLibraryWorkspace mode={initialView} />;
}
