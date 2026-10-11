"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, BookOpenText, BrainCircuit, BriefcaseBusiness, ChartNoAxesCombined, ChevronDown, ClipboardCheck, FileChartColumn, FilePenLine, FolderOpen, Images, LayoutDashboard, LibraryBig, Lightbulb, Sparkles, LogOut, Search, Send, Settings, ShoppingBag, UsersRound, Video, WandSparkles } from "lucide-react";
import { preferredOrganizationId, preferredProjectId, scopeChangeEvent } from "../lib/client-scope";
import { deliveryPlan, type DeliveryFeature } from "../lib/delivery-entitlements";

import { clearEcommerceNavigationCache, EcommerceNavLink } from "./ecommerce/EcommerceNavLink";

type NavigationItem = { label: string; icon: typeof LayoutDashboard; href: string; feature?: DeliveryFeature };
type NavigationGroup = { label: string; items: NavigationItem[] };

const navGroups: NavigationGroup[] = [
  { label: "运营工作", items: [
    { label: "工作台", icon: LayoutDashboard, href: "/" },
    { label: "企业空间", icon: BriefcaseBusiness, href: "/projects" },
    { label: "选题中心", icon: Lightbulb, href: "/topics" },
    { label: "内容生产", icon: FilePenLine, href: "/content" },
    { label: "电商中心", icon: ShoppingBag, href: "/content/ecommerce" },
    { label: "公众号图片", icon: Images, href: "/wechat-images", feature: "wechatImages" },
    { label: "审核中心", icon: ClipboardCheck, href: "/workflow?view=review" },
  ] },
  { label: "研究与资产", items: [
    { label: "视频分析", icon: Video, href: "/analysis", feature: "videoAnalysis" },
    { label: "口播改写", icon: WandSparkles, href: "/script-rewrite" },
    { label: "对标内容库", icon: LibraryBig, href: "/analysis?view=benchmark", feature: "videoAnalysis" },
    { label: "品牌知识库", icon: BookOpenText, href: "/knowledge" }, { label: "项目记忆", icon: BrainCircuit, href: "/memory" }, { label: "灵感卡片", icon: Sparkles, href: "/inspiration" },
    { label: "素材中心", icon: FolderOpen, href: "/analysis?view=assets", feature: "videoAnalysis" },
  ] },
  { label: "增长复盘", items: [
    { label: "发布管理", icon: Send, href: "/workflow?view=publish" },
    { label: "数据复盘", icon: ChartNoAxesCombined, href: "/insights?view=overview", feature: "insights" },
    { label: "报告中心", icon: FileChartColumn, href: "/insights?view=reports", feature: "insights" },
  ] },
];

type Organization = { id: string; name: string };
type Project = { id: string; name: string; client_name: string };
type CurrentUser = { id: string; email: string; displayName: string };

type NavigationContext = { project: Project | null; organizationId: string; user: CurrentUser | null };
const emptyContext: NavigationContext = { project: null, organizationId: "", user: null };
// Browser-memory snapshot survives client navigation, but not logout or a full reload.
let lastContext: NavigationContext = emptyContext;
function initialNavigationContext() {
  if (typeof window === "undefined") return emptyContext;
  const query = new URLSearchParams(window.location.search);
  const org = query.get("organizationId"), project = query.get("projectId");
  if (org && org !== lastContext.organizationId || project && project !== lastContext.project?.id) return emptyContext;
  return lastContext;
}

function avatarText(name: string) {
  const value = name.trim();
  if (!value) return "…";
  if (/^[\u3400-\u9fff]/u.test(value)) return value.slice(0, 1);
  const words = value.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? value.slice(0, 2)).toUpperCase();
}

