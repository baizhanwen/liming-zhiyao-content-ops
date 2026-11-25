import { WandSparkles } from "lucide-react";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ContentProductionWorkspace } from "../../components/ContentProductionWorkspace";
import { InspirationWorkspace } from "../../components/InspirationWorkspace";
import { ModuleHeader, ModuleLink } from "../../components/ModuleHeader";
import { ReferenceVideoPicker } from "../../components/ReferenceVideoPicker";
import { ScriptRewriteWorkspace } from "../../components/ScriptRewriteWorkspace";
import { firstStudioParam, studioHref, type StudioQuery } from "../../lib/studio-links";

const stages = [
  { view: "inspiration", label: "灵感库" },
  { view: "drafts", label: "稿件" },
] as const;

export default async function StudioPage({ searchParams }: { searchParams: Promise<StudioQuery> }) {
  const query = await searchParams;
  const value = (key: string) => firstStudioParam(query[key])?.trim() || "";
  const organizationId = value("organizationId");
  const projectId = value("projectId");
  const scope = { organizationId, projectId };
  const initialScope = { initialOrganizationId: organizationId, initialProjectId: projectId };
  const view = value("view");
  if (view === "topics") {
    if (value("sourceVideoId") && organizationId && projectId)
      redirect(`/analysis/${encodeURIComponent(value("sourceVideoId"))}?${new URLSearchParams(scope)}`);
    redirect(studioHref("inspiration", { ...scope, topicId: value("topicId"), cardId: value("inspirationCardId") }));
  }
  const inLibrary = view === "inspiration";
  const creating = view === "create";
  const rewriting = view === "rewrite";
  const drafted = !inLibrary && !creating && !rewriting;
  const kind = value("ideaKind");
  const returnTo = studioHref("drafts", { ...scope, contentId: value("returnContentId") });

  return <AppShell activePath="/studio">
    <ModuleHeader
      title="创作中心"
      tabs={stages.map(stage => ({
        label: stage.label, href: studioHref(stage.view, scope),
        active: stage.view === (inLibrary ? "inspiration" : "drafts"),
      }))}
      actions={drafted ? <ModuleLink className="primary-button link-button" href={studioHref("create", scope)}>
        <WandSparkles aria-hidden="true" />创作文案
      </ModuleLink> : (creating || rewriting) && <ModuleLink className="link-button" href={returnTo}>返回稿件</ModuleLink>}
    />
    {inLibrary && <InspirationWorkspace key={JSON.stringify([organizationId,projectId,value("conversationId"),value("cardId"),value("topicId")])}
      {...initialScope} initialConversationId={value("conversationId")} initialCardId={value("cardId")} initialTopicId={value("topicId")} />}
    {creating && <ReferenceVideoPicker requested={scope} ideaId={value("ideaId")} ideaKind={kind === "card" || kind === "topic" ? kind : undefined} />}
    {drafted && <ContentProductionWorkspace {...initialScope} initialTopicId={value("topicId")} initialContentId={value("contentId")} />}
    {rewriting && <ScriptRewriteWorkspace {...initialScope} initialRewriteId={value("rewriteId")} initialVersionId={value("versionId")}
      legacyImport={value("legacyImport") === "1" && !value("returnContentId")} returnContentId={value("returnContentId")} returnContentVersion={Number(value("returnContentVersion")) || 0} />}
  </AppShell>;
}
