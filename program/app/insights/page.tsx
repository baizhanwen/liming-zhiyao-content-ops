import { AppShell } from "../../components/AppShell";
import { InsightsWorkspace } from "../../components/InsightsWorkspace";

type View = "overview" | "imports" | "matches" | "reports";

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ view?: string; organizationId?: string; projectId?: string }> }) {
  const query = await searchParams; const view: View = query.view === "imports" || query.view === "matches" || query.view === "reports" ? query.view : "overview";
  const headings = {
    overview: ["内容表现", "数据复盘", "以最新作品快照计算播放、互动、关注和线索，识别值得复用的内容结构。"],
    imports: ["数据接入", "数据导入", "导入抖音 XLSX 或 CSV 数据，核对预览后保存作品表现。"],
    matches: ["作品关联", "已发布作品匹配", "将本企业空间的公开作品、运营数据与视频分析人工确认后绑定。"],
    reports: ["周期复盘", "报告中心", "按固定口径生成周报、月报和自定义报告，定稿后冻结当期指标快照。"],
  } as const;
  const [kicker, title, description] = headings[view];
  return <AppShell activePath={`/insights?view=${view}`}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div></section><InsightsWorkspace initialView={view} initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}

