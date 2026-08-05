import { AppShell } from "../../components/AppShell";
import { AnalysisWorkspace } from "../../components/AnalysisWorkspace";

type AnalysisView = "videos" | "benchmark" | "assets";

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const query = await searchParams;
  const view: AnalysisView = query.view === "benchmark" || query.view === "assets" ? query.view : "videos";
  const headings = {
    videos: ["阶段 2 · 最小分析闭环", "视频分析", "链接与媒体先安全入库，再由独立分析服务异步处理。"],
    benchmark: ["阶段 2 · 样本沉淀", "对标内容库", "集中查看已入库的对标视频、处理进度与可追溯分析结果。"],
    assets: ["阶段 2 · 分析资产", "素材中心", "从已入库内容中查看可复用的视频、音频与分析资产。"],
  } as const;
  const [kicker, title, description] = headings[view];
  const activePath = view === "videos" ? "/analysis" : `/analysis?view=${view}`;

  return <AppShell activePath={activePath}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div><a className="secondary-link" href="/projects">切换客户项目 →</a></section><AnalysisWorkspace initialView={view} /></AppShell>;
}
