"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope } from "../lib/client-scope";

type Organization = { id: string; name: string; role: string };
type Project = { id: string; name: string; client_name: string; status: string; service_starts_at: string | null; service_ends_at: string | null; content_target: number; member_count: number };

async function messageFrom(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "请求没有完成，请稍后重试。";
}

export function ProjectManager() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizationRole, setOrganizationRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState("");

  const loadProjects = useCallback(async (id: string) => {
    if (!id) return;
    const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(await messageFrom(response));
    const body = await response.json() as { projects: Project[]; organizationRole: string };
    const nextProjectId = preferredProjectId(body.projects);
    setProjects(body.projects); setCurrentProjectId(nextProjectId); rememberCurrentScope(id, nextProjectId);
    setOrganizationRole(body.organizationRole);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/organizations");
        if (!response.ok) throw new Error(await messageFrom(response));
        const body = await response.json() as { organizations: Organization[] };
        if (!active) return;
        setOrganizations(body.organizations);
        const first = preferredOrganizationId(body.organizations);
        setOrganizationId(first);
        if (first) await loadProjects(first);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [loadProjects]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
    if (!response.ok) { setError(await messageFrom(response)); setSaving(false); return; }
    const body = await response.json() as { organization: Organization };
    setOrganizations([body.organization]); setOrganizationId(body.organization.id); setOrganizationRole("admin"); setProjects([]); setCurrentProjectId(""); rememberCurrentScope(body.organization.id); setSaving(false);
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: form.get("name"), clientName: form.get("clientName"), serviceStartsAt: form.get("serviceStartsAt"), serviceEndsAt: form.get("serviceEndsAt"), contentTarget: Number(form.get("contentTarget")) }) });
    if (!response.ok) { setError(await messageFrom(response)); setSaving(false); return; }
    const body = await response.json() as { project: Project };
    setProjects((current) => [body.project, ...current]); setCurrentProjectId(body.project.id); rememberCurrentScope(organizationId, body.project.id); formElement.reset(); setSaving(false);
  }

  function enterProject(projectId: string) {
    setCurrentProjectId(projectId);
    rememberCurrentScope(organizationId, projectId);
    window.location.assign(`/?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`);
  }

  async function updateProjectStatus(project: Project, status: string) {
    setUpdatingId(project.id); setError(""); const response = await fetch("/api/projects", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId: project.id, status }) });
    if (!response.ok) setError(await messageFrom(response)); else setProjects((items) => items.map((item) => item.id === project.id ? { ...item, status } : item)); setUpdatingId("");
  }

  if (loading) return <div className="management-state" role="status">正在载入客户项目…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入项目空间</strong><p>{error}</p><small>请确认本地身份配置和数据库迁移已经完成。</small></div>;
  if (organizations.length === 0) return <section className="setup-card"><span className="setup-step">第一步</span><h2>创建你的公司空间</h2><p>公司空间负责隔离客户项目、成员、媒体和审计记录。创建者将成为公司管理员。</p><form className="stack-form" onSubmit={createOrganization}><label>公司名称<input name="name" required minLength={2} maxLength={80} placeholder="例如：利明智耀新媒体" /></label><button className="primary-button" disabled={saving}>{saving ? "正在创建…" : "创建公司空间"}</button></form></section>;

  return (
    <div className="management-layout">
      <section className="management-main">
        <div className="management-toolbar"><label>公司空间<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); setLoading(true); try { await loadProjects(id); } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); } finally { setLoading(false); } }}>{organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}</select></label><span>{projects.length} 个客户项目</span></div>
        {error && <div className="inline-alert" role="alert">{error}</div>}
        {projects.length === 0 ? <div className="empty-panel"><h2>还没有客户项目</h2><p>创建第一个项目后，就能分配成员并建立独立的客户内容空间。</p></div> : <div className="project-card-grid">{projects.map((project) => { const isCurrent = project.id === currentProjectId; return <article className={`project-card${isCurrent ? " current" : ""}`} key={project.id}><div className="project-card-top"><span className="project-monogram">{project.client_name.slice(0, 1)}</span>{organizationRole === "admin" ? <select className="inline-select" value={project.status} disabled={updatingId === project.id} onChange={(event) => updateProjectStatus(project, event.target.value)}><option value="draft">筹备中</option><option value="active">运行中</option><option value="paused">已暂停</option><option value="archived">已归档</option></select> : <span className={`status ${project.status === "active" ? "success" : "warning"}`}>{project.status === "active" ? "运行中" : project.status === "paused" ? "已暂停" : project.status === "archived" ? "已归档" : "筹备中"}</span>}</div><h2>{project.name}</h2><p>{project.client_name}</p><dl><div><dt>内容目标</dt><dd>{project.content_target || "未设置"}{project.content_target ? " 条/月" : ""}</dd></div><div><dt>项目成员</dt><dd>{project.member_count} 人</dd></div></dl><div className="project-card-footer"><span>{project.service_starts_at || "待确认开始时间"}</span><div><a href={`/members?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(project.id)}`}>分配成员</a><button type="button" className="project-enter-button" disabled={isCurrent} onClick={() => enterProject(project.id)}>{isCurrent ? "当前项目" : "进入项目 →"}</button></div></div></article>; })}</div>}
      </section>
      {organizationRole === "admin" && <aside className="create-panel"><p className="section-kicker">新客户项目</p><h2>建立独立协作空间</h2><p>创建后自动成为项目负责人，后续可在成员页邀请策划、审核人和客户。</p><form className="stack-form" onSubmit={createProject}><label>项目名称<input name="name" required minLength={2} maxLength={80} placeholder="例如：短视频内容运营" /></label><label>客户名称<input name="clientName" required minLength={2} maxLength={80} placeholder="填写客户或品牌名称" /></label><div className="form-row"><label>开始日期<input name="serviceStartsAt" type="date" /></label><label>结束日期<input name="serviceEndsAt" type="date" /></label></div><label>月内容目标<input name="contentTarget" type="number" min="0" max="999" defaultValue="12" /></label><button className="primary-button" disabled={saving}>{saving ? "正在创建…" : "创建客户项目"}</button></form></aside>}
    </div>
  );
}
