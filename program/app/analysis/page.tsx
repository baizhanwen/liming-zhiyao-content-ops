import { AppShell } from "../../components/AppShell";
import { AnalysisWorkspace } from "../../components/AnalysisWorkspace";
import { ModuleHeader } from "../../components/ModuleHeader";

type AnalysisView = "videos" | "benchmark" | "assets";
type Query = { view?: string; organizationId?: string; projectId?: string };

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<Query> }) {
  const { view: requestedView, organizationId, projectId } = await searchParams;
  const view: AnalysisView = requestedView === "benchmark" || requestedView === "assets" ? requestedView : "videos";

  return <AppShell activePath="/analysis">
    <ModuleHeader title="素材中心" tabs={[
      { href: "/analysis?view=videos", label: "视频分析", active: view === "videos" },
      { href: "/analysis?view=benchmark", label: "空间对标", active: view === "benchmark" },
      { href: "/analysis?view=assets", label: "公司素材", active: view === "assets" },
    ]} />
    <AnalysisWorkspace key={`${view}:${organizationId ?? ""}:${projectId ?? ""}`} initialView={view} initialOrganizationId={organizationId} initialProjectId={projectId} />
  </AppShell>;
}
