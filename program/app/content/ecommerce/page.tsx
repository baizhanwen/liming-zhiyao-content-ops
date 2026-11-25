import { redirect } from "next/navigation";

export default async function LegacyEcommercePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const item of typeof value === "string" ? [value] : value ?? []) params.append(name, item);
  }
  redirect(params.size ? `/ecommerce?${params}` : "/ecommerce");
}
