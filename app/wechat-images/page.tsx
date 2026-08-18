import { AppShell } from "../../components/AppShell";
import { WechatImageWorkspace } from "../../components/WechatImageWorkspace";

export default async function WechatImagesPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; topic?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/wechat-images"><section className="page-heading management-heading"><div><p>内容生产 · 图文资产</p><h1>公众号图片</h1><span>输入选题、选择模板，生成可编辑并可直接下载的高清信息长图。</span></div></section><WechatImageWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialTopic={query.topic} /></AppShell>;
}

