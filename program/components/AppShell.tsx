"use client";

import type { ReactNode } from "react";
import { createContext, startTransition, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { navigateClientSide } from "vinext/shims/navigation";
import { Bell, BookOpenText, ChartNoAxesCombined, ChevronDown, ClipboardCheck, FilePenLine, FolderOpen, Images, LayoutDashboard, LogOut, Menu, Search, Settings, ShoppingBag, UsersRound, X } from "lucide-react";
import { preferredOrganizationId, preferredProjectId, scopeChangeEvent } from "../lib/client-scope";
import { deliveryPlan, type DeliveryFeature } from "../lib/delivery-entitlements";

import { clearEcommerceNavigationCache, EcommerceNavLink } from "./ecommerce/EcommerceNavLink";
import { useWorkspaceScroll } from "./useWorkspaceScroll";
import "./workbench-shell.css";

type NavigationItem = { label: string; icon: typeof LayoutDashboard; href: string; feature?: DeliveryFeature };
type NavigationGroup = { label: string; items: NavigationItem[] };

const navGroups: NavigationGroup[] = [
  { label: "运营工作", items: [
    { label: "工作台", icon: LayoutDashboard, href: "/" },
    { label: "素材中心", icon: FolderOpen, href: "/analysis", feature: "videoAnalysis" },
    { label: "创作中心", icon: FilePenLine, href: "/studio" },
    { label: "审核发布", icon: ClipboardCheck, href: "/workflow" },
    { label: "数据报告", icon: ChartNoAxesCombined, href: "/insights", feature: "insights" },
    { label: "空间资料", icon: BookOpenText, href: "/space" },
  ] },
  { label: "专项工具", items: [
    { label: "电商中心", icon: ShoppingBag, href: "/ecommerce" },
    { label: "公众号图片", icon: Images, href: "/wechat-images", feature: "wechatImages" },
  ] },
];

const visibleGroups = navGroups.map((group) => ({
  ...group,
  items: group.items.filter((item) => !item.feature || deliveryPlan.features[item.feature]),
})).filter((group) => group.items.length > 0);

type Organization = { id: string; name: string };
type Project = { id: string; name: string; status: string };
type CurrentUser = { id: string; email: string; displayName: string };

type Scope = { organizationId: string; projectId: string };
type NavigationContext = { project: Project | null; organizationId: string; organizationName: string; user: CurrentUser | null; routeScope: string };
const emptyContext: NavigationContext = { project: null, organizationId: "", organizationName: "", user: null, routeScope: "" };
export const NavigationScope = createContext<Scope>({ organizationId: "", projectId: "" });

export function scopedNavigationHref(href: string, { organizationId, projectId }: Scope) {
  if (!organizationId) return href;
  const url = new URL(href, "http://localhost");
  url.searchParams.set("organizationId", organizationId);
  if (projectId) url.searchParams.set("projectId", projectId);
  else url.searchParams.delete("projectId");
  return `${url.pathname}${url.search}${url.hash}`;
}

function pathname(href: string) {
  return href.split(/[?#]/, 1)[0];
}

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

function BrandMark() {
  return (
    <svg className="shell-brand-mark" width="38" height="38" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      <path d="M2 8a6 6 0 0 1 6-6h4a4 4 0 0 1 4 4v10H6a4 4 0 0 1-4-4zM18 22v-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" />
      <rect x="21" y="2" width="9" height="10" rx="3" opacity=".83" />
      <rect x="2" y="21" width="10" height="9" rx="3" opacity=".78" />
    </svg>
  );
}

export function AppShell({ children, activePath }: { children: ReactNode; activePath: string }) {
  const [context, setContext] = useState<NavigationContext>(initialNavigationContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [pendingModule, setPendingModule] = useState<{ path: string } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const closeMenuButton = useRef<HTMLButtonElement>(null);
  const searchLink = useRef<HTMLAnchorElement>(null);
  const account = useRef<HTMLDetailsElement>(null);
  const shortcut = useRef<HTMLElement>(null);
  const { project, organizationId, organizationName, user } = context;
  const query = useSearchParams();
  const scrollPanel = useWorkspaceScroll(query?.toString() ?? "");
  const requestedOrganization = query?.get("organizationId") ?? "";
  const requestedProject = query?.get("projectId") ?? "";
  const routeScope = JSON.stringify([requestedOrganization, requestedProject]);

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
      const nextOrganizationName = body.organizations.find((item) => item.id === nextOrganizationId)?.name ?? "";
      const nextContext = { user: body.currentUser, organizationId: nextOrganizationId, organizationName: nextOrganizationName, routeScope };
      if (!active || version !== requestVersion) return;
      const keepProject = lastContext.user?.id === body.currentUser.id && lastContext.organizationId === nextOrganizationId;
      if (!keepProject) { lastContext = { ...nextContext, project: null }; setContext(lastContext); }
      if (!nextOrganizationId) return;
      const projectResponse = await fetch(`/api/projects?organizationId=${encodeURIComponent(nextOrganizationId)}`);
      if (!active || version !== requestVersion) return;
      if (projectResponse.status === 401 || projectResponse.status === 403 || projectResponse.status === 404) {
        lastContext = { ...nextContext, project: null };
        setContext(lastContext); clearEcommerceNavigationCache(); return;
      }
      if (!projectResponse.ok) return;
      const projectBody = await projectResponse.json() as { projects: Project[] };
      const projects = projectBody.projects.filter((item) => item.status !== "archived");
      const nextProjectId = preferredProjectId(projects, requestedProjectId);
      if (active && version === requestVersion) {
        lastContext = { ...nextContext, project: projects.find((item) => item.id === nextProjectId) ?? null };
        setContext(lastContext);
      }
    }
    void loadContext(requestedOrganization, requestedProject);
    const onScopeChange = (event: Event) => { const detail = (event as CustomEvent<{ organizationId?: string; projectId?: string }>).detail; void loadContext(detail?.organizationId, detail?.projectId); };
    window.addEventListener(scopeChangeEvent, onScopeChange);
    return () => { active = false; window.removeEventListener(scopeChangeEvent, onScopeChange); };
  }, [requestedOrganization, requestedProject, routeScope]);

  useEffect(() => {
    if (shortcut.current) shortcut.current.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
    function restorePage(event: PageTransitionEvent) {
      // A restored document may belong to a session that has since signed out.
      if (event.persisted) window.location.reload();
    }
    window.addEventListener("pageshow", restorePage);
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector('dialog[open], [aria-modal="true"]')) {
        event.preventDefault();
        searchLink.current?.click();
      }
      if (event.key === "Escape" && account.current?.open) {
        account.current.open = false;
        account.current.querySelector("summary")?.focus();
      }
    }
    function closeAccount(event: PointerEvent) {
      if (account.current?.open && event.target instanceof Node && !account.current.contains(event.target)) account.current.open = false;
    }
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", closeAccount);
    return () => {
      window.removeEventListener("pageshow", restorePage);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", closeAccount);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    closeMenuButton.current?.focus();
    const breakpoint = window.matchMedia("(max-width: 620px)");
    const onResize = () => { if (!breakpoint.matches) setMenuOpen(false); };
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = sidebar.current?.querySelectorAll<HTMLElement>("a[href], button");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", keydown);
    breakpoint.addEventListener("change", onResize);
    const trigger = menuButton.current;
    return () => {
      window.removeEventListener("keydown", keydown);
      breakpoint.removeEventListener("change", onResize);
      trigger?.focus({ preventScroll: true });
    };
  }, [menuOpen]);

  const projectName = project?.name || "尚未选择企业空间";
  const matchesRequestedScope = (!requestedOrganization || requestedOrganization === organizationId)
    && (!requestedProject || requestedProject === project?.id);
  const scope = organizationId && (context.routeScope === routeScope || matchesRequestedScope)
    ? { organizationId, projectId: project?.id ?? "" }
    : { organizationId: requestedOrganization, projectId: requestedProject };
  const projectHref = scopedNavigationHref("/projects", scope);
  const currentPath = pathname(activePath);
  async function signOut() {
    setSigningOut(true);
    setSignOutError("");
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Sign-out failed");
      lastContext = emptyContext;
      clearEcommerceNavigationCache();
      window.location.replace("/login");
    } catch {
      setSigningOut(false);
      setSignOutError("暂时无法确认退出结果，请重试。");
    }
  }
  function openModule(href: string) {
    const target = { path: pathname(href) };
    setMenuOpen(false);
    setPendingModule(target);
    // Start the router in click order, even while the first destination is loading.
    startTransition(() => {
      void navigateClientSide(href, "push", true, true).finally(() => {
        setPendingModule(current => current === target ? null : current);
      });
    });
  }

  function navigationLink({ href, label, icon: Icon }: NavigationItem) {
    const linkHref = href === "/" ? href : scopedNavigationHref(href, scope);
    const isCurrent = currentPath === href;
    const isPending = pendingModule?.path === href;
    const selected = pendingModule ? isPending : isCurrent;
    const link = (
      <Link key={href} className={selected ? "nav-item active" : "nav-item"} href={linkHref} aria-label={label} title={label}
        aria-current={isCurrent ? "page" : undefined} aria-busy={isPending || undefined} data-no-feedback
        onNavigate={event => { event.preventDefault(); openModule(linkHref); }}>
        <Icon className="nav-icon" aria-hidden="true" /><strong>{label}</strong>
      </Link>
    );
    if (href !== "/ecommerce") return link;
    const projectId = project?.id ?? "";
    return <EcommerceNavLink key={`${href}:${user?.id ?? ""}:${organizationId}:${projectId}`} userId={user?.id ?? ""} organizationId={organizationId} projectId={projectId} pagePath={activePath}>{link}</EcommerceNavLink>;
  }

  return (
    <div className="app-shell workbench-shell">
      <a className="shell-skip" href="#main">跳至主内容</a>
      {menuOpen && <button className="mobile-nav-backdrop" type="button" tabIndex={-1} data-no-feedback aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
      <aside ref={sidebar} id="module-navigation" className={menuOpen ? "sidebar mobile-open" : "sidebar"} aria-label="主导航" role={menuOpen ? "dialog" : undefined} aria-modal={menuOpen || undefined}>
        <div className="shell-brand-row">
          <Link className="shell-brand" href="/" aria-label="利明智耀工作台首页" onClick={() => setMenuOpen(false)}>
            <BrandMark /><span><strong>利明智耀</strong><small>创作者工作台</small></span>
          </Link>
          <button ref={closeMenuButton} className="shell-menu-close" type="button" aria-label="关闭模块导航" data-no-feedback onClick={() => setMenuOpen(false)}><X aria-hidden="true" /></button>
        </div>
        <nav aria-label="全部模块">
          {visibleGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map(navigationLink)}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          {navigationLink({ href: "/members", label: "成员与权限", icon: UsersRound })}
          {navigationLink({ href: "/settings", label: "系统设置", icon: Settings })}
          <Link className="project-switcher" href={projectHref} title={projectName} aria-label={`切换企业空间，当前为${[organizationName, projectName].filter(Boolean).join(" · ")}`} onClick={() => setMenuOpen(false)}>
            <span className="project-logo" aria-hidden="true">{project ? projectName.slice(0, 1) : "—"}</span>
            <span className="project-copy"><small>{organizationName || "当前企业空间"}</small><strong>{projectName}</strong></span>
            <ChevronDown className="project-chevron" aria-hidden="true" />
          </Link>
        </div>
      </aside>
      <div className="shell-paper" ref={scrollPanel} inert={menuOpen}>
        <header className="topbar">
          <button ref={menuButton} className="shell-menu-trigger" type="button" data-no-feedback aria-label="打开模块导航" aria-expanded={menuOpen} aria-controls="module-navigation" onClick={() => setMenuOpen(true)}>
            <Menu aria-hidden="true" />
          </button>
          <Link className="shell-mobile-brand" href="/" aria-label="利明智耀工作台首页"><BrandMark />利明智耀</Link>
          <Link ref={searchLink} className="search-button" href={scopedNavigationHref("/search", scope)} aria-label="全局搜索">
            <Search className="top-icon" aria-hidden="true" /><span>搜索工作台</span><kbd ref={shortcut}>⌘ K</kbd>
          </Link>
          <div className="top-actions">
            <Link className="icon-button notification" href={scopedNavigationHref("/settings#alerts", scope)} aria-label="查看运行告警" title="运行告警"><Bell className="top-icon" aria-hidden="true" /></Link>
            <details className="shell-account" ref={account} onBlur={(event) => {
              if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }}>
              <summary aria-label="账户菜单" title={user?.displayName || "账户菜单"}>
                <span className="avatar" aria-hidden="true">{avatarText(user?.displayName || "")}</span>
                <span className="shell-account-name">{user?.displayName || "当前账号"}</span>
                <ChevronDown className="shell-account-chevron" aria-hidden="true" />
              </summary>
              <div className="shell-account-menu">
                <Link href={scopedNavigationHref("/settings", scope)} aria-label={user ? `打开${user.displayName}的设置` : "打开成员设置"} onClick={() => { if (account.current) account.current.open = false; }}><Settings aria-hidden="true" />系统设置</Link>
                <button className="signout-button" type="button" aria-label="退出当前账号" disabled={signingOut} onClick={signOut}><LogOut aria-hidden="true" />{signingOut ? "正在退出…" : "退出登录"}</button>
                {signOutError && <p className="inline-alert" role="alert">{signOutError}</p>}
              </div>
            </details>
          </div>
        </header>
        <main id="main" className="workspace" tabIndex={-1}>
          <NavigationScope.Provider value={scope}>{children}</NavigationScope.Provider>
        </main>
      </div>
    </div>
  );
}
