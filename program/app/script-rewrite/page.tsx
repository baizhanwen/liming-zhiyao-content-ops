import { AppShell } from "../../components/AppShell";
import { ScriptRewriteWorkspace } from "../../components/ScriptRewriteWorkspace";

export default async function ScriptRewritePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/script-rewrite"><section className="page-heading management-heading"><div><p>按需生成 · 与视频分析解耦</p><h1>口播改写工作台</h1><span>粘贴文案或选择已有转写的视频，只在确认消耗后生成微调同构或内容等价重构。</span></div></section><ScriptRewriteWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
