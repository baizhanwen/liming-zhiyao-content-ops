export type MaterialPerformance = {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  followersGained?: number | null;
  leads?: number | null;
  completionRateBps?: number | null;
};

export type MaterialFeedback = {
  usageCount: number;
  approvedCount: number;
  changesRequestedCount: number;
  manualRevisionCount: number;
  commentCount: number;
  publishedCount: number;
  performance: MaterialPerformance;
};

export type MaterialRecommendationContext = {
  topic: string;
  audience: string;
  structure: string;
  conversion: string;
};

export type MaterialRecommendationCandidate = {
  id: string;
  title: string;
  authorName?: string | null;
  category?: string | null;
  tags?: string[];
  notes?: string | null;
  analysisText: string;
  directPerformance?: MaterialPerformance;
  feedback?: MaterialFeedback;
};

export type MaterialRecommendation = MaterialRecommendationCandidate & {
  score: number;
  scores: {
    topic: number;
    audience: number;
    structure: number;
    conversion: number;
    performance: number;
    feedback: number;
  };
  reasons: string[];
  matchedTerms: string[];
  hasOutcomeData: boolean;
  recommended: boolean;
};

const STOP_TERMS = new Set([
  "一个", "一些", "这个", "那个", "这些", "那些", "我们", "你们", "他们", "可以", "如何", "什么", "为什么", "内容", "视频", "进行", "通过", "以及", "相关", "方法", "用户", "客户", "目标", "需要", "问题", "分析", "生成", "企业",
]);

const STRUCTURE_TERMS = ["开场", "钩子", "反差", "冲突", "故事", "清单", "步骤", "节奏", "悬念", "案例", "金句", "转折", "结论", "口播"];
const CONVERSION_TERMS = ["转化", "咨询", "私信", "评论", "关注", "收藏", "分享", "成交", "留资", "引流", "购买", "行动", "信任", "品牌"];

