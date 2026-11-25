import { AppShell } from "../../components/AppShell";
import { ModuleHeader, ModuleLink } from "../../components/ModuleHeader";
import { SpaceWorkspace } from "../../components/SpaceWorkspace";
import { AUTHORIZED_METHOD_LIBRARY_VISIBLE, spaceSearchParams, type SpaceSearchParams, type SpaceTab } from "../../lib/space-navigation";

const views: { id: SpaceTab; label: string }[] = [
  { id: "overview", label: "空间概览" },
  { id: "knowledge", label: "品牌知识" },
  { id: "strategy", label: "内容策略" },
  { id: "memory", label: "项目记忆" },
  ...(AUTHORIZED_METHOD_LIBRARY_VISIBLE
    ? [{ id: "method" as const, label: "授权方法论" }]
    : []),
];

export default async function SpacePage({ searchParams }: { searchParams: Promise<SpaceSearchParams> }) {
  const params = spaceSearchParams(await searchParams);
  const tab = views.find((view) => view.id === params.get("tab")) ?? views[0];
  const organizationId = params.get("organizationId")?.trim() ?? "";
  const projectId = params.get("projectId")?.trim() ?? "";
  const scope = new URLSearchParams();
  if (organizationId) scope.set("organizationId", organizationId);
  if (projectId) scope.set("projectId", projectId);
  const tabs = views.map((view) => {
    const query = new URLSearchParams(scope);
    query.set("tab", view.id);
    if (params.get("from") === "ecommerce") query.set("from", "ecommerce");
    return { href: `/space?${query}`, label: view.label, active: view.id === tab.id };
  });

  return <AppShell activePath="/space">
    <ModuleHeader title="空间资料" tabs={tabs} actions={
      params.get("from") === "ecommerce" && <ModuleLink className="secondary-link" href={`/ecommerce${scope.size ? `?${scope}` : ""}`}>返回电商中心</ModuleLink>
    } />
    <SpaceWorkspace key={JSON.stringify([organizationId, projectId])} tab={tab.id} requestedOrganizationId={organizationId} requestedProjectId={projectId} />
  </AppShell>;
}
