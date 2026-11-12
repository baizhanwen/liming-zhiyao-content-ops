import type { ProductPublic, TaskBrief } from "./contracts";

export type CopyReadinessGap = { field: string; label: string; reason: string; example: string };
export type CopyReadiness = { ready: boolean; missing: CopyReadinessGap[]; summary: string };
type CopyProduct = Partial<Pick<ProductPublic, "category" | "specification" | "sellingPoints" | "scenarios" | "copyFacts" | "claims">> & { name?: string };
type CopyBrief = Partial<Pick<TaskBrief, "scene" | "barrier" | "audience">>;

const compact = (value: string) => value.trim().replace(/[\s，。！？、,.;；:：!？?]+/gu, "");
// Only known empty answers and unsupported adjectives are treated as missing.
// This is a minimal material check; the writing/review model still judges whether
// these details support a useful angle. We do not score by character count.
const genericAnswers = new Set([
  "无", "暂无", "未知", "待补充", "待填写", "自行填写", "暂无资料", "没有", "有", "是", "否",
  "便宜", "价格便宜", "价格低", "价格实惠", "实惠", "免费", "好用", "实用", "方便", "性价比高", "高性价比", "质量好", "品质好", "优质", "高质量", "省时", "省钱", "提升效率", "提高效率",
  "学习", "学习提升", "学习提升人群", "学习AI", "学AI", "提升学习", "课程", "AI课程", "课程学习", "课程学习与练习", "课程与知识服务", "知识服务", "零基础", "适合零基础", "入门", "简单易学", "专业", "系统", "实操", "内容丰富",
]);
const genericScenes = new Set([
  "日常使用", "日常居家使用", "办公或学习", "外出与旅行", "送礼", "专业工作", "课程学习与练习", "学习", "练习", "使用", "日常",
]);

function usable(value: string | undefined, repeated: Set<string>) {
  if (!value?.trim()) return false;
  return value.split(/[\n。；;]+/u).some(part => {
    const normalized = compact(part);
    return Boolean(normalized && !genericAnswers.has(normalized) && !repeated.has(normalized)
      && !/^(?:规格|数量|份数|课程数|版本)?\d+(?:\.\d+)?(?:份|个|门|套)?$/u.test(normalized)
      && !/^(?:待补|请填|填入|示例[:：]|【|\[)/u.test(part.trim()));
  });
}

/** Checks for enough real material to write, without inventing or mutating facts. */
export function assessEcommerceCopyReadiness({ product, brief }: { product: CopyProduct; brief?: CopyBrief }): CopyReadiness {
  const facts = product.copyFacts;
  const repeated = new Set([product.name, product.category].filter((value): value is string => Boolean(value)).map(compact));
  const confirmedClaims = product.claims?.filter(claim => claim.status === "confirmed").map(claim => claim.allowedExpression || claim.statement) ?? [];
  const ownDetails = [facts?.content, product.specification, product.sellingPoints, ...confirmedClaims];
  const hasProductDetail = ownDetails.some(value => usable(value, repeated));
  const mechanismDetails = [facts?.usage, facts?.difference, facts?.delivery, facts?.limitations, facts?.speakerExperience];
  const hasMechanism = mechanismDetails.some(value => usable(value, repeated));
  const scene = brief?.scene || product.scenarios;
  const hasScene = Boolean(scene?.trim() && !genericScenes.has(compact(scene)) && usable(scene, repeated));
  // A legacy free-text entry can already contain a complete example/mechanism;
  // do not force that user to copy it into a newly introduced form field.
  const describedProcess = [product.sellingPoints, product.specification, facts?.content, ...confirmedClaims]
    .some(value => value && /(?:用于|适合|通过|只需|配有|包含|附带|每节|每次|先.{1,30}再|将.{1,30}(?:转为|改成|生成)|旋开|旋紧|按下|打开|收纳|作业|模板|案例|演示|课程目录)/u.test(value) && usable(value, repeated));
  const course = /课程|知识|培训|教学/u.test(product.category ?? "");
  const missing: CopyReadinessGap[] = [];
  if (!hasProductDetail) missing.push({
    field: "content", label: course ? "具体教什么" : "一个具体商品特点",
    reason: "当前资料主要是名称、品类或笼统形容，无法形成有内容的购买理由。",
    example: course ? "写出一节课的主题和练习任务，例如课程目录中实际已有的一个内容。" : "写出真实规格、结构、包含物或操作方式；“便宜、好用”还不够具体。",
  });
  if (!hasMechanism && !hasScene && !describedProcess) missing.push({
    field: "usage", label: course ? "一项实际学习任务或交付" : "一个使用细节",
    reason: "还缺少把商品特点讲明白的场景、过程或交付细节，正文容易只剩概括。",
    example: course ? "说明学习者实际会做什么、得到什么材料，或需要具备什么基础。" : "说明谁在什么情况下怎么使用，或一个已确认的操作步骤。",
  });
  return {
    ready: missing.length === 0, missing,
    summary: missing.length ? "先补充关键内容，再写出有购买理由的文案。" : "已有具体商品内容与表达细节，可开始选择角度并生成文案。",
  };
}
