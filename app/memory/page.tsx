import { AppShell } from "../../components/AppShell";
import { ProjectMemoryWorkspace } from "../../components/ProjectMemoryWorkspace";

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/memory"><section className="page-heading management-heading"><div><p>项目级长期备忘录</p><h1>自动项目记忆</h1><span>独立项目助理从视频分析、灵感对话和你的反馈中持续更新；人工只用于纠错，版本与来源完整保留。</span></div></section><ProjectMemoryWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}