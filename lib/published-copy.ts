import { z } from "zod";

export const publishedCopyPlatforms = ["douyin", "xiaohongshu", "wechat_official", "wechat_channels", "bilibili", "other"] as const;
export const publishedCopyFormats = ["spoken_script", "article", "caption", "newsletter", "other"] as const;
export const monetizationTypes = ["none", "private_message", "consultation", "course", "community", "product", "lead_magnet", "brand_awareness", "other"] as const;

export type MonetizationType = (typeof monetizationTypes)[number];
export type PublishedCopyPerformance = Partial<Record<"views" | "likes" | "saves" | "leads" | "conversions", number>>;

const identifier = z.string().trim().min(1).max(100);
const optionalMetric = z.coerce.number().int().min(0).max(1_000_000_000).optional();

export const createPublishedCopySchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  title: z.string().trim().min(2).max(160),
  body: z.string().trim().min(20).max(50_000),
  platform: z.enum(publishedCopyPlatforms),
  contentFormat: z.enum(publishedCopyFormats).default("spoken_script"),
  publishedAt: z.union([z.iso.datetime({ offset: true }), z.literal("")]).optional(),
  externalUrl: z.union([z.url().max(2_000), z.literal("")]).optional(),
  monetizationTypes: z.array(z.enum(monetizationTypes)).max(5).default([]),
  monetizationDetail: z.string().trim().max(1_000).optional(),
  performance: z.object({
    views: optionalMetric,
    likes: optionalMetric,
    saves: optionalMetric,
    leads: optionalMetric,
    conversions: optionalMetric,
  }).strict().optional(),
}).strict();

export const publishedCopyImportRowSchema = createPublishedCopySchema.omit({ organizationId: true, projectId: true });
export const importPublishedCopiesSchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  records: z.array(z.unknown()).min(1).max(200),
}).strict();

export const updatePublishedCopyPerformanceSchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  monetizationTypes: z.array(z.enum(monetizationTypes)).max(5).optional(),
  monetizationDetail: z.string().trim().max(1_000).optional(),
  performance: z.object({
    views: optionalMetric,
    likes: optionalMetric,
    saves: optionalMetric,
    leads: optionalMetric,
    conversions: optionalMetric,
  }).strict(),
}).strict();

export type PublishedCopyAnalysis = {
  characterCount: number;
  paragraphCount: number;
  averageParagraphLength: number;
  hookType: "question" | "numbered" | "contrast" | "story" | "pain_point" | "direct";
  ctaType: "private_message" | "comment" | "follow" | "consultation" | "purchase" | "join" | "download" | "save_share" | "none";
  toneTags: string[];
  monetizationTypes: MonetizationType[];
};

export type PublishedCopyRecord = {
  id: string;
  title: string;
  body: string;
  platform: string;
  content_format: string;
  source_type: string;
  published_at: string | null;
  external_url: string | null;
  character_count: number;
  paragraph_count: number;
  monetization_types_json: string;
  monetization_detail: string | null;
  analysis_json: string;
  performance_json: string;
  created_at: string;
  updated_at: string;
};

function unique<T>(items: T[]) { return [...new Set(items)]; }
function includesAny(text: string, terms: string[]) { return terms.some((term) => text.includes(term)); }

export function readPublishedCopyPerformance(value: string): PublishedCopyPerformance {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([key, metric]) => ["views", "likes", "saves", "leads", "conversions"].includes(key) && typeof metric === "number" && Number.isFinite(metric) && metric >= 0));
  } catch { return {}; }
}

export function publishedCopyPerformanceScore(performance: PublishedCopyPerformance) {
  const views = Number(performance.views || 0); const likes = Number(performance.likes || 0); const saves = Number(performance.saves || 0);
  const leads = Number(performance.leads || 0); const conversions = Number(performance.conversions || 0);
  const hasData = [views, likes, saves, leads, conversions].some((value) => value > 0);
  if (!hasData) return { score: 0, hasData: false };
  const volume = Math.log1p(views) * .12 + Math.log1p(likes) * .35 + Math.log1p(saves) * .8 + Math.log1p(leads) * 2.2 + Math.log1p(conversions) * 4;
  const rate = views > 0 ? Math.min(8, (saves / views) * 180 + (leads / views) * 700 + (conversions / views) * 1_500) : 0;
  return { score: Math.round(Math.min(50, volume + rate) * 100) / 100, hasData: true };
}

