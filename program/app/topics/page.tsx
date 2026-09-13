import { AppShell } from "../../components/AppShell";
import { TopicWorkspace } from "../../components/TopicWorkspace";

export default async function TopicsPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; sourceVideoId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/topics"><section className="page-heading management-heading"><div><p>阶段 3 · 从证据到创作</p><h1>选题中心</h1><span>每个选题保留来源、目标人群、内容目标和复用理由。</span></div></section><TopicWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} sourceVideoId={query.sourceVideoId} /></AppShell>;
}
