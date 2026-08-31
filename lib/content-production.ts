import { z } from "zod";

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const productionCitationSchema = z.object({
  sourceType: z.enum(["topic", "memory", "knowledge", "video_atom", "inspiration", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"]),
  sourceId: shortText(200),
  quote: shortText(80).refine((value) => canonicalCitationText(value).length >= 8, "引用原文需要至少 8 个有效字符"),
}).strict();

const sourceUsageKeySchema = z.enum(["topic", "project_memory", "selected_knowledge", "project_knowledge", "video_atom", "inspiration", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"]);
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
  }).strict()).max(11),
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
  // Added by the server from the deterministic methodology router. The model
  // does not author this field, so old packs and compatibility retries remain
  // valid while every new pack can retain the exact methods that guided it.
  methodologyApplication: z.object({
    planId: shortText(200),
    planVersion: shortText(80),
    mode: shortText(80),
    selectedMethodIds: z.array(shortText(200)).min(1).max(20),
  }).strict().optional(),
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

function boundedGeneratedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return value;
  return value.trim().slice(0, maximum).trim();
}

/**
 * Repair only model-authored display fields whose length can be reduced without
 * changing the production package's facts or structure. Citation excerpts stay
 * subject to the later exact-source check, so shortening can never turn an
 * invented citation into an accepted one.
 */
export function normalizeGeneratedProductionPackTextBounds(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...input };

  if (Array.isArray(input.citations)) {
    normalized.citations = input.citations.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>), quote: boundedGeneratedText((item as Record<string, unknown>).quote, 80) }
      : item);
  }
  if (Array.isArray(input.hashtags)) {
    normalized.hashtags = input.hashtags.map((item) => boundedGeneratedText(item, 80));
  }
  if (Array.isArray(input.adaptations)) {
    normalized.adaptations = input.adaptations.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>), platform: boundedGeneratedText((item as Record<string, unknown>).platform, 80) }
      : item);
  }
  return normalized;
}

export function productionPackValidationIssue(error: z.ZodError, value?: unknown) {
  const issue = error.issues[0];
  if (!issue) return "结构无效";
  const path = issue.path.length ? issue.path.map(String).join(".") : "根结构";
  let current = value;
  for (const segment of issue.path) {
    if (!current || typeof current !== "object") { current = undefined; break; }
    current = (current as Record<string | number, unknown>)[segment as string | number];
  }
  const actualLength = typeof current === "string" || Array.isArray(current) ? `（实际长度 ${current.length}）` : "";
  return `${path}：${issue.message}${actualLength}`;
}

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
    { key: "project_memory", sourceType: "memory", label: "已确认项目记忆", required: false, include: (source) => source.sourceType === "memory" },
    { key: "selected_knowledge", sourceType: "knowledge", label: "选题指定品牌知识", required: selectedKnowledge.size > 0, include: (source) => source.sourceType === "knowledge" && selectedKnowledge.has(source.sourceId) },
    { key: "project_knowledge", sourceType: "knowledge", label: "项目品牌知识", required: selectedKnowledge.size === 0, include: (source) => source.sourceType === "knowledge" && !selectedKnowledge.has(source.sourceId) },
    { key: "video_atom", sourceType: "video_atom", label: "视频知识原子", required: false, include: (source) => source.sourceType === "video_atom" },
    { key: "inspiration", sourceType: "inspiration", label: "已确认灵感候选", required: false, include: (source) => source.sourceType === "inspiration" },
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
  const checks = groups.filter((group) => group.required).map((group) => {
    const passed = group.key === "benchmark" ? group.citedCount === group.availableCount : group.citedCount > 0;
    return {
      key: group.key,
      label: `${group.label}采用证据`,
      passed,
      detail: passed
        ? `已通过 ${group.citedCount} 条来源的逐字引用建立追溯。`
        : group.key === "benchmark"
          ? `已选择 ${group.availableCount} 条对标样本，但只有 ${group.citedCount} 条形成可追溯引用。`
          : `已向模型提供 ${group.availableCount} 条，但没有形成可追溯引用。`,
    };
  });
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
  // Accepted only for backwards compatibility with older clients. The API
  // deliberately ignores it and always runs new generation at max capability.
  modelProfile: z.string().trim().max(40).optional(),
  benchmarkEntryIds: z.array(shortText(100)).max(5).default([]),
  recommendedBenchmarkIds: z.array(shortText(100)).max(5).default([]),
}).strict();

