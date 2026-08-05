"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ProductionPack } from "../lib/content-production";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Topic = { id: string; title: string; angle: string | null; status: string; priority: number };
type ContentItem = { id: string; topic_id: string; title: string; status: string; current_version: number; generation_mode: string; pack_json: string; full_script: string; short_script: string; prompt_version?: string | null; model_call_id?: string | null; updated_at: string };

async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求没有完成，请稍后重试。"; }
function readPack(value: string): ProductionPack | null { try { return JSON.parse(value) as ProductionPack; } catch { return null; } }
function replaceItem(items: ContentItem[], patch: Partial<ContentItem> & { id: string }) { return items.map((item) => item.id === patch.id ? { ...item, ...patch } : item); }

export function ContentProductionWorkspace({ initialOrganizationId = "", initialProjectId = "", initialTopicId = "" }: { initialOrganizationId?: string; initialProjectId?: string; initialTopicId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]); const [items, setItems] = useState<ContentItem[]>([]); const [canWrite, setCanWrite] = useState(false); const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState("");

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) return;
    const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
    const [topicResponse, contentResponse] = await Promise.all([fetch(`/api/topics?${query}`), fetch(`/api/content-items?${query}`)]);
    if (!topicResponse.ok) throw new Error(await readError(topicResponse)); if (!contentResponse.ok) throw new Error(await readError(contentResponse));
    const topicBody = await topicResponse.json() as { topics: Topic[] }; const contentBody = await contentResponse.json() as { items: ContentItem[]; canWrite: boolean };
    setTopics(topicBody.topics.filter((topic) => topic.status !== "archived")); setItems(contentBody.items); setCanWrite(contentBody.canWrite);
    const preferred = contentBody.items.find((item) => item.topic_id === initialTopicId)?.id || contentBody.items[0]?.id || ""; setSelectedId(preferred);
  }, [initialTopicId]);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => { const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { projects: Project[] }; setProjects(body.projects); const selected = body.projects.some((project) => project.id === preferred) ? preferred : body.projects[0]?.id ?? ""; setProjectId(selected); await loadWorkspace(orgId, selected); }, [loadWorkspace]);
  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const selected = body.organizations.some((organization) => organization.id === initialOrganizationId) ? initialOrganizationId : body.organizations[0]?.id ?? ""; setOrganizationId(selected); if (selected) await loadProjects(selected, initialProjectId); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [initialOrganizationId, initialProjectId, loadProjects]);

  const selected = items.find((item) => item.id === selectedId) ?? null; const pack = useMemo(() => selected ? readPack(selected.pack_json) : null, [selected]);
  const availableTopics = topics.filter((topic) => !items.some((item) => item.topic_id === topic.id));

  async function createItem(topicId: string) {
    setBusy(`create:${topicId}`); setError(""); const response = await fetch("/api/content-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, topicId }) });
    if (!response.ok) { setError(await readError(response)); setBusy(""); return; } const body = await response.json() as { item: ContentItem }; setItems((current) => [body.item, ...current]); setTopics((current) => current.map((topic) => topic.id === topicId ? { ...topic, status: "drafting" } : topic)); setSelectedId(body.item.id); setBusy("");
  }
  async function generateItem(contentId: string, profile: string) {
    setBusy(`generate:${contentId}`); setError(""); const response = await fetch(`/api/content-items/${contentId}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, modelProfile: profile }) });
    if (!response.ok) { setError(await readError(response)); setBusy(""); return; } const body = await response.json() as { item: Partial<ContentItem> & { id: string } }; setItems((current) => replaceItem(current, body.item)); setBusy("");
  }
  async function saveVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !pack) return; setBusy(`save:${selected.id}`); setError(""); const form = new FormData(event.currentTarget); const nextPack = { ...pack, fullScript: String(form.get("fullScript") || ""), shortScript: String(form.get("shortScript") || "") };
    const response = await fetch(`/api/content-items/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, pack: nextPack, changeSummary: form.get("changeSummary") }) });
    if (!response.ok) { setError(await readError(response)); setBusy(""); return; } const body = await response.json() as { item: Partial<ContentItem> & { id: string } }; setItems((current) => replaceItem(current, body.item)); setBusy("");
  }

  if (loading) return <div className="management-state" role="status">正在载入内容生产…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入内容生产</strong><p>{error}</p></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><span aria-hidden="true">✦</span><h2>请先创建客户项目</h2><p>每份生产包必须归属于明确的客户项目。</p></div>;
  return <div className="production-workspace"><div className="management-toolbar production-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>客户项目<select value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); await loadWorkspace(organizationId, id); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>{items.length} 个内容任务</span></div>{error && <div className="inline-alert" role="alert">{error}</div>}
    <div className="production-layout"><aside className="panel production-list"><div className="panel-heading"><div><p className="section-kicker">版本化创作</p><h2>生产任务</h2></div></div>{items.length ? <div className="production-items">{items.map((item) => <button type="button" className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><span className="status neutral">v{item.current_version}</span><strong>{item.title}</strong><small>{item.generation_mode === "ai" ? "AI 生产包" : item.generation_mode === "manual" ? "人工修订" : "结构草稿"}</small></button>)}</div> : <div className="list-empty">还没有进入生产的选题。</div>}{canWrite && availableTopics.length > 0 && <section className="topic-backlog"><h3>待生产选题</h3>{availableTopics.slice(0, 12).map((topic) => <div key={topic.id}><span><strong>{topic.title}</strong><small>P{topic.priority} · {topic.status === "selected" ? "已入选" : "选题池"}</small></span><button type="button" disabled={Boolean(busy)} onClick={() => createItem(topic.id)}>{busy === `create:${topic.id}` ? "创建中…" : "进入生产"}</button></div>)}</section>}</aside>
      <main className="panel production-editor">{selected && pack ? <><div className="production-editor-head"><div><p className="section-kicker">{selected.generation_mode === "ai" ? `提示词 ${selected.prompt_version || "已记录"}` : "可编辑结构草稿"}</p><h2>{selected.title}</h2><span>当前版本 v{selected.current_version} · 每次保存都会创建不可变新版本</span></div>{canWrite && <div className="generation-actions"><select name="modelProfile" aria-label="模型档位" defaultValue="standard" id={`profile-${selected.id}`}><option value="fast">快速</option><option value="standard">标准</option><option value="advanced">高级</option></select><button type="button" disabled={Boolean(busy)} onClick={() => { const element = document.getElementById(`profile-${selected.id}`) as HTMLSelectElement | null; void generateItem(selected.id, element?.value || "standard"); }}>{busy === `generate:${selected.id}` ? "生成中…" : "AI 生成新版本"}</button></div>}</div>
        <form key={`${selected.id}:${selected.current_version}`} className="production-form" onSubmit={saveVersion}><section><label>完整口播稿<textarea name="fullScript" rows={16} defaultValue={pack.fullScript} readOnly={!canWrite} /></label><label>精简版<textarea name="shortScript" rows={7} defaultValue={pack.shortScript} readOnly={!canWrite} /></label>{canWrite && <div className="save-version"><input name="changeSummary" maxLength={500} placeholder="本次修改说明（可选）" /><button disabled={Boolean(busy)}>{busy === `save:${selected.id}` ? "保存中…" : "保存为新版本"}</button></div>}</section>
          <aside className="production-pack"><section><h3>开头备选</h3>{pack.hooks.map((item) => <p key={item}>{item}</p>)}</section><section><h3>分镜脚本</h3>{pack.storyboard.map((item, index) => <article key={`${item.shot}-${index}`}><strong>{item.shot} · {item.durationSec}s</strong><p>{item.visual}</p><small>{item.performance}</small></article>)}</section><section><h3>封面与发布</h3><div className="plain-chips">{pack.coverCopy.map((item) => <span key={item}>{item}</span>)}</div>{pack.publishTitles.map((item) => <p key={item}>{item}</p>)}</section><section><h3>素材与表演</h3>{[...pack.performanceNotes, ...pack.brollSuggestions].map((item) => <p key={item}>{item}</p>)}</section>{pack.riskNotes.length > 0 && <section className="risk-pack"><h3>发布前确认</h3>{pack.riskNotes.map((item) => <p key={item}>{item}</p>)}</section>}<section><h3>事实引用</h3>{pack.citations.map((item) => <p key={`${item.sourceType}:${item.sourceId}`}>{item.quote}<small>{item.sourceType}</small></p>)}</section></aside></form></> : <div className="production-empty"><span aria-hidden="true">✦</span><h2>从选题开始一份生产包</h2><p>先创建结构草稿，再用已确认知识和当前策略生成可审核口播稿。</p></div>}</main>
    </div>
  </div>;
}
