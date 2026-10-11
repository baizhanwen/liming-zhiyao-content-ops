import { AppShell } from "../../../components/AppShell";
import { EcommerceWorkspace } from "../../../components/ecommerce/EcommerceWorkspace";

export default async function EcommercePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/content/ecommerce"><section className="page-heading management-heading"><div><p>电商中心 · 电商素材</p><h1>从商品事实到可拍摄的内容</h1><span>明确一个卖点，选用合适的方法，保留每条内容的事实依据。</span></div></section><EcommerceWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
