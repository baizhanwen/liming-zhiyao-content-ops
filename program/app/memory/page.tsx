import { redirect } from "next/navigation";
import { spaceSearchParams, type SpaceSearchParams } from "../../lib/space-navigation";

export default async function MemoryPage({ searchParams }: { searchParams: Promise<SpaceSearchParams> }) {
  const params = spaceSearchParams(await searchParams);
  params.set("tab", "memory");
  redirect(`/space?${params}`);
}
