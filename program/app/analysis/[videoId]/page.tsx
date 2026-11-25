import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { ModuleHeader } from "../../../components/ModuleHeader";
import { AnalysisDetail } from "../../../components/AnalysisDetail";

export default async function AnalysisDetailPage({ params, searchParams }: {
  params: Promise<{ videoId: string }>;
  searchParams: Promise<{ organizationId?: string; projectId?: string; libraryEntryId?: string; analysisId?: string; view?: string }>;
}) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]);
  const organizationId = query.organizationId?.trim() ?? "";
  const projectId = query.projectId?.trim() ?? "";
  const libraryEntryId = query.libraryEntryId?.trim() ?? "";
  const analysisId = query.analysisId?.trim() ?? "";
  const sourceView = query.view === "assets" || query.view === "benchmark" ? query.view : "videos";
  const backLink = `/analysis?${new URLSearchParams({ view: sourceView, organizationId, projectId })}`;
  return <AppShell activePath="/analysis">
    {organizationId && projectId
      ? <AnalysisDetail key={`${organizationId}:${projectId}:${videoId}:${analysisId}`} videoId={videoId} organizationId={organizationId} projectId={projectId} libraryEntryId={libraryEntryId || undefined} initialAnalysisId={analysisId || undefined} sourceView={sourceView} />
      : <><ModuleHeader title="视频分析" /><div className="management-state error-state"><strong>缺少企业空间</strong><p>请从素材中心选择记录后进入详情。</p><Link href={backLink}>返回素材中心</Link></div></>}
  </AppShell>;
}