export function countCopyCharacters(body: string) {
  return Array.from(body.normalize("NFKC").replace(/\s+/g, "")).length;
}

export function analyzePublishedCopy(body: string, requested: readonly MonetizationType[] = []): PublishedCopyAnalysis {
  const normalized = body.normalize("NFKC").trim();
  const paragraphs = normalized.split(/\n\s*\n|\n+/).map((item) => item.trim()).filter(Boolean);
  const characterCount = countCopyCharacters(normalized);
  const opening = normalized.slice(0, 140);
  const ending = normalized.slice(-220);
  const hookType: PublishedCopyAnalysis["hookType"] = /[?？]|为什么|有没有|你是否/.test(opening) ? "question"
    : /(?:^|\s)[0-9一二三四五六七八九十]+[个步点条]|第[一二三四五六七八九十0-9]+/.test(opening) ? "numbered"
      : /不是.+而是|VS|vs|区别|相反/.test(opening) ? "contrast"
        : /我曾经|我以前|有一次|去年|当时|故事/.test(opening) ? "story"
          : /痛点|难题|困扰|踩坑|失败|焦虑|卡在/.test(opening) ? "pain_point" : "direct";
  const ctaType: PublishedCopyAnalysis["ctaType"] = includesAny(ending, ["私信", "后台回复"]) ? "private_message"
    : includesAny(ending, ["咨询", "诊断", "预约"]) ? "consultation"
      : includesAny(ending, ["购买", "下单", "立即抢", "报名课程"]) ? "purchase"
        : includesAny(ending, ["进群", "加入社群", "加群"]) ? "join"
          : includesAny(ending, ["下载", "领取", "获取资料", "获取清单"]) ? "download"
            : includesAny(ending, ["评论区", "留言", "评论告诉我"]) ? "comment"
              : includesAny(ending, ["关注", "点个关注"]) ? "follow"
                : includesAny(ending, ["收藏", "转发", "分享给"]) ? "save_share" : "none";
  const inferred: MonetizationType[] = [];
  if (includesAny(normalized, ["私信", "后台回复"])) inferred.push("private_message");
  if (includesAny(normalized, ["咨询", "诊断", "预约", "方案沟通"])) inferred.push("consultation");
  if (includesAny(normalized, ["课程", "训练营", "报名学习"])) inferred.push("course");
  if (includesAny(normalized, ["社群", "进群", "加群", "会员群"])) inferred.push("community");
  if (includesAny(normalized, ["购买", "下单", "产品链接", "橱窗", "套餐"])) inferred.push("product");
  if (includesAny(normalized, ["领取", "下载", "资料包", "白皮书", "清单"])) inferred.push("lead_magnet");
  if (includesAny(normalized, ["品牌认知", "品牌曝光", "记住我们", "品牌故事"])) inferred.push("brand_awareness");
  const monetization = unique([...(requested.length ? requested : inferred)]);
  if (!monetization.length) monetization.push("none");
  const toneTags = unique([
    includesAny(normalized, ["第一", "第二", "步骤", "方法", "框架"]) ? "方法型" : "",
    includesAny(normalized, ["我们", "企业", "业务", "经营", "客户"]) ? "专业经营" : "",
    includesAny(normalized, ["你", "咱们", "其实", "说白了"]) ? "口语直接" : "",
    includesAny(normalized, ["数据", "%", "增长", "转化率"]) ? "数据驱动" : "",
    includesAny(normalized, ["故事", "当时", "后来", "终于"]) ? "叙事型" : "",
  ].filter(Boolean));
  if (!toneTags.length) toneTags.push("清晰说明");
  return {
    characterCount,
    paragraphCount: Math.max(1, paragraphs.length),
    averageParagraphLength: Math.round(characterCount / Math.max(1, paragraphs.length)),
    hookType,
    ctaType,
    toneTags,
    monetizationTypes: monetization,
  };
}

