import { z } from "zod";

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const productionCitationSchema = z.object({
  sourceType: z.enum(["topic", "knowledge", "video_analysis", "strategy", "benchmark"]),
  sourceId: shortText(200),
  quote: shortText(1000),
}).strict();

export const productionPackSchema = z.object({
  hooks: z.array(shortText(200)).min(2).max(5),
  fullScript: shortText(12_000).refine((value) => value.length >= 20),
  shortScript: shortText(6_000).refine((value) => value.length >= 10),
  storyboard: z.array(z.object({
    shot: shortText(120),
    visual: shortText(500),
    script: shortText(2_000),
    performance: shortText(500),
    durationSec: z.number().int().min(1).max(300),
  }).strict()).min(1).max(30),
  performanceNotes: z.array(shortText(500)).max(20),
  brollSuggestions: z.array(shortText(500)).max(20),
  subtitleHighlights: z.array(shortText(200)).max(20),
  coverCopy: z.array(shortText(120)).min(1).max(10),
  publishTitles: z.array(shortText(160)).min(1).max(10),
  hashtags: z.array(shortText(80)).max(20),
  commentPrompt: shortText(500),
  adaptations: z.array(z.object({ platform: shortText(80), copy: shortText(4_000) }).strict()).max(10),
  citations: z.array(productionCitationSchema).min(1).max(30).refine(
    (items) => new Set(items.map((item) => `${item.sourceType}:${item.sourceId}`)).size === items.length,
    "引用来源不能重复",
  ),
  riskNotes: z.array(shortText(500)).max(20),
}).strict();

export type ProductionPack = z.infer<typeof productionPackSchema>;

export const createContentItemSchema = z.object({
  organizationId: shortText(100),
  projectId: shortText(100),
  topicId: shortText(100),
}).strict();

export const saveContentVersionSchema = z.object({
  organizationId: shortText(100),
  projectId: shortText(100),
  pack: productionPackSchema,
  changeSummary: z.string().trim().max(500).optional(),
}).strict();

export const generateContentSchema = z.object({
  organizationId: shortText(100),
  projectId: shortText(100),
  modelProfile: z.enum(["fast", "standard", "advanced"]).default("standard"),
  benchmarkEntryIds: z.array(shortText(100)).max(5).default([]),
}).strict();

export const CONTENT_PROMPT_VERSION = "content-draft.v2";
export const CONTENT_PROMPT_NAME = "口播稿与短视频生产包";
export const CONTENT_SYSTEM_PROMPT = `你是新媒体服务公司的资深内容策划。根据给定选题、已启用策略、已确认品牌知识和用户选择的对标样本，生成可直接进入审核的原创短视频生产包。

要求：
1. 只使用输入中提供的事实，不补造客户案例、数据、资质或承诺；
2. 对标样本只用于学习钩子、结构、节奏、情绪和转化方法，不能近义改写、拼接或洗稿来源原文；
3. 完整口播稿要自然、口语化、可拍摄，开头快速进入问题；
4. 每个事实性表达必须在 citations 中引用输入提供的来源 ID 和原文；输入含 benchmark 来源时，至少引用一条 benchmark，证明本次确实使用了对标内容库；
5. 风险、不确定信息和需要客户确认的内容写入 riskNotes；
6. 仅输出 JSON，不要 Markdown、解释或代码围栏。`;

export const CONTENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hooks", "fullScript", "shortScript", "storyboard", "performanceNotes", "brollSuggestions", "subtitleHighlights", "coverCopy", "publishTitles", "hashtags", "commentPrompt", "adaptations", "citations", "riskNotes"],
  properties: {
    hooks: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } },
    fullScript: { type: "string" }, shortScript: { type: "string" },
    storyboard: { type: "array", items: { type: "object", additionalProperties: false, required: ["shot", "visual", "script", "performance", "durationSec"], properties: { shot: { type: "string" }, visual: { type: "string" }, script: { type: "string" }, performance: { type: "string" }, durationSec: { type: "integer" } } } },
    performanceNotes: { type: "array", items: { type: "string" } }, brollSuggestions: { type: "array", items: { type: "string" } }, subtitleHighlights: { type: "array", items: { type: "string" } },
    coverCopy: { type: "array", items: { type: "string" } }, publishTitles: { type: "array", items: { type: "string" } }, hashtags: { type: "array", items: { type: "string" } }, commentPrompt: { type: "string" },
    adaptations: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "copy"], properties: { platform: { type: "string" }, copy: { type: "string" } } } },
    citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceType", "sourceId", "quote"], properties: { sourceType: { enum: ["topic", "knowledge", "video_analysis", "strategy", "benchmark"] }, sourceId: { type: "string" }, quote: { type: "string" } } } },
    riskNotes: { type: "array", items: { type: "string" } },
  },
} as const;

