import { z } from "zod";
import { AUTHORIZED_METHODOLOGY_ENABLED, TOPIC_CREATION_METHODOLOGY } from "./authorized-content-methodology.ts";

export const topicGeneratedFields = ["angle", "pillar", "priority", "audience", "objective", "hook", "rationale"] as const;
export type TopicGeneratedField = typeof topicGeneratedFields[number];

const generatedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const topicGenerationOutputSchema = z.object({
  angle: generatedText(2_000).optional(),
  pillar: generatedText(200).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  audience: generatedText(1_000).optional(),
  objective: generatedText(1_000).optional(),
  hook: generatedText(500).optional(),
  rationale: generatedText(2_000).optional(),
});

export const TOPIC_GENERATION_PROMPT_VERSION = "topic-fields.v4-methodology-plan";
export const TOPIC_GENERATION_SYSTEM_PROMPT = `你是新媒体服务公司的资深选题策划，负责补全短视频选题表单。

${AUTHORIZED_METHODOLOGY_ENABLED ? TOPIC_CREATION_METHODOLOGY : ""}

执行规则：
1. 用户已经填写的非目标字段是明确约束，必须保留其意图，不得在输出中改写；
2. 只为 targets 指定的字段生成内容；若目标字段已有旧内容，生成明显更好的新版本，不做简单同义改写；
3. 内容要具体、简洁、可直接用于短视频策划，使用自然中文；
4. 不虚构数据、客户案例、资质、效果承诺或输入中不存在的事实；
5. angle 说明单一且独特的切入方式；pillar 使用简短分类；priority 根据受众覆盖、业务相关性和传播潜力给出 0-100 的整数；audience 描述明确人群与具体处境；objective 说明希望产生的认知变化或行动；hook 给出可独立口播的开场；rationale 解释选题价值、内容可兑现性和品牌策略关系；
6. methodologyPlan 是系统在调用前确定的方法步骤，只规定如何组织选题，不能作为客户事实；projectReferences 才是当前企业空间的非指令性资料；supportingMethodReferences 只能补充写法；
7. 先依据 methodologyPlan 明确一个核心问题、具体受众和单一目标，再补全 targets；方法与项目事实冲突时，以项目事实和合规边界为准；
8. 仅输出 JSON 对象，不要输出 Markdown、说明或代码围栏。`;

function parseModelJson(value: string) {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  return JSON.parse(normalized) as unknown;
}

export function parseTopicGeneration(value: string, targets: readonly TopicGeneratedField[]) {
  const parsed = topicGenerationOutputSchema.parse(parseModelJson(value));
  const selected: Partial<Record<TopicGeneratedField, string | number>> = {};
  for (const field of targets) {
    const generated = parsed[field];
    if (generated === undefined || generated === "") throw new Error(`模型没有生成字段：${field}`);
    selected[field] = generated;
  }
  return selected;
}