function safeAnalysis(record: PublishedCopyRecord): PublishedCopyAnalysis {
  try { return JSON.parse(record.analysis_json) as PublishedCopyAnalysis; }
  catch { return analyzePublishedCopy(record.body, safeMonetizationTypes(record.monetization_types_json)); }
}

export function safeMonetizationTypes(value: string): MonetizationType[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is MonetizationType => typeof item === "string" && monetizationTypes.includes(item as MonetizationType)) : [];
  } catch { return []; }
}

export function publishedCopyPromptSource(record: PublishedCopyRecord) {
  const analysis = safeAnalysis(record);
  const performance = publishedCopyPerformanceScore(readPublishedCopyPerformance(record.performance_json));
  return [
    `历史发布标题：${record.title}`,
    `平台：${record.platform}`,
    `字数：${record.character_count}`,
    `段落：${record.paragraph_count}`,
    `开场结构：${analysis.hookType}`,
    `行动引导：${analysis.ctaType}`,
    `表达标签：${analysis.toneTags.join("、")}`,
    `变现形式：${analysis.monetizationTypes.join("、")}`,
    performance.hasData ? `效果指数：${performance.score}（仅用于同项目历史文案相对比较）` : "",
    record.monetization_detail ? `变现说明：${record.monetization_detail}` : "",
    `历史原文：\n${record.body.slice(0, 4_000)}`,
  ].filter(Boolean).join("\n");
}

function terms(value: string) {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const words = normalized.match(/[\p{Script=Han}]{2,8}|[a-z0-9]{2,20}/gu) ?? [];
  const chunks: string[] = [];
  for (const word of words) {
    chunks.push(word);
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 3) for (let index = 0; index < word.length - 1; index += 1) chunks.push(word.slice(index, index + 2));
  }
  return unique(chunks).slice(0, 120);
}

export function selectRelevantPublishedCopies(records: PublishedCopyRecord[], query: string, limit = 5) {
  const queryTerms = terms(query);
  return records.map((record, index) => {
    const title = record.title.toLocaleLowerCase("zh-CN");
    const body = record.body.toLocaleLowerCase("zh-CN");
    const matched = queryTerms.filter((term) => title.includes(term) || body.includes(term));
    const titleMatches = matched.filter((term) => title.includes(term)).length;
    const outcome = Math.min(6, publishedCopyPerformanceScore(readPublishedCopyPerformance(record.performance_json)).score * .35);
    return { record, score: matched.length + titleMatches * 2 + outcome + Math.max(0, 1 - index / 200), matchedTerms: matched.slice(0, 8) };
  }).sort((left, right) => right.score - left.score).slice(0, Math.max(0, limit));
}

