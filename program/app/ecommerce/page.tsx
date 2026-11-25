import { AppShell } from "../../components/AppShell";
import { EcommerceWorkspace } from "../../components/ecommerce/EcommerceWorkspace";
import { ModuleHeader } from "../../components/ModuleHeader";

export default async function EcommercePage({ searchParams }: {
  searchParams: Promise<{ organizationId?: string; projectId?: string }>;
}) {
  const { organizationId, projectId } = await searchParams;
  return (
    <AppShell activePath="/ecommerce">
      <ModuleHeader title="电商中心" />
      <EcommerceWorkspace initialOrganizationId={organizationId} initialProjectId={projectId} />
    </AppShell>
  );
}
