import { AppShell } from "../../components/AppShell";
import { KnowledgeWorkspace } from "../../components/KnowledgeWorkspace";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/knowledge"><section className="page-heading management-heading"><div><p>阶段 3 · 客户知识底座</p><h1>品牌知识库</h1><span>知识保留来源和版本，确认后才能进入内容生成。</span></div></section><KnowledgeWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
