import { knowledgeCategories, knowledgeSourceTypes, type KnowledgeCategory, type KnowledgeSourceType } from "./content-ops";

export const KNOWLEDGE_IMPORT_MAX_ROWS = 100;

export type KnowledgeImportRow = {
  rowNumber: number;
  title: string;
  category: KnowledgeCategory;
  body: string;
  sourceType: KnowledgeSourceType;
  sourceRef: string | null;
};

export type KnowledgeImportIssue = { rowNumber: number; message: string };

const categoryAliases: Record<string, KnowledgeCategory> = {
  品牌故事: "brand_story", "创始人/出镜人": "founder", 创始人: "founder", 出镜人: "founder",
  成功案例: "case_study", 客户问题: "customer_question", 销售话术: "sales_script",
  历史优质文案: "high_performing_copy", 行业术语: "industry_term", 禁用词与合规: "compliance",
  合规要求: "compliance", 品牌语气: "brand_voice", 客户修改偏好: "client_preference", 其他: "other",
};

const sourceAliases: Record<string, KnowledgeSourceType> = {
  人工录入: "manual", 客户资料: "document", 网页来源: "url", 客户反馈: "client_feedback", 分析沉淀: "analysis",
};

function text(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; }
function valueFrom(row: Record<string, unknown>, aliases: readonly string[]) {
  for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  return "";
}

function normalizeCategory(value: unknown): KnowledgeCategory | null {
  const clean = text(value); if (!clean) return null;
  if (knowledgeCategories.includes(clean as KnowledgeCategory)) return clean as KnowledgeCategory;
  return categoryAliases[clean] ?? null;
}

function normalizeSourceType(value: unknown): KnowledgeSourceType | null {
  const clean = text(value) || "人工录入";
  if (knowledgeSourceTypes.includes(clean as KnowledgeSourceType)) return clean as KnowledgeSourceType;
  return sourceAliases[clean] ?? null;
}

export function validateKnowledgeImportRows(input: unknown): { rows: KnowledgeImportRow[]; issues: KnowledgeImportIssue[] } {
  if (!Array.isArray(input)) return { rows: [], issues: [{ rowNumber: 0, message: "Excel 数据格式无效。" }] };
  if (input.length > KNOWLEDGE_IMPORT_MAX_ROWS) return { rows: [], issues: [{ rowNumber: 0, message: `单次最多导入 ${KNOWLEDGE_IMPORT_MAX_ROWS} 条知识。` }] };
  const rows: KnowledgeImportRow[] = []; const issues: KnowledgeImportIssue[] = []; const seen = new Set<string>();
  input.forEach((candidate, index) => {
    const rowNumber = index + 2;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { issues.push({ rowNumber, message: "该行不是有效的数据记录。" }); return; }
    const row = candidate as Record<string, unknown>;
    const title = text(valueFrom(row, ["标题", "title"]));
    const category = normalizeCategory(valueFrom(row, ["分类", "category"]));
    const body = text(valueFrom(row, ["知识正文", "正文", "body"]));
    const sourceType = normalizeSourceType(valueFrom(row, ["来源类型", "来源", "sourceType", "source_type"]));
    const sourceRefText = text(valueFrom(row, ["来源说明或链接", "来源说明", "sourceRef", "source_ref"]));
    const rowIssues: string[] = [];
    if (title.length < 2 || title.length > 120) rowIssues.push("标题需为 2 至 120 个字符");
    if (!category) rowIssues.push("分类不在模板允许范围内");
    if (body.length < 10 || body.length > 20000) rowIssues.push("知识正文需为 10 至 20000 个字符");
    if (!sourceType) rowIssues.push("来源类型无效");
    if (sourceType && sourceType !== "manual" && !sourceRefText) rowIssues.push("非人工录入必须填写来源说明或链接");
    const dedupeKey = `${title.toLocaleLowerCase("zh-CN")}\u0000${body}`;
    if (!rowIssues.length && seen.has(dedupeKey)) rowIssues.push("与本文件前面的知识重复");
    if (rowIssues.length || !category || !sourceType) { issues.push({ rowNumber, message: rowIssues.join("；") }); return; }
    seen.add(dedupeKey);
    rows.push({ rowNumber, title, category, body, sourceType, sourceRef: sourceRefText ? sourceRefText.slice(0, 1000) : null });
  });
  return { rows, issues };
}