export type ContentPromptSource = {
  sourceType: z.infer<typeof productionCitationSchema>["sourceType"];
  sourceId: string;
  title: string;
  text: string;
};

/**
 * Keep facts, methods and examples in separate prompt layers. This is a
 * deterministic boundary, not a request for the model to decide which source
 * is factual after it has already read everything as one undifferentiated
 * block.
 */
export function partitionContentPromptSources<T extends ContentPromptSource>(sources: readonly T[]) {
  const projectFactTypes = new Set<T["sourceType"]>(["memory", "knowledge", "video_atom", "video_analysis", "strategy"]);
  const exampleTypes = new Set<T["sourceType"]>(["benchmark", "historical_copy", "inspiration"]);
  return {
    taskSources: sources.filter((source) => source.sourceType === "topic"),
    projectFacts: sources.filter((source) => projectFactTypes.has(source.sourceType)),
    methodology: sources.filter((source) => source.sourceType === "method_knowledge"),
    referenceExamples: sources.filter((source) => exampleTypes.has(source.sourceType)),
  };
}

export const CONTENT_PROMPT_VERSION = "content-draft.v12-output-bounds";
export const CONTENT_PROMPT_NAME = "分层事实、确定性方法计划与可恢复生产包";
export const CONTENT_JSON_EXAMPLE = `JSON 顶层结构示例（实际输出必须填写完整内容并保留全部字段）：
{"hooks":["开头一","开头二"],"fullScript":"完整口播稿","shortScript":"短版口播稿","storyboard":[{"shot":"镜头一","visual":"画面","script":"台词","performance":"表演提示","durationSec":5}],"performanceNotes":[],"brollSuggestions":[],"subtitleHighlights":[],"coverCopy":["封面文案"],"publishTitles":["发布标题"],"hashtags":[],"commentPrompt":"评论引导","adaptations":[],"citations":[{"sourceType":"topic","sourceId":"输入中的真实来源 ID","quote":"从该来源逐字引用的原文"}],"riskNotes":[],"qualityReview":{"coreMechanism":"唯一核心机制","hookDiagnosis":{"topic":"话题","hook":"抓手","credibility":"可信度","suspense":"悬念","verdict":"strong"},"resonance":{"silentRelease":"沉默解除","motivation":"满足动机","stance":"有效立场","firstSharer":"首批传播者","beliefShift":"信念与行动"},"flowRisks":[],"benchmarkMethods":[],"publishReadiness":"ready","blockers":[]}}`;
export const CONTENT_SYSTEM_PROMPT = `你是新媒体服务公司的资深内容策划。系统会把选题、已启用策略、已确认品牌知识、已确认项目记忆及其他当前企业空间资料，按“本次任务、项目事实、方法计划、参考案例”分层提供。你要依据项目事实写内容，依据方法计划决定写法，只把参考案例当作结构启发，生成可直接进入审核的原创短视频生产包。

输入分层与边界：
- taskBrief：本次要完成的选题和交付任务，不是事实来源，不能用选题中的假设支撑客户事实；
- projectFacts：当前企业空间中可用于支撑事实表达的资料；
- methodologyPlan：系统在调用模型前确定的方法步骤，只指导选题组织、钩子、结构、节奏、表达与检查，绝不能充当客户事实、案例、数据、资质或结果证明；
- referenceExamples：对标样本、历史文案和灵感，只能学习抽象结构与表达策略，绝不能把其人物、数字、案例、结论或成绩写成客户事实；
- sourceIndex：仅用于核对来源 ID、标题和类型，不扩大任何来源的授权范围。

执行要求：
1. 事实性表达只能来自 projectFacts，不补造客户案例、数据、资质、成绩、身份或承诺；方法论、对标样本、历史文案和灵感均不能支撑事实；video_analysis 和 video_atom 只能证明对应视频中存在的内容，不能自动升级为当前客户事实或普遍因果；
2. 完整口播稿要围绕 qualityReview.coreMechanism 这一单一核心机制展开，开头承诺必须由正文兑现；
3. 对标样本只用于学习方法，不能近义改写、拼接、搬运或洗稿来源原文；
4. 每个事实性表达必须在 citations 中引用 projectFacts 提供的来源 ID 和逐字原文；quote 只复制来源 text 中 8–80 字的连续短原文，不要改写、概括、补全或添加引号。必须至少引用 methodologyPlan.planId 对应的 method_knowledge 来源，证明采用了本次确定的方法计划；每条输入 benchmark 都必须在 citations 中逐条引用，证明已逐条处理所选参考素材。method_knowledge 引用只证明写法，benchmark、historical_copy 和 inspiration 引用只证明参考了什么结构，它们都不能证明客户事实；
5. qualityReview.benchmarkMethods 必须与输入中的 benchmark 逐条对应且不得遗漏：实际采用时说明采用的方法与落地方式；不采用其正向方法时，也必须把它作为反例并说明规避方式。sourceId 必须对应各自的 benchmark 来源；
6. 风险、不确定信息和需要客户确认的内容写入 riskNotes；事实不足或内容价值不足时在 qualityReview 中如实标记 revise 或 blocked；
7. 输入含 historical_copy 时，必须至少引用一条实际采用的历史文案；只学习其字数区间、段落节奏、开场结构、行动引导和变现方式，不得拼接、洗稿或连续复用历史正文超过 12 个字（citations.quote 中用于追溯的原文不受此限制）；
8. 输入含 historicalStyleProfile 时，优先遵循 suggestedMinCharacters–suggestedMaxCharacters、suggestedMinParagraphs–suggestedMaxParagraphs、bestHookType、bestCtaType、toneTags 和 bestMonetizationType；confidence 为 low 时仅作弱参考，不能为迎合画像而虚构事实或强行加入转化动作；
9. 系统会在生成后客观检测完整口播稿的字数、段落、开场、行动引导、语气、变现方式和与历史原文的连续重复片段；检测不通过时会把具体差异返回给你重写；
10. 当前内容策略必须形成至少一条 strategy 引用；选题指定了品牌知识时，必须引用至少一条指定 knowledge；未指定时至少引用一条项目 knowledge；选题来自视频分析时，必须引用对应 video_analysis；
11. 输入中的 benchmarkFeedback 是系统根据历史审核、人工修订和发布指标汇总的反馈信号。优先采用主题匹配且历史通过率、真实表现更好的方法；退回和人工修订较多的样本只用于规避问题。不得把相关性信号说成因果结论，也不得在成稿中披露内部评分；
12. 严格执行 methodologyPlan 中选定的方法，不自行把未选方法升级为强制规则；如果方法与项目事实冲突，以项目事实和合规边界为准；
13. citations.quote 必须是 8–80 字连续原文；hashtags 中每一项和 adaptations.platform 均不得超过 80 字，平台名只写简短名称；
14. 不要输出 methodologyApplication、historicalStyleApplication 或 sourceUsageReport，这些字段由系统检测后写入；仅输出 JSON，不要输出 Markdown、解释或代码围栏。

${CONTENT_JSON_EXAMPLE}`;

