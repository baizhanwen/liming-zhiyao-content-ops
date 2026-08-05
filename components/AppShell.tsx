import type { ReactNode } from "react";
import Link from "next/link";

const navGroups = [
  { label: "运营工作", items: [
    { label: "工作台", icon: "◫", href: "/" },
    { label: "客户项目", icon: "◆", href: "/projects" },
    { label: "选题中心", icon: "◇", href: "/topics" },
    { label: "内容生产", icon: "✦", href: "/content" },
    { label: "审核中心", icon: "✓", href: "/workflow?view=review" },
    { label: "内容日历", icon: "▦", href: "/workflow?view=calendar" },
  ] },
  { label: "研究与资产", items: [
    { label: "视频分析", icon: "▣", href: "/analysis" },
    { label: "对标内容库", icon: "◈", href: "/analysis" },
    { label: "品牌知识库", icon: "▤", href: "/knowledge" },
    { label: "素材中心", icon: "▥", href: "/analysis" },
  ] },
  { label: "增长复盘", items: [
    { label: "发布管理", icon: "↗", href: "/workflow?view=publish" },
    { label: "数据复盘", icon: "◫", href: "/insights?view=overview" },
    { label: "报告中心", icon: "≋", href: "/insights?view=reports" },
  ] },
];

export function AppShell({ children, activePath, projectName = "澄川管理咨询" }: { children: ReactNode; activePath: string; projectName?: string }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="利明智耀工作台首页"><span className="brand-mark" aria-hidden="true">利</span><span>利明智耀</span></Link>
        <Link className="project-switcher" href="/projects" aria-label="切换客户项目"><span className="project-logo">{projectName.slice(0, 1)}</span><span className="project-copy"><small>当前客户项目</small><strong>{projectName}</strong></span><span aria-hidden="true">⌄</span></Link>
        <div className="top-actions">
          <Link className="search-button" href="/search" aria-label="全局搜索"><span aria-hidden="true">⌕</span><span>搜索内容、视频或成员</span><kbd>⌘ K</kbd></Link>
          <Link className="icon-button notification" href="/settings#alerts" aria-label="查看运行告警"><span aria-hidden="true">◌</span><i /></Link>
          <Link className="avatar" href="/settings" aria-label="打开公司与个人设置">LX</Link>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => <Link className={activePath === item.href ? "nav-item active" : "nav-item"} href={item.href} key={`${group.label}:${item.href}`} aria-current={activePath === item.href ? "page" : undefined}><span aria-hidden="true">{item.icon}</span><strong>{item.label}</strong></Link>)}</div>)}</nav>
        <div className="sidebar-footer"><Link className={activePath === "/members" ? "nav-item active" : "nav-item"} href="/members"><span aria-hidden="true">♙</span><strong>成员与权限</strong></Link><Link className={activePath === "/settings" ? "nav-item active" : "nav-item"} href="/settings"><span aria-hidden="true">⚙</span><strong>系统设置</strong></Link></div>
      </aside>

      <main id="main" className="workspace">{children}</main>
    </div>
  );
}
