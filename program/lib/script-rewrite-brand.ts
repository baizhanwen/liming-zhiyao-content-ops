export type RewriteBrandScope = { organizationId: string; projectId: string };
export type RewriteBrandSource = {
  itemId: string; versionId: string; version: number; title: string; category: string; excerpt: string;
};
export type RewriteBrandContext = RewriteBrandScope & {
  targetName: string | null; targetSourceId: string | null; sources: RewriteBrandSource[]; missing: string[]; stamp: string;
};

const sourceLimit = 12;
const maxExcerpt = 1200;
const maxTerms = 20;
const maxStamp = 4096;
const ignoredTerms = new Set(["我们", "这个", "大家", "一个", "时候", "可以", "今天", "怎么", "你们", "还有", "还是", "自己", "哪些", "一下", "为什么", "他们", "什么", "这样", "就是", "不是", "这个问题"]);

function queryTerms(query: string) {
  const source = query.slice(0, 12000).normalize("NFKC").toLowerCase();
  const words = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(source)].filter(word => word.isWordLike).map(word => word.segment)
    : source.match(/[a-z0-9][a-z0-9.-]+|[\p{Script=Han}]{2,8}/gu) ?? [];
  return [...new Set(words.filter(word => word.length >= 2 && word.length <= 48 && !ignoredTerms.has(word)))].slice(0, maxTerms);
}

type BrandRow = {
  item_id: string; version_id: string; version: number; title: string; category: string;
  body: string; form_kind: string | null; account_name: string | null; background: string | null;
  subject: string | null; boundary: string | null; priority: number; peer_count: number;
  updated_at: string;
};

// Keep the same bounded, ordered selection in the read and the final write guard.
// Raw questionnaire JSON, references and anonymous respondents' answers never leave SQLite.
const publicRows = `SELECT k.updated_at, k.id AS item_id,
  v.id AS version_id, v.version, k.category,
  CASE WHEN json_extract(v.form_json,'$.answers.publication')='匿名后可公开'
    THEN '匿名公开摘要' ELSE k.title END AS title,
  CASE WHEN json_extract(v.form_json,'$.answers.publication')='匿名后可公开'
    THEN COALESCE(json_extract(v.form_json,'$.answers.publicSummary'),'') ELSE v.body END AS body,
  json_extract(v.form_json,'$.kind') AS form_kind,
  CASE WHEN json_extract(v.form_json,'$.kind')='profile' THEN json_extract(v.form_json,'$.answers.accountName') END AS account_name,
  CASE WHEN json_extract(v.form_json,'$.kind')='profile' THEN json_extract(v.form_json,'$.answers.subject') END AS subject,
  CASE WHEN json_extract(v.form_json,'$.kind')='profile' THEN json_extract(v.form_json,'$.answers.background') END AS background,
  CASE WHEN json_extract(v.form_json,'$.kind')='profile' THEN json_extract(v.form_json,'$.answers.boundary') END AS boundary
  FROM knowledge_items k JOIN knowledge_item_versions v ON v.item_id=k.id AND v.version=k.current_version
    AND v.project_id=k.project_id AND v.organization_id=k.organization_id
  WHERE k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL
    AND CASE WHEN v.form_json IS NULL THEN 1 WHEN json_valid(v.form_json) THEN
      json_extract(v.form_json,'$.kind')='profile' OR (
        json_extract(v.form_json,'$.answers.publication') IN ('可以公开','匿名后可公开')
        AND (json_extract(v.form_json,'$.kind')='product' OR json_extract(v.form_json,'$.answers.nature')='官方事实')
        AND COALESCE(json_extract(v.form_json,'$.answers.nature'),'') NOT IN ('待核对','虚构或改编')
        AND (COALESCE(json_extract(v.form_json,'$.answers.usage'),'')='' OR
          instr(json_extract(v.form_json,'$.answers.usage'),'事实依据')>0)
      ) ELSE 0 END`;

const nameLabels = ["发布名称", "品牌名称", "品牌名", "品牌全称", "品牌简称", "企业全称", "企业简称", "公司全称", "公司简称", "企业名称", "公司名称", "账号名称"];
const productLabels = ["产品名称", "产品名", "服务名称", "服务名", "官方表述"];
function labeledInSql(labels: string[]) {
  return labels.map(label => `instr(labels_text,'${label}:')>0`).join(" OR ");
}
const identityInSql = labeledInSql(nameLabels);
const productInSql = labeledInSql(productLabels);
const rankedQuery = `WITH public_rows AS (${publicRows}), labeled AS (
  SELECT *, replace(replace(replace(body,'：',':'),' ',''),char(12288),'') AS labels_text FROM public_rows
), candidates AS (
  SELECT *, CASE WHEN form_kind='profile' THEN 0
    WHEN form_kind IS NULL AND category IN ('brand_story','other') AND (${identityInSql}) THEN 1
    WHEN category='compliance' THEN 2
    WHEN category='brand_voice' THEN 3 ELSE 4 END AS priority,
    (SELECT count(*) FROM json_each(?) term WHERE instr(lower(title || ' ' || body), term.value)>0) AS relevance
  FROM labeled
  WHERE form_kind IS NOT NULL OR category IN ('brand_story','brand_voice','compliance','sales_script')
    OR (category='other' AND ((${identityInSql}) OR (${productInSql})))
), ranked AS (
  SELECT *, CASE WHEN priority < 2 THEN COUNT(*) OVER (PARTITION BY priority) ELSE 0 END AS peer_count FROM candidates
) SELECT * FROM ranked ORDER BY min(priority,2), relevance DESC, priority, updated_at DESC, item_id LIMIT ${sourceLimit}`;

