import { AppShell } from "../../components/AppShell";
import { ContentProductionWorkspace } from "../../components/ContentProductionWorkspace";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; topicId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/content"><section className="page-heading management-heading"><div><p>阶段 3 · 从选题到可审核生产包</p><h1>内容生产</h1><span>口播稿、分镜、素材建议和发布文案统一版本化，并保留知识与策略引用。</span></div></section><ContentProductionWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialTopicId={query.topicId} /></AppShell>;
}
