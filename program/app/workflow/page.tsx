import { AppShell } from "../../components/AppShell";
import { ModuleHeader } from "../../components/ModuleHeader";
import { WorkflowWorkspace } from "../../components/WorkflowWorkspace";

type WorkflowView = "review" | "calendar" | "publish";
type Query = { view?: string; organizationId?: string; projectId?: string; contentId?: string };

export default async function WorkflowPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { view: requestedView, organizationId, projectId, contentId } = await searchParams;
  const view: WorkflowView = requestedView === "calendar" || requestedView === "publish" ? requestedView : "review";

  return <AppShell activePath="/workflow">
    <ModuleHeader title="审核发布" tabs={[
      { href: "/workflow?view=review", label: "审核", active: view === "review" },
      { href: "/workflow?view=publish", label: "发布", active: view !== "review" },
    ]} />
    <WorkflowWorkspace key={`${view}:${organizationId ?? ""}:${projectId ?? ""}:${contentId ?? ""}`} initialView={view} initialOrganizationId={organizationId} initialProjectId={projectId} initialContentId={contentId} />
  </AppShell>;
}
