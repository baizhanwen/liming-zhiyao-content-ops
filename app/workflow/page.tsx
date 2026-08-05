import { AppShell } from "../../components/AppShell";
import { WorkflowWorkspace } from "../../components/WorkflowWorkspace";

type WorkflowView = "review" | "calendar" | "publish";

export default async function WorkflowPage({ searchParams }: { searchParams: Promise<{ view?: string; organizationId?: string; projectId?: string; contentId?: string }> }) {
  const query = await searchParams;
  const view: WorkflowView = query.view === "calendar" || query.view === "publish" ? query.view : "review";
  const headings = {
    review: ["阶段 4 · 版本化审核", "审核中心", "内部意见、客户决定和修改轮次都绑定到明确稿件版本。"],
    calendar: ["阶段 4 · 节奏管理", "内容日历", "把已审核内容安排到明确平台与时间，随时识别空档和冲突。"],
    publish: ["阶段 4 · 发布留痕", "发布管理", "记录发布准备、失败原因和线上作品链接，形成可追踪交付闭环。"],
  } as const;
  const [kicker, title, description] = headings[view];
  return <AppShell activePath={`/workflow?view=${view}`}><section className="page-heading management-heading"><div><p>{kicker}</p><h1>{title}</h1><span>{description}</span></div></section><WorkflowWorkspace initialView={view} initialOrganizationId={query.organizationId} initialProjectId={query.projectId} initialContentId={query.contentId} /></AppShell>;
}

