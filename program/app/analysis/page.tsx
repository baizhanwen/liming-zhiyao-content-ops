import { AppShell } from "../../components/AppShell";
import { AnalysisWorkspace } from "../../components/AnalysisWorkspace";

type AnalysisView = "videos" | "benchmark" | "assets";

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const query = await searchParams;
  const view: AnalysisView = query.view === "benchmark" || query.view === "assets" ? query.view : "videos";
  const headings = {
    videos: ["视频研究", "视频分析", "提交视频，查看转写和内容分析结果。"],
    benchmark: ["参考内容", "对标内容库", "按企业空间管理已选对标素材，复用公司历史分析结果。"],
    assets: ["素材管理", "素材中心", "集中检索历来分析过的视频，并选择性导入不同企业空间。"],
  } as const;
  const [kicker, title, description] = headings[view];
  const activePath = view === "videos" ? "/analysis" : `/analysis?view=${view}`;

  return <AppShell activePath={activePath}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div><a className="secondary-link" href="/projects">切换企业空间 →</a></section><AnalysisWorkspace initialView={view} /></AppShell>;
}
