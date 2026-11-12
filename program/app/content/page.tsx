import { AppShell } from "../../components/AppShell";
import { ContentProductionWorkspace } from "../../components/ContentProductionWorkspace";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; topicId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/content"><section className="page-heading management-heading"><div><p>内容创作</p><h1>内容生产</h1><span>创作和修改口播稿，查看分镜、素材与发布建议。</span></div></section><ContentProductionWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialTopicId={query.topicId} /></AppShell>;
}
