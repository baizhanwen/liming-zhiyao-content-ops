import { redirect } from "next/navigation";
import { studioHref, type StudioQuery } from "../../lib/studio-links";

export default async function LegacyStudioPage({ searchParams }: { searchParams: Promise<StudioQuery> }) {
  redirect(studioHref("topics", await searchParams));
}