export function createProductionScaffold(topic: { id: string; title: string; angle?: string | null; hook?: string | null; objective?: string | null }) {
  const hook = topic.hook?.trim() || `为什么很多人知道“${topic.title}”，却一直做不到？`;
  const angle = topic.angle?.trim() || `围绕“${topic.title}”说明问题、方法和下一步行动。`;
  const objective = topic.objective?.trim() || "帮助目标用户建立清晰认知并愿意继续交流";
  return productionPackSchema.parse({
    hooks: [hook, `别急着下结论，先看清“${topic.title}”背后的关键问题。`],
    fullScript: `${hook}\n\n${angle}\n\n先把常见误区讲清楚，再结合已确认的品牌事实补充方法、案例或证据。最后给出一个具体、可执行的下一步，并以“${objective}”为内容目标完成收束。`,
    shortScript: `${hook}\n${angle}\n用一个明确方法给出下一步行动。`,
    storyboard: [{ shot: "开场近景", visual: "人物正面出镜，字幕突出核心问题", script: hook, performance: "直接、克制，首句后停顿半秒", durationSec: 5 }],
    performanceNotes: ["事实和案例补齐前不要使用绝对化表达", "重要结论前短暂停顿，突出关键词"],
    brollSuggestions: ["与选题相关的工作场景或产品细节", "方法步骤对应的简洁图卡"],
    subtitleHighlights: [topic.title], coverCopy: [topic.title], publishTitles: [topic.title], hashtags: [],
    commentPrompt: "你在这个问题上最想解决的具体困难是什么？",
    adaptations: [], citations: [{ sourceType: "topic", sourceId: topic.id, quote: topic.title }],
    riskNotes: ["当前为结构草稿，发布前需补齐并核对品牌事实与合规要求"],
  });
}

export function parseProductionPack(value: unknown) {
  return productionPackSchema.safeParse(value);
}

export function parseModelJson(value: string) {
  const trimmed = value.replace(/^\uFEFF/, "").trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(withoutFence) as unknown; } catch { /* try the first balanced JSON object below */ }
  const start = withoutFence.indexOf("{");
  if (start < 0) throw new SyntaxError("模型响应中没有 JSON 对象。");
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < withoutFence.length; index += 1) {
    const character = withoutFence[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(withoutFence.slice(start, index + 1)) as unknown;
    }
  }
  throw new SyntaxError("模型响应中的 JSON 对象不完整。");
}

export function analysisReportSourceText(reportJson: string) {
  try {
    const report = JSON.parse(reportJson) as Record<string, unknown>;
    const sections: string[] = [];
    const labels: Record<string, string> = { summary: "核心结论", spoken_script: "口播结构", hook_analysis: "钩子方法", viral_points: "爆点", rhythm_analysis: "节奏", emotion_curve: "情绪", conversion_design: "转化设计", highlights: "亮点", risks: "风险", recommendations: "复用建议" };
    for (const [key, label] of Object.entries(labels)) {
      const value = report[key];
      if (typeof value === "string" && value.trim()) sections.push(`${label}：${value.trim()}`);
      else if (Array.isArray(value)) {
        const items = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
        if (items.length) sections.push(`${label}：\n${items.join("\n")}`);
      }
    }
    return (sections.length ? sections.join("\n\n") : reportJson).slice(0, 8_000);
  } catch { return reportJson.slice(0, 8_000); }
}
