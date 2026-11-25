import Link from "next/link";
import { ModuleHeader } from "../../../components/ModuleHeader";
import { AppShell } from "../../../components/AppShell";
import { ReferenceDraftComposer } from "../../../components/ReferenceDraftComposer";
import { firstStudioParam, studioHref, type StudioQuery } from "../../../lib/studio-links";

export default async function StructureDraftPage({ searchParams }: { searchParams: Promise<StudioQuery> }) {
  const query = await searchParams;
  const value = (key: string) => firstStudioParam(query[key])?.trim() || "";
  const scope = { organizationId: value("organizationId"), projectId: value("projectId"), videoId: value("videoId"), analysisId: value("analysisId"), libraryEntryId: value("libraryEntryId") };
  const ideaKind = value("ideaKind");
  const initialIdeaKind = ideaKind === "card" || ideaKind === "topic" ? ideaKind : undefined;
  const initialIdeaId = initialIdeaKind ? value("ideaId") : undefined;
  return <AppShell activePath="/studio">{scope.organizationId && scope.projectId && scope.videoId && scope.analysisId
    ? <ReferenceDraftComposer key={JSON.stringify([scope, value("contentId"), initialIdeaId, initialIdeaKind])} {...scope} initialContentId={value("contentId")} initialIdeaId={initialIdeaId} initialIdeaKind={initialIdeaKind} />
    : <><ModuleHeader title="创作文案" /><section className="management-state"><p>请选择参考视频</p><Link href={studioHref("create", { organizationId: scope.organizationId, projectId: scope.projectId, ideaId: initialIdeaId, ideaKind: initialIdeaKind })}>选择参考视频</Link></section></>}</AppShell>;
}