export function buildPublishedCopyProfile(records: PublishedCopyRecord[]) {
  if (!records.length) return { count: 0, averageCharacters: 0, minCharacters: 0, maxCharacters: 0, suggestedMinCharacters: 0, suggestedMaxCharacters: 0, suggestedMinParagraphs: 0, suggestedMaxParagraphs: 0, suggestedAverageParagraphLength: 0, performanceSampleSize: 0, confidence: "low" as const, bestHookType: null, bestCtaType: null, bestMonetizationType: null, topPerformers: [] as Array<{ id: string; title: string; score: number; views: number; saves: number; leads: number; conversions: number }>, commonPlatforms: [] as Array<{ value: string; count: number; score: number }>, monetizationTypes: [] as Array<{ value: string; count: number; score: number }>, hookTypes: [] as Array<{ value: string; count: number; score: number }>, toneTags: [] as Array<{ value: string; count: number; score: number }> };
  const counts = records.map((record) => record.character_count).sort((a, b) => a - b);
  const analyses = records.map(safeAnalysis);
  const weighted = records.map((record, index) => {
    const performance = publishedCopyPerformanceScore(readPublishedCopyPerformance(record.performance_json));
    return { record, analysis: analyses[index], performance, weight: performance.hasData ? 1 + performance.score : 1 };
  });
  const frequency = (items: Array<{ value: string; weight: number }>) => Object.values(items.reduce<Record<string, { value: string; count: number; score: number }>>((accumulator, item) => {
    const current = accumulator[item.value] || { value: item.value, count: 0, score: 0 };
    current.count += 1; current.score += item.weight; accumulator[item.value] = current; return accumulator;
  }, {})).map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 })).sort((left, right) => right.score - left.score || right.count - left.count);
  const performanceRecords = weighted.filter((item) => item.performance.hasData).sort((left, right) => right.performance.score - left.performance.score);
  const preferredRecords = performanceRecords.length >= 3 ? performanceRecords.slice(0, Math.max(3, Math.ceil(performanceRecords.length * .5))) : weighted;
  const preferredCounts = preferredRecords.map((item) => item.record.character_count).sort((left, right) => left - right);
  const percentile = (values: number[], ratio: number) => values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * ratio)))] || 0;
  const suggestedMinCharacters = percentile(preferredCounts, .2);
  const suggestedMaxCharacters = percentile(preferredCounts, .8);
  const preferredParagraphs = preferredRecords.map((item) => item.analysis.paragraphCount).sort((left, right) => left - right);
  const preferredParagraphLengths = preferredRecords.map((item) => item.analysis.averageParagraphLength).sort((left, right) => left - right);
  const hookTypes = frequency(weighted.map((item) => ({ value: item.analysis.hookType, weight: item.weight }))).slice(0, 4);
  const ctaTypes = frequency(weighted.map((item) => ({ value: item.analysis.ctaType, weight: item.weight })).filter((item) => item.value !== "none"));
  const monetization = frequency(weighted.flatMap((item) => item.analysis.monetizationTypes.filter((value) => value !== "none").map((value) => ({ value, weight: item.weight }))));
  const toneTags = frequency(weighted.flatMap((item) => item.analysis.toneTags.map((value) => ({ value, weight: item.weight }))));
  return {
    count: records.length,
    averageCharacters: Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length),
    minCharacters: counts[0],
    maxCharacters: counts[counts.length - 1],
    suggestedMinCharacters,
    suggestedMaxCharacters: Math.max(suggestedMinCharacters, suggestedMaxCharacters),
    suggestedMinParagraphs: percentile(preferredParagraphs, .2),
    suggestedMaxParagraphs: Math.max(percentile(preferredParagraphs, .2), percentile(preferredParagraphs, .8)),
    suggestedAverageParagraphLength: percentile(preferredParagraphLengths, .5),
    performanceSampleSize: performanceRecords.length,
    confidence: performanceRecords.length >= 8 ? "high" as const : performanceRecords.length >= 3 ? "medium" as const : "low" as const,
    bestHookType: hookTypes[0] || null,
    bestCtaType: ctaTypes[0] || null,
    bestMonetizationType: monetization[0] || null,
    topPerformers: performanceRecords.slice(0, 5).map((item) => {
      const performance = readPublishedCopyPerformance(item.record.performance_json);
      return { id: item.record.id, title: item.record.title, score: item.performance.score, views: Number(performance.views || 0), saves: Number(performance.saves || 0), leads: Number(performance.leads || 0), conversions: Number(performance.conversions || 0) };
    }),
    commonPlatforms: frequency(weighted.map((item) => ({ value: item.record.platform, weight: item.weight }))).slice(0, 4),
    monetizationTypes: monetization.slice(0, 5),
    hookTypes,
    toneTags: toneTags.slice(0, 6),
  };
}

export type PublishedCopyProfile = ReturnType<typeof buildPublishedCopyProfile>;
export type HistoricalStyleCheck = { key: "characters" | "paragraphs" | "hook" | "cta" | "tone" | "monetization"; label: string; matched: boolean; expected: string; actual: string };
export type HistoricalStyleApplication = {
  status: "passed" | "review" | "rewrite";
  confidence: "low" | "medium" | "high";
  sourceIds: string[];
  matchedChecks: number;
  totalChecks: number;
  checks: HistoricalStyleCheck[];
  actual: PublishedCopyAnalysis;
  originality: { passed: boolean; longestSharedCharacters: number; sourceId: string | null; phrase: string | null };
};

function canonicalStyleText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s"'“”‘’「」『』《》〈〉【】〔〕(){}，。！!？?:：;；、…—–·•]/gu, "");
}

