"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";


import Link from "next/link";
import { materialCardState } from "../lib/material-analysis-state";
import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { readMaterialArchive, readMaterialResponse, materialManifestFiles } from "../lib/material-archive";
import { MATERIAL_MAX_ARCHIVE_BYTES, MATERIAL_MAX_MANIFEST_BYTES, MATERIAL_MAX_MEDIA_BYTES } from "../lib/material-transfer-limits";
import { strFromU8, strToU8, zipSync } from "fflate";
import { Download, FolderInput, Upload } from "lucide-react";
import { preferredOrganizationId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type LibraryEntry = Parameters<typeof materialCardState>[0] & {
  id: string; reference_id?: string; video_id: string; category: string; tags: string[]; notes: string | null; updated_at: string;
  platform: string; source_type: string; source_url: string | null; title: string | null; author_name: string | null;
  duration_sec: number | null; status: string; job_status: string | null; job_progress: number | null; current_stage: string | null;
  content_category?: string | null; content_category_label?: string | null; content_tags?: string[];
  source_project_id?: string; source_project_name: string; account_name: string | null; cover_url: string | null; reference_count?: number; imported_to_project?: number;
};

type ContentFilters = { topicCategory: string; contentForm: string; durationBucket: string; tag: string };
type FilterOption = { id: string; label: string };
type FilterOptions = { topicCategories: FilterOption[]; contentForms: FilterOption[]; durationBuckets: FilterOption[]; tags: string[] };
const emptyContentFilters: ContentFilters = { topicCategory: "", contentForm: "", durationBucket: "", tag: "" };
const emptyFilterOptions: FilterOptions = { topicCategories: [], contentForms: [], durationBuckets: [], tags: [] };



export function VideoLibraryWorkspace({ mode }: { mode: "benchmark" | "assets" }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [contentFilters, setContentFilters] = useState<ContentFilters>(emptyContentFilters);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(emptyFilterOptions);
  const [canImportToProject, setCanImportToProject] = useState(false);
  const loadGeneration = useRef(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true); const [working, setWorking] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [canManage, setCanManage] = useState(false); const [canWrite, setCanWrite] = useState(false); const [coverFailures, setCoverFailures] = useState<Record<string, boolean>>({});
  const [coverRetries, setCoverRetries] = useState<Record<string, number>>({});
  const [transferring, setTransferring] = useState(false);

  const loadEntries = useCallback(async (orgId: string, projId: string, search = "", content = emptyContentFilters) => {
    if (!orgId || (mode !== "assets" && !projId)) { ++loadGeneration.current; setEntries([]); setSelected([]); setCanImportToProject(false); setLoading(false); return; }
    const generation = ++loadGeneration.current;
    setLoading(true); setError("");
    try {
      const base = mode === "assets" ? "/api/video-library" : "/api/video-library/references";
      const params = new URLSearchParams({ organizationId: orgId }); if (projId) params.set("projectId", projId);
      if (search.trim()) params.set("q", search.trim());
      for (const [key, value] of Object.entries(content)) if (value) params.set(key, value);
      const response = await scopedFetch(`${base}?${params}`); if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { entries: LibraryEntry[]; canManage?: boolean; canWrite?: boolean; canImportToProject?: boolean; filterOptions?: FilterOptions };
      if (generation !== loadGeneration.current) return;
      setEntries(body.entries); setCanManage(Boolean(body.canManage)); setCanWrite(Boolean(body.canWrite)); setCanImportToProject(Boolean(body.canImportToProject)); setSelected([]); setCoverFailures({});
      setFilterOptions(body.filterOptions ?? emptyFilterOptions);
    } catch (reason) { if (generation === loadGeneration.current) { setError(reason instanceof Error ? reason.message : "素材库加载失败。"); setEntries([]); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [mode]);

  const loadProjects = useCallback(async (orgId: string) => {
    const body = await loadClientProjects<Project>(orgId, ""); const nextProject = body.selected;
    setProjects(body.projects); setProjectId(nextProject); setContentFilters(emptyContentFilters); rememberCurrentScope(orgId, nextProject); await loadEntries(orgId, nextProject);
  }, [loadEntries]);

  useEffect(() => { let active = true; (async () => {
    try {
      const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { organizations: Organization[] }; if (!active) return;
      const nextOrganization = preferredOrganizationId(body.organizations); setOrganizations(body.organizations); setOrganizationId(nextOrganization);
      if (nextOrganization) await loadProjects(nextOrganization);
    } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "公司与项目加载失败。"); }
    finally { if (active) setLoading(false); }
  })(); return () => { active = false; }; }, [loadProjects]);

  async function filterContent(key: keyof ContentFilters, value: string) {
    const next = { ...contentFilters, [key]: value };
    setContentFilters(next);
    await loadEntries(organizationId, projectId, query, next);
  }

  async function search(event: FormEvent) { event.preventDefault(); await loadEntries(organizationId, projectId, query, contentFilters); }
  async function importSelected(entryIds = selected) {
    if (!entryIds.length || !projectId || !canImportToProject) return; setWorking(true); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/video-library/references", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, entryIds }) });
      if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { imported: number; alreadyActive?: number };
      setNotice(`已将 ${body.imported} 条素材同步到当前企业空间的对标内容库。${body.alreadyActive ? `其中 ${body.alreadyActive} 条已在库中。` : ""}`); await loadEntries(organizationId, projectId, query, contentFilters);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "同步失败。"); } finally { setWorking(false); }
  }
  async function removeReference(entry: LibraryEntry) {
    if (!entry.reference_id) return; setWorking(true); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/video-library/references", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, referenceId: entry.reference_id }) });
      if (!response.ok) throw new Error(await readError(response)); setNotice("已从当前项目移出该对标素材。"); await loadEntries(organizationId, projectId, query, contentFilters);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "移出失败。"); } finally { setWorking(false); }
  }
  function downloadBlob(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; anchor.click(); URL.revokeObjectURL(href);
  }

  function ownedBuffer(bytes: Uint8Array) { return Uint8Array.from(bytes).buffer; }

  async function exportMaterials() {
    if (!organizationId || !canManage) return; setTransferring(true); setError(""); setNotice("");
    try {
      const params = new URLSearchParams({ organizationId }); if (selected.length) params.set("entryIds", selected.join(","));
      const response = await scopedFetch(`/api/video-library/transfer?${params}`); if (!response.ok) throw new Error(await readError(response));
      const manifestBytes = await readMaterialResponse(response, MATERIAL_MAX_MANIFEST_BYTES, "导出清单超过 20000000 字节，请减少选择或使用完整备份。");
      const manifest = JSON.parse(strFromU8(manifestBytes)) as { entries: Array<{ assets: Array<{ blobName: string; downloadUrl: string; filename: string; sizeBytes: number }> }> };
      materialManifestFiles(manifest);
      let totalBytes = 0;
      const declaredBytes = manifest.entries.flatMap(entry => entry.assets).reduce((total, asset) => total + asset.sizeBytes, 0);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MATERIAL_MAX_MEDIA_BYTES) throw new Error("所选媒体超过 750 MiB 或大小无效，请减少选择后分批导出。");
      const files: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest)) };
      for (const entry of manifest.entries) for (const asset of entry.assets) {
        const assetResponse = await scopedFetch(asset.downloadUrl); if (!assetResponse.ok) throw new Error(`下载素材文件“${asset.filename}”失败。`);
        const bytes = await readMaterialResponse(assetResponse, MATERIAL_MAX_MEDIA_BYTES - totalBytes, "所选媒体实际大小超过 750 MiB，未生成迁移包；请减少选择。");
        totalBytes += bytes.length; files[`media/${asset.blobName}`] = bytes;
      }
      const archive = zipSync(files, { level: 0 }); if (archive.length > MATERIAL_MAX_ARCHIVE_BYTES) throw new Error("迁移 ZIP 过大，请减少选择后分批导出。"); downloadBlob(new Blob([ownedBuffer(archive)], { type: "application/zip" }), `利明智耀素材中心-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice(`已导出 ${manifest.entries.length} 条素材及其媒体文件。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材迁移包导出失败。"); }
    finally { setTransferring(false); }
  }

  async function importMaterials(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file || !organizationId || !projectId || !canManage) return;
    setTransferring(true); setError(""); setNotice("");
    try {
      const { manifest, files } = await readMaterialArchive(file);
      const form = new FormData(); form.set("organizationId", organizationId); form.set("projectId", projectId); form.set("manifest", JSON.stringify(manifest));
      const appended = new Set<string>();
      for (const entry of manifest.entries) for (const asset of entry.assets || []) {
        if (!appended.has(asset.blobName)) { form.append("media", files.get(`media/${asset.blobName}`)!, asset.blobName); appended.add(asset.blobName); }
      }
      const response = await scopedFetch("/api/video-library/transfer", { method: "POST", body: form });
      if (!response.ok) {
        const failure = await response.clone().json().catch(() => null) as { progress?: { imported: number; skipped: number; failedEntry: number | null; remaining: number } } | null;
        if (failure?.progress?.failedEntry) setNotice(`本次已导入 ${failure.progress.imported} 条，跳过 ${failure.progress.skipped} 条；从第 ${failure.progress.failedEntry} 条起还有 ${failure.progress.remaining} 条尚未确认完成。请刷新核对后再重试迁移包。`);
        throw new Error(await readError(response));
      }
      const body = await response.json() as { imported: number; skipped: number }; setNotice(`已导入 ${body.imported} 条素材${body.skipped ? `，跳过 ${body.skipped} 条重复素材` : ""}。`); await loadEntries(organizationId, projectId, query, contentFilters);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材迁移包导入失败。"); }
    finally { setTransferring(false); }
  }

  const tagOptions = !contentFilters.tag || filterOptions.tags.includes(contentFilters.tag)
    ? filterOptions.tags : [contentFilters.tag, ...filterOptions.tags];

  function retryCover(entryId: string) {
    setCoverFailures((current) => ({ ...current, [entryId]: false }));
    setCoverRetries((current) => ({ ...current, [entryId]: (current[entryId] ?? 0) + 1 }));
  }

  if (!organizationId && !loading) return <div className="empty-panel"><h2>请先创建公司和企业空间</h2><p>素材必须归属于明确的公司空间。</p><Link className="primary-button link-button" href="/projects">前往企业空间</Link></div>;
  return <div className="video-library-workspace">
    <div className="management-toolbar library-scope-toolbar">
      <label>公司<select aria-label="公司" disabled={working || transferring} value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); setQuery(""); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label>{mode === "assets" ? "同步目标企业空间" : "当前企业空间"}<select aria-label={mode === "assets" ? "同步目标企业空间" : "当前企业空间"} disabled={working || transferring} value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadEntries(organizationId, id, query, contentFilters); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <button type="button" disabled={loading || working || transferring} onClick={() => loadEntries(organizationId, projectId, query, contentFilters)}>{loading ? "刷新中…" : "刷新"}</button>
    </div>
    <article className="panel library-panel">
      <div className="library-command-bar">
        <form onSubmit={search}><input disabled={working || transferring} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者、账号、标签或来源项目" aria-label="搜索素材" /><button type="submit" disabled={loading || working || transferring}>搜索</button></form>
        <div className="library-command-summary">
          <span className="library-material-count">{mode === "assets" ? <><small>公司素材</small><strong>{entries.length}</strong><em>条</em></> : <><small>项目对标素材</small><strong>{entries.length}</strong><em>条</em></>}</span>
          {mode === "assets" && <div className="library-command-actions">
            <button className="library-import-button" type="button" disabled={!selected.length || !canImportToProject || loading || working || transferring} onClick={() => void importSelected()}><FolderInput aria-hidden="true" /><span>{working ? "处理中…" : `同步到对标内容库${selected.length ? `（${selected.length}）` : ""}`}</span></button>
            {canManage && <div className="library-transfer-actions" aria-label="素材迁移">
              <button className="library-transfer-button" type="button" disabled={transferring} onClick={() => void exportMaterials()}><Download aria-hidden="true" /><span>{transferring ? "迁移处理中…" : selected.length ? `导出所选（${selected.length}）` : "导出全部"}</span></button>
              <label className={`library-file-import${transferring ? " disabled" : ""}`}><Upload aria-hidden="true" /><span>导入迁移包</span><input type="file" accept="application/zip,.zip" disabled={transferring} onChange={(event) => void importMaterials(event)} /></label>
            </div>}
          </div>}
        </div>
      </div>
      {error && <div className="inline-alert" role="alert">{error}</div>}{notice && <div className="library-notice" role="status">{notice}</div>}
      {mode === "assets" && !loading && !canImportToProject && <p className="library-sync-hint" role="status">{projectId ? "当前角色不能向所选企业空间同步素材。" : "请选择要同步到的企业空间。"}</p>}
      <div className="library-content-filters" aria-label="内容筛选">
        <label>选题类别<select aria-label="选题类别" disabled={working || transferring} value={contentFilters.topicCategory} onChange={event => void filterContent("topicCategory", event.target.value)}><option value="">全部类别</option>{filterOptions.topicCategories.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>内容形式<select aria-label="内容形式" disabled={working || transferring} value={contentFilters.contentForm} onChange={event => void filterContent("contentForm", event.target.value)}><option value="">全部形式</option>{filterOptions.contentForms.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>时长分组<select aria-label="时长分组" disabled={working || transferring} value={contentFilters.durationBucket} onChange={event => void filterContent("durationBucket", event.target.value)}><option value="">全部时长</option>{filterOptions.durationBuckets.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>标签<select aria-label="标签" disabled={working || transferring} value={contentFilters.tag} onChange={event => void filterContent("tag", event.target.value)}><option value="">全部标签</option>{tagOptions.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
      </div>
      {loading ? <div className="list-empty">正在整理素材库…</div> : entries.length === 0 ? <div className="list-empty">{mode === "assets" ? "公司素材库还没有匹配的分析视频。新分析完成后会自动沉淀到这里。" : "当前项目还没有对标素材。请从素材中心选择并导入。"}</div> : <div className="library-grid">{entries.map((entry) => {
        const checked = selected.includes(entry.id); const analysisState = materialCardState(entry);
        const analysisParams = new URLSearchParams({ organizationId, projectId });
        if (entry.source_project_id !== projectId) analysisParams.set("libraryEntryId", entry.id);
        const coverUrl = entry.cover_url ? entry.cover_url + (entry.cover_url.includes("?") ? "&" : "?") + "mediaRetry=" + (coverRetries[entry.id] ?? 0) : null;
        return <article className={`library-card${checked ? " selected" : ""}`} key={entry.reference_id ?? entry.id}>
          <div className="library-cover">
            {coverUrl && !coverFailures[entry.id] ? (
              // eslint-disable-next-line @next/next/no-img-element -- Private media requires browser session cookies.
              <img
                key={coverRetries[entry.id] ?? 0}
                src={coverUrl}
                alt={`${entry.title || "视频素材"}封面`}
                loading="lazy"
                onLoad={() => setCoverFailures((current) => current[entry.id] ? { ...current, [entry.id]: false } : current)}
                onError={() => setCoverFailures((current) => ({ ...current, [entry.id]: true }))}
              />
            ) : (
              <span className={`library-cover-placeholder${coverFailures[entry.id] ? " library-cover-failure" : ""}`} role={coverFailures[entry.id] ? "alert" : undefined} aria-hidden={!coverFailures[entry.id]}>
                {coverFailures[entry.id] ? <><strong>封面读取失败</strong><button type="button" onClick={() => retryCover(entry.id)}>重试</button></> : entry.source_type === "upload" ? "本地" : "链接"}
              </span>
            )}
            <em className={`status ${analysisState.tone}`} title={analysisState.hint || analysisState.label}>{analysisState.label}</em>
            {mode === "assets" && <label className="library-select"><input type="checkbox" checked={checked} disabled={Boolean(entry.imported_to_project) || !canImportToProject} onChange={() => setSelected((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])} /><span>{entry.imported_to_project ? "已同步" : "选择"}</span></label>}
          </div>
          <div className="library-card-body"><div className="library-card-tags"><span>{entry.content_category_label || "待分类"}</span><small>{entry.platform === "douyin" ? "抖音" : "本地上传"}</small></div><h3>{entry.title || "待提取视频标题"}</h3><p>{entry.account_name || entry.author_name || "未关联账号"} · 来源：{entry.source_project_name}</p><div className="plain-chips">{entry.tags.length ? entry.tags.slice(0, 6).map(tag => <span key={tag}>{tag}</span>) : <span>暂无标签</span>}</div>{entry.tags.length > 6 && <details className="library-tag-details"><summary>查看全部 {entry.tags.length} 个标签</summary><div className="plain-chips">{entry.tags.slice(6).map(tag => <span key={tag}>{tag}</span>)}</div></details>}

          </div>
          <footer>
            <div className="library-card-source-row">
              <span className="library-card-source" title={mode === "assets" ? `已被 ${entry.reference_count ?? 0} 个项目引用` : `来自 ${entry.source_project_name}`}>{mode === "assets" ? `已被 ${entry.reference_count ?? 0} 个项目引用` : `来自 ${entry.source_project_name}`}</span>
            </div>
            <div className="library-card-actions">
              <Link href={`/analysis/${entry.video_id}?${analysisParams}`}>查看分析</Link>
              {mode === "assets" && <button className={entry.imported_to_project ? "library-sync-complete" : undefined} type="button" disabled={working || transferring || !canImportToProject || Boolean(entry.imported_to_project)} title={entry.imported_to_project ? "此素材已在当前企业空间的对标内容库中" : !canImportToProject ? "请选择有同步权限的企业空间" : "同步到当前企业空间的对标内容库"} onClick={() => void importSelected([entry.id])}>{entry.imported_to_project ? "已同步到对标内容库" : "同步到对标内容库"}</button>}
              {mode === "benchmark" && <button className="library-remove-reference" type="button" disabled={working || !canWrite} title={!canWrite ? "当前角色没有移出权限" : undefined} onClick={() => removeReference(entry)}>移出项目</button>}
            </div>
          </footer>
        </article>;
      })}</div>}
    </article>
  </div>;
}
