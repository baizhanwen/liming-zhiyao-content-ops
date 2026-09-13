import { AppShell } from "../../components/AppShell";
import { InspirationWorkspace } from "../../components/InspirationWorkspace";

export default async function InspirationPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; conversationId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/inspiration"><section className="page-heading management-heading"><div><p>对标内容驱动的创意协作</p><h1>灵感对话工作台</h1><span>结合对标内容与已采纳记忆讨论选题和创意，选中的建议可保存为灵感卡片，不会自动进入选题中心。</span></div></section><InspirationWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialConversationId={query.conversationId} /></AppShell>;
}
