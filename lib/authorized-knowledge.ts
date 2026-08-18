export type AuthorizedKnowledgeTask = "topic" | "content" | "analysis";

/**
 * Stable, customer-safe identifiers for the licensed Liming Zhiyao method
 * library. `dbskill` and `dbs-*` were import-time implementation names and
 * must never be written by current runtime code or exposed in an export.
 */
export const AUTHORIZED_KNOWLEDGE_SOURCE_ID = "liming-zhiyao-authorized-methods-v1";
export const LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = ["dbskill"] as const;
export const AUTHORIZED_KNOWLEDGE_SKILL_PREFIX = "liming-method-";

export function normalizeAuthorizedKnowledgeSkillTag(value: string) {
  const tag = value.trim().slice(0, 100);
  if (!tag) return "";
  const normalizedTag = tag.toLowerCase();
  if (normalizedTag.startsWith(AUTHORIZED_KNOWLEDGE_SKILL_PREFIX)) return normalizedTag;
  if (normalizedTag.startsWith("dbs-")) return `${AUTHORIZED_KNOWLEDGE_SKILL_PREFIX}${normalizedTag.slice(4)}`;
  return tag;
}

export function normalizeAuthorizedKnowledgeSkillTags(values: readonly string[]) {
  return [...new Set(values.map(normalizeAuthorizedKnowledgeSkillTag).filter(Boolean))].slice(0, 30);
}

export type AuthorizedKnowledgeAtom = {
  id: string;
  source_id: string;
  knowledge: string;
  original: string;
  url: string | null;
  published_at: string | null;
  topics_json: string;
  skills_json: string;
  atom_type: string;
  confidence: string;
};

export type RetrievedAuthorizedKnowledge = AuthorizedKnowledgeAtom & {
  score: number;
  matchedTerms: string[];
  topics: string[];
  skills: string[];
};

type QueryResult<T> = { results: T[] };
type KnowledgeDatabase = {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<QueryResult<T>> } };
};

const domainTerms = [
  "内容", "创作", "选题", "标题", "封面", "开头", "钩子", "口播", "短视频", "长视频", "直播", "传播", "共鸣", "流量", "平台", "抖音", "小红书", "公众号",
  "对标", "模仿", "案例", "产品", "商业", "利润", "客户", "用户", "受众", "老板", "企业", "创业", "成交", "转化", "复购", "定价", "知识付费",
  "人工智能", "AI", "工具", "提示词", "智能体", "知识库", "执行力", "心理", "观点", "方法", "认知", "表达", "语言",
] as const;

const ignoredTerms = new Set(["一个", "这个", "那个", "什么", "怎么", "如何", "为什么", "可以", "需要", "进行", "内容", "视频", "我们", "他们", "自己", "已经", "还是", "但是", "然后", "就是"]);
const taskSkills: Record<AuthorizedKnowledgeTask, string[]> = {
  topic: ["liming-method-content", "liming-method-benchmark"],
  content: ["liming-method-content", "liming-method-benchmark"],
  analysis: ["liming-method-content", "liming-method-benchmark", "liming-method-deconstruct"],
};

function parseList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function authorizedKnowledgeSearchTerms(value: string, maximum = 18) {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const weighted = new Map<string, number>();
  const add = (term: string, weight: number) => {
    const clean = term.trim();
    if (clean.length < 2 || ignoredTerms.has(clean)) return;
    weighted.set(clean, Math.max(weighted.get(clean) ?? 0, weight));
  };
  for (const term of domainTerms) if (normalized.includes(term.toLowerCase())) add(term.toLowerCase(), 12 + term.length);
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9.+#-]{1,30}/g)) add(match[0], 10 + match[0].length);
  for (const match of normalized.matchAll(/[\u3400-\u9fff]{2,30}/g)) {
    const sequence = match[0];
    if (sequence.length <= 10) add(sequence, 8 + sequence.length);
    for (const size of [4, 3, 2]) {
      for (let index = 0; index <= sequence.length - size; index += 1) add(sequence.slice(index, index + size), size + 1);
    }
  }
  return Array.from(weighted.entries()).sort((left, right) => right[1] - left[1] || right[0].length - left[0].length).slice(0, maximum).map(([term]) => term);
}

function scoreAtom(atom: AuthorizedKnowledgeAtom, terms: string[], preferredSkills: string[]) {
  const knowledge = atom.knowledge.toLowerCase(); const original = atom.original.toLowerCase();
  const topics = parseList(atom.topics_json); const skills = parseList(atom.skills_json);
  const topicText = topics.join(" ").toLowerCase(); const skillText = skills.join(" ").toLowerCase();
  const matchedTerms: string[] = [];
  let score = atom.confidence === "high" ? 3 : atom.confidence === "medium" ? 2 : 0;
  if (["method", "principle", "case", "anti-pattern"].includes(atom.atom_type)) score += 1;
  for (const skill of preferredSkills) if (skills.includes(skill)) score += 5;
  for (const term of terms) {
    let matched = false;
    if (knowledge.includes(term)) { score += 7 + Math.min(4, term.length); matched = true; }
    if (original.includes(term)) { score += 2 + Math.min(3, term.length); matched = true; }
    if (topicText.includes(term)) { score += 5; matched = true; }
    if (skillText.includes(term)) { score += 3; matched = true; }
    if (matched) matchedTerms.push(term);
  }
  return { score, matchedTerms, topics, skills };
}

export async function retrieveAuthorizedKnowledge(
  db: KnowledgeDatabase,
  query: string,
  options: { task: AuthorizedKnowledgeTask; limit?: number } = { task: "content" },
) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 6));
  const terms = authorizedKnowledgeSearchTerms(query);
  const preferredSkills = taskSkills[options.task];
  const filters: string[] = []; const bindings: string[] = [];
  for (const term of terms) {
    filters.push("(knowledge LIKE ? ESCAPE '\\' OR original LIKE ? ESCAPE '\\' OR topics_json LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(term)}%`; bindings.push(like, like, like);
  }
  for (const skill of preferredSkills) {
    filters.push("skills_json LIKE ? ESCAPE '\\'"); bindings.push(`%${escapeLike(skill)}%`);
  }
  const rows = await db.prepare(`
    SELECT id, source_id, knowledge, original, url, published_at, topics_json, skills_json, atom_type, confidence
    FROM authorized_knowledge_atoms
    WHERE source_id = ? AND (${filters.join(" OR ")})
    ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, published_at DESC
    LIMIT 240
  `).bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID, ...bindings).all<AuthorizedKnowledgeAtom>();

  const unique = new Map<string, RetrievedAuthorizedKnowledge>();
  for (const atom of rows.results) {
    const scored = scoreAtom(atom, terms, preferredSkills);
    if (!scored.matchedTerms.length && !scored.skills.some((skill) => preferredSkills.includes(skill))) continue;
    const key = atom.knowledge.replace(/\s+/g, " ").trim();
    const candidate = { ...atom, ...scored };
    const existing = unique.get(key);
    if (!existing || candidate.score > existing.score) unique.set(key, candidate);
  }
  return Array.from(unique.values()).sort((left, right) => right.score - left.score || (right.published_at ?? "").localeCompare(left.published_at ?? "")).slice(0, limit);
}

export function authorizedKnowledgePromptSource(atom: RetrievedAuthorizedKnowledge) {
  return [
    `授权知识原子：${atom.knowledge}`,
    `原文：${atom.original}`,
    atom.topics.length ? `主题：${atom.topics.join("、")}` : "",
    atom.url ? `来源链接：${atom.url}` : "",
  ].filter(Boolean).join("\n");
}