export const CONTENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hooks", "fullScript", "shortScript", "storyboard", "performanceNotes", "brollSuggestions", "subtitleHighlights", "coverCopy", "publishTitles", "hashtags", "commentPrompt", "adaptations", "citations", "riskNotes", "qualityReview"],
  properties: {
    hooks: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 200 } },
    fullScript: { type: "string", minLength: 20, maxLength: 12_000 }, shortScript: { type: "string", minLength: 10, maxLength: 6_000 },
    storyboard: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false, required: ["shot", "visual", "script", "performance", "durationSec"], properties: { shot: { type: "string", minLength: 1, maxLength: 120 }, visual: { type: "string", minLength: 1, maxLength: 500 }, script: { type: "string", minLength: 1, maxLength: 2_000 }, performance: { type: "string", minLength: 1, maxLength: 500 }, durationSec: { type: "integer", minimum: 1, maximum: 300 } } } },
    performanceNotes: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, brollSuggestions: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } }, subtitleHighlights: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
    coverCopy: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 120 } }, publishTitles: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 160 } }, hashtags: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } }, commentPrompt: { type: "string", minLength: 1, maxLength: 500 },
    adaptations: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["platform", "copy"], properties: { platform: { type: "string", minLength: 1, maxLength: 80 }, copy: { type: "string", minLength: 1, maxLength: 4_000 } } } },
    citations: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false, required: ["sourceType", "sourceId", "quote"], properties: { sourceType: { enum: ["topic", "memory", "knowledge", "video_atom", "inspiration", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"] }, sourceId: { type: "string", minLength: 1, maxLength: 200 }, quote: { type: "string", minLength: 8, maxLength: 80 } } } },
    riskNotes: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
    qualityReview: {
      type: "object", additionalProperties: false,
      required: ["coreMechanism", "hookDiagnosis", "resonance", "flowRisks", "benchmarkMethods", "publishReadiness", "blockers"],
      properties: {
        coreMechanism: { type: "string", minLength: 1, maxLength: 500 },
        hookDiagnosis: { type: "object", additionalProperties: false, required: ["topic", "hook", "credibility", "suspense", "verdict"], properties: { topic: { type: "string", minLength: 1, maxLength: 300 }, hook: { type: "string", minLength: 1, maxLength: 300 }, credibility: { type: "string", minLength: 1, maxLength: 300 }, suspense: { type: "string", minLength: 1, maxLength: 300 }, verdict: { enum: ["strong", "revise", "blocked"] } } },
        resonance: { type: "object", additionalProperties: false, required: ["silentRelease", "motivation", "stance", "firstSharer", "beliefShift"], properties: { silentRelease: { type: "string", minLength: 1, maxLength: 500 }, motivation: { type: "string", minLength: 1, maxLength: 500 }, stance: { type: "string", minLength: 1, maxLength: 500 }, firstSharer: { type: "string", minLength: 1, maxLength: 500 }, beliefShift: { type: "string", minLength: 1, maxLength: 500 } } },
        flowRisks: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["level", "location", "issue", "fix"], properties: { level: { enum: ["high", "medium", "low"] }, location: { type: "string", minLength: 1, maxLength: 160 }, issue: { type: "string", minLength: 1, maxLength: 500 }, fix: { type: "string", minLength: 1, maxLength: 500 } } } },
        benchmarkMethods: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["sourceId", "method", "application"], properties: { sourceId: { type: "string", minLength: 1, maxLength: 200 }, method: { type: "string", minLength: 1, maxLength: 500 }, application: { type: "string", minLength: 1, maxLength: 500 } } } },
        publishReadiness: { enum: ["ready", "revise", "blocked"] },
        blockers: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
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

export const ANALYSIS_REPORT_SOURCE_TEXT_LIMIT = 12_000;

type AnalysisRecord = Record<string, unknown>;
type AnalysisEvidenceRow = { text: string; source: string; timecode: string; confidence: string };

const analysisFieldLabels: Record<string, string> = {
  summary: "核心结论", hook: "开头抓手", structure: "内容结构", audience: "目标受众",
  hook_analysis: "钩子方法", viral_points: "爆点", rhythm_analysis: "节奏", emotion_curve: "情绪",
  conversion_design: "转化设计", cta_analysis: "CTA 分析", visual: "视觉分析", language: "语言分析", highlights: "亮点",
  risks: "风险", recommendations: "复用建议",
};

const nestedFieldLabels: Record<string, string> = {
  label: "标签", title: "标题", name: "名称", stage: "阶段", role: "作用", description: "说明",
  detail: "详情", content: "内容", text: "原文", value: "值", type: "类型", method: "方法",
  application: "应用", scene: "场景", action: "动作", camera_expression: "镜头表达",
  visual_role: "画面作用", ocr_text: "画面文字", confidence: "置信度", detected: "是否识别到 CTA",
  summary: "结论", items: "CTA 明细", placement: "出现位置", quote: "原话", target_action: "目标动作",
  conversion_path: "承接路径", strength: "强度", effectiveness: "有效性", issues: "问题",
  recommendation: "优化建议", recommendations: "优化建议", overall_assessment: "整体判断",
};

function analysisRecord(value: unknown): AnalysisRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AnalysisRecord : null;
}

