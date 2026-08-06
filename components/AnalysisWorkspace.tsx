"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Video = { id: string; platform: string; source_type: string; source_url: string | null; title: string | null; status: string; error_message: string | null; created_at: string; filename?: string | null; size_bytes?: number | null };
type Job = { id: string; video_id: string; status: string; progress: number; current_stage: string | null; error_code: string | null; error_message: string | null; retry_count: number; created_at: string; updated_at: string };
type ServiceStatus = { credentialConfigured: boolean; modelConfigured: boolean; publicLinkCookieConfigured: boolean; lastWorkerHeartbeat: string | null };

const stages = ["媒体入库", "音频处理", "语音转写", "字幕与关键帧", "结构化分析", "生成报告"];
const statusLabels: Record<string, string> = { pending: "等待中", queued: "已排队", downloading: "获取媒体", processing: "处理媒体", transcribing: "语音转写", extracting: "提取画面", analyzing: "结构分析", completed: "已完成", failed: "失败", cancelled: "已取消" };

async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求没有完成，请稍后重试。"; }

export function AnalysisWorkspace({ initialView = "videos" }: { initialView?: "videos" | "benchmark" | "assets" }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [videos, setVideos] = useState<Video[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const [service, setService] = useState<ServiceStatus | null>(null); const [uploadProgress, setUploadProgress] = useState("");

  const loadVideos = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) { setVideos([]); setJobs([]); return; }
    const response = await fetch(`/api/videos?organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { videos: Video[]; jobs: Job[]; canWrite: boolean; service: ServiceStatus };
    setVideos(body.videos); setJobs(body.jobs); setCanWrite(body.canWrite); setService(body.service);
  }, []);

  const loadProjects = useCallback(async (orgId: string) => {
    const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { projects: Project[] };
    setProjects(body.projects); const first = preferredProjectId(body.projects); setProjectId(first); rememberCurrentScope(orgId, first); await loadVideos(orgId, first);
  }, [loadVideos]);

  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const first = preferredOrganizationId(body.organizations); setOrganizationId(first); if (first) await loadProjects(first); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [loadProjects]);

  function appendCreated(body: { video: Video; job: Job }) { setVideos((current) => [body.video, ...current]); setJobs((current) => [body.job, ...current]); }

  async function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      const response = await fetch("/api/videos/from-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, url: form.get("url"), title: form.get("title") }) });
      if (!response.ok) { setError(await readError(response)); return; }
      appendCreated(await response.json()); formElement.reset();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "链接入库失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setError(""); setUploadProgress(""); const formElement = event.currentTarget; const fileInput = formElement.elements.namedItem("file") as HTMLInputElement | null; const files = Array.from(fileInput?.files ?? []);
    if (!files.length) { setError("请选择至少一个视频或音频文件。"); setSubmitting(false); return; }
    let completed = 0; const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      setUploadProgress(`正在上传 ${index + 1} / ${files.length}：${file.name}`);
      try {
        const form = new FormData(); form.set("file", file);
        const response = await fetch("/api/videos/upload", { method: "POST", headers: { "x-organization-id": organizationId, "x-project-id": projectId }, body: form });
        if (!response.ok) failures.push(`${file.name}：${await readError(response)}`); else { appendCreated(await response.json()); completed += 1; }
      } catch (reason) { failures.push(`${file.name}：${reason instanceof Error ? reason.message : "网络请求失败"}`); }
    }
    if (completed) formElement.reset();
    setUploadProgress(`批量上传完成：成功 ${completed} 个，失败 ${failures.length} 个。`);
    if (failures.length) setError(failures.join("；")); setSubmitting(false);
  }

  async function retry(jobId: string) {
    setError("");
    try {
      const response = await fetch(`/api/analysis-jobs/${jobId}/retry`, { method: "POST" });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { job: Job };
      setJobs((current) => current.map((job) => job.id === jobId ? { ...job, ...body.job } : job));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "任务重试失败，请稍后再试。"); }
  }

  if (loading) return <div className="management-state" role="status">正在载入视频分析空间…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入视频分析</strong><p>{error}</p><small>请确认本地身份已启用，并先创建公司与客户项目。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><span aria-hidden="true">▷</span><h2>请先创建客户项目</h2><p>视频、媒体文件和分析结果必须归属于明确的客户项目。</p><a className="primary-button link-button" href="/projects">前往客户项目</a></div>;
  const visibleVideos = videos.filter((video) => initialView !== "assets" || jobs.some((job) => job.video_id === video.id && job.status === "completed"));

  return <div className={`analysis-layout${initialView === "videos" ? "" : " single-view"}`}>
    <section className="analysis-main">
      <div className="management-toolbar analysis-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>客户项目<select value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadVideos(organizationId, id); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button type="button" onClick={() => loadVideos(organizationId, projectId)}>刷新状态</button></div>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {initialView === "videos" && service && <article className="panel analysis-readiness"><div><p className="section-kicker">分析服务就绪状态</p><h2>{service.credentialConfigured && service.modelConfigured ? "配置已就绪" : "仍需完成服务配置"}</h2></div><dl><div><dt>服务令牌</dt><dd className={service.credentialConfigured ? "ready" : "waiting"}>{service.credentialConfigured ? "已配置" : "待配置"}</dd></div><div><dt>结构分析模型</dt><dd className={service.modelConfigured ? "ready" : "waiting"}>{service.modelConfigured ? "已配置" : "待配置"}</dd></div><div><dt>抖音链接 Cookie</dt><dd className={service.publicLinkCookieConfigured ? "ready" : "waiting"}>{service.publicLinkCookieConfigured ? "已配置" : "未配置（仍可上传）"}</dd></div><div><dt>最近任务心跳</dt><dd>{service.lastWorkerHeartbeat ? new Date(service.lastWorkerHeartbeat).toLocaleString("zh-CN") : "尚无记录"}</dd></div></dl><Link href="/settings">查看系统设置 →</Link></article>}
      {initialView === "videos" && <article className="panel pipeline-panel"><div className="panel-heading"><div><p className="section-kicker">异步分析流水线</p><h2>网页请求只负责入库，计算任务分阶段执行</h2></div><span className="status neutral">可重试 · 可追溯</span></div><ol>{stages.map((stage, index) => <li key={stage}><span>{index + 1}</span><strong>{stage}</strong>{index < stages.length - 1 && <i aria-hidden="true" />}</li>)}</ol></article>}
      <article className="panel video-list-panel"><div className="panel-heading"><div><p className="section-kicker">{initialView === "benchmark" ? "对标样本" : initialView === "assets" ? "分析资产" : "视频与任务"}</p><h2>{initialView === "assets" ? `${visibleVideos.length} 条内容已生成可用资产` : `${videos.length} 条内容已进入当前项目`}</h2></div></div>{visibleVideos.length === 0 ? <div className="list-empty">{initialView === "assets" ? "当前项目还没有已完成分析的可用资产。" : "提交一条抖音链接或上传本地媒体，开始建立分析样本。"}</div> : <div className="analysis-list">{visibleVideos.map((video) => { const job = jobs.find((item) => item.video_id === video.id); const failed = job?.status === "failed" || job?.status === "cancelled"; return <article className="analysis-row" key={video.id}><span className={`media-kind ${video.source_type}`}>{video.source_type === "url" ? "链" : "媒"}</span><div className="analysis-copy"><strong>{video.title || "待提取视频标题"}</strong><small>{video.source_type === "url" ? "抖音公开链接" : `${video.filename || "本地媒体"} · ${video.size_bytes ? `${(video.size_bytes / 1024 / 1024).toFixed(1)} MB` : ""}`}</small><div className="job-stage"><span>{job?.current_stage || "等待任务创建"}</span>{job && <div className="progress-track small"><i style={{ width: `${job.progress}%` }} /></div>}</div>{job?.error_message && <p>{job.error_message}</p>}</div><div className="analysis-status"><span className={`status ${failed ? "danger" : job?.status === "completed" ? "success" : "neutral"}`}>{statusLabels[job?.status || "pending"] || job?.status}</span><small>{job?.progress || 0}%</small>{job?.status === "completed" && <Link href={`/analysis/${video.id}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>{initialView === "assets" ? "查看资产" : "查看结果"}</Link>}{failed && job && canWrite && <button type="button" onClick={() => retry(job.id)}>重试</button>}</div></article>; })}</div>}</article>
    </section>
    {canWrite && initialView === "videos" && <aside className="analysis-ingest"><article className="create-panel"><p className="section-kicker">链接入库</p><h2>添加抖音公开内容</h2><p>仅登记公开 HTTPS 链接。媒体获取、转写和模型分析不会在网页请求中同步执行。</p><form className="stack-form" onSubmit={submitUrl}><label>抖音链接<input name="url" type="url" required placeholder="https://v.douyin.com/..." /></label><label>内部备注（可选）<input name="title" maxLength={120} placeholder="例如：管理者选题参考" /></label><button className="primary-button" disabled={submitting}>{submitting ? "正在入库…" : "创建分析任务"}</button></form></article><article className="create-panel upload-panel"><p className="section-kicker">批量本地上传</p><h2>上传视频或音频</h2><p>可一次选择多个文件，系统会依次上传并分别创建任务；单文件上限 50 MB。</p><form className="stack-form" onSubmit={uploadFile}><label className="file-drop">选择一个或多个媒体文件<input name="file" type="file" multiple required accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav" /><span>MP4、MOV、WebM、MP3、M4A、WAV</span></label><button className="secondary-button" disabled={submitting}>{submitting ? "正在批量上传…" : "上传并创建任务"}</button>{uploadProgress && <p className="upload-progress" role="status">{uploadProgress}</p>}</form></article></aside>}
  </div>;
}
