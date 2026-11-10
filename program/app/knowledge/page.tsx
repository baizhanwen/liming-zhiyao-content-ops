import { AppShell } from "../../components/AppShell";
import { KnowledgeWorkspace } from "../../components/KnowledgeWorkspace";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; tab?: string; from?: string }> }) {
  const query = await searchParams;
  const scope = new URLSearchParams({ organizationId: query.organizationId ?? "", projectId: query.projectId ?? "" });
  return <AppShell activePath="/knowledge"><section className="page-heading management-heading"><div><p>阶段 3 · 品牌内容底座</p><h1>品牌知识库</h1><span>集中管理品牌事实与内容策略，确认后供内容生成调用。</span></div>{query.from === "ecommerce" && <a href={`/content/ecommerce?${scope}`}>返回电商中心 →</a>}</section><KnowledgeWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialTab={query.tab === "strategy" ? "strategy" : "knowledge"} /></AppShell>;
}
