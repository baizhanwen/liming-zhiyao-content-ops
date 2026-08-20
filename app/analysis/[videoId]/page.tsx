import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { AnalysisDetail } from "../../../components/AnalysisDetail";

export default async function AnalysisDetailPage({ params, searchParams }: { params: Promise<{ videoId: string }>; searchParams: Promise<{ organizationId?: string; projectId?: string; libraryEntryId?: string }> }) {
  const [{ videoId }, query] = await Promise.all([params, searchParams]); const organizationId = query.organizationId?.trim() ?? ""; const projectId = query.projectId?.trim() ?? ""; const libraryEntryId = query.libraryEntryId?.trim() ?? "";
  return <AppShell activePath="/analysis"><section className="page-heading management-heading"><div><p>阶段 2 · 可追溯分析结果</p><h1>单条视频分析</h1><span>原文、处理证据和结构化结论在同一页面核对。</span></div><Link className="secondary-link" href="/analysis">← 返回视频列表</Link></section>{organizationId && projectId ? <AnalysisDetail videoId={videoId} organizationId={organizationId} projectId={projectId} libraryEntryId={libraryEntryId || undefined} /> : <div className="management-state error-state"><strong>缺少项目范围</strong><p>请从视频分析列表进入详情页。</p><Link href="/analysis">返回视频分析</Link></div>}</AppShell>;
}
