"use client";

import { SplitWorkspace } from "./SplitWorkspace";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { readApiError as messageFrom } from "../lib/client-format";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { spaceProjectStatus } from "../lib/space-navigation";
import { OrganizationStrategyOverview } from "./KnowledgeWorkspace";
import "./space-workspace.css";

type Organization = { id: string; name: string; role: string };
type Project = { id: string; name: string; status: string; service_starts_at: string | null; service_ends_at: string | null; content_target: number; member_count: number };

export function ProjectManager({ requestedOrganizationId, requestedProjectId, strategyOverview }: {
  requestedOrganizationId: string;
  requestedProjectId: string;
  strategyOverview: boolean;
}) {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizationRole, setOrganizationRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState("");

  const loadProjects = useCallback(async (id: string, requested = "", signal?: AbortSignal) => {
    const response = await scopedFetch(`/api/projects?organizationId=${encodeURIComponent(id)}`, { signal });
    if (!response.ok) throw new Error(await messageFrom(response));
    const body = await response.json() as { projects: Project[]; organizationRole: string };
    if (signal?.aborted) return;
    const nextProjectId = preferredProjectId(body.projects.filter((project) => project.status !== "archived"), requested);
    setOrganizationId(id); setProjects(body.projects); setCurrentProjectId(nextProjectId);
    setOrganizationRole(body.organizationRole);
    rememberCurrentScope(id, nextProjectId);
    return nextProjectId;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const response = await fetch("/api/organizations", { signal });
        if (!response.ok) throw new Error(await messageFrom(response));
        const body = await response.json() as { organizations: Organization[] };
        if (signal.aborted) return;
        setOrganizations(body.organizations);
        const first = preferredOrganizationId(body.organizations, requestedOrganizationId);
        if (first) await loadProjects(first, requestedProjectId, signal);
      } catch (reason) { if (!signal.aborted) setError(reason instanceof Error ? reason.message : "加载失败"); }
      finally { if (!signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [loadProjects, requestedOrganizationId, requestedProjectId]);

  async function switchOrganization(id: string) {
    setError("");
    setLoading(true);
    try {
      const projectId = await loadProjects(id);
      const scope = new URLSearchParams({ organizationId: id });
      if (projectId) scope.set("projectId", projectId);
      if (strategyOverview) scope.set("view", "strategies");
      router.replace(`/projects?${scope}`, { scroll: false });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
    finally { setLoading(false); }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await scopedFetch("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
    if (!response.ok) { setError(await messageFrom(response)); setSaving(false); return; }
    const body = await response.json() as { organization: Organization };
    setOrganizations([body.organization]); setOrganizationId(body.organization.id); setOrganizationRole("admin"); setProjects([]); setCurrentProjectId(""); rememberCurrentScope(body.organization.id); setSaving(false);
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await scopedFetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: form.get("name"), serviceStartsAt: form.get("serviceStartsAt"), serviceEndsAt: form.get("serviceEndsAt"), contentTarget: Number(form.get("contentTarget")) }) });
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
    setUpdatingId(project.id);
    setError("");
    try {
      const response = await scopedFetch("/api/projects", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId: project.id, status }) });
      if (!response.ok) { setError(await messageFrom(response)); return; }
      const updated = projects.map((item) => item.id === project.id ? { ...item, status } : item);
      setProjects(updated);
      if (!currentProjectId || (project.id === currentProjectId && status === "archived")) {
        const nextId = preferredProjectId(updated.filter((item) => item.status !== "archived"));
        setCurrentProjectId(nextId);
        rememberCurrentScope(organizationId, nextId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新状态失败。");
    } finally { setUpdatingId(""); }
  }

  if (loading) return <div className="management-state" role="status">正在载入企业空间…</div>;
  if (error && !organizationId) return <div className="management-state error-state"><strong>企业空间加载失败</strong><p role="alert">{error}</p></div>;
  if (organizations.length === 0) return <section className="setup-card"><span className="setup-step">第一步</span><h2>创建你的公司空间</h2><p>公司空间负责隔离企业空间、成员、媒体和审计记录。创建者将成为公司管理员。</p><form className="stack-form" onSubmit={createOrganization}><label>公司名称<input name="name" required minLength={2} maxLength={80} placeholder="例如：利明智耀新媒体" /></label><button className="primary-button" disabled={saving}>{saving ? "正在创建…" : "创建公司空间"}</button></form></section>;

  const isAdmin = organizationRole === "admin";
  const scope = new URLSearchParams({ organizationId });
  if (currentProjectId) scope.set("projectId", currentProjectId);

  return (
    <div className="space-management">
      <div className="management-toolbar space-management-toolbar">
        <label>公司<select value={organizationId} disabled={saving || Boolean(updatingId)} onChange={(event) => void switchOrganization(event.target.value)}>
          {organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}
        </select></label>
        <div className="space-management-actions">
          {strategyOverview
            ? <Link className="secondary-link" href={`/projects?${scope}`}>返回空间列表</Link>
            : <>
              {currentProjectId && <Link className="secondary-link" href={`/space?${scope}`}>查看当前空间资料</Link>}
              {isAdmin && <Link className="secondary-link" href={`/projects?${scope}&view=strategies`}>策略总览</Link>}
            </>}
        </div>
      </div>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {strategyOverview ? (isAdmin
        ? <OrganizationStrategyOverview key={organizationId} organizationId={organizationId} />
        : <div className="empty-panel"><h2>策略总览仅向公司管理员开放</h2><p>企业空间成员可以在空间资料中查看当前空间的内容策略。</p></div>
      ) : <SplitWorkspace className={`management-layout${isAdmin ? "" : " read-only"}`}>
        <section className="management-main">
          {projects.length === 0 ? <div className="empty-panel">
            <h2>没有可访问的企业空间</h2>
            <p>{isAdmin ? "创建企业空间后，即可分配成员并开始协作。" : "请联系公司管理员分配企业空间。"}</p>
          </div> : <div className="project-card-grid">{projects.map((project) => {
            const isCurrent = project.id === currentProjectId;
            const projectScope = new URLSearchParams({ organizationId, projectId: project.id });
            return <article className={`project-card${isCurrent ? " current" : ""}`} key={project.id}>
              <div className="project-card-top">
                <span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1)}</span>
                {isAdmin ? <select className="inline-select" aria-label={`${project.name}的空间状态`} value={project.status} disabled={saving || Boolean(updatingId)} onChange={(event) => void updateProjectStatus(project, event.target.value)}>
                  {Object.entries(spaceProjectStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select> : <span className={`status ${project.status === "active" ? "success" : "neutral"}`}>{spaceProjectStatus[project.status] || "状态待确认"}</span>}
              </div>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>月内容目标</dt><dd>{project.content_target ? `${project.content_target} 条` : "未设置"}</dd></div>
                <div><dt>已分配成员</dt><dd>{project.member_count} 人</dd></div>
              </dl>
              <div className="project-card-footer">
                <span>{project.service_starts_at || "待确认开始时间"}</span>
                <div>
                  <Link href={`/members?${projectScope}`}>{isAdmin ? "分配成员" : "查看成员"}</Link>
                  {project.status !== "archived" && <button type="button" className="project-enter-button" disabled={isCurrent || saving || Boolean(updatingId)} onClick={() => enterProject(project.id)}>{isCurrent ? "当前空间" : "进入空间 →"}</button>}
                </div>
              </div>
            </article>;
          })}</div>}
        </section>
        {isAdmin && <aside className="create-panel"><h2>创建企业空间</h2><form className="stack-form" onSubmit={createProject}><label>空间名称<input name="name" required minLength={2} maxLength={80} placeholder="例如：短视频内容运营空间" /></label><div className="form-row"><label>开始日期<input name="serviceStartsAt" type="date" /></label><label>结束日期<input name="serviceEndsAt" type="date" /></label></div><label>月内容目标<input name="contentTarget" type="number" min="0" max="999" defaultValue="12" /></label><button className="primary-button" disabled={saving || Boolean(updatingId)}>{saving ? "正在创建…" : "创建企业空间"}</button></form></aside>}
      </SplitWorkspace>}
    </div>
  );
}
