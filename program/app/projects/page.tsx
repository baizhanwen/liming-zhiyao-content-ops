import { AppShell } from "../../components/AppShell";
import { ProjectManager } from "../../components/ProjectManager";

export default function ProjectsPage() {
  return <AppShell activePath="/projects"><section className="page-heading management-heading"><div><p>平台地基 · 空间隔离</p><h1>企业空间</h1><span>每个企业空间拥有独立成员、资料、内容和分析任务。</span></div><a className="secondary-link" href="/members">管理成员与权限 →</a></section><ProjectManager /></AppShell>;
}
