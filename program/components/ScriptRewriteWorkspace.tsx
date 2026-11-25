"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError, formatClientDate as dateLabel } from "../lib/client-format";
import type { ProductionPack } from "../lib/content-production";
import { RecordSidebar, RecordSidebarItem } from "./RecordSidebar";
import { SplitWorkspace } from "./SplitWorkspace";
import { studioHref } from "../lib/studio-links";
import { isScopeCancellation } from "../lib/client-scope-request";


import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRewriteTokenUsage, partitionScriptRewriteFailures, SCRIPT_REWRITE_MAX_CHARACTERS, type RewriteValidationCheck, type ScriptRewriteVariant } from "../lib/script-rewrite";
import { preferredOrganizationId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { estimateAdaptedRewriteUsage, type RewriteAdaptationOptions, type RewriteAdaptationSnapshot } from "../lib/script-rewrite-options";
import type { RewriteBrandContext } from "../lib/script-rewrite-brand";
import { RewriteBrandPanel, RewriteBrandRecord, brandModeLabels, type RewriteBrandSettings } from "./RewriteBrandPanel";
import "./analysis-cleanup.css";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type WorkspaceRow = { id: string; title: string; source_type: string; source_label: string; source_character_count: number; source_video_id: string | null; status: string; version_count: number; latest_variant: string | null; latest_run_status: string | null; created_at: string; updated_at: string };
type VideoSource = { id: string; title: string; createdAt: string; available: boolean; sourceLabel: string; sourceCharacters: number; preview: string; transcriptId: string | null; transcriptVersion: number | null; analysisId: string | null };
type RewriteVersion = { id: string; version: number; variant: "source" | "light_rewrite" | "restructured" | "manual"; parentVersionId: string | null; runId: string | null; text: string; paragraphs: string[]; sourceMapping: string[]; outline: Array<{ sectionId: string; title: string; role: string; factIds?: string[]; sourceParagraphIds: string[] }>; validation: { passed?: boolean; checks?: RewriteValidationCheck[]; effectiveChangeCoveragePercent?: number; changedParagraphPercent?: number; textSimilarity?: number; sequenceSimilarity?: number }; modelProvider: string | null; modelName: string | null; promptVersion: string | null; modelCallId: string | null; changeSummary: string | null; createdAt: string; draftId?: string | null; adaptation?: RewriteAdaptationSnapshot | null };
type RewriteRun = { id: string; variant: ScriptRewriteVariant; status: "started" | "completed" | "failed"; sourceVersionId: string; resultVersionId: string | null; retryOfRunId: string | null; estimatedCallCount: number; estimatedInputTokens: number; maximumOutputTokens: number; actualInputTokens: number; actualOutputTokens: number; actualTotalTokens: number; unknownRequestCount: number | null; modelCallId: string | null; promptVersion: string; validation: { passed?: boolean; checks?: RewriteValidationCheck[]; issues?: string[] }; errorCode: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null; adaptation?: RewriteAdaptationSnapshot | null };
type RewriteDetail = { workspace: { id: string; title: string; sourceType: "pasted" | "video"; sourceVideoId: string | null; sourceTranscriptId: string | null; sourceTranscriptVersion: number | null; sourceAnalysisId: string | null; sourceLabel: string; sourceText: string; sourceHash: string; sourceCharacters: number; createdAt: string; updatedAt: string }; versions: RewriteVersion[]; runs: RewriteRun[]; canWrite: boolean; brandKnowledge?: RewriteBrandContext | null };
type GenerationConfirmation = {
  workspaceId: string;
  variants: ScriptRewriteVariant[];
  retryOfRunId: string;
  adaptation: RewriteAdaptationOptions | null;
  targetName: string | null;
  estimate: ReturnType<typeof estimateAdaptedRewriteUsage>;
};

const variantNames: Record<string, string> = { source: "来源快照", light_rewrite: "微调同构", restructured: "内容等价重构", manual: "人工编辑" };


function numberLabel(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }

function safeFilename(value: string) { return value.replace(/[<>:"/\\|?*]/g, "-").trim().slice(0, 60) || "口播改写"; }
function downloadText(filename: string, value: string) { const url = URL.createObjectURL(new Blob([value], { type: "text/markdown;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }

function ChangedText({ source, result }: { source: string; result: string }) {
  if (source === result) return <>{result}</>;
  let prefix = 0; const maximumPrefix = Math.min(source.length, result.length);
  while (prefix < maximumPrefix && source[prefix] === result[prefix]) prefix += 1;
  let suffix = 0; const maximumSuffix = Math.min(source.length - prefix, result.length - prefix);
  while (suffix < maximumSuffix && source[source.length - 1 - suffix] === result[result.length - 1 - suffix]) suffix += 1;
  const end = suffix ? result.length - suffix : result.length;
  return <>{result.slice(0, prefix)}<mark>{result.slice(prefix, end)}</mark>{suffix ? result.slice(end) : ""}</>;
}

export function ScriptRewriteWorkspace({ initialOrganizationId = "", initialProjectId = "", initialRewriteId = "", initialVersionId = "",
  returnContentId = "", returnContentVersion = 0, legacyImport = false }: {
  initialOrganizationId?: string; initialProjectId?: string; initialRewriteId?: string; initialVersionId?: string;
  returnContentId?: string; returnContentVersion?: number; legacyImport?: boolean;
}) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]); const [videos, setVideos] = useState<VideoSource[]>([]); const [canWrite, setCanWrite] = useState(false);
  const [rewriteId, setRewriteId] = useState(""); const [detail, setDetail] = useState<RewriteDetail | null>(null); const [selectedVersionId, setSelectedVersionId] = useState("");
  const [sourceMode, setSourceMode] = useState<"pasted" | "video">("pasted"); const [sourceText, setSourceText] = useState(""); const [sourceVideoId, setSourceVideoId] = useState(""); const [title, setTitle] = useState("");
  const [variants, setVariants] = useState<ScriptRewriteVariant[]>([]); const [editing, setEditing] = useState(false); const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false); const [generating, setGenerating] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [generationConfirmation, setGenerationConfirmation] = useState<GenerationConfirmation | null>(null);
  const [briefDraft, setBriefDraft] = useState<{ workspaceId: string; settings: RewriteBrandSettings } | null>(null);
  const detailRequest = useRef(0);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const [refreshingBrand, setRefreshingBrand] = useState(false);

  const scopeQuery = useCallback((orgId: string, projId: string) => `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`, []);
  const loadDetail = useCallback(async (orgId: string, projId: string, id: string, preferredVersionId = "") => {
    const requestNumber = ++detailRequest.current;
    if (!id) { setDetail(null); setSelectedVersionId(""); return; }
    const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(id)}?${scopeQuery(orgId, projId)}`);
    if (!response.ok) { const error = await readError(response); if (requestNumber === detailRequest.current) throw new Error(error); return; }
    const body = await response.json() as RewriteDetail;
    if (requestNumber !== detailRequest.current) return;
    setDetail(body); setVariants([]);
    const selected = body.versions.some((item) => item.id === preferredVersionId) ? preferredVersionId : body.versions.find((item) => item.variant !== "source")?.id ?? body.versions[0]?.id ?? "";
    setSelectedVersionId(selected); setEditing(false); setEditText("");
  }, [scopeQuery]);

  const loadWorkspace = useCallback(async (orgId: string, projId: string, preferredRewriteId = "", preferredVersionId = "") => {
    if (!orgId || !projId) { setWorkspaces([]); setVideos([]); setDetail(null); return; }
    const response = await scopedFetch(`/api/script-rewrites?${scopeQuery(orgId, projId)}&rewriteId=${encodeURIComponent(preferredRewriteId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { workspaces: WorkspaceRow[]; videos: VideoSource[]; canWrite: boolean };
    setWorkspaces(body.workspaces); setVideos(body.videos); setCanWrite(body.canWrite);
    const selected = body.workspaces.some((item) => item.id === preferredRewriteId) ? preferredRewriteId : body.workspaces[0]?.id ?? "";
    setRewriteId(selected); await loadDetail(orgId, projId, selected, selected === preferredRewriteId ? preferredVersionId : "");
  }, [loadDetail, scopeQuery]);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred); setProjects(body.projects);
    const selected = body.selected; setProjectId(selected); rememberCurrentScope(orgId, selected);
    const isLinkedScope = orgId === initialOrganizationId && selected === initialProjectId;
    await loadWorkspace(orgId, selected, isLinkedScope ? initialRewriteId : "", isLinkedScope ? initialVersionId : "");
  }, [loadWorkspace, initialOrganizationId, initialProjectId, initialRewriteId, initialVersionId]);

  useEffect(() => {
    let active = true;
    scopedFetch("/api/organizations").then(async (response) => { if (!response.ok) throw new Error(await readError(response)); return response.json() as Promise<{ organizations: Organization[] }> }).then(async (body) => {
      if (!active) return; setOrganizations(body.organizations); const selected = preferredOrganizationId(body.organizations, initialOrganizationId); setOrganizationId(selected); await loadProjects(selected, initialProjectId);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "工作台载入失败。") }).finally(() => { if (active) setLoading(false) });
    return () => { active = false; };
  }, [initialOrganizationId, initialProjectId, loadProjects]);

  useEffect(() => {
    if (!generationConfirmation) return;
    const modal = confirmationDialog.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const dismissBackdrop = (event: MouseEvent) => {
      if (event.target === modal) setGenerationConfirmation(null);
    };
    modal?.addEventListener("mousedown", dismissBackdrop);
    modal?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      modal?.removeEventListener("mousedown", dismissBackdrop);
      if (modal?.open) modal.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [generationConfirmation]);

  const selectedVideo = videos.find((item) => item.id === sourceVideoId) ?? null;
  const selectedVersion = detail?.versions.find((item) => item.id === selectedVersionId) ?? detail?.versions[0] ?? null;
  const selectedRun = selectedVersion?.runId ? detail?.runs.find((item) => item.id === selectedVersion.runId) ?? null : null;
  const sourceParagraphs = detail?.versions.find((item) => item.variant === "source")?.paragraphs ?? detail?.workspace.sourceText.split(/\n\s*\n/).filter(Boolean) ?? [];
  const knowledge = detail?.brandKnowledge ?? null;
  const versionBrandChanged = selectedVersion?.adaptation?.mode === "current_brand" && !!knowledge &&
    selectedVersion.adaptation.brandStamp !== knowledge.stamp;
  const settings: RewriteBrandSettings = detail && briefDraft?.workspaceId === detail.workspace.id ? briefDraft.settings : {
    mode: knowledge?.targetName ? "current_brand" : "preserve", goal: "", audience: "", scenario: "",
  };
  const brandReady = settings.mode !== "current_brand" || Boolean(knowledge?.targetName && knowledge.stamp);
  const estimate = useMemo(() => detail ? estimateAdaptedRewriteUsage(detail.workspace.sourceText, variants, settings.mode) : null, [detail, variants, settings.mode]);
  const { unresolved: failedRuns, historical: historicalFailedRuns } = partitionScriptRewriteFailures(detail?.runs ?? []);

  async function refreshBrandKnowledge() {
    if (!detail || refreshingBrand) return;
    const id = detail.workspace.id;
    const requestNumber = detailRequest.current;
    setRefreshingBrand(true);
    setError("");
    try {
      const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(id)}?${scopeQuery(organizationId, projectId)}`);
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as RewriteDetail;
      if (requestNumber === detailRequest.current) {
        setDetail(current => current?.workspace.id === id ? { ...current, brandKnowledge: body.brandKnowledge, canWrite: body.canWrite } : current);
      }
    } catch (reason) {
      if (requestNumber === detailRequest.current && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "品牌资料刷新失败。");
    } finally { setRefreshingBrand(false); }
  }

  async function openDraft() {
    if (!detail || !selectedVersion || selectedVersion.variant === "source" || drafting) return;
    const draftUrl = (contentId: string) => studioHref("drafts", { organizationId, projectId, contentId });
    if (selectedVersion.draftId) { window.location.assign(draftUrl(selectedVersion.draftId)); return; }
    if (!detail.canWrite || editing || versionBrandChanged) return;
    setDrafting(true);
    setError("");
    try {
      const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(detail.workspace.id)}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, versionId: selectedVersion.id }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const { contentId } = await response.json() as { contentId: string };
      window.location.assign(draftUrl(contentId));
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "稿件创建失败。");
    } finally {
      setDrafting(false);
    }
  }

  async function selectWorkspace(id: string) {
    if (id === rewriteId && detail) return;
    setDetail(null);
    setGenerationConfirmation(null);
    setRewriteId(id);
    setError("");
    setMessage("");
    try {
      await loadDetail(organizationId, projectId, id);
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "详情载入失败。");
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreating(true); setError(""); setMessage("");
    try {
      const response = await scopedFetch("/api/script-rewrites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, sourceType: sourceMode, sourceText, videoId: sourceVideoId, title }) });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { workspace: { id: string } }; setSourceText(""); setTitle(""); setMessage("来源快照已保存；尚未调用任何改写模型。"); await loadWorkspace(organizationId, projectId, body.workspace.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区创建失败。"); } finally { setCreating(false); }
  }

  function toggleVariant(variant: ScriptRewriteVariant) { setVariants((current) => current.includes(variant) ? current.filter((item) => item !== variant) : [...current, variant]); }

  function requestGeneration(selectedVariants = variants, retryOfRunId = "") {
    if (!detail || !selectedVariants.length || generating) return;
    const run = retryOfRunId ? detail.runs.find(item => item.id === retryOfRunId) : null;
    if (retryOfRunId && !run || !retryOfRunId && !brandReady) return;
    const adaptation = run ? run.adaptation ?? null : {
      ...settings, goal: settings.goal.trim(), audience: settings.audience.trim(), scenario: settings.scenario.trim(),
      ...(settings.mode === "current_brand" && knowledge ? { brandStamp: knowledge.stamp } : {}),
    };
    setGenerationConfirmation({
      workspaceId: detail.workspace.id,
      variants: [...selectedVariants], retryOfRunId, adaptation,
      targetName: run ? run.adaptation?.targetName ?? null : knowledge?.targetName ?? null,
      estimate: estimateAdaptedRewriteUsage(detail.workspace.sourceText, selectedVariants, adaptation?.mode ?? null),
    });
  }

  async function generate(confirmation: GenerationConfirmation) {
    const { variants: selectedVariants, retryOfRunId, adaptation } = confirmation;
    if (!detail || detail.workspace.id !== confirmation.workspaceId || !selectedVariants.length) return;
    setGenerating(true); setError(""); setMessage("");
    try {
      const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(detail.workspace.id)}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, variants: selectedVariants, ...(retryOfRunId ? { retryOfRunId } : { adaptation }) }) });
      const body = await response.json().catch(() => null) as { results?: Array<{ status: string; versionId?: string; error?: { code?: string; message?: string } }> ; error?: { code?: string; message?: string } } | null;
      if (!response.ok) {
        if (["REWRITE_BRAND_CHANGED", "REWRITE_BRAND_REQUIRED"].includes(body?.error?.code ?? "")) {
          await loadDetail(organizationId, projectId, detail.workspace.id, selectedVersionId);
          setVariants(selectedVariants);
        }
        setError(body?.error?.message ?? "改写生成失败。");
        return;
      }
      const completed = body?.results?.filter((item) => item.status === "completed") ?? []; const failed = body?.results?.filter((item) => item.status === "failed") ?? [];
      setMessage(failed.length ? `${completed.length} 个版本生成成功，${failed.length} 个版本失败。` : `${completed.length} 个版本生成完成。`);
      if (failed.length) setError([...new Set(failed.map(item => item.error?.message || "改写未完成，请查看失败运行记录。"))].join("\n"));
      if (failed.some(item => item.error?.code === "REWRITE_ACCESS_CHANGED")) {
        setCanWrite(false); setDetail(current => current ? { ...current, canWrite: false } : current); return;
      }
      await loadWorkspace(organizationId, projectId, detail.workspace.id); if (completed[0]?.versionId) await loadDetail(organizationId, projectId, detail.workspace.id, completed[0].versionId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "改写生成失败。"); } finally { setGenerating(false); }
  }

  async function saveManualVersion() {
    if (!detail || !selectedVersion) return; setSaving(true); setError("");
    try {
      const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(detail.workspace.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, parentVersionId: selectedVersion.id, text: editText, changeSummary: `基于 v${selectedVersion.version} 人工编辑` }) });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { version: { id: string } }; setMessage("人工编辑已保存为新版本，原版本保持不变。"); await loadWorkspace(organizationId, projectId, detail.workspace.id); await loadDetail(organizationId, projectId, detail.workspace.id, body.version.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "人工版本保存失败。"); } finally { setSaving(false); }
  }

  const editingOriginalDraft = Boolean(returnContentId && returnContentVersion > 0 && organizationId === initialOrganizationId
    && projectId === initialProjectId && detail?.workspace.id === initialRewriteId);
  async function savePolishedDraft() {
    if (!editingOriginalDraft || !detail?.canWrite || !selectedVersion || selectedVersion.variant === "source" || drafting || versionBrandChanged) return;
    setDrafting(true); setError("");
    try {
      const query = new URLSearchParams({ organizationId, projectId, contentId: returnContentId });
      const response = await scopedFetch("/api/content-items?" + query);
      if (!response.ok) throw new Error(await readError(response));
      type Draft = { id: string; current_version: number; pack_json: string; full_script: string };
      const { items } = await response.json() as { items: Draft[] };
      const original = items.find(item => item.id === returnContentId);
      if (!original || original.current_version !== returnContentVersion || original.full_script.trim() !== detail.workspace.sourceText.trim()) {
        throw new Error("原稿已有更新，请返回稿件核对新版本后再润色。");
      }
      const pack = JSON.parse(original.pack_json) as ProductionPack;
      const saved = await scopedFetch(`/api/content-items/${encodeURIComponent(original.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, expectedVersion: returnContentVersion, polishVersionId: selectedVersion.id,
          pack: { ...pack, fullScript: selectedVersion.text },
          changeSummary: `润色原稿 v${returnContentVersion} · 改写版本 v${selectedVersion.version}` }),
      });
      if (!saved.ok) throw new Error(await readError(saved));
      window.location.assign(studioHref("drafts", { organizationId, projectId, contentId: original.id }));
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "润色版保存失败。");
    } finally { setDrafting(false); }
  }

  async function copyVersion() { if (!selectedVersion) return; try { await navigator.clipboard.writeText(selectedVersion.text); setMessage(`v${selectedVersion.version} 已复制。`); } catch { setError("复制失败，请重新点击一次。") } }
  function exportVersion() { if (!detail || !selectedVersion) return; const metadata = [`# ${detail.workspace.title}`, "", `- 版本：v${selectedVersion.version} · ${variantNames[selectedVersion.variant]}`, `- 来源：${detail.workspace.sourceLabel}`, `- 模型：${[selectedVersion.modelProvider, selectedVersion.modelName].filter(Boolean).join(" / ") || "人工或来源快照"}`, "", selectedVersion.text, ""].join("\n"); downloadText(`${safeFilename(detail.workspace.title)}-v${selectedVersion.version}.md`, metadata); setMessage("Markdown 已下载到浏览器下载目录。"); }

  function clearScope() {
    detailRequest.current++;
    setDetail(null); setWorkspaces([]); setVideos([]); setRewriteId(""); setSelectedVersionId(""); setCanWrite(false);
    setBriefDraft(null); setGenerationConfirmation(null); setVariants([]);
    setMessage(""); setError(""); setSourceVideoId(""); setSourceText(""); setTitle("");
  }

  if (loading) return <div className="management-state" role="status">正在载入口播改写工作台…</div>;
  return <div className="script-rewrite-workspace">
    <section className="management-toolbar script-rewrite-scope"><label>公司<select aria-label="公司" value={organizationId} disabled={generating || creating || saving || drafting} onChange={(event) => runScopedAction(async () => { const value = event.target.value; clearScope(); setOrganizationId(value); setLoading(true); setError(""); try { await loadProjects(value); } catch (reason) { setError(reason instanceof Error ? reason.message : "项目载入失败。") } finally { setLoading(false) } }, setError)}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>企业空间<select aria-label="企业空间" value={projectId} disabled={generating || creating || saving || drafting} onChange={(event) => runScopedAction(async () => { const value = event.target.value; clearScope(); setProjectId(value); rememberCurrentScope(organizationId, value); setLoading(true); try { await loadWorkspace(organizationId, value); } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区载入失败。") } finally { setLoading(false) } }, setError)}>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></section>
    {error && <div className="inline-alert" role="alert">{error}</div>}{message && <div className="transcript-save-message" role="status">{message}</div>}
    {legacyImport && canWrite && projectId && <details key={detail?.workspace.id ?? projectId} className="panel rewrite-create-disclosure rewrite-source-panel" open={!detail}>
      <summary><strong>新建改写任务</strong><span className="rewrite-disclosure-icon" aria-hidden="true">＋</span></summary>
      <form className="rewrite-create-card" onSubmit={createWorkspace}>
        <div className="rewrite-source-fields">
          <label>任务名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="可选，例如：老板 IP 长视频改写" /></label>
          <div className="rewrite-source-tabs" role="group" aria-label="来源方式">
            <button type="button" className={sourceMode === "pasted" ? "active" : ""} aria-pressed={sourceMode === "pasted"} onClick={() => setSourceMode("pasted")}>粘贴文案</button>
            <button type="button" className={sourceMode === "video" ? "active" : ""} aria-pressed={sourceMode === "video"} onClick={() => setSourceMode("video")}>选择素材视频</button>
          </div>
        </div>
        {sourceMode === "pasted" ? <label>原始文案
          <textarea value={sourceText} onChange={event => setSourceText(event.target.value)} minLength={20} maxLength={SCRIPT_REWRITE_MAX_CHARACTERS} required placeholder="粘贴需要微调或重构的完整口播文案…" />
          <small>{numberLabel(sourceText.length)} / {numberLabel(SCRIPT_REWRITE_MAX_CHARACTERS)} 字符</small>
        </label> : <>
          <label>当前项目素材<select value={sourceVideoId} onChange={event => setSourceVideoId(event.target.value)} required>
            <option value="">选择已有转写的视频</option>
            {videos.map(item => <option value={item.id} disabled={!item.available} key={item.id}>{item.title} · {item.sourceLabel}</option>)}
          </select></label>
          {selectedVideo && <div className={selectedVideo.available ? "rewrite-source-preview" : "rewrite-source-preview unavailable"}>
            <strong>{selectedVideo.sourceLabel}</strong><span>{selectedVideo.available ? `${numberLabel(selectedVideo.sourceCharacters)} 字符 · ${selectedVideo.preview}` : "系统不会静默启动完整视频分析"}</span>
          </div>}
        </>}
        <button className="primary-button" disabled={creating || !canWrite || (sourceMode === "pasted" ? sourceText.trim().length < 20 : !selectedVideo?.available)}>{creating ? "正在保存…" : "保存来源并进入工作台"}</button>
      </form>
    </details>}
    {workspaces.length > 0 && <SplitWorkspace className="script-rewrite-grid record-sidebar-layout">
      <RecordSidebar title="改写列表" count={workspaces.length} className="rewrite-history">
        {workspaces.map(item => <RecordSidebarItem
          key={item.id}
          title={item.title}
          selected={item.id === rewriteId}
          disabled={generating || saving || drafting}
          onSelect={() => void selectWorkspace(item.id)}
          meta={<>
            <span>{item.source_label} · {numberLabel(item.source_character_count)} 字</span>
            <span>{item.version_count} 个版本 · <time dateTime={item.updated_at}>{dateLabel(item.updated_at)}</time></span>
          </>}
        />)}
      </RecordSidebar>
      <div key={rewriteId} className="script-rewrite-main">
        {!detail ? <section className="panel rewrite-empty"><h2>请选择改写任务</h2><p>从改写列表中打开一份稿件。</p></section> : <>

        {detail && <section className="panel rewrite-generator"><header><div><p className="section-kicker">改写设置</p><h2>选择改写方式</h2></div><span className="zero-token-badge">未选择 = 0 次调用</span></header><div className="rewrite-mode-grid"><button type="button" disabled={!detail.canWrite || generating} className={variants.includes("light_rewrite") ? "selected" : ""} aria-pressed={variants.includes("light_rewrite")} onClick={() => toggleVariant("light_rewrite")}><strong>微调同构</strong><p>保留原稿内容和段落顺序，只调整表达。</p></button><button type="button" disabled={!detail.canWrite || generating} className={variants.includes("restructured") ? "selected" : ""} aria-pressed={variants.includes("restructured")} onClick={() => toggleVariant("restructured")}><strong>内容等价重构</strong><p>保留观点和事实，重新组织开头、论证与结尾。</p></button></div><details className="rewrite-mode-help"><summary>查看改写说明</summary><p>微调保持各段的功能与顺序；重构会重新安排论证路径。两种方式都会核对原稿的观点、事实和结论。</p></details>
            <RewriteBrandPanel settings={settings} onChange={next => setBriefDraft({ workspaceId: detail.workspace.id, settings: next })}
              knowledge={knowledge} organizationId={organizationId} projectId={projectId} refreshing={refreshingBrand} onRefresh={() => void refreshBrandKnowledge()} disabled={!detail.canWrite || generating} />
            <div className="rewrite-usage-summary"><p><span>来源 {numberLabel(estimate?.sourceCharacters ?? 0)} 字</span><strong>预计 {estimate?.callCount ?? 0} 次调用<small>（最多 {estimate?.maximumCallCount ?? 0} 次）</small></strong></p><button className="primary-button" type="button" onClick={() => requestGeneration()} disabled={!variants.length || generating || refreshingBrand || !detail.canWrite || !brandReady}>{generating ? "模型正在改写…" : variants.length ? "核对预估并生成" : "先选择改写方式"}</button></div></section>}
          <section className="panel rewrite-result-panel"><header><div><h2>原稿与改写</h2></div>{selectedVersion && <div><button type="button" onClick={copyVersion}>复制</button><button type="button" onClick={exportVersion}>导出</button><button type="button" onClick={() => { setEditing(true); setEditText(selectedVersion.text) }} disabled={!detail.canWrite}>人工编辑</button>
            {editingOriginalDraft && selectedVersion.variant !== "source" && detail.canWrite && <button type="button" className="primary-button"
              disabled={drafting || editing || saving || generating || versionBrandChanged || selectedVersion.validation?.passed === false}
              onClick={() => void savePolishedDraft()}>{drafting ? "正在保存…" : "保存为原稿的新版本"}</button>}
            {!editingOriginalDraft && selectedVersion.variant !== "source" && (selectedVersion.draftId || detail.canWrite) && <button className="primary-button" type="button" disabled={drafting || editing || saving || generating || (versionBrandChanged && !selectedVersion.draftId)} onClick={() => void openDraft()}>{drafting ? "正在创建…" : selectedVersion.draftId ? "打开稿件 →" : "当前版本转为稿件 →"}</button>}
          </div>}</header>
            {versionBrandChanged && <p className="rewrite-brand-stale">这版使用的品牌资料已更新。可以回看历史正文，转为新稿件前请用当前资料重新生成。</p>}
            <div className="rewrite-version-strip">{detail.versions.map((item) => <button type="button" className={item.id === selectedVersion?.id ? "active" : ""} key={item.id} onClick={() => { setSelectedVersionId(item.id); setEditing(false) }}><strong>v{item.version}</strong><span>{variantNames[item.variant]}</span><small>{dateLabel(item.createdAt)}</small></button>)}</div>{selectedVersion && <>{editing ? <div className="rewrite-editor"><textarea aria-label="编辑当前版本的文案" value={editText} onChange={(event) => setEditText(event.target.value)} maxLength={SCRIPT_REWRITE_MAX_CHARACTERS} /><div><button type="button" onClick={() => setEditing(false)} disabled={saving}>取消</button><button className="primary-button" type="button" onClick={saveManualVersion} disabled={saving || editText.trim().length < 20}>{saving ? "正在保存…" : "保存为新版本"}</button></div></div> : <div className="rewrite-compare"><article><header><strong>来源快照</strong><span>只读 · 永不覆盖</span></header>{sourceParagraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article><article><header><strong>v{selectedVersion.version} · {variantNames[selectedVersion.variant]}</strong><div className="rewrite-reading-tools">{selectedVersion.variant === "light_rewrite" && <label><input type="checkbox" checked={showChanges} onChange={(event) => setShowChanges(event.target.checked)} />显示改动</label>}<span>{selectedVersion.validation?.passed === false ? "建议人工复核" : "可复制与继续编辑"}</span></div></header>{selectedVersion.paragraphs.length ? selectedVersion.paragraphs.map((paragraph, index) => <p key={index}>{selectedVersion.variant === "light_rewrite" && showChanges ? <ChangedText source={sourceParagraphs[index] ?? ""} result={paragraph} /> : paragraph}</p>) : <p>{selectedVersion.text}</p>}</article></div>}<div className="rewrite-provenance"><span>{variantNames[selectedVersion.variant]}</span><span>{[selectedVersion.modelProvider, selectedVersion.modelName].filter(Boolean).join(" / ") || "未调用模型"}</span><span>{selectedRun ? formatRewriteTokenUsage(selectedRun.actualTotalTokens, selectedRun.unknownRequestCount ?? null) : selectedVersion.promptVersion || "来源快照"}</span></div>
            {selectedVersion.adaptation && <RewriteBrandRecord snapshot={selectedVersion.adaptation} manual={selectedVersion.variant === "manual"} />}
            </>}</section>
          {failedRuns.length > 0 && <section className="panel rewrite-failures"><header><div><p className="section-kicker">如实保留失败</p><h2>失败运行</h2></div><span>{failedRuns.length}</span></header>{failedRuns.map((run) => <article key={run.id}><div><strong>{variantNames[run.variant]}生成失败</strong><span>{run.errorMessage || run.errorCode || "模型结果未通过校验"}</span>{run.validation.issues?.map((issue, index) => <span key={index}>{issue}</span>)}{run.validation.checks?.filter((check) => !check.passed).map((check) => <span key={check.key}>{check.label}：{check.value}</span>)}<small>{dateLabel(run.createdAt)} · {formatRewriteTokenUsage(run.actualTotalTokens, run.unknownRequestCount ?? null)} · 重试将尝试复用已生成内容</small></div><button type="button" onClick={() => requestGeneration([run.variant], run.id)} disabled={generating || !detail.canWrite}>单独重试这一版</button></article>)}</section>}
          {selectedVersion?.validation.passed === false && selectedVersion.runId && (selectedVersion.variant === "light_rewrite" || selectedVersion.variant === "restructured") && <section className="panel rewrite-failures"><header><div><p className="section-kicker">正文已保留</p><h2>这版仍有待修订项</h2></div><button type="button" onClick={() => requestGeneration([selectedVersion.variant as ScriptRewriteVariant], selectedVersion.runId!)} disabled={generating || !detail.canWrite}>继续修订这版</button></header>{selectedVersion.validation.checks?.filter((check) => !check.passed).map((check) => <article key={check.key}><span>{check.label}：{check.value}</span></article>)}</section>}
          {historicalFailedRuns.length > 0 && <details className="panel rewrite-failures rewrite-failure-history"><summary>历史失败记录（后续改写已通过） · {historicalFailedRuns.length} 次</summary>{historicalFailedRuns.map((run) => <article key={run.id}><div><strong>{variantNames[run.variant]} · 历史失败</strong><span>{run.errorMessage || run.errorCode}</span><small>{dateLabel(run.createdAt)} · {formatRewriteTokenUsage(run.actualTotalTokens, run.unknownRequestCount ?? null)}</small></div></article>)}</details>}
        </>}
      </div>
    </SplitWorkspace>}
    {!workspaces.length && (!legacyImport || !canWrite || !projectId) && <div className="list-empty">{projectId ? "当前空间还没有改写任务。" : "请选择企业空间。"}</div>}
    {generationConfirmation && <dialog ref={confirmationDialog} className="rewrite-confirm-backdrop" aria-labelledby="rewrite-confirm-title" aria-describedby="rewrite-confirm-description"
      onCancel={event => { event.preventDefault(); setGenerationConfirmation(null); }}>
      <section className="rewrite-confirm-dialog">
        <header><span aria-hidden="true">AI</span><div><small>{generationConfirmation.retryOfRunId ? "重新生成失败版本" : "开始新的生成"}</small><h2 id="rewrite-confirm-title">{generationConfirmation.variants.map((item) => variantNames[item]).join("、")}</h2></div></header>
        <p id="rewrite-confirm-description">开始后将调用内容模型，来源快照和已有版本不会被覆盖。</p>
        {generationConfirmation.adaptation && <dl className="rewrite-confirm-settings">
          <div><dt>品牌处理</dt><dd>{brandModeLabels[generationConfirmation.adaptation.mode]}{generationConfirmation.adaptation.mode === "current_brand" && generationConfirmation.targetName && " · " + generationConfirmation.targetName}</dd></div>
          {generationConfirmation.adaptation.goal && <div><dt>改写目标</dt><dd>{generationConfirmation.adaptation.goal}</dd></div>}
          {generationConfirmation.adaptation.audience && <div><dt>目标受众</dt><dd>{generationConfirmation.adaptation.audience}</dd></div>}
          {generationConfirmation.adaptation.scenario && <div><dt>口播场景</dt><dd>{generationConfirmation.adaptation.scenario}</dd></div>}
        </dl>}
        <dl className="rewrite-confirm-costs"><div><dt>预计调用</dt><dd>{generationConfirmation.estimate.callCount} 次 <small>最多 {generationConfirmation.estimate.maximumCallCount} 次</small></dd></div><div><dt>预计输入</dt><dd>{numberLabel(generationConfirmation.estimate.estimatedInputTokens)} <small>Token</small></dd></div><div><dt>输出上限</dt><dd>{numberLabel(generationConfirmation.estimate.maximumOutputTokens)} <small>Token</small></dd></div></dl>
        <footer><button type="button" onClick={() => setGenerationConfirmation(null)}>暂不生成</button><button className="primary-button" type="button" onClick={() => { const pending = generationConfirmation; setGenerationConfirmation(null); void generate(pending) }}>开始生成</button></footer>
      </section>
    </dialog>}
  </div>;
}
