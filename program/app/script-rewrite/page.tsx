import { AppShell } from "../../components/AppShell";
import { ScriptRewriteWorkspace } from "../../components/ScriptRewriteWorkspace";

export default async function ScriptRewritePage({ searchParams }: { searchParams: Promise<{ organizationId?: string; projectId?: string }> }) {
  const query = await searchParams;
  return <AppShell activePath="/script-rewrite"><section className="page-heading management-heading"><div><p>口播文案改写</p><h1>口播改写工作台</h1><span>粘贴文案或选择已有转写，按你的目标改写口播稿。</span></div></section><ScriptRewriteWorkspace initialOrganizationId={query.organizationId} initialProjectId={query.projectId} /></AppShell>;
}
