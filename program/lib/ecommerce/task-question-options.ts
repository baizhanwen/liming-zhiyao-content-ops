import { taskBriefSchema, type ProductPublic, type TaskBrief } from "./contracts.ts";

export const taskQuestionOptions = {
  user: ["个人自用者", "家庭用户", "家长与孩子", "上班族", "学生", "企业或门店用户"],
  buyer: ["使用者本人", "家人代购", "家长", "企业或门店负责人"],
  scene: ["日常居家使用", "工作或学习时", "外出或旅行时", "送礼或节日场景", "原有产品需要替换时"],
  barrier: ["不了解产品能解决什么问题", "担心实际效果不符合预期", "担心价格不值", "担心操作复杂", "不确定是否适合自己", "已有替代方案，不急着更换"],
  destination: ["点击当前视频商品卡查看详情", "进入主页查看商品", "进入直播间了解详情", "根据页面指引完成购买"],
} as const;

/** Exact matches only: a saved custom description must never become a preset. */
export function taskQuestionSelection(value: string, options: readonly string[]) {
  return options.includes(value) ? value : value ? "custom" : "";
}

export function firstVideoTaskTitle(name: string) {
  const suffix = " · 第一条商品视频";
  let prefix = "";
  for (const character of name) {
    if (prefix.length + character.length + suffix.length > 300) break;
    prefix += character;
  }
  return prefix + suffix;
}

export function taskBriefForProduct(brief: TaskBrief, product: ProductPublic | null): TaskBrief {
  return {
    ...brief,
    audience: { ...(product?.audience ?? taskBriefSchema.parse({ audience: {} }).audience) },
    scene: product?.scenarios ?? "", barrier: product?.purchaseConcerns ?? "", destination: product?.landingUrl ?? "",
    claimId: "", evidenceIds: [],
  };
}

export function initialTaskDraft({ row, products, initialProductVersionId = "", guided = false }: {
  row?: { title: string; product_version_id: string; brief_json: string };
  products: { name: string; version_id: string; public_json: string }[];
  initialProductVersionId?: string;
  guided?: boolean;
}) {
  if (row) return { title: row.title, versionId: row.product_version_id, brief: JSON.parse(row.brief_json) as TaskBrief };
  const product = products.find(item => item.version_id === initialProductVersionId);
  const empty = taskBriefSchema.parse({ audience: {} });
  return {
    title: guided && product ? firstVideoTaskTitle(product.name) : "",
    versionId: product?.version_id ?? "",
    brief: product ? taskBriefForProduct(empty, JSON.parse(product.public_json) as ProductPublic) : empty,
  };
}
