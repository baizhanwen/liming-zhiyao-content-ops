import { AppShell } from "../../components/AppShell";
import { AnalysisWorkspace } from "../../components/AnalysisWorkspace";

type AnalysisView = "videos" | "benchmark" | "assets";

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const query = await searchParams;
  const view: AnalysisView = query.view === "benchmark" || query.view === "assets" ? query.view : "videos";
  const headings = {
    videos: ["阶段 2 · 最小分析闭环", "视频分析", "链接与媒体先安全入库，再由独立分析服务异步处理。"],
    benchmark: ["阶段 3 · 项目样本", "对标内容库", "按企业空间管理已选对标素材，复用公司历史分析结果。"],
    assets: ["阶段 3 · 公司资产", "素材中心", "集中检索历来分析过的视频，并选择性导入不同企业空间。"],
  } as const;
  const [kicker, title, description] = headings[view];
  const activePath = view === "videos" ? "/analysis" : `/analysis?view=${view}`;

  return <AppShell activePath={activePath}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div><a className="secondary-link" href="/projects">切换企业空间 →</a></section><AnalysisWorkspace initialView={view} /></AppShell>;
}
