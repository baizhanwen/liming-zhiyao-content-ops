"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { estimateRewriteUsage, SCRIPT_REWRITE_MAX_CHARACTERS, type RewriteValidationCheck, type ScriptRewriteVariant } from "../lib/script-rewrite";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type WorkspaceRow = { id: string; title: string; source_type: string; source_label: string; source_character_count: number; source_video_id: string | null; status: string; version_count: number; latest_variant: string | null; latest_run_status: string | null; created_at: string; updated_at: string };
type VideoSource = { id: string; title: string; createdAt: string; available: boolean; sourceLabel: string; sourceCharacters: number; preview: string; transcriptId: string | null; transcriptVersion: number | null; analysisId: string | null };
type RewriteVersion = { id: string; version: number; variant: "source" | "light_rewrite" | "restructured" | "manual"; parentVersionId: string | null; runId: string | null; text: string; paragraphs: string[]; sourceMapping: string[]; outline: Array<{ sectionId: string; title: string; role: string; factIds?: string[]; sourceParagraphIds: string[] }>; validation: { passed?: boolean; checks?: RewriteValidationCheck[]; effectiveChangeCoveragePercent?: number; changedParagraphPercent?: number; textSimilarity?: number; sequenceSimilarity?: number }; modelProvider: string | null; modelName: string | null; promptVersion: string | null; modelCallId: string | null; changeSummary: string | null; createdAt: string };
type RewriteRun = { id: string; variant: ScriptRewriteVariant; status: "started" | "completed" | "failed"; sourceVersionId: string; resultVersionId: string | null; retryOfRunId: string | null; estimatedCallCount: number; estimatedInputTokens: number; maximumOutputTokens: number; actualInputTokens: number; actualOutputTokens: number; actualTotalTokens: number; modelCallId: string | null; promptVersion: string; validation: { checks?: RewriteValidationCheck[] }; errorCode: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null };
type RewriteDetail = { workspace: { id: string; title: string; sourceType: "pasted" | "video"; sourceVideoId: string | null; sourceTranscriptId: string | null; sourceTranscriptVersion: number | null; sourceAnalysisId: string | null; sourceLabel: string; sourceText: string; sourceHash: string; sourceCharacters: number; createdAt: string; updatedAt: string }; versions: RewriteVersion[]; runs: RewriteRun[]; canWrite: boolean };
type GenerationConfirmation = { variants: ScriptRewriteVariant[]; retryOfRunId: string; estimate: ReturnType<typeof estimateRewriteUsage> };

