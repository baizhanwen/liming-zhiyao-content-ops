import { AppShell } from "../../../components/AppShell";
import { EcommerceWorkspace } from "../../../components/ecommerce/EcommerceWorkspace";

export default async function EcommercePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/content/ecommerce"><section className="page-heading management-heading ec-page-heading"><div><h1>电商中心</h1><span>管理商品、卖点和事实依据，生成可直接使用的商品文案。</span></div></section><EcommerceWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
