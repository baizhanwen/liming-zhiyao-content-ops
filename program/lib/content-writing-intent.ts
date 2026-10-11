import { z } from "zod";

export const writingIntentLabels = {
  auto: "AI 自动判断",
  explain: "科普讲解",
  tutorial: "操作教程",
  opinion: "观点表达",
  brand: "品牌介绍",
} as const;

export const writingIntentSchema = z.enum(["auto", "explain", "tutorial", "opinion", "brand"]);
export type WritingIntent = z.infer<typeof writingIntentSchema>;
export const resolvedWritingIntentSchema = z.object({
  kind: z.enum(["explain", "tutorial", "opinion", "brand"]),
  reason: z.string().trim().min(1).max(200),
}).strict();

export const CONTENT_WRITING_GUIDANCE = `创作意图与通用知识：
- taskBrief.writingIntent 为 auto 时，根据本次选题、角度、受众与目标判断科普讲解、操作教程、观点表达或品牌介绍；不能仅因账号属于企业就判断为品牌介绍。手动指定时遵循指定意图。
- 《AI发展史》这类历史或概念题通常按科普讲解，正文需要有具体发展脉络、关键变化与通俗解释；《怎么使用ChatGPT》这类任务通常按操作教程，交付具体步骤和例子。不得写成教作者如何写稿的提纲。
- 没有用户素材仍须完成可直接念出的口播稿。可使用模型有把握的稳定通用知识、公开历史常识和明确标注的假设示例；通用知识不属于客户事实，不要求以品牌资料证明，也不伪造来源、网址、逐字引文或“已经联网核实”的说法。
- 有争议、时效性强或把握不足的具体年份、数字、研究结论写入 riskNotes 说明待核实；删去非必要的不确定细节。不能因没有公司案例就把整篇科普稿标记为 blocked，也不能用空话填补知识不足。
- 科普需要区分通俗比喻与严格定义；历史演变中多种路线可能同时存在，不能把主线简化为旧方法完全消失、新方法突然出现，也不能无依据宣称某一步是“第一次”。对于理解、意识等存在争论的概念，不写成已经定论的绝对断言。只说明有把握的机制和局限。
- 公司经历、客户案例、产品能力和业绩只能使用本次已选 projectFacts。选择资料表示允许按相关性使用，不代表必须植入；无关资料可不采用。未选品牌知识时不插入公司案例，不能把通用或假设示例写成公司的真实成果。
- 根据意图选择结构与结尾。科普兑现解释，教程兑现步骤，观点给出理由；没有明确营销要求时不加入咨询、购买、私信等转化动作，不把所有结尾都写成“下一步行动”。
- fullScript 和 shortScript 只写观众实际听到的完整台词，不出现“先把误区讲清楚”“再补充案例”“待补充”等写作指令或占位文字。无明确时长要求时，完整稿以约500–800个中文字为参考，根据内容密度调整。
- 在 writingIntent 中返回实际 kind 和简短 reason，说明本次为什么采用这种写法；reason 只解释写法，不宣称事实已经核实。`;

export function incompleteScriptReason(pack: { fullScript: string; shortScript: string }) {
  const placeholder = /先把常见误区讲清楚，再结合已确认的品牌事实|用一个明确方法给出下一步行动|这份内容尚未生成口播稿|精简版尚未生成|待结合(?:目标人群|具体受众)补充|[【[]待补充[】\]]/u;
  return placeholder.test(pack.fullScript) || placeholder.test(pack.shortScript)
    ? "口播稿仍包含写作指令或占位文字，请写出具体内容和完整台词。"
    : null;
}