const variantNames: Record<string, string> = { source: "来源快照", light_rewrite: "微调同构", restructured: "内容等价重构", manual: "人工编辑" };

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "请求没有完成，请稍后重试。";
}
function numberLabel(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
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

export function ScriptRewriteWorkspace({ initialOrganizationId = "", initialProjectId = "" }: { initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]); const [videos, setVideos] = useState<VideoSource[]>([]); const [canWrite, setCanWrite] = useState(false);
  const [rewriteId, setRewriteId] = useState(""); const [detail, setDetail] = useState<RewriteDetail | null>(null); const [selectedVersionId, setSelectedVersionId] = useState("");
  const [sourceMode, setSourceMode] = useState<"pasted" | "video">("pasted"); const [sourceText, setSourceText] = useState(""); const [sourceVideoId, setSourceVideoId] = useState(""); const [title, setTitle] = useState("");
  const [variants, setVariants] = useState<ScriptRewriteVariant[]>([]); const [editing, setEditing] = useState(false); const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false); const [generating, setGenerating] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [generationConfirmation, setGenerationConfirmation] = useState<GenerationConfirmation | null>(null);

  const scopeQuery = useCallback((orgId: string, projId: string) => `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`, []);
  const loadDetail = useCallback(async (orgId: string, projId: string, id: string, preferredVersionId = "") => {
    if (!id) { setDetail(null); setSelectedVersionId(""); return; }
    const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(id)}?${scopeQuery(orgId, projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as RewriteDetail; setDetail(body); setVariants([]);
    const selected = body.versions.some((item) => item.id === preferredVersionId) ? preferredVersionId : body.versions.find((item) => item.variant !== "source")?.id ?? body.versions[0]?.id ?? "";
    setSelectedVersionId(selected); setEditing(false); setEditText("");
  }, [scopeQuery]);

  const loadWorkspace = useCallback(async (orgId: string, projId: string, preferredRewriteId = "") => {
    if (!orgId || !projId) { setWorkspaces([]); setVideos([]); setDetail(null); return; }
    const response = await scopedFetch(`/api/script-rewrites?${scopeQuery(orgId, projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { workspaces: WorkspaceRow[]; videos: VideoSource[]; canWrite: boolean };
    setWorkspaces(body.workspaces); setVideos(body.videos); setCanWrite(body.canWrite);
    const selected = body.workspaces.some((item) => item.id === preferredRewriteId) ? preferredRewriteId : body.workspaces[0]?.id ?? "";
    setRewriteId(selected); await loadDetail(orgId, projId, selected);
  }, [loadDetail, scopeQuery]);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    rememberCurrentScope(orgId, ""); const response = await scopedFetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { projects: Project[] }; setProjects(body.projects);
    const selected = preferredProjectId(body.projects, preferred); setProjectId(selected); rememberCurrentScope(orgId, selected); await loadWorkspace(orgId, selected);
  }, [loadWorkspace]);

  useEffect(() => {
    let active = true;
    scopedFetch("/api/organizations").then(async (response) => { if (!response.ok) throw new Error(await readError(response)); return response.json() as Promise<{ organizations: Organization[] }> }).then(async (body) => {
      if (!active) return; setOrganizations(body.organizations); const selected = preferredOrganizationId(body.organizations, initialOrganizationId); setOrganizationId(selected); await loadProjects(selected, initialProjectId);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "工作台载入失败。") }).finally(() => { if (active) setLoading(false) });
    return () => { active = false; };
  }, [initialOrganizationId, initialProjectId, loadProjects]);

  useEffect(() => {
    if (!generationConfirmation) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !generating) setGenerationConfirmation(null) };
    document.body.style.overflow = "hidden"; window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape) };
  }, [generationConfirmation, generating]);

  const selectedVideo = videos.find((item) => item.id === sourceVideoId) ?? null;
  const selectedVersion = detail?.versions.find((item) => item.id === selectedVersionId) ?? detail?.versions[0] ?? null;
  const selectedRun = selectedVersion?.runId ? detail?.runs.find((item) => item.id === selectedVersion.runId) ?? null : null;
  const sourceParagraphs = detail?.versions.find((item) => item.variant === "source")?.paragraphs ?? detail?.workspace.sourceText.split(/\n\s*\n/).filter(Boolean) ?? [];
  const estimate = useMemo(() => detail ? estimateRewriteUsage(detail.workspace.sourceText, variants) : null, [detail, variants]);
  const validationChecks = Array.isArray(selectedVersion?.validation?.checks) ? selectedVersion.validation.checks : [];
  const failedRuns = detail?.runs.filter((item) => item.status === "failed") ?? [];

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
    setGenerationConfirmation({ variants: [...selectedVariants], retryOfRunId, estimate: estimateRewriteUsage(detail.workspace.sourceText, selectedVariants) });
  }

  async function generate(selectedVariants = variants, retryOfRunId = "") {
    if (!detail || !selectedVariants.length) return;
    setGenerating(true); setError(""); setMessage("");
    try {
      const response = await scopedFetch(`/api/script-rewrites/${encodeURIComponent(detail.workspace.id)}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, variants: selectedVariants, retryOfRunId: retryOfRunId || undefined }) });
      const body = await response.json().catch(() => null) as { results?: Array<{ status: string; versionId?: string; error?: { message?: string } }> ; error?: { message?: string } } | null;
      if (!response.ok) { setError(body?.error?.message ?? "改写生成失败。"); return; }
      const completed = body?.results?.filter((item) => item.status === "completed") ?? []; const failed = body?.results?.filter((item) => item.status === "failed") ?? [];
      setMessage(failed.length ? `${completed.length} 个版本生成成功，${failed.length} 个版本失败；失败版本没有使用原稿补位。` : `${completed.length} 个版本生成完成。`);
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

  async function copyVersion() { if (!selectedVersion) return; try { await navigator.clipboard.writeText(selectedVersion.text); setMessage(`v${selectedVersion.version} 已复制。`); } catch { setError("复制失败，请重新点击一次。") } }
  function exportVersion() { if (!detail || !selectedVersion) return; const metadata = [`# ${detail.workspace.title}`, "", `- 版本：v${selectedVersion.version} · ${variantNames[selectedVersion.variant]}`, `- 来源：${detail.workspace.sourceLabel}`, `- 模型：${[selectedVersion.modelProvider, selectedVersion.modelName].filter(Boolean).join(" / ") || "人工或来源快照"}`, "", selectedVersion.text, ""].join("\n"); downloadText(`${safeFilename(detail.workspace.title)}-v${selectedVersion.version}.md`, metadata); setMessage("Markdown 已下载到浏览器下载目录。"); }

  if (loading) return <div className="management-state" role="status">正在载入口播改写工作台…</div>;
  return <div className="script-rewrite-workspace">
    <section className="management-toolbar script-rewrite-scope"><label>公司<select value={organizationId} onChange={async (event) => { const value = event.target.value; setOrganizationId(value); setLoading(true); setError(""); try { await loadProjects(value); } catch (reason) { setError(reason instanceof Error ? reason.message : "项目载入失败。") } finally { setLoading(false) } }}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={async (event) => { const value = event.target.value; setProjectId(value); rememberCurrentScope(organizationId, value); setLoading(true); try { await loadWorkspace(organizationId, value); } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区载入失败。") } finally { setLoading(false) } }}>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></section>
    {error && <div className="inline-alert" role="alert">{error}</div>}{message && <div className="transcript-save-message" role="status">{message}</div>}
    <div className="script-rewrite-grid">
      <aside className="script-rewrite-sidebar">
        <form className="panel rewrite-create-card" onSubmit={createWorkspace}><div><p className="section-kicker">第一步 · 保存来源快照</p><h2>新建改写任务</h2><span>建档不会调用模型，也不会产生 Token。</span></div><label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="可选，例如：老板 IP 长视频改写" /></label><div className="rewrite-source-tabs"><button type="button" className={sourceMode === "pasted" ? "active" : ""} onClick={() => setSourceMode("pasted")}>粘贴文案</button><button type="button" className={sourceMode === "video" ? "active" : ""} onClick={() => setSourceMode("video")}>选择素材视频</button></div>{sourceMode === "pasted" ? <label>原始文案<textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} minLength={20} maxLength={SCRIPT_REWRITE_MAX_CHARACTERS} required placeholder="粘贴需要微调或重构的完整口播文案…" /><small>{numberLabel(sourceText.length)} / {numberLabel(SCRIPT_REWRITE_MAX_CHARACTERS)} 字符</small></label> : <><label>当前项目素材<select value={sourceVideoId} onChange={(event) => setSourceVideoId(event.target.value)} required><option value="">选择已有转写的视频</option>{videos.map((item) => <option value={item.id} disabled={!item.available} key={item.id}>{item.title} · {item.sourceLabel}</option>)}</select></label>{selectedVideo && <div className={selectedVideo.available ? "rewrite-source-preview" : "rewrite-source-preview unavailable"}><strong>{selectedVideo.sourceLabel}</strong><span>{selectedVideo.available ? `${numberLabel(selectedVideo.sourceCharacters)} 字符 · ${selectedVideo.preview}` : "系统不会静默启动完整视频分析"}</span></div>}</>}<button className="primary-button" disabled={creating || !canWrite || (sourceMode === "pasted" ? sourceText.trim().length < 20 : !selectedVideo?.available)}>{creating ? "正在保存…" : "保存来源并进入工作台"}</button></form>
        {detail && <section className="panel rewrite-generator"><header><div><p className="section-kicker">第二步 · 按需选择</p><h2>确认后才生成</h2></div><span className="zero-token-badge">未选择 = 0 次调用</span></header><div className="rewrite-mode-grid"><button type="button" className={variants.includes("light_rewrite") ? "selected" : ""} onClick={() => toggleVariant("light_rewrite")}><i>{variants.includes("light_rewrite") ? "✓" : "01"}</i><strong>微调同构</strong><p>主题、信息和段落顺序不变；保持钩子、案例、转折与收束功能，只重写表达。</p><small>同序映射 → 全文仿写 → 语义与防照抄审计</small></button><button type="button" className={variants.includes("restructured") ? "selected" : ""} onClick={() => toggleVariant("restructured")}><i>{variants.includes("restructured") ? "✓" : "02"}</i><strong>内容等价重构</strong><p>观点、事实和结论不变；脱离原稿措辞，重新设计开场、论证路径、信息顺序和收束。</p><small>语义账本与写作画像 → 新叙事 → 独立成稿 → 全面审计</small></button></div><div className="rewrite-estimate"><div><small>来源字数</small><strong>{numberLabel(estimate?.sourceCharacters ?? 0)}</strong></div><div><small>预计调用</small><strong>{estimate?.callCount ?? 0} 次（最多 {estimate?.maximumCallCount ?? 0} 次）</strong></div><div><small>预计输入</small><strong>{numberLabel(estimate?.estimatedInputTokens ?? 0)} Token</strong></div><div><small>输出上限</small><strong>{numberLabel(estimate?.maximumOutputTokens ?? 0)} Token</strong></div><button className="primary-button" type="button" onClick={() => requestGeneration()} disabled={!variants.length || generating || !detail.canWrite}>{generating ? "模型正在改写…" : variants.length ? "核对预估并生成" : "先选择改写方式"}</button></div></section>}
        <section className="panel rewrite-list-card"><header><div><p className="section-kicker">项目内任务</p><h2>改写列表</h2></div><span>{workspaces.length}</span></header>{workspaces.length ? <div>{workspaces.map((item) => <button type="button" className={item.id === rewriteId ? "active" : ""} key={item.id} onClick={async () => { setRewriteId(item.id); setError(""); try { await loadDetail(organizationId, projectId, item.id) } catch (reason) { setError(reason instanceof Error ? reason.message : "详情载入失败。") } }}><strong>{item.title}</strong><span>{item.source_label} · {numberLabel(item.source_character_count)} 字</span><small>{item.version_count} 个版本 · {dateLabel(item.updated_at)}</small></button>)}</div> : <p>还没有改写任务。先保存一份来源快照。</p>}</section>
      </aside>
      <main className="script-rewrite-main">
        {!detail ? <section className="panel rewrite-empty"><span>01</span><h2>先选择来源</h2><p>普通视频分析不会再自动生成微调和重构稿；只有在这里明确选择并确认后才会调用内容生成模型。</p></section> : <>

          <section className="panel rewrite-result-panel"><header><div><p className="section-kicker">第三步 · 对照与留版本</p><h2>原文 / 结果并排核对</h2></div>{selectedVersion && <div><button type="button" onClick={copyVersion}>复制</button><button type="button" onClick={exportVersion}>导出</button><button type="button" onClick={() => { setEditing(true); setEditText(selectedVersion.text) }} disabled={!detail.canWrite}>人工编辑</button></div>}</header><div className="rewrite-version-strip">{detail.versions.map((item) => <button type="button" className={item.id === selectedVersion?.id ? "active" : ""} key={item.id} onClick={() => { setSelectedVersionId(item.id); setEditing(false) }}><strong>v{item.version}</strong><span>{variantNames[item.variant]}</span><small>{dateLabel(item.createdAt)}</small></button>)}</div>{selectedVersion && <>{editing ? <div className="rewrite-editor"><textarea value={editText} onChange={(event) => setEditText(event.target.value)} maxLength={SCRIPT_REWRITE_MAX_CHARACTERS} /><div><button type="button" onClick={() => setEditing(false)} disabled={saving}>取消</button><button className="primary-button" type="button" onClick={saveManualVersion} disabled={saving || editText.trim().length < 20}>{saving ? "正在保存…" : "保存为新版本"}</button></div></div> : <div className="rewrite-compare"><article><header><strong>来源快照</strong><span>只读 · 永不覆盖</span></header>{sourceParagraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article><article><header><strong>v{selectedVersion.version} · {variantNames[selectedVersion.variant]}</strong><span>{selectedVersion.validation?.passed === false ? "建议人工复核" : "可复制与继续编辑"}</span></header>{selectedVersion.paragraphs.length ? selectedVersion.paragraphs.map((paragraph, index) => <p key={index}>{selectedVersion.variant === "light_rewrite" ? <ChangedText source={sourceParagraphs[index] ?? ""} result={paragraph} /> : paragraph}</p>) : <p>{selectedVersion.text}</p>}</article></div>}<div className="rewrite-provenance"><span>{variantNames[selectedVersion.variant]}</span><span>{[selectedVersion.modelProvider, selectedVersion.modelName].filter(Boolean).join(" / ") || "未调用模型"}</span><span>{selectedRun?.actualTotalTokens ? `实际 ${numberLabel(selectedRun.actualTotalTokens)} Token` : selectedVersion.promptVersion || "来源快照"}</span></div>{validationChecks.length > 0 && <div className="rewrite-validation-grid">{validationChecks.map((item) => <span className={item.passed ? "passed" : "failed"} key={item.key}><i>{item.passed ? "✓" : "!"}</i><b>{item.label}</b><small>{String(item.value)}</small></span>)}</div>}</>}</section>
          {failedRuns.length > 0 && <section className="panel rewrite-failures"><header><div><p className="section-kicker">如实保留失败</p><h2>失败运行</h2></div><span>{failedRuns.length}</span></header>{failedRuns.map((run) => <article key={run.id}><div><strong>{variantNames[run.variant]}生成失败</strong><span>{run.errorMessage || run.errorCode || "模型结果未通过校验"}</span><small>{dateLabel(run.createdAt)} · 已发生 {numberLabel(run.actualTotalTokens)} Token</small></div><button type="button" onClick={() => requestGeneration([run.variant], run.id)} disabled={generating || !detail.canWrite}>单独重试这一版</button></article>)}</section>}
        </>}
      </main>
    </div>
    {generationConfirmation && <div className="rewrite-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !generating) setGenerationConfirmation(null) }}>
      <section className="rewrite-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rewrite-confirm-title" aria-describedby="rewrite-confirm-description">
        <header><span aria-hidden="true">AI</span><div><small>{generationConfirmation.retryOfRunId ? "重新生成失败版本" : "开始新的生成"}</small><h2 id="rewrite-confirm-title">{generationConfirmation.variants.map((item) => variantNames[item]).join("、")}</h2></div></header>
        <p id="rewrite-confirm-description">开始后将调用内容模型，来源快照和已有版本不会被覆盖。</p>
        <dl className="rewrite-confirm-costs"><div><dt>预计调用</dt><dd>{generationConfirmation.estimate.callCount} 次 <small>最多 {generationConfirmation.estimate.maximumCallCount} 次</small></dd></div><div><dt>预计输入</dt><dd>{numberLabel(generationConfirmation.estimate.estimatedInputTokens)} <small>Token</small></dd></div><div><dt>输出上限</dt><dd>{numberLabel(generationConfirmation.estimate.maximumOutputTokens)} <small>Token</small></dd></div></dl>
        <footer><button type="button" onClick={() => setGenerationConfirmation(null)}>暂不生成</button><button className="primary-button" type="button" onClick={() => { const pending = generationConfirmation; setGenerationConfirmation(null); void generate(pending.variants, pending.retryOfRunId) }}>开始生成</button></footer>
      </section>
    </div>}
  </div>;
}
