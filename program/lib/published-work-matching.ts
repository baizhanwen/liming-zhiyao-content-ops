export type PublishedWorkMatchInput = {
  platformWorkId?: string | null;
  title: string;
  publishedAt?: string | null;
};

export type AnalyzedVideoMatchInput = PublishedWorkMatchInput & {
  id: string;
  durationSec?: number | null;
};

export function normalizePublishedTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[#＃@＠]/g, " ").replace(/[\p{P}\p{S}\s]+/gu, "").trim();
}

function bigrams(value: string) {
  if (value.length < 2) return value ? [value] : [];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

export function publishedTitleSimilarity(left: string, right: string) {
  const a = normalizePublishedTitle(left); const b = normalizePublishedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftPairs = bigrams(a); const rightPairs = bigrams(b);
  const rightCounts = new Map<string, number>();
  for (const item of rightPairs) rightCounts.set(item, (rightCounts.get(item) || 0) + 1);
  let overlap = 0;
  for (const item of leftPairs) {
    const count = rightCounts.get(item) || 0;
    if (!count) continue;
    overlap += 1; rightCounts.set(item, count - 1);
  }
  return overlap * 2 / (leftPairs.length + rightPairs.length);
}

function dayDistance(left?: string | null, right?: string | null) {
  if (!left || !right) return null;
  const a = new Date(left).getTime(); const b = new Date(right).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

export function scorePublishedWorkCandidate(work: PublishedWorkMatchInput, video: AnalyzedVideoMatchInput) {
  if (work.platformWorkId && video.platformWorkId && work.platformWorkId === video.platformWorkId) {
    return { score: 100, method: "platform_id", reason: "抖音作品ID完全一致" };
  }
  const titleSimilarity = publishedTitleSimilarity(work.title, video.title);
  const distance = dayDistance(work.publishedAt, video.publishedAt);
  const dateScore = distance === 0 ? 25 : distance === 1 ? 18 : distance !== null && distance <= 3 ? 10 : 0;
  const score = Math.min(99, Math.round(titleSimilarity * 72 + dateScore));
  const exactTitle = titleSimilarity === 1;
  const method = exactTitle && distance === 0 ? "exact_title_date" : distance !== null && distance <= 3 ? "title_date" : "title";
  const reason = exactTitle && distance === 0
    ? "标题和发布日期一致"
    : Math.round(titleSimilarity * 100) + "% 标题相似" + (distance === null ? "，缺少可比发布时间" : "，发布时间相差 " + distance + " 天");
  return { score, method, reason };
}

export function isPublicOwnedWork(reviewStatus?: string | null) {
  const value = (reviewStatus || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  return !/(自见|仅自己|私密|草稿|删除)/.test(value);
}
