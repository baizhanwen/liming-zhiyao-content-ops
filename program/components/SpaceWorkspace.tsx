"use client";

import { ArrowRight, BookOpenText, BrainCircuit, ListChecks } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatClientDate, readApiError } from "../lib/client-format";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope } from "../lib/client-scope";
import { spaceProjectStatus, type SpaceTab } from "../lib/space-navigation";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace";
import { ProjectMemoryWorkspace } from "./ProjectMemoryWorkspace";
import "./space-workspace.css";

type Organization = { id: string; name: string };
type Project = {
  id: string;
  name: string;
  status: string;
  service_starts_at: string | null;
  service_ends_at: string | null;
  content_target: number;
  member_count: number;
};

type SpaceState =
  | { status: "loading" }
  | { status: "empty" | "error"; title: string; description: string; managementHref: string }
  | { status: "ready"; organization: Organization; project: Project };

const shortcuts = [
  { tab: "knowledge", title: "品牌知识", description: "品牌事实、案例、客户问题与用语规范", icon: BookOpenText },
  { tab: "strategy", title: "内容策略", description: "账号定位、目标人群、内容支柱与阶段目标", icon: ListChecks },
  { tab: "memory", title: "项目记忆", description: "从素材和反馈中沉淀的经验与待采纳候选", icon: BrainCircuit },
] as const;

export function SpaceWorkspace({ tab, requestedOrganizationId, requestedProjectId }: {
  tab: SpaceTab;
  requestedOrganizationId: string;
  requestedProjectId: string;
}) {
  const [state, setState] = useState<SpaceState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let managementHref = "/projects";
    async function loadSpace() {
      try {
        const organizationsResponse = await fetch("/api/organizations", { signal });
        if (!organizationsResponse.ok) throw new Error(await readApiError(organizationsResponse));
        const { organizations } = await organizationsResponse.json() as { organizations: Organization[] };
        if (signal.aborted) return;
        const organizationId = requestedOrganizationId || preferredOrganizationId(organizations);
        const organization = organizations.find((entry) => entry.id === organizationId);

        if (!organization) {
          setState(organizationId
            ? { status: "empty", title: "无法访问链接中的公司", description: "请从企业空间列表选择有权访问的公司和空间。", managementHref }
            : { status: "empty", title: "还没有可用的公司", description: "创建公司或接受团队邀请后，即可查看企业空间资料。", managementHref });
          return;
        }

        const organizationQuery = new URLSearchParams({ organizationId });
        managementHref = `/projects?${organizationQuery}`;
        const projectsResponse = await fetch(`/api/projects?${organizationQuery}`, { signal });
        if (!projectsResponse.ok) throw new Error(await readApiError(projectsResponse));
        const { projects } = await projectsResponse.json() as { projects: Project[] };
        if (signal.aborted) return;
        const projectId = requestedProjectId || preferredProjectId(projects.filter((entry) => entry.status !== "archived"));
        const project = projects.find((entry) => entry.id === projectId);
        if (project?.status === "archived") {
          setState({ status: "empty", title: "该企业空间已归档", description: "请在企业空间管理中选择一个可用空间。公司管理员可以在策略总览查看历史策略。", managementHref });
          return;
        }

        if (!project) {
          setState(projectId
            ? { status: "empty", title: "无法访问链接中的企业空间", description: "请从企业空间列表选择一个可访问的空间。", managementHref }
            : { status: "empty", title: "还没有可用的企业空间", description: "公司管理员可以创建企业空间，或为你分配已有空间。", managementHref });
          return;
        }

        rememberCurrentScope(organizationId, project.id);
        setState({ status: "ready", organization, project });
      } catch (error) {
        if (!signal.aborted) setState({
          status: "error",
          title: "空间资料加载失败",
          description: error instanceof Error ? error.message : "请稍后重试。",
          managementHref,
        });
      }
    }
    void loadSpace();
    return () => controller.abort();
  }, [requestedOrganizationId, requestedProjectId]);

  if (state.status === "loading") return <div className="management-state" role="status">正在载入空间资料…</div>;
  if (state.status !== "ready") return <section className="empty-panel">
    <h2>{state.title}</h2><p role={state.status === "error" ? "alert" : undefined}>{state.description}</p>
    <Link className="secondary-link" href={state.managementHref}>前往企业空间</Link>
  </section>;

  const { organization, project } = state;
  if (tab === "memory") return <ProjectMemoryWorkspace organizationId={organization.id} projectId={project.id} />;
  if (tab !== "overview") return <KnowledgeWorkspace key={`${organization.id}:${project.id}:${tab}`} organizationId={organization.id} projectId={project.id} projectName={project.name} tab={tab} />;
  const scope = new URLSearchParams({ organizationId: organization.id, projectId: project.id });

  return <div className="space-overview">
    <section className="panel">
      <div className="panel-heading space-overview-heading">
        <div className="space-overview-identity">
          <span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1)}</span>
          <div><h2>{project.name}</h2><p>{organization.name}</p></div>
          <span className={`status ${project.status === "active" ? "success" : "neutral"}`}>{spaceProjectStatus[project.status] || "状态待确认"}</span>
        </div>
        <Link className="secondary-link" href={`/projects?${scope}`}>管理企业空间</Link>
      </div>
      <dl className="space-overview-details">
        <div><dt>月内容目标</dt><dd>{project.content_target ? `${project.content_target} 条` : "未设置"}</dd></div>
        <div><dt>已分配成员</dt><dd>{project.member_count} 人</dd></div>
        <div><dt>服务开始</dt><dd>{formatClientDate(project.service_starts_at, "fullDate", "未设置")}</dd></div>
        <div><dt>服务结束</dt><dd>{formatClientDate(project.service_ends_at, "fullDate", "未设置")}</dd></div>
      </dl>
    </section>
    <nav className="space-shortcuts" aria-label="空间资料快捷入口">
      {shortcuts.map(({ tab: id, title, description, icon: Icon }) => <Link className="panel space-shortcut" key={id} href={`/space?${scope}&tab=${id}`}>
        <span className="space-shortcut-icon"><Icon aria-hidden="true" /></span>
        <span><strong>{title}</strong><small>{description}</small></span>
        <ArrowRight className="space-shortcut-arrow" aria-hidden="true" />
      </Link>)}
    </nav>
  </div>;
}
