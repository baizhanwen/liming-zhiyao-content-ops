import { AppShell } from "../../components/AppShell";
import { AnalysisWorkspace } from "../../components/AnalysisWorkspace";

export default function AnalysisPage() {
  return <AppShell activePath="/analysis"><section className="page-heading management-heading"><div><p>阶段 2 · 最小分析闭环</p><h1>视频分析</h1><span>链接与媒体先安全入库，再由独立分析服务异步处理。</span></div><a className="secondary-link" href="/projects">切换客户项目 →</a></section><AnalysisWorkspace /></AppShell>;
}
