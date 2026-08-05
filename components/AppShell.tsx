import type { ReactNode } from "react";
import Link from "next/link";
import { Bell, BookOpenText, BriefcaseBusiness, CalendarDays, ChartNoAxesCombined, ChevronDown, ClipboardCheck, FileChartColumn, FilePenLine, FolderOpen, LayoutDashboard, LibraryBig, Lightbulb, Search, Send, Settings, UsersRound, Video } from "lucide-react";

const navGroups = [
  { label: "运营工作", items: [
    { label: "工作台", icon: LayoutDashboard, href: "/" },
    { label: "客户项目", icon: BriefcaseBusiness, href: "/projects" },
    { label: "选题中心", icon: Lightbulb, href: "/topics" },
    { label: "内容生产", icon: FilePenLine, href: "/content" },
    { label: "审核中心", icon: ClipboardCheck, href: "/workflow?view=review" },
    { label: "内容日历", icon: CalendarDays, href: "/workflow?view=calendar" },
  ] },
  { label: "研究与资产", items: [
    { label: "视频分析", icon: Video, href: "/analysis" },
    { label: "对标内容库", icon: LibraryBig, href: "/analysis?view=benchmark" },
    { label: "品牌知识库", icon: BookOpenText, href: "/knowledge" },
    { label: "素材中心", icon: FolderOpen, href: "/analysis?view=assets" },
  ] },
  { label: "增长复盘", items: [
    { label: "发布管理", icon: Send, href: "/workflow?view=publish" },
    { label: "数据复盘", icon: ChartNoAxesCombined, href: "/insights?view=overview" },
    { label: "报告中心", icon: FileChartColumn, href: "/insights?view=reports" },
  ] },
];

export function AppShell({ children, activePath, projectName = "澄川管理咨询" }: { children: ReactNode; activePath: string; projectName?: string }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="利明智耀工作台首页"><span className="brand-mark" aria-hidden="true">利</span><span>利明智耀</span></Link>
        <Link className="project-switcher" href="/projects" aria-label="切换客户项目"><span className="project-logo">{projectName.slice(0, 1)}</span><span className="project-copy"><small>当前客户项目</small><strong>{projectName}</strong></span><ChevronDown className="project-chevron" aria-hidden="true" /></Link>
        <div className="top-actions">
          <Link className="search-button" href="/search" aria-label="全局搜索"><Search className="top-icon" aria-hidden="true" /><span>搜索内容、视频或成员</span><kbd>⌘ K</kbd></Link>
          <Link className="icon-button notification" href="/settings#alerts" aria-label="查看运行告警"><Bell className="top-icon" aria-hidden="true" /><i /></Link>
          <Link className="avatar" href="/settings" aria-label="打开公司与个人设置">LX</Link>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => { const Icon = item.icon; const active = activePath === item.href; return <Link className={active ? "nav-item active" : "nav-item"} href={item.href} key={`${group.label}:${item.href}`} aria-current={active ? "page" : undefined}><Icon className="nav-icon" aria-hidden="true" /><strong>{item.label}</strong></Link>; })}</div>)}</nav>
        <div className="sidebar-footer"><Link className={activePath === "/members" ? "nav-item active" : "nav-item"} href="/members"><UsersRound className="nav-icon" aria-hidden="true" /><strong>成员与权限</strong></Link><Link className={activePath === "/settings" ? "nav-item active" : "nav-item"} href="/settings"><Settings className="nav-icon" aria-hidden="true" /><strong>系统设置</strong></Link></div>
      </aside>

      <main id="main" className="workspace">{children}</main>
    </div>
  );
}
