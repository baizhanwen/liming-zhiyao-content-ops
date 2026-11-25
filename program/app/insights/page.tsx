import { AppShell } from "../../components/AppShell";
import { InsightsWorkspace } from "../../components/InsightsWorkspace";
import { InsightsHeader, type InsightsView } from "../../components/InsightsHeader";

type Query = { view?: string; organizationId?: string; projectId?: string };

export default async function InsightsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { view: requestedView, organizationId, projectId } = await searchParams;
  const view: InsightsView = requestedView === "imports" || requestedView === "matches" || requestedView === "reports" || requestedView === "performance" ? requestedView : "overview";
  const scope = { organizationId: organizationId ?? "", projectId: projectId ?? "" };
  return <AppShell activePath="/insights">
    <InsightsHeader key={`header:${view}:${scope.organizationId}:${scope.projectId}`} view={view} initialScope={scope} />
    <InsightsWorkspace key={`${view}:${organizationId ?? ""}:${projectId ?? ""}`} initialView={view} initialOrganizationId={organizationId} initialProjectId={projectId} />
  </AppShell>;
}
