import { AppShell } from "../../components/AppShell";
import { InsightsWorkspace } from "../../components/InsightsWorkspace";

type View = "overview" | "imports" | "reports";

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ view?: string; organizationId?: string; projectId?: string }> }) {
  const query = await searchParams; const view: View = query.view === "imports" || query.view === "reports" ? query.view : "overview";
  const headings = {
    overview: ["阶段 5 · 数据闭环", "数据复盘", "以最新作品快照计算播放、互动、关注和线索，识别值得复用的内容结构。"],
    imports: ["阶段 5 · 客户后台数据", "数据导入", "使用标准 CSV 模板导入已发布作品的累计表现，保留批次、拒绝项和审计记录。"],
    reports: ["阶段 5 · 周期复盘", "报告中心", "按固定口径生成周报、月报和自定义报告，定稿后冻结当期指标快照。"],
  } as const;
  const [kicker, title, description] = headings[view];
  return <AppShell activePath={`/insights?view=${view}`}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div></section><InsightsWorkspace initialView={view} initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}