export function AppShell({ children, activePath }: { children: ReactNode; activePath: string }) {
  const [context, setContext] = useState<NavigationContext>(initialNavigationContext);
  const { project, organizationId, user } = context;

  useEffect(() => {
    let active = true; let requestVersion = 0;
    async function loadContext(requestedOrganizationId = "", requestedProjectId = "") {
      const version = ++requestVersion;
      if (requestedOrganizationId && requestedOrganizationId !== lastContext.organizationId || requestedProjectId && requestedProjectId !== lastContext.project?.id) {
        lastContext = emptyContext; setContext(emptyContext);
      }
      const organizationResponse = await fetch("/api/organizations");
      if (!active || version !== requestVersion) return;
      if (organizationResponse.status === 401) {
        lastContext = emptyContext; clearEcommerceNavigationCache(); setContext(emptyContext);
        const returnTo = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      if (!organizationResponse.ok) return;
      const body = await organizationResponse.json() as { organizations: Organization[]; currentUser: CurrentUser };
      const nextOrganizationId = preferredOrganizationId(body.organizations, requestedOrganizationId);
      if (!active || version !== requestVersion) return;
      const keepProject = lastContext.user?.id === body.currentUser.id && lastContext.organizationId === nextOrganizationId;
      if (!keepProject) { lastContext = { user: body.currentUser, organizationId: nextOrganizationId, project: null }; setContext(lastContext); }
      if (!nextOrganizationId) return;
      const projectResponse = await fetch(`/api/projects?organizationId=${encodeURIComponent(nextOrganizationId)}`);
      if (!active || version !== requestVersion) return;
      if (projectResponse.status === 401 || projectResponse.status === 403 || projectResponse.status === 404) {
        lastContext = { user: body.currentUser, organizationId: nextOrganizationId, project: null };
        setContext(lastContext); clearEcommerceNavigationCache(); return;
      }
      if (!projectResponse.ok) return;
      const projectBody = await projectResponse.json() as { projects: Project[] };
      const nextProjectId = preferredProjectId(projectBody.projects, requestedProjectId);
      if (active && version === requestVersion) {
        lastContext = { user: body.currentUser, organizationId: nextOrganizationId, project: projectBody.projects.find((item) => item.id === nextProjectId) ?? null };
        setContext(lastContext);
      }
    }
    const query = new URLSearchParams(window.location.search);
    void loadContext(query.get("organizationId") ?? "", query.get("projectId") ?? "");
    const onScopeChange = (event: Event) => { const detail = (event as CustomEvent<{ organizationId?: string; projectId?: string }>).detail; void loadContext(detail?.organizationId, detail?.projectId); };
    window.addEventListener(scopeChangeEvent, onScopeChange);
    return () => { active = false; window.removeEventListener(scopeChangeEvent, onScopeChange); };
  }, []);

  const projectName = project?.name || "尚未选择企业空间";
  const projectHref = organizationId && project ? `/projects?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(project.id)}` : "/projects";
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="利明智耀工作台首页"><span className="brand-mark" aria-hidden="true">利</span><span>利明智耀</span></Link>
        <Link className="project-switcher" href={projectHref} aria-label={`切换企业空间，当前为${projectName}`}><span className="project-logo">{project ? projectName.slice(0, 1) : "—"}</span><span className="project-copy"><small>当前企业空间</small><strong>{projectName}</strong></span><ChevronDown className="project-chevron" aria-hidden="true" /></Link>
        <div className="top-actions">
          <Link className="search-button" href="/search" aria-label="全局搜索"><Search className="top-icon" aria-hidden="true" /><span>搜索内容、视频或成员</span><kbd>⌘ K</kbd></Link>
          <Link className="icon-button notification" href="/settings#alerts" aria-label="查看运行告警"><Bell className="top-icon" aria-hidden="true" /><i /></Link>
          <button className="icon-button signout-button" type="button" aria-label="退出当前账号" title="退出登录" onClick={async () => { await fetch("/api/auth/session", { method: "DELETE" }); lastContext = emptyContext; clearEcommerceNavigationCache(); window.location.replace("/login"); }}><LogOut className="top-icon" aria-hidden="true" /></button>
          <Link className="avatar" href="/settings" aria-label={user ? `打开${user.displayName}的设置` : "打开成员设置"} title={user?.displayName || undefined}>{avatarText(user?.displayName || "")}</Link>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <nav>{navGroups.map((group) => ({ ...group, items: group.items.filter((item) => !item.feature || deliveryPlan.features[item.feature]) })).filter((group) => group.items.length > 0).map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => { const Icon = item.icon; const active = activePath === item.href; if (item.href === "/content/ecommerce") return <EcommerceNavLink key={`${user?.id ?? ""}:${organizationId}:${project?.id ?? ""}`} userId={user?.id ?? ""} organizationId={organizationId} projectId={project?.id ?? ""} active={active} pagePath={activePath} />; return <Link className={active ? "nav-item active" : "nav-item"} href={item.href} key={`${group.label}:${item.href}`} aria-current={active ? "page" : undefined}><Icon className="nav-icon" aria-hidden="true" /><strong>{item.label}</strong></Link>; })}</div>)}</nav>
        <div className="sidebar-footer"><Link className={activePath === "/members" ? "nav-item active" : "nav-item"} href="/members"><UsersRound className="nav-icon" aria-hidden="true" /><strong>成员与权限</strong></Link><Link className={activePath === "/settings" ? "nav-item active" : "nav-item"} href="/settings"><Settings className="nav-icon" aria-hidden="true" /><strong>系统设置</strong></Link></div>
      </aside>

      <main id="main" className="workspace">{children}</main>
    </div>
  );
}
