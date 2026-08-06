import { z } from "zod";

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

export const TOPIC_GENERATION_PROMPT_VERSION = "topic-fields.v1";
export const TOPIC_GENERATION_SYSTEM_PROMPT = `你是新媒体服务公司的资深选题策划，负责补全短视频选题表单。

规则：
1. 用户已经填写的非目标字段是明确约束，必须保留其意图，不得在输出中改写；
2. 只为 targets 指定的字段生成内容；若目标字段已有旧内容，生成明显更好的新版本，不做简单同义改写；
3. 内容要具体、简洁、可用于短视频策划，使用自然中文；
4. 不虚构数据、客户案例、资质、效果承诺或输入中不存在的事实；
5. angle 说明独特切入方式，pillar 使用简短分类，priority 根据受众覆盖、业务相关性和传播潜力给出 0-100 的整数，audience 描述明确人群，objective 说明希望产生的用户行动或认知，hook 给出可直接口播的开场，rationale 解释选题价值；
6. 仅输出 JSON 对象，不要 Markdown、说明或代码围栏。`;

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
    if (!generated) throw new Error(`模型没有生成字段：${field}`);
    selected[field] = generated;
  }
  return selected;
}
