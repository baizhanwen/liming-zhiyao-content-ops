import { redirect } from "next/navigation";
import { spaceSearchParams, type SpaceSearchParams } from "../../lib/space-navigation";

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<SpaceSearchParams> }) {
  const params = spaceSearchParams(await searchParams);
  const tab = params.get("tab");
  if (tab !== "strategy" && tab !== "method") params.set("tab", "knowledge");
  redirect(`/space?${params}`);
}