function value(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

export function materialSearchTerms(input: string, maximum = 80) {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const latin = normalized.match(/[a-z0-9][a-z0-9+._-]{1,24}/g) ?? [];
  const chineseChunks = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const chinese = chineseChunks.flatMap((chunk) => {
    const terms: string[] = [];
    for (const length of [2, 3, 4]) {
      for (let index = 0; index <= chunk.length - length; index += 1) terms.push(chunk.slice(index, index + length));
    }
    return terms;
  });
  return uniq([...latin, ...chinese]).filter((term) => !STOP_TERMS.has(term)).slice(0, maximum);
}

function overlap(context: string, source: string, maximum: number, multiplier: number) {
  const sourceTerms = new Set(materialSearchTerms(source, 500));
  const matched = materialSearchTerms(context).filter((term) => sourceTerms.has(term));
  return { score: Math.min(maximum, matched.length * multiplier), matched };
}

function keywordScore(source: string, context: string, keywords: string[], maximum: number) {
  const normalized = `${source}\n${context}`.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const matched = keywords.filter((term) => normalized.includes(term));
  return { score: Math.min(maximum, matched.length * 2), matched };
}

function performanceScore(performance: MaterialPerformance | undefined, maximum: number) {
  if (!performance) return 0;
  const attention = Math.log10(value(performance.views) + 1) / 6;
  const engagement = Math.log10(value(performance.likes) + value(performance.comments) + value(performance.shares) + value(performance.saves) + 1) / 5;
  const business = Math.log10(value(performance.followersGained) + value(performance.leads) * 4 + 1) / 4;
  const completion = value(performance.completionRateBps) / 10_000;
  return Math.min(maximum, Math.round((attention * 0.35 + engagement * 0.3 + business * 0.25 + completion * 0.1) * maximum));
}

function mergePerformance(first?: MaterialPerformance, second?: MaterialPerformance): MaterialPerformance {
  const keys: (keyof MaterialPerformance)[] = ["views", "likes", "comments", "shares", "saves", "followersGained", "leads"];
  const merged: MaterialPerformance = {};
  for (const key of keys) merged[key] = value(first?.[key]) + value(second?.[key]);
  merged.completionRateBps = Math.max(value(first?.completionRateBps), value(second?.completionRateBps));
  return merged;
}

function hasPerformance(performance?: MaterialPerformance) {
  return Boolean(performance && Object.values(performance).some((entry) => value(entry) > 0));
}

function feedbackScore(feedback?: MaterialFeedback) {
  if (!feedback?.usageCount) return 0;
  const decisions = feedback.approvedCount + feedback.changesRequestedCount;
  const approvalRate = decisions ? feedback.approvedCount / decisions : 0.5;
  const revisionRate = feedback.manualRevisionCount / Math.max(1, feedback.usageCount);
  const discussionRate = feedback.commentCount / Math.max(1, feedback.usageCount);
  return Math.max(-5, Math.min(8, Math.round(approvalRate * 8 - revisionRate * 1.5 - discussionRate * 0.35)));
}

export function scoreMaterialCandidate(candidate: MaterialRecommendationCandidate, context: MaterialRecommendationContext): MaterialRecommendation {
  const source = [candidate.title, candidate.authorName, candidate.category, candidate.tags?.join(" "), candidate.notes, candidate.analysisText].filter(Boolean).join("\n");
  const topic = overlap(context.topic, source, 42, 3);
  const audience = overlap(context.audience, source, 16, 3);
  const structureOverlap = overlap(context.structure, source, 10, 2);
  const structureKeywords = keywordScore(candidate.analysisText, context.structure, STRUCTURE_TERMS, 10);
  const conversionOverlap = overlap(context.conversion, source, 10, 2);
  const conversionKeywords = keywordScore(candidate.analysisText, context.conversion, CONVERSION_TERMS, 10);
  const structure = Math.min(14, Math.max(structureOverlap.score, structureKeywords.score));
  const conversion = Math.min(12, Math.max(conversionOverlap.score, conversionKeywords.score));
  const combinedPerformance = mergePerformance(candidate.directPerformance, candidate.feedback?.performance);
  const performance = performanceScore(combinedPerformance, 10);
  const feedback = feedbackScore(candidate.feedback);
  const score = Math.max(0, Math.min(100, Math.round(topic.score + audience.score + structure + conversion + performance + feedback)));
  const hasOutcomeData = hasPerformance(combinedPerformance) || Boolean(candidate.feedback?.approvedCount || candidate.feedback?.changesRequestedCount || candidate.feedback?.publishedCount);
  const reasons: string[] = [];
  const matchedTerms = uniq([...topic.matched, ...audience.matched, ...structureOverlap.matched, ...conversionOverlap.matched]).slice(0, 8);
  if (topic.score) reasons.push(`主题匹配：${topic.matched.slice(0, 3).join("、") || "内容语义接近"}`);
  if (audience.score) reasons.push(`受众匹配：${audience.matched.slice(0, 2).join("、") || "目标人群接近"}`);
  if (structure) reasons.push(`结构可借鉴：${structureKeywords.matched.slice(0, 3).join("、") || "表达结构接近"}`);
  if (conversion) reasons.push(`转化设计匹配：${conversionKeywords.matched.slice(0, 3).join("、") || "行动目标接近"}`);
  if (hasPerformance(combinedPerformance)) reasons.push("包含真实发布或平台表现数据");
  if (candidate.feedback?.approvedCount) reasons.push(`历史引用后通过审核 ${candidate.feedback.approvedCount} 次`);
  if (candidate.feedback?.changesRequestedCount) reasons.push(`历史引用后退回修改 ${candidate.feedback.changesRequestedCount} 次`);
  return { ...candidate, score, scores: { topic: topic.score, audience: audience.score, structure, conversion, performance, feedback }, reasons: reasons.slice(0, 5), matchedTerms, hasOutcomeData, recommended: false };
}

export function recommendMaterials(candidates: MaterialRecommendationCandidate[], context: MaterialRecommendationContext, maximum = 5) {
  const ranked = candidates.map((candidate) => scoreMaterialCandidate(candidate, context)).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.hasOutcomeData !== left.hasOutcomeData) return Number(right.hasOutcomeData) - Number(left.hasOutcomeData);
    return left.title.localeCompare(right.title, "zh-CN");
  });
  const available = Math.min(maximum, ranked.length);
  const minimum = Math.min(3, available);
  let count = minimum;
  while (count < available && ranked[count].score >= Math.max(28, ranked[0].score - 12)) count += 1;
  const recommendedIds = ranked.slice(0, count).map((entry) => entry.id);
  const selected = new Set(recommendedIds);
  return { entries: ranked.map((entry) => ({ ...entry, recommended: selected.has(entry.id) })), recommendedIds };
}

export function materialFeedbackPrompt(feedback?: MaterialFeedback) {
  if (!feedback || (!feedback.usageCount && !feedback.publishedCount && !hasPerformance(feedback.performance))) return "本项目暂无该素材的历史使用反馈。";
  const metrics = feedback.performance;
  return [
    `本项目历史引用 ${feedback.usageCount} 次`,
    `审核通过 ${feedback.approvedCount} 次`,
    `退回修改 ${feedback.changesRequestedCount} 次`,
    `人工修订版本 ${feedback.manualRevisionCount} 个`,
    `审核评论 ${feedback.commentCount} 条`,
    `已发布 ${feedback.publishedCount} 次`,
    hasPerformance(metrics) ? `发布反馈：播放/阅读 ${value(metrics.views)}，赞 ${value(metrics.likes)}，评 ${value(metrics.comments)}，转 ${value(metrics.shares)}，藏 ${value(metrics.saves)}，线索 ${value(metrics.leads)}` : "暂无发布指标",
    "以上仅是历史相关性信号，不代表该素材对结果存在单一因果关系。",
  ].join("；");
}
