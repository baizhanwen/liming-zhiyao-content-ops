"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";


import Link from "next/link";
import { materialCardState } from "../lib/material-analysis-state";
import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Download, FolderInput, Upload } from "lucide-react";
import { preferredOrganizationId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type LibraryEntry = Parameters<typeof materialCardState>[0] & {
  id: string; reference_id?: string; video_id: string; category: string; tags: string[]; notes: string | null; updated_at: string;
  platform: string; source_type: string; source_url: string | null; title: string | null; author_name: string | null;
  duration_sec: number | null; status: string; job_status: string | null; job_progress: number | null; current_stage: string | null;
  source_project_id?: string; source_project_name: string; account_name: string | null; cover_url: string | null; reference_count?: number; imported_to_project?: number;
};

const categories = [
  ["", "全部分类"], ["published", "已发布的视频"], ["benchmark", "对标样本"], ["industry", "行业洞察"], ["case", "案例拆解"],
  ["trend", "趋势热点"], ["creative", "创意参考"], ["other", "未分类"],
] as const;
const categoryNames = Object.fromEntries(categories.filter(([value]) => value)) as Record<string, string>;



export function VideoLibraryWorkspace({ mode }: { mode: "benchmark" | "assets" }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState(""); const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true); const [working, setWorking] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [canManage, setCanManage] = useState(false); const [canWrite, setCanWrite] = useState(false); const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({}); const [coverFailures, setCoverFailures] = useState<Record<string, boolean>>({});
  const [coverRetries, setCoverRetries] = useState<Record<string, number>>({});
  const [transferring, setTransferring] = useState(false);

  const loadEntries = useCallback(async (orgId: string, projId: string, search = "", filter = "") => {
    if (!orgId || (mode !== "assets" && !projId)) { setEntries([]); return; }
    setLoading(true); setError("");
    try {
      const base = mode === "assets" ? "/api/video-library" : "/api/video-library/references";
      const params = new URLSearchParams({ organizationId: orgId }); if (projId && mode !== "assets") params.set("projectId", projId);
      if (search.trim()) params.set("q", search.trim()); if (filter) params.set("category", filter);
      const response = await scopedFetch(`${base}?${params}`); if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { entries: LibraryEntry[]; canManage?: boolean; canWrite?: boolean };
      setEntries(body.entries); setCanManage(Boolean(body.canManage)); setCanWrite(Boolean(body.canWrite)); setSelected([]); setCoverFailures({});
      setTagDrafts(Object.fromEntries(body.entries.map((entry) => [entry.id, entry.tags.join("、")])));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材库加载失败。"); setEntries([]); }
    finally { setLoading(false); }
  }, [mode]);

  const loadProjects = useCallback(async (orgId: string) => {
    const body = await loadClientProjects<Project>(orgId, ""); const nextProject = body.selected;
    setProjects(body.projects); setProjectId(nextProject); rememberCurrentScope(orgId, nextProject); await loadEntries(orgId, nextProject, "", "");
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

  async function search(event: FormEvent) { event.preventDefault(); await loadEntries(organizationId, projectId, query, category); }
  async function importSelected() {
    if (!selected.length) return; setWorking(true); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/video-library/references", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, entryIds: selected }) });
      if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { imported: number };
      setNotice(`已将 ${body.imported} 条素材导入当前项目的对标内容库。`); await loadEntries(organizationId, projectId, query, category);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败。"); } finally { setWorking(false); }
  }
  async function removeReference(entry: LibraryEntry) {
    if (!entry.reference_id) return; setWorking(true); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/video-library/references", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, referenceId: entry.reference_id }) });
      if (!response.ok) throw new Error(await readError(response)); setNotice("已从当前项目移出该对标素材。"); await loadEntries(organizationId, projectId, query, category);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "移出失败。"); } finally { setWorking(false); }
  }
  async function saveMetadata(entry: LibraryEntry, nextCategory = entry.category) {
    setWorking(true); setError(""); setNotice("");
    const tags = (tagDrafts[entry.id] ?? "").split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean);
    try {
      const response = await scopedFetch("/api/video-library", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, entryId: entry.id, expectedUpdatedAt: entry.updated_at, category: nextCategory, tags, notes: entry.notes }) });
      if (!response.ok) throw new Error(await readError(response)); setNotice("素材分类与标签已保存。"); await loadEntries(organizationId, projectId, query, category);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材整理结果没有保存。"); } finally { setWorking(false); }
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
      const manifest = await response.json() as { entries: Array<{ assets: Array<{ blobName: string; downloadUrl: string; filename: string }> }> };
      const files: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest)) };
      for (const entry of manifest.entries) for (const asset of entry.assets) {
        const assetResponse = await scopedFetch(asset.downloadUrl); if (!assetResponse.ok) throw new Error(`下载素材文件“${asset.filename}”失败。`);
        files[`media/${asset.blobName}`] = new Uint8Array(await assetResponse.arrayBuffer());
      }
      const archive = zipSync(files, { level: 0 }); downloadBlob(new Blob([ownedBuffer(archive)], { type: "application/zip" }), `利明智耀素材中心-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice(`已导出 ${manifest.entries.length} 条素材及其媒体文件。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材迁移包导出失败。"); }
    finally { setTransferring(false); }
  }

  async function importMaterials(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file || !organizationId || !projectId || !canManage) return;
    setTransferring(true); setError(""); setNotice("");
    try {
      const archive = unzipSync(new Uint8Array(await file.arrayBuffer())); const manifestBytes = archive["manifest.json"]; if (!manifestBytes) throw new Error("迁移包缺少 manifest.json。");
      const manifest = JSON.parse(strFromU8(manifestBytes)) as { entries?: Array<{ assets?: Array<{ blobName?: string }> }> }; if (!Array.isArray(manifest.entries)) throw new Error("迁移包清单格式不正确。");
      const form = new FormData(); form.set("organizationId", organizationId); form.set("projectId", projectId); form.set("manifest", JSON.stringify(manifest));
      for (const entry of manifest.entries) for (const asset of entry.assets || []) {
        if (!asset.blobName) throw new Error("迁移包含有未命名的媒体文件。"); const bytes = archive[`media/${asset.blobName}`]; if (!bytes) throw new Error(`迁移包缺少媒体文件 ${asset.blobName}。`);
        form.append("media", new Blob([ownedBuffer(bytes)]), asset.blobName);
      }
      const response = await scopedFetch("/api/video-library/transfer", { method: "POST", body: form });
      if (!response.ok) {
        const failure = await response.clone().json().catch(() => null) as { progress?: { imported: number; skipped: number; failedEntry: number | null; remaining: number } } | null;
        if (failure?.progress?.failedEntry) setNotice(`本次已导入 ${failure.progress.imported} 条，跳过 ${failure.progress.skipped} 条；从第 ${failure.progress.failedEntry} 条起还有 ${failure.progress.remaining} 条尚未确认完成。请刷新核对后再重试迁移包。`);
        throw new Error(await readError(response));
      }
      const body = await response.json() as { imported: number; skipped: number }; setNotice(`已导入 ${body.imported} 条素材${body.skipped ? `，跳过 ${body.skipped} 条重复素材` : ""}。`); await loadEntries(organizationId, projectId, query, category);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材迁移包导入失败。"); }
    finally { setTransferring(false); }
  }

  function retryCover(entryId: string) {
    setCoverFailures((current) => ({ ...current, [entryId]: false }));
    setCoverRetries((current) => ({ ...current, [entryId]: (current[entryId] ?? 0) + 1 }));
  }

  if (!organizationId && !loading) return <div className="empty-panel"><h2>请先创建公司和企业空间</h2><p>素材必须归属于明确的公司空间。</p><Link className="primary-button link-button" href="/projects">前往企业空间</Link></div>;
  return <div className="video-library-workspace">
    <div className="management-toolbar library-scope-toolbar">
      <label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); setQuery(""); setCategory(""); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label>{mode === "assets" ? "导入目标企业空间" : "当前企业空间"}<select value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadEntries(organizationId, id); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => loadEntries(organizationId, projectId, query, category)}>{loading ? "刷新中…" : "刷新"}</button>
    </div>
    <article className="panel library-panel">
      <div className="library-command-bar">
        <form onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者、账号、标签或来源项目" aria-label="搜索素材" /><select value={category} onChange={async (event) => { const value = event.target.value; setCategory(value); await loadEntries(organizationId, projectId, query, value); }} aria-label="按分类筛选">{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button type="submit" disabled={loading}>搜索</button></form>
        <div className="library-command-summary">
          <span className="library-material-count">{mode === "assets" ? <><small>公司素材</small><strong>{entries.length}</strong><em>条</em></> : <><small>项目对标素材</small><strong>{entries.length}</strong><em>条</em></>}</span>
          {mode === "assets" && <div className="library-command-actions">
            <button className="library-import-button" type="button" disabled={!selected.length || working || transferring} onClick={importSelected}><FolderInput aria-hidden="true" /><span>{working ? "处理中…" : `导入项目${selected.length ? `（${selected.length}）` : ""}`}</span></button>
            {canManage && <div className="library-transfer-actions" aria-label="素材迁移">
              <button className="library-transfer-button" type="button" disabled={transferring} onClick={() => void exportMaterials()}><Download aria-hidden="true" /><span>{transferring ? "迁移处理中…" : selected.length ? `导出所选（${selected.length}）` : "导出全部"}</span></button>
              <label className={`library-file-import${transferring ? " disabled" : ""}`}><Upload aria-hidden="true" /><span>导入迁移包</span><input type="file" accept="application/zip,.zip" disabled={transferring} onChange={(event) => void importMaterials(event)} /></label>
            </div>}
          </div>}
        </div>
      </div>
      {error && <div className="inline-alert" role="alert">{error}</div>}{notice && <div className="library-notice" role="status">{notice}</div>}
      {loading ? <div className="list-empty">正在整理素材库…</div> : entries.length === 0 ? <div className="list-empty">{mode === "assets" ? "公司素材库还没有匹配的分析视频。新分析完成后会自动沉淀到这里。" : "当前项目还没有对标素材。请从素材中心选择并导入。"}</div> : <div className="library-grid">{entries.map((entry) => {
        const checked = selected.includes(entry.id); const analysisState = materialCardState(entry);
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
            <em className={`status ${analysisState.tone}`}>{analysisState.label}</em>
            {mode === "assets" && <label className="library-select"><input type="checkbox" checked={checked} disabled={Boolean(entry.imported_to_project)} onChange={() => setSelected((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])} /><span>{entry.imported_to_project ? "已导入" : "选择"}</span></label>}
          </div>
          <div className="library-card-body"><div className="library-card-tags"><span>{categoryNames[entry.category] ?? "未分类"}</span><small>{entry.platform === "douyin" ? "抖音" : "本地上传"}</small></div><h3>{entry.title || "待提取视频标题"}</h3><p>{entry.account_name || entry.author_name || "未关联账号"} · 来源：{entry.source_project_name}</p>{analysisState.hint && <p>{analysisState.hint}</p>}<div className="plain-chips">{entry.tags.length ? entry.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>暂无标签</span>}</div>
            {mode === "assets" && canManage && <div className="library-edit"><select value={entry.category} disabled={working || loading} aria-label="素材分类" onChange={(event) => saveMetadata(entry, event.target.value)}>{categories.filter(([value]) => value).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input disabled={working || loading} value={tagDrafts[entry.id] ?? ""} onChange={(event) => setTagDrafts((current) => ({ ...current, [entry.id]: event.target.value }))} placeholder="标签用逗号分隔" aria-label="素材标签" /><button type="button" onClick={() => saveMetadata(entry)} disabled={working}>保存</button></div>}
          </div>
          <footer><span>{mode === "assets" ? `已被 ${entry.reference_count ?? 0} 个项目引用` : `来自 ${entry.source_project_name}`}</span><div><Link href={`/analysis/${entry.video_id}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&libraryEntryId=${encodeURIComponent(entry.id)}`}>查看分析</Link>{analysisState.tone !== "success" && entry.source_project_id === projectId && (mode === "assets" ? canManage : canWrite) && <Link href={`/analysis/${entry.video_id}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>进入来源空间分析</Link>}{mode === "benchmark" && canWrite && <button type="button" disabled={working} onClick={() => removeReference(entry)}>移出项目</button>}</div></footer>
        </article>;
      })}</div>}
    </article>
  </div>;
}
