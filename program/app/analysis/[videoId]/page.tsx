import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { AnalysisDetail } from "../../../components/AnalysisDetail";

export default async function AnalysisDetailPage({ params, searchParams }: { params: Promise<{ videoId: string }>; searchParams: Promise<{ organizationId?: string; projectId?: string; libraryEntryId?: string; analysisId?: string }> }) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]); const organizationId = query.organizationId?.trim() ?? ""; const projectId = query.projectId?.trim() ?? ""; const libraryEntryId = query.libraryEntryId?.trim() ?? ""; const analysisId = query.analysisId?.trim() ?? "";
  return <AppShell activePath="/analysis">{organizationId && projectId ? <AnalysisDetail key={`${organizationId}:${projectId}:${videoId}:${analysisId}`} videoId={videoId} organizationId={organizationId} projectId={projectId} libraryEntryId={libraryEntryId || undefined} initialAnalysisId={analysisId || undefined} /> : <div className="management-state error-state"><strong>缺少项目范围</strong><p>请从视频分析列表进入详情页。</p><Link href="/analysis">返回视频分析</Link></div>}</AppShell>;
}
