/** Suggestions remain editable text. Choosing one never confirms a product fact. */
export const productQuestionOptions = {
  category: ["食品饮料", "家居日用", "美妆个护", "服饰配件", "数码家电", "课程与知识服务", "企业服务"],
  user: ["上班族", "学生", "有孩子的家庭", "居家生活人群", "学习提升人群", "企业团队"],
  buyer: ["使用者本人", "家长", "伴侣或家庭成员", "企业采购负责人"],
  scene: ["日常居家使用", "办公或学习", "外出与旅行", "送礼", "专业工作", "课程学习与练习"],
  concern: ["不清楚是否适合自己", "担心实际效果", "觉得价格偏高", "担心使用麻烦", "不清楚与其他选择的区别", "担心质量或售后"],
} as const;

export function productAnswerSelection(value: string, options: readonly string[], editingCustom = false) {
  if (editingCustom) return "__custom__";
  if (!value) return "";
  return options.includes(value) ? value : "__custom__";
}

export function productAnswerTransition(value: string, previousCustom: string, next: string, options: readonly string[]) {
  const custom = value && !options.includes(value) ? value : previousCustom;
  if (next === "__custom__") return { value: custom, custom, editingCustom: true };
  if (next === "" || options.includes(next)) return { value: next, custom, editingCustom: false };
  return { value, custom, editingCustom: !options.includes(value) };
}
