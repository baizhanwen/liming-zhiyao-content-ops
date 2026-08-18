import { z } from "zod";
import { AUTHORIZED_METHODOLOGY_ENABLED, CONTENT_CREATION_METHODOLOGY } from "./authorized-content-methodology.ts";

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const productionCitationSchema = z.object({
  sourceType: z.enum(["topic", "knowledge", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"]),
  sourceId: shortText(200),
  quote: shortText(80).refine((value) => canonicalCitationText(value).length >= 8, "引用原文需要至少 8 个有效字符"),
}).strict();

const sourceUsageKeySchema = z.enum(["topic", "selected_knowledge", "project_knowledge", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"]);
export const sourceUsageReportSchema = z.object({
  status: z.enum(["verified", "partial"]),
  traceableCitationCount: z.number().int().min(0).max(30),
  groups: z.array(z.object({
    key: sourceUsageKeySchema,
    sourceType: productionCitationSchema.shape.sourceType,
    label: shortText(80),
    required: z.boolean(),
    availableCount: z.number().int().min(0).max(100),
    citedCount: z.number().int().min(0).max(30),
    citedSourceIds: z.array(shortText(200)).max(30),
    evidenceQuotes: z.array(shortText(80)).max(30),
  }).strict()).max(8),
  checks: z.array(z.object({ key: sourceUsageKeySchema, label: shortText(120), passed: z.boolean(), detail: shortText(500) }).strict()).max(8),
}).strict();

export const contentQualityReviewSchema = z.object({
  coreMechanism: shortText(500),
  hookDiagnosis: z.object({
    topic: shortText(300),
    hook: shortText(300),
    credibility: shortText(300),
    suspense: shortText(300),
    verdict: z.enum(["strong", "revise", "blocked"]),
  }).strict(),
  resonance: z.object({
    silentRelease: shortText(500),
    motivation: shortText(500),
    stance: shortText(500),
    firstSharer: shortText(500),
    beliefShift: shortText(500),
  }).strict(),
  flowRisks: z.array(z.object({
    level: z.enum(["high", "medium", "low"]),
    location: shortText(160),
    issue: shortText(500),
    fix: shortText(500),
  }).strict()).max(12),
  benchmarkMethods: z.array(z.object({
    sourceId: shortText(200),
    method: shortText(500),
    application: shortText(500),
  }).strict()).max(5),
  publishReadiness: z.enum(["ready", "revise", "blocked"]),
  blockers: z.array(shortText(500)).max(12),
}).strict();

export const historicalStyleApplicationSchema = z.object({
  status: z.enum(["passed", "review", "rewrite"]),
  confidence: z.enum(["low", "medium", "high"]),
  sourceIds: z.array(shortText(200)).max(5),
  matchedChecks: z.number().int().min(0).max(6),
  totalChecks: z.number().int().min(0).max(6),
  checks: z.array(z.object({ key: z.enum(["characters", "paragraphs", "hook", "cta", "tone", "monetization"]), label: shortText(80), matched: z.boolean(), expected: shortText(500), actual: shortText(500) }).strict()).max(6),
  actual: z.object({
    characterCount: z.number().int().min(0), paragraphCount: z.number().int().min(1), averageParagraphLength: z.number().int().min(0),
    hookType: z.enum(["question", "numbered", "contrast", "story", "pain_point", "direct"]),
    ctaType: z.enum(["private_message", "comment", "follow", "consultation", "purchase", "join", "download", "save_share", "none"]),
    toneTags: z.array(shortText(80)).max(10),
    monetizationTypes: z.array(z.enum(["none", "private_message", "consultation", "course", "community", "product", "lead_magnet", "brand_awareness", "other"])).max(5),
  }).strict(),
  originality: z.object({ passed: z.boolean(), longestSharedCharacters: z.number().int().min(0), sourceId: z.string().nullable(), phrase: z.string().nullable() }).strict(),
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
  // Optional only for compatibility with production packs created before v3.
  // The v3 model output schema below requires this field for all new generations.
  qualityReview: contentQualityReviewSchema.optional(),
  // Computed by the server after generation. Older production packs do not contain it.
  historicalStyleApplication: historicalStyleApplicationSchema.optional(),
  // Computed from validated citations by the server. It separates available context from traceable adoption.
  sourceUsageReport: sourceUsageReportSchema.optional(),
}).strict();

export type ProductionPack = z.infer<typeof productionPackSchema>;

export function canonicalCitationText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s"'“”„‟‘’「」『』《》〈〉【】〔〕(){}【】,，。！!？?:：;；、…—–·•]+/gu, "");
}

export function citationQuoteMatchesSource(sourceText: string, quote: string) {
  const source = canonicalCitationText(sourceText);
  const candidate = canonicalCitationText(quote);
  return candidate.length >= 8 && candidate.length <= 80 && source.includes(candidate);
}

type UsageSource = { sourceType: z.infer<typeof productionCitationSchema>["sourceType"]; sourceId: string };
type UsageCitation = z.infer<typeof productionCitationSchema>;

export function buildSourceUsageReport(availableSources: UsageSource[], citations: UsageCitation[], selectedKnowledgeSourceIds: Iterable<string> = []) {
  const selectedKnowledge = new Set(selectedKnowledgeSourceIds);
  const definitions: { key: z.infer<typeof sourceUsageKeySchema>; sourceType: UsageSource["sourceType"]; label: string; required: boolean; include: (source: UsageSource) => boolean }[] = [
    { key: "topic", sourceType: "topic", label: "选题信息", required: false, include: (source) => source.sourceType === "topic" },
    { key: "selected_knowledge", sourceType: "knowledge", label: "选题指定品牌知识", required: selectedKnowledge.size > 0, include: (source) => source.sourceType === "knowledge" && selectedKnowledge.has(source.sourceId) },
    { key: "project_knowledge", sourceType: "knowledge", label: "项目品牌知识", required: selectedKnowledge.size === 0, include: (source) => source.sourceType === "knowledge" && !selectedKnowledge.has(source.sourceId) },
    { key: "video_analysis", sourceType: "video_analysis", label: "选题关联视频分析", required: true, include: (source) => source.sourceType === "video_analysis" },
    { key: "strategy", sourceType: "strategy", label: "当前内容策略", required: true, include: (source) => source.sourceType === "strategy" },
    { key: "benchmark", sourceType: "benchmark", label: "所选对标样本", required: true, include: (source) => source.sourceType === "benchmark" },
    { key: "method_knowledge", sourceType: "method_knowledge", label: "授权方法知识", required: true, include: (source) => source.sourceType === "method_knowledge" },
    { key: "historical_copy", sourceType: "historical_copy", label: "品牌历史文案", required: true, include: (source) => source.sourceType === "historical_copy" },
  ];
  const groups = definitions.flatMap((definition) => {
    const availableIds = new Set(availableSources.filter(definition.include).map((source) => source.sourceId));
    if (!availableIds.size) return [];
    const evidence = citations.filter((citation) => citation.sourceType === definition.sourceType && availableIds.has(citation.sourceId));
    const citedSourceIds = Array.from(new Set(evidence.map((citation) => citation.sourceId)));
    return [{
      key: definition.key,
      sourceType: definition.sourceType,
      label: definition.label,
      required: definition.required,
      availableCount: availableIds.size,
      citedCount: citedSourceIds.length,
      citedSourceIds,
      evidenceQuotes: evidence.map((citation) => citation.quote),
    }];
  });
  const checks = groups.filter((group) => group.required).map((group) => ({
    key: group.key,
    label: `${group.label}采用证据`,
    passed: group.citedCount > 0,
    detail: group.citedCount > 0 ? `已通过 ${group.citedCount} 条来源的逐字引用建立追溯。` : `已向模型提供 ${group.availableCount} 条，但没有形成可追溯引用。`,
  }));
  return sourceUsageReportSchema.parse({
    status: checks.every((check) => check.passed) ? "verified" : "partial",
    traceableCitationCount: citations.length,
    groups,
    checks,
  });
}

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
  recommendedBenchmarkIds: z.array(shortText(100)).max(5).default([]),
}).strict();

export const CONTENT_PROMPT_VERSION = "content-draft.v10-material-feedback-loop";
export const CONTENT_PROMPT_NAME = "口播稿、短视频生产包与质量诊断";
export const CONTENT_JSON_EXAMPLE = `JSON 顶层结构示例（实际输出必须填写完整内容并保留全部字段）：
{"hooks":["开头一","开头二"],"fullScript":"完整口播稿","shortScript":"短版口播稿","storyboard":[{"shot":"镜头一","visual":"画面","script":"台词","performance":"表演提示","durationSec":5}],"performanceNotes":[],"brollSuggestions":[],"subtitleHighlights":[],"coverCopy":["封面文案"],"publishTitles":["发布标题"],"hashtags":[],"commentPrompt":"评论引导","adaptations":[],"citations":[{"sourceType":"topic","sourceId":"输入中的真实来源 ID","quote":"从该来源逐字引用的原文"}],"riskNotes":[],"qualityReview":{"coreMechanism":"唯一核心机制","hookDiagnosis":{"topic":"话题","hook":"抓手","credibility":"可信度","suspense":"悬念","verdict":"strong"},"resonance":{"silentRelease":"沉默解除","motivation":"满足动机","stance":"有效立场","firstSharer":"首批传播者","beliefShift":"信念与行动"},"flowRisks":[],"benchmarkMethods":[],"publishReadiness":"ready","blockers":[]}}`;
export const CONTENT_SYSTEM_PROMPT = `你是新媒体服务公司的资深内容策划。根据给定选题、已启用策略、已确认品牌知识和用户选择的对标样本，生成可直接进入审核的原创短视频生产包。

${AUTHORIZED_METHODOLOGY_ENABLED ? CONTENT_CREATION_METHODOLOGY : ""}

执行要求：
1. 只使用输入中提供的事实，不补造客户案例、数据、资质、成绩、身份或承诺；
2. 完整口播稿要围绕 qualityReview.coreMechanism 展开，开头承诺必须由正文兑现；
3. 对标样本只用于学习方法，不能近义改写、拼接、搬运或洗稿来源原文；
4. 每个事实性表达必须在 citations 中引用输入提供的来源 ID 和逐字原文；quote 只复制来源 text 中 8–80 字的连续短原文，不要改写、概括、补全或添加引号；输入含 benchmark 来源时，至少引用一条 benchmark；输入含 method_knowledge 时，至少引用一条实际采用的方法原文；
5. qualityReview.benchmarkMethods 只填写本次实际采用的对标方法，sourceId 必须对应输入中的 benchmark 来源；
6. 风险、不确定信息和需要客户确认的内容写入 riskNotes；事实不足或内容价值不足时在 qualityReview 中如实标记 revise 或 blocked；
7. 输入含 historical_copy 时，必须至少引用一条实际采用的历史文案；只学习其字数区间、段落节奏、开场结构、行动引导和变现方式，不得拼接、洗稿或连续复用历史正文超过 12 个字（citations.quote 中用于追溯的原文不受此限制）；
8. 输入含 historicalStyleProfile 时，优先遵循 suggestedMinCharacters–suggestedMaxCharacters、suggestedMinParagraphs–suggestedMaxParagraphs、bestHookType、bestCtaType、toneTags 和 bestMonetizationType；confidence 为 low 时仅作弱参考，不能为迎合画像而虚构事实或强行加入转化动作；
9. 系统会在生成后客观检测完整口播稿的字数、段落、开场、行动引导、语气、变现方式和与历史原文的连续重复片段；检测不通过时会把具体差异返回给你重写；
10. 当前内容策略必须形成至少一条 strategy 引用；选题指定了品牌知识时，必须引用至少一条指定 knowledge；未指定时至少引用一条项目 knowledge；选题来自视频分析时，必须引用对应 video_analysis；
11. 输入中的 benchmarkFeedback 是系统根据历史审核、人工修订和发布指标汇总的反馈信号。优先采用主题匹配且历史通过率、真实表现更好的方法；退回和人工修订较多的样本只用于规避问题。不得把相关性信号说成因果结论，也不得在成稿中披露内部评分；
12. 不要输出 historicalStyleApplication 或 sourceUsageReport，这两个字段由系统检测后写入；仅输出 JSON，不要输出 Markdown、解释或代码围栏。

${CONTENT_JSON_EXAMPLE}`;

export const CONTENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hooks", "fullScript", "shortScript", "storyboard", "performanceNotes", "brollSuggestions", "subtitleHighlights", "coverCopy", "publishTitles", "hashtags", "commentPrompt", "adaptations", "citations", "riskNotes", "qualityReview"],
  properties: {
    hooks: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } },
    fullScript: { type: "string" }, shortScript: { type: "string" },
    storyboard: { type: "array", items: { type: "object", additionalProperties: false, required: ["shot", "visual", "script", "performance", "durationSec"], properties: { shot: { type: "string" }, visual: { type: "string" }, script: { type: "string" }, performance: { type: "string" }, durationSec: { type: "integer" } } } },
    performanceNotes: { type: "array", items: { type: "string" } }, brollSuggestions: { type: "array", items: { type: "string" } }, subtitleHighlights: { type: "array", items: { type: "string" } },
    coverCopy: { type: "array", items: { type: "string" } }, publishTitles: { type: "array", items: { type: "string" } }, hashtags: { type: "array", items: { type: "string" } }, commentPrompt: { type: "string" },
    adaptations: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "copy"], properties: { platform: { type: "string" }, copy: { type: "string" } } } },
    citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceType", "sourceId", "quote"], properties: { sourceType: { enum: ["topic", "knowledge", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"] }, sourceId: { type: "string" }, quote: { type: "string" } } } },
    riskNotes: { type: "array", items: { type: "string" } },
    qualityReview: {
      type: "object", additionalProperties: false,
      required: ["coreMechanism", "hookDiagnosis", "resonance", "flowRisks", "benchmarkMethods", "publishReadiness", "blockers"],
      properties: {
        coreMechanism: { type: "string" },
        hookDiagnosis: { type: "object", additionalProperties: false, required: ["topic", "hook", "credibility", "suspense", "verdict"], properties: { topic: { type: "string" }, hook: { type: "string" }, credibility: { type: "string" }, suspense: { type: "string" }, verdict: { enum: ["strong", "revise", "blocked"] } } },
        resonance: { type: "object", additionalProperties: false, required: ["silentRelease", "motivation", "stance", "firstSharer", "beliefShift"], properties: { silentRelease: { type: "string" }, motivation: { type: "string" }, stance: { type: "string" }, firstSharer: { type: "string" }, beliefShift: { type: "string" } } },
        flowRisks: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["level", "location", "issue", "fix"], properties: { level: { enum: ["high", "medium", "low"] }, location: { type: "string" }, issue: { type: "string" }, fix: { type: "string" } } } },
        benchmarkMethods: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["sourceId", "method", "application"], properties: { sourceId: { type: "string" }, method: { type: "string" }, application: { type: "string" } } } },
        publishReadiness: { enum: ["ready", "revise", "blocked"] },
        blockers: { type: "array", maxItems: 12, items: { type: "string" } },
      },
    },
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
    adaptations: [], citations: [{ sourceType: "topic", sourceId: topic.id, quote: angle.slice(0, 80) }],
    riskNotes: ["当前为结构草稿，发布前需补齐并核对品牌事实与合规要求"],
    qualityReview: {
      coreMechanism: angle,
      hookDiagnosis: { topic: topic.title, hook, credibility: "待从品牌知识或真实案例中补充", suspense: "以问题保留认知缺口", verdict: "revise" },
      resonance: { silentRelease: "待结合目标人群补充", motivation: objective, stance: "站在目标用户的实际处境一侧", firstSharer: "待结合具体受众补充", beliefShift: objective },
      flowRisks: [], benchmarkMethods: [], publishReadiness: "revise", blockers: ["尚未完成事实核对和对标方法选择"],
    },
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
