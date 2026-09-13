import { AppShell } from "../../components/AppShell";
import { KnowledgeWorkspace } from "../../components/KnowledgeWorkspace";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/knowledge"><section className="page-heading management-heading"><div><p>阶段 3 · 品牌内容底座</p><h1>品牌知识库</h1><span>集中管理品牌事实与内容策略，确认后供内容生成调用。</span></div></section><KnowledgeWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
