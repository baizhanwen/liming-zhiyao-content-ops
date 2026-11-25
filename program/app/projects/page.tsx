import { AppShell } from "../../components/AppShell";
import { ModuleHeader } from "../../components/ModuleHeader";
import { ProjectManager } from "../../components/ProjectManager";
import { spaceSearchParams, type SpaceSearchParams } from "../../lib/space-navigation";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SpaceSearchParams> }) {
  const params = spaceSearchParams(await searchParams);
  const organizationId = params.get("organizationId")?.trim() ?? "";
  const projectId = params.get("projectId")?.trim() ?? "";
  const strategyOverview = params.get("view") === "strategies";
  return <AppShell activePath="/projects">
    <ModuleHeader title={strategyOverview ? "策略总览" : "企业空间管理"} />
    <ProjectManager key={JSON.stringify([organizationId, projectId])} requestedOrganizationId={organizationId} requestedProjectId={projectId} strategyOverview={strategyOverview} />
  </AppShell>;
}
