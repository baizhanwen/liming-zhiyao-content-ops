import { AppShell } from "../../components/AppShell";
import { ModuleHeader } from "../../components/ModuleHeader";
import { WechatImageWorkspace } from "../../components/WechatImageWorkspace";
import { deliveryFeatureEnabled } from "../../lib/delivery-entitlements";
import { notFound } from "next/navigation";

export default async function WechatImagesPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string; topic?: string }> }) {
  if (!deliveryFeatureEnabled("wechatImages")) notFound();
  const query = await searchParams;
  return <AppShell activePath="/wechat-images">
    <ModuleHeader title="公众号图片" />
    <WechatImageWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialTopic={query.topic} />
  </AppShell>;
}
