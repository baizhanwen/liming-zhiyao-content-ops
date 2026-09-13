import { areProjectMemoriesEquivalent } from "./project-memory-similarity.ts";

export type ProjectMemoryListItem = {
  id: string;
  canonical_key: string;
  status: string;
  title: string;
  content: string;
  revision: number;
  updated_at: string;
  [key: string]: unknown;
};

function isNewer(left: ProjectMemoryListItem, right: ProjectMemoryListItem) {
  const timeDifference = Date.parse(left.updated_at) - Date.parse(right.updated_at);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference > 0;
  if (left.revision !== right.revision) return left.revision > right.revision;
  if (left.status !== right.status) return left.status === "confirmed";
  return left.id > right.id;
}

function isPreferredEquivalent(left: ProjectMemoryListItem, right: ProjectMemoryListItem) {
  if (left.status !== right.status) return left.status === "confirmed";
  return isNewer(left, right);
}

/**
 * The workspace shows one current decision per memory subject. Older revisions
 * and model-generated semantic aliases remain available in history, but are
 * not rendered as separate knowledge atoms.
 */
export function collapseProjectMemoryListItems<T extends ProjectMemoryListItem>(items: T[]) {
  const latestByCanonicalKey = new Map<string, T>();
  for (const item of items) {
    if (item.status !== "candidate" && item.status !== "confirmed") continue;
    const existing = latestByCanonicalKey.get(item.canonical_key);
    if (!existing || isNewer(item, existing)) latestByCanonicalKey.set(item.canonical_key, item);
  }

  const representatives: T[] = [];
  for (const item of latestByCanonicalKey.values()) {
    const equivalentIndex = representatives.findIndex((current) => areProjectMemoriesEquivalent(current, item));
    if (equivalentIndex < 0) {
      representatives.push(item);
    } else if (isPreferredEquivalent(item, representatives[equivalentIndex])) {
      representatives[equivalentIndex] = item;
    }
  }
  return representatives.sort((left, right) => {
    if (left.status !== right.status) return left.status === "confirmed" ? -1 : 1;
    return Date.parse(right.updated_at) - Date.parse(left.updated_at);
  });
}