function cleanAnalysisText(value: unknown, maximum = 1_500) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value).replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maximum);
}

function compactAnalysisValue(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  const primitive = cleanAnalysisText(value);
  if (primitive) return [primitive];
  if (Array.isArray(value)) return value.slice(0, 20).flatMap((item) => compactAnalysisValue(item, depth + 1));
  const record = analysisRecord(value);
  if (!record) return [];
  const parts: string[] = [];
  for (const [key, nested] of Object.entries(record).slice(0, 16)) {
    if (["provenance", "source_segment_ids", "analysis_meta"].includes(key)) continue;
    const values = compactAnalysisValue(nested, depth + 1);
    if (!values.length) continue;
    const label = nestedFieldLabels[key] ?? key.replaceAll("_", " ");
    parts.push(`${label}：${values.join("；")}`);
  }
  return parts.length ? [parts.join("；")] : [];
}

function analysisTimestamp(record: AnalysisRecord, prefix: "start" | "end" | "timestamp") {
  const millisecondKeys = prefix === "timestamp"
    ? ["timestamp_ms", "timestampMs", "time_ms", "timeMs"]
    : [`${prefix}_ms`, `${prefix}Ms`];
  for (const key of millisecondKeys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  }
  const secondKeys = prefix === "timestamp"
    ? ["timestamp_sec", "timestampSec", "time_sec", "timeSec"]
    : [`${prefix}_sec`, `${prefix}Sec`];
  for (const key of secondKeys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1_000));
  }
  return null;
}

function formatAnalysisTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function analysisTimecode(record: AnalysisRecord) {
  const literalValue = record.timestamp ?? record.timecode ?? record.time_code;
  const literal = typeof literalValue === "string" ? cleanAnalysisText(literalValue, 40) : "";
  if (literal) return literal;
  const start = analysisTimestamp(record, "start") ?? analysisTimestamp(record, "timestamp");
  const end = analysisTimestamp(record, "end");
  if (start === null) return "";
  const startText = formatAnalysisTimestamp(start);
  return end !== null && end > start ? `${startText}–${formatAnalysisTimestamp(end)}` : startText;
}

function analysisEvidenceSource(value: unknown, fallback: string) {
  const source = cleanAnalysisText(value, 80).toLocaleLowerCase("zh-CN");
  if (/asr|speech|transcript|audio/.test(source)) return "ASR";
  if (/ocr/.test(source)) return "OCR";
  if (/vision|visual|frame|keyframe/.test(source)) return "关键帧/视觉";
  if (fallback === "asr") return "ASR";
  if (fallback === "ocr") return "OCR";
  if (fallback === "keyframe") return "关键帧/视觉";
  return source ? source.toUpperCase() : "证据";
}

function analysisEvidenceRows(value: unknown, fallbackSource: string): AnalysisEvidenceRow[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") {
      const text = cleanAnalysisText(item, 1_000);
      return text ? [{ text, source: analysisEvidenceSource("", fallbackSource), timecode: "", confidence: "" }] : [];
    }
    const record = analysisRecord(item);
    if (!record) return [];
    const text = cleanAnalysisText(
      record.text ?? record.evidence_text ?? record.ocr_text ?? record.transcript ?? record.caption
      ?? record.description ?? record.observation ?? record.content,
      1_000,
    );
    if (!text) return [];
    const confidenceValue = record.confidence;
    const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
      ? `${confidenceValue <= 1 ? Math.round(confidenceValue * 100) : Math.round(confidenceValue)}%`
      : "";
    return [{ text, source: analysisEvidenceSource(record.source ?? record.kind, fallbackSource), timecode: analysisTimecode(record), confidence }];
  });
}