function longestSharedPhrase(script: string, records: PublishedCopyRecord[], threshold = 18) {
  const generated = canonicalStyleText(script); const windows = new Map<string, { sourceId: string; index: number; source: string }>();
  for (const record of records) {
    const source = canonicalStyleText(record.body);
    for (let index = 0; index <= source.length - threshold; index += 1) {
      const window = source.slice(index, index + threshold); if (!windows.has(window)) windows.set(window, { sourceId: record.id, index, source });
    }
  }
  let longest = 0; let sourceId: string | null = null; let phrase: string | null = null;
  for (let index = 0; index <= generated.length - threshold; index += 1) {
    const match = windows.get(generated.slice(index, index + threshold)); if (!match) continue;
    let length = threshold;
    while (index + length < generated.length && match.index + length < match.source.length && generated[index + length] === match.source[match.index + length]) length += 1;
    if (length > longest) { longest = length; sourceId = match.sourceId; phrase = generated.slice(index, index + Math.min(length, 48)); }
  }
  return { passed: longest < threshold, longestSharedCharacters: longest, sourceId, phrase };
}

export function validateHistoricalStyleApplication(script: string, profile: PublishedCopyProfile, sourceRecords: PublishedCopyRecord[], sourceIds: string[]): HistoricalStyleApplication {
  const actual = analyzePublishedCopy(script); const checks: HistoricalStyleCheck[] = [];
  if (profile.suggestedMinCharacters > 0) {
    const tolerance = Math.max(30, Math.round((profile.suggestedMaxCharacters - profile.suggestedMinCharacters) * .2));
    checks.push({ key: "characters", label: "字数区间", matched: actual.characterCount >= profile.suggestedMinCharacters - tolerance && actual.characterCount <= profile.suggestedMaxCharacters + tolerance, expected: `${profile.suggestedMinCharacters}–${profile.suggestedMaxCharacters} 字`, actual: `${actual.characterCount} 字` });
  }
  if (profile.suggestedMinParagraphs > 0) checks.push({ key: "paragraphs", label: "段落节奏", matched: actual.paragraphCount >= Math.max(1, profile.suggestedMinParagraphs - 1) && actual.paragraphCount <= profile.suggestedMaxParagraphs + 1, expected: `${profile.suggestedMinParagraphs}–${profile.suggestedMaxParagraphs} 段，平均约 ${profile.suggestedAverageParagraphLength} 字`, actual: `${actual.paragraphCount} 段，平均 ${actual.averageParagraphLength} 字` });
  if (profile.bestHookType) checks.push({ key: "hook", label: "开场结构", matched: actual.hookType === profile.bestHookType.value, expected: profile.bestHookType.value, actual: actual.hookType });
  if (profile.bestCtaType) checks.push({ key: "cta", label: "行动引导", matched: actual.ctaType === profile.bestCtaType.value, expected: profile.bestCtaType.value, actual: actual.ctaType });
  const expectedTones = profile.toneTags.slice(0, 3).map((item) => item.value);
  if (expectedTones.length) checks.push({ key: "tone", label: "表达语气", matched: actual.toneTags.some((item) => expectedTones.includes(item)), expected: expectedTones.join("、"), actual: actual.toneTags.join("、") });
  if (profile.bestMonetizationType) checks.push({ key: "monetization", label: "变现方式", matched: actual.monetizationTypes.includes(profile.bestMonetizationType.value as MonetizationType), expected: profile.bestMonetizationType.value, actual: actual.monetizationTypes.join("、") });
  const matchedChecks = checks.filter((item) => item.matched).length; const originality = longestSharedPhrase(script, sourceRecords);
  const requiredMatches = profile.confidence === "high" ? Math.ceil(checks.length * .67) : profile.confidence === "medium" ? Math.ceil(checks.length * .5) : 0;
  const status: HistoricalStyleApplication["status"] = !originality.passed || matchedChecks < requiredMatches ? "rewrite" : profile.confidence === "low" ? "review" : "passed";
  return { status, confidence: profile.confidence, sourceIds: unique(sourceIds).slice(0, 5), matchedChecks, totalChecks: checks.length, checks, actual, originality };
}
