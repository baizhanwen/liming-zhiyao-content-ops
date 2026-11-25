export const studioViews = ["inspiration", "topics", "drafts", "create", "rewrite"] as const;
export type StudioView = (typeof studioViews)[number];
export type StudioQuery = Record<string, string | string[] | undefined>;

export function studioHref(view: StudioView, query: StudioQuery = {}, hash = "") {
  const params = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(query)) {
    if (key === "view" || !value) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return `/studio?${params}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function firstStudioParam(value: StudioQuery[string]) {
  return Array.isArray(value) ? value[0] : value;
}

export function structureDraftHref(scope: { organizationId: string; projectId: string; videoId: string; analysisId: string; libraryEntryId?: string; contentId?: string; ideaId?: string; ideaKind?: "card" | "topic" }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) if (value) params.set(key, value);
  return `/studio/from-analysis?${params}`;
}