function collectAnalysisEvidence(report: AnalysisRecord) {
  const groups: Array<[unknown, string]> = [
    [report.evidence, "evidence"], [report.asr_segments, "asr"], [report.transcript_segments, "asr"],
    [report.ocr, "ocr"], [report.ocr_segments, "ocr"], [report.keyframes, "keyframe"],
    [report.key_frames, "keyframe"], [report.visual_keyframes, "keyframe"],
  ];
  const transcript = analysisRecord(report.transcript);
  if (transcript) groups.push([transcript.segments, "asr"]);
  const seen = new Set<string>();
  return groups.flatMap(([value, fallback]) => analysisEvidenceRows(value, fallback)).filter((row) => {
    const normalized = canonicalCitationText(row.text);
    const key = `${row.source}|${row.timecode}|${normalized}`;
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 36);
}

function spokenScriptSection(report: AnalysisRecord) {
  const scriptSet = analysisRecord(report.spoken_script_set);
  const corrected = analysisRecord(scriptSet?.corrected_original);
  if (corrected) {
    const status = cleanAnalysisText(corrected.status, 40) || "unknown";
    const validation = analysisRecord(corrected.validation);
    const coverage = validation?.source_segment_coverage_percent;
    const text = cleanAnalysisText(corrected.text, 3_600)
      || (Array.isArray(corrected.paragraphs) ? corrected.paragraphs.map((item) => cleanAnalysisText(item, 1_000)).filter(Boolean).join("\n\n").slice(0, 3_600) : "");
    const detail = [`状态：${status}`];
    if (typeof validation?.passed === "boolean") detail.push(`验收：${validation.passed ? "通过" : "未通过"}`);
    if (typeof coverage === "number") detail.push(`来源片段覆盖：${Math.round(coverage)}%`);
    if (status === "completed" && text) detail.push(text);
    else {
      const error = cleanAnalysisText(corrected.error, 300);
      if (error) detail.push(`未采用原因：${error}`);
    }
    return detail.join("\n");
  }
  return compactAnalysisValue(report.spoken_script).join("\n").slice(0, 3_600);
}

function analysisCoverageLines(report: AnalysisRecord) {
  const meta = analysisRecord(report.analysis_meta);
  if (!meta) return [];
  const lines: string[] = [];
  const add = (label: string, value: unknown, suffix = "") => {
    const text = cleanAnalysisText(value, 80);
    if (text) lines.push(`${label}：${text}${suffix}`);
  };
  add("分析模式", meta.processing_mode ?? meta.mode);
  add("视频时长", meta.duration_minutes, " 分钟");
  if (typeof meta.analyzed_segments === "number" || typeof meta.source_segments === "number") {
    lines.push(`ASR 片段覆盖：${String(meta.analyzed_segments ?? "—")}/${String(meta.source_segments ?? "—")}`);
  }
  add("转写覆盖率", meta.transcript_coverage_percent ?? meta.coverage_percent, "%");
  add("综合证据覆盖率", meta.evidence_coverage_percent, "%");
  const visual = analysisRecord(meta.visual_extraction);
  if (visual) {
    const kept = visual.kept_count ?? visual.keyframe_count;
    const target = visual.target_count;
    if (typeof kept === "number") lines.push(`关键帧：${kept}${typeof target === "number" ? `/${target}` : ""}`);
    add("场景候选", visual.scene_count);
    add("视觉观察", analysisRecord(visual.visual_understanding)?.observation_count);
  }
  return lines;
}

function analysisInsightEvidenceLines(report: AnalysisRecord, evidence: AnalysisEvidenceRow[]) {
  const links = Array.isArray(report.insight_evidence) ? report.insight_evidence : [];
  const evidenceByText = new Map(evidence.map((row) => [canonicalCitationText(row.text), row]));
  const seen = new Set<string>();
  return links.slice(0, 40).flatMap((item) => {
    const link = analysisRecord(item);
    if (!link) return [];
    const section = cleanAnalysisText(link.section, 80);
    const itemIndex = typeof link.item_index === "number" ? link.item_index + 1 : "—";
    const evidenceText = cleanAnalysisText(link.evidence_text, 500);
    if (!section || !evidenceText) return [];
    const row = evidenceByText.get(canonicalCitationText(evidenceText));
    const locator = row ? [row.timecode && `[${row.timecode}]`, row.source].filter(Boolean).join(" ") : `“${evidenceText}”`;
    const line = `${analysisFieldLabels[section] ?? section}[${itemIndex}] ← ${locator}`;
    if (seen.has(line)) return [];
    seen.add(line);
    return [line];
  });
}

function appendAnalysisSection(sections: string[], label: string, lines: string[], maximum: number) {
  const seen = new Set<string>();
  const body = lines.map((line) => cleanAnalysisText(line, 2_000)).filter((line) => {
    const key = canonicalCitationText(line);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n").slice(0, maximum).trim();
  if (body) sections.push(`【${label}】\n${body}`);
}

export function analysisReportSourceText(reportJson: string) {
  try {
    const parsed = JSON.parse(reportJson) as unknown;
    const report = analysisRecord(parsed);
    if (!report) return cleanAnalysisText(reportJson, ANALYSIS_REPORT_SOURCE_TEXT_LIMIT);
    const sections: string[] = [];
    const sectionBudgets: Record<string, number> = {
      summary: 600, hook: 250, structure: 600, audience: 250, hook_analysis: 300,
      viral_points: 300, rhythm_analysis: 300, emotion_curve: 250, conversion_design: 300, cta_analysis: 700,
      visual: 400, language: 400, highlights: 300, risks: 300, recommendations: 300,
    };
    for (const [key, label] of Object.entries(analysisFieldLabels)) {
      const lines = compactAnalysisValue(report[key]);
      appendAnalysisSection(sections, label, lines, sectionBudgets[key] ?? 300);
    }
    const script = spokenScriptSection(report);
    if (script) appendAnalysisSection(sections, "经校正原版口播", [script], 3_200);
    const evidence = collectAnalysisEvidence(report);
    appendAnalysisSection(sections, "分析覆盖摘要", analysisCoverageLines(report), 400);
    appendAnalysisSection(sections, "带时间码的 ASR／OCR／关键帧证据", evidence.map((row) => {
      const prefix = [row.timecode && `[${row.timecode}]`, row.source, row.confidence && `置信度 ${row.confidence}`].filter(Boolean).join(" · ");
      return `${prefix ? `${prefix}：` : ""}${row.text}`;
    }), 2_200);
    appendAnalysisSection(sections, "结论与证据绑定", analysisInsightEvidenceLines(report, evidence), 700);

    if (!sections.length) {
      for (const [key, value] of Object.entries(report).slice(0, 20)) {
        if (["analysis_meta", "spoken_script_set"].includes(key)) continue;
        appendAnalysisSection(sections, analysisFieldLabels[key] ?? key.replaceAll("_", " "), compactAnalysisValue(value), 1_000);
      }
    }
    return sections.join("\n\n").slice(0, ANALYSIS_REPORT_SOURCE_TEXT_LIMIT).trim();
  } catch {
    return cleanAnalysisText(reportJson, ANALYSIS_REPORT_SOURCE_TEXT_LIMIT);
  }
}
