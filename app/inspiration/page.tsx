import { AppShell } from "../../components/AppShell";
import { InspirationWorkspace } from "../../components/InspirationWorkspace";

export default async function InspirationPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/inspiration"><section className="page-heading management-heading"><div><p>对标内容驱动的创意协作</p><h1>灵感对话工作台</h1><span>基于当前企业空间的对标内容库连续追问选题、标题、角度和系列规划，并把建议保存为可追溯的灵感卡片。</span></div></section><InspirationWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
