import { AppShell } from "../../components/AppShell";
import { ProjectMemoryWorkspace } from "../../components/ProjectMemoryWorkspace";

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/memory"><section className="page-heading management-heading"><div><p>项目级长期备忘录</p><h1>自动项目记忆</h1><span>从视频分析与反馈中沉淀内容观点、问题、案例线索和表达方法；由你采纳后，仅供灵感对话参考，版本与来源完整保留。</span></div></section><ProjectMemoryWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