function boundedExcerpt(body: string, budget = maxExcerpt) {
  if (body.trim().length <= budget) return body.trim();
  const sentences = body.match(/[^\n。！？!?]+(?:[。！？!?]+|$)|[^\n。！？!?]+(?=\n)/gu) ?? [];
  const kept: string[] = [];
  let size = 0;
  for (const segment of sentences) {
    const sentence = segment.trim();
    if (sentence.length + size + 1 > budget) continue;
    if (sentence) { kept.push(sentence); size += sentence.length + 1; }
  }
  return kept.join("\n");
}

function asSource(row: BrandRow): RewriteBrandSource | null {
  let body = row.body;
  if (row.form_kind === "profile") {
    // Representative work can belong to somebody else and is not brand evidence.
    body = [["发布名称", row.account_name], ["账号主体", row.subject], ["长期公开边界", row.boundary], ["可长期公开的背景", row.background]]
      .filter(([, value]) => value).map(([label, value]) => label + "：" + value).join("\n");
  }
  const excerpt = boundedExcerpt(body, row.form_kind === "profile" ? 2100 : maxExcerpt);
  return excerpt ? { itemId: row.item_id, versionId: row.version_id, version: row.version, category: row.category, title: row.title, excerpt } : null;
}

type Identity = { name: string; rank: number; source: RewriteBrandSource };
const identityField = new RegExp("^(?:本账号的?|我方|我们的|本公司|本企业|本品牌)?(" + nameLabels.join("|") + ")\\s*[：:]\\s*(.+)$", "u");
function identityCandidates(row: BrandRow, source: RewriteBrandSource): Identity[] {
  if (row.form_kind === "profile" && typeof row.account_name === "string" && source.excerpt.includes("发布名称：" + row.account_name)) {
    return [{ name: row.account_name.trim(), rank: 0, source }];
  }
  if (row.form_kind || row.priority !== 1 || /第三方|竞品|对标|客户案例|合作方|合作品牌|其他品牌|外部案例|引用案例/u.test(row.title + "\n" + source.excerpt)) return [];
  const choices: Identity[] = [];
  for (const line of source.excerpt.split(/[\n；;。]/u)) {
    const match = identityField.exec(line.trim());
    if (!match) continue;
    const name = match[2].trim().replace(/^[「“《"]|[」”》"]$/gu, "");
    if (!name || name.length > 100 || /[、，,。！？!?：:；;|｜]/u.test(name)) continue;
    const rank = /发布名称|账号名称|品牌名称|品牌名/u.test(match[1]) ? 1 : /简称/u.test(match[1]) ? 2 : 3;
    choices.push({ name, rank, source });
  }
  return choices;
}

type Proof = [string, number, string, number];
function proof(row: BrandRow): Proof { return [row.version_id, row.version, row.updated_at, row.peer_count]; }

export async function readRewriteBrandContext(db: D1Database, scope: RewriteBrandScope, query = ""): Promise<RewriteBrandContext> {
  const terms = queryTerms(query);
  const { results } = await db.prepare(rankedQuery).bind(scope.organizationId, scope.projectId, JSON.stringify(terms)).all<BrandRow>();
  const sources: RewriteBrandSource[] = [];
  const identities: Identity[] = [];
  for (const row of results) {
    const source = asSource(row);
    if (source) { sources.push(source); identities.push(...identityCandidates(row, source)); }
  }
  const topRank = identities.reduce((rank, entry) => Math.min(rank, entry.rank), Infinity);
  const leading = identities.filter(entry => entry.rank === topRank);
  const names = new Set(leading.map(entry => entry.name));
  // A crowded space must not silently pick one identity before examining all peers.
  const tier = topRank === 0 ? 0 : 1;
  const peers = results.filter(row => row.priority === tier);
  const truncatedIdentity = peers.length > 0 && peers[0].peer_count > peers.length;
  const identity = !truncatedIdentity && names.size === 1 ? leading[0] : null;
  const missing = identity ? [] : [names.size > 1 || truncatedIdentity
    ? "当前空间有多条可能的发布主体，请核对品牌知识中要使用的发布名称。"
    : "请在当前空间确认一条含发布名称、品牌名称或企业全称的品牌知识。"];
  const stamp = JSON.stringify([scope.organizationId, scope.projectId, terms, results.map(proof)]);
  return { ...scope, targetName: identity?.name ?? null, targetSourceId: identity?.source.itemId ?? null, sources, missing, stamp };
}

/** Attach to the same statement that stores the model output, after its ordinary workspace access guard. */
export function rewriteBrandGuard(scope: RewriteBrandScope, stamp: string): { sql: string; bindings: string[] } {
  const invalid = { sql: "0", bindings: [] };
  if (!stamp || stamp.length > maxStamp) return invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(stamp); } catch { return invalid; }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== scope.organizationId || parsed[1] !== scope.projectId) return invalid;
  const [, , terms, rows] = parsed;
  if (!Array.isArray(terms) || terms.length > maxTerms || !terms.every(term => typeof term === "string" && term.length <= 48)
    || !Array.isArray(rows) || rows.length > sourceLimit || !rows.every(row => Array.isArray(row) && row.length === 4
      && typeof row[0] === "string" && Number.isSafeInteger(row[1]) && typeof row[2] === "string" && Number.isSafeInteger(row[3]))) return invalid;
  return {
    sql: `(SELECT json_group_array(json_array(version_id,version,updated_at,peer_count)) FROM (${rankedQuery})) = ?`,
    bindings: [scope.organizationId, scope.projectId, JSON.stringify(terms), JSON.stringify(rows)],
  };
}
