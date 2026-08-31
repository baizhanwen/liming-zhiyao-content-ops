export type ProjectKnowledgeSourceType = "memory" | "knowledge" | "video_atom" | "strategy" | "inspiration";

export type ProjectKnowledgeRow = {
  sourceType: ProjectKnowledgeSourceType;
  sourceId: string;
  organizationId: string;
  projectId: string;
  title: string;
  text: string;
  status: string;
  kind?: "hard" | "soft";
  category?: string;
  revision?: number;
  contentHash?: string;
  confidence?: number | null;
  expiresAt?: string | null;
  originSourceType?: string | null;
  originSourceId?: string | null;
  feedbackReuse?: boolean;
};

export type RetrievedProjectKnowledge = ProjectKnowledgeRow & {
  score: number;
  matchedTerms: string[];
  rank: number;
};

function terms(query: string) {
  const normalized = query.normalize("NFKC").toLowerCase();
  const words = normalized.split(/[\s,，。；;、|/]+/).filter((item) => item.length > 1);
  const cjk = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  return Array.from(new Set([...words, ...cjk])).slice(0, 24);
}

function clip(value: string, maximum: number) { return value.length <= maximum ? value : value.slice(0, Math.max(0, maximum - 18)) + "……（已按预算截断）"; }

function authorized(row: ProjectKnowledgeRow, organizationId: string, projectId: string, now: string) {
  if (row.organizationId !== organizationId || row.projectId !== projectId) return false;
  if (row.sourceType === "memory" && (row.status !== "confirmed" || Boolean(row.expiresAt && row.expiresAt <= now))) return false;
  if (row.sourceType === "knowledge" && row.status !== "confirmed") return false;
  if (row.sourceType === "video_atom" && row.status !== "active") return false;
  if (row.sourceType === "strategy" && row.status !== "active") return false;
  if (row.sourceType === "inspiration" && (row.status !== "confirmed" || Boolean(row.expiresAt && row.expiresAt <= now))) return false;
  return true;
}

export function retrieveAuthorizedProjectKnowledge(input: { rows: ProjectKnowledgeRow[]; organizationId: string; projectId: string; query?: string; now?: string; limit?: number; maxCharacters?: number }) {
  const now = input.now ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(40, input.limit ?? 20));
  const budget = Math.max(4_000, Math.min(80_000, input.maxCharacters ?? 24_000));
  const queryTerms = terms(input.query ?? "");
  const candidates = input.rows.filter((row) => authorized(row, input.organizationId, input.projectId, now)).map((row) => {
    const haystack = `${row.title} ${row.text}`.toLowerCase();
    const matchedTerms = queryTerms.filter((term) => haystack.includes(term));
    const hardBoost = row.kind === "hard" || row.sourceType === "strategy" ? 100 : 0;
    const confidenceBoost = Math.max(0, Math.min(30, Number(row.confidence ?? 0) / 3));
    const score = hardBoost + matchedTerms.reduce((sum, term) => sum + 10 + Math.min(10, term.length), 0) + confidenceBoost;
    return { ...row, score, matchedTerms };
  }).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const selected: RetrievedProjectKnowledge[] = []; let used = 0;
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const allowance = candidate.kind === "hard" || candidate.sourceType === "strategy" ? Math.min(6_000, budget - used) : Math.min(4_000, budget - used);
    if (allowance < 80) break;
    const text = clip(candidate.text, allowance);
    selected.push({ ...candidate, text, rank: selected.length + 1 });
    used += text.length;
  }
  return selected;
}
