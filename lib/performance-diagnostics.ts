export type DiagnosticStatus = "ready" | "watch" | "insufficient";
export type RuleStatus = "triggered" | "not_triggered" | "insufficient";

export type PerformanceDiagnosticSnapshot = {
  summary: {
    contentCount: number;
    views: number;
    interactions: number;
    followersGained: number;
    leads: number;
    engagementRate: number;
    leadRate?: number;
    averageCompletionRate?: number | null;
    averageWatchSeconds?: number | null;
    baselineCoverage?: { total: number; complete: number; partial: number; newPublications: number };
  };
  topContent: Array<{ title: string; views: number; interactions: number; followersGained: number; leads: number }>;
  peerGroups?: Array<{ key: string; label: string; sampleSize: number; medianViews: number | null; medianCompletionRate: number | null; medianEngagementRate: number | null; periodStart: string; periodEnd: string }>;
  evidence?: Array<{ kind: "video_segment" | "script_structure" | "material"; contentItemId: string; sourceType: string; sourceId: string; label: string; quote: string | null; locator: string | null }>;
};

export type DiagnosticLayer = {
  key: "data_quality" | "distribution" | "retention" | "engagement_conversion" | "attribution";
  label: string;
  status: DiagnosticStatus;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  missing: string[];
};

export type DiagnosticRule = {
  code: string;
  label: string;
  layer: DiagnosticLayer["key"];
  status: RuleStatus;
  confidence: "low" | "medium" | "high";
  minimumSample: number;
  evidence: string[];
  uncertainty: string;
};

export type PerformanceDiagnostics = {
  version: "performance-diagnostics.v1";
  layers: DiagnosticLayer[];
  rules: DiagnosticRule[];
  peerGroups: NonNullable<PerformanceDiagnosticSnapshot["peerGroups"]>;
  evidence: NonNullable<PerformanceDiagnosticSnapshot["evidence"]>;
  attributionNotice: string;
};

function confidence(sampleSize: number): "low" | "medium" | "high" {
  return sampleSize >= 8 ? "high" : sampleSize >= 3 ? "medium" : "low";
}

function sampleEvidence(sampleSize: number) {
  return "当前样本 " + sampleSize + " 条；规则只在达到各自最小样本后触发。";
}

function rule(input: Omit<DiagnosticRule, "confidence"> & { confidence?: DiagnosticRule["confidence"] }): DiagnosticRule {
  return { ...input, confidence: input.confidence ?? "low" };
}

export function buildPerformanceDiagnostics(snapshot: PerformanceDiagnosticSnapshot): PerformanceDiagnostics {
  const summary = snapshot.summary;
  const contentCount = Number(summary.contentCount || 0);
  const baselinePartial = Number(summary.baselineCoverage?.partial || 0);
  const sampleConfidence = confidence(contentCount);
  const engagementRate = typeof summary.engagementRate === "number" && Number.isFinite(summary.engagementRate) ? summary.engagementRate : 0;
  const leadRate = typeof summary.leadRate === "number" && Number.isFinite(summary.leadRate) ? summary.leadRate : 0;
  const averageCompletionRate = typeof summary.averageCompletionRate === "number" && Number.isFinite(summary.averageCompletionRate) ? summary.averageCompletionRate : null;
  const averageWatchSeconds = typeof summary.averageWatchSeconds === "number" && Number.isFinite(summary.averageWatchSeconds) ? summary.averageWatchSeconds : null;
  const hasViews = summary.views > 0;
  const hasRetention = averageCompletionRate !== null || averageWatchSeconds !== null;
  const rules: DiagnosticRule[] = [
    rule({ code: "DATA_SAMPLE_SMALL", label: "样本量不足，暂不宜下强结论", layer: "data_quality", status: contentCount < 3 ? "triggered" : "not_triggered", minimumSample: 3, evidence: [sampleEvidence(contentCount)], uncertainty: "至少积累 3 条同周期或同类作品后再比较；当前结论仅作方向提示。" }),
    rule({ code: "BASELINE_PARTIAL", label: "部分作品缺少期初基线", layer: "data_quality", status: baselinePartial > 0 ? "triggered" : "not_triggered", minimumSample: 1, evidence: [String(baselinePartial) + " 条作品使用首条可见快照作为基线。"], uncertainty: "这些作品的新增量不代表完整生命周期增量。" }),
    rule({ code: "REACH_WITHOUT_ENGAGEMENT", label: "有分发但互动偏弱", layer: "distribution", status: contentCount >= 3 && hasViews && engagementRate < 0.03 ? "triggered" : contentCount < 3 || !hasViews ? "insufficient" : "not_triggered", minimumSample: 3, evidence: ["周期新增播放 " + summary.views + "，互动率 " + (engagementRate * 100).toFixed(2) + "%。"], uncertainty: "可能与受众匹配、开头承诺或分发样本有关，不能据此断言单一因果。" }),
    rule({ code: "RETENTION_GAP", label: "留存指标偏弱，需回看开头与结构", layer: "retention", status: contentCount >= 3 && averageCompletionRate !== null && averageCompletionRate < 35 ? "triggered" : !hasRetention || contentCount < 3 ? "insufficient" : "not_triggered", minimumSample: 3, evidence: ["平均完播率 " + (averageCompletionRate === null ? "未提供" : averageCompletionRate.toFixed(2) + "%") + "，平均播放时长 " + (averageWatchSeconds === null ? "未提供" : averageWatchSeconds.toFixed(1) + " 秒") + "。"], uncertainty: "需要结合具体视频段、时长和平台口径复核，不能把完播差直接归因于脚本质量。" }),
    rule({ code: "ENGAGEMENT_WITHOUT_CONVERSION", label: "有互动但尚无线索转化", layer: "engagement_conversion", status: contentCount >= 3 && summary.interactions > 0 && summary.leads === 0 ? "triggered" : contentCount < 3 || summary.interactions === 0 ? "insufficient" : "not_triggered", minimumSample: 3, evidence: ["新增互动 " + summary.interactions + "，新增线索 " + summary.leads + "，线索率 " + (leadRate * 100).toFixed(2) + "%。"], uncertainty: "线索可能漏录或存在归因延迟；先补齐转化口径，再决定是否调整 CTA。" }),
    rule({ code: "HIGH_ENGAGEMENT_LOW_REACH", label: "互动质量较好但分发规模偏小", layer: "distribution", status: contentCount >= 3 && hasViews && engagementRate >= 0.08 && summary.views < 1_000 ? "triggered" : contentCount < 3 || !hasViews ? "insufficient" : "not_triggered", minimumSample: 3, evidence: ["互动率 " + (engagementRate * 100).toFixed(2) + "%，周期新增播放 " + summary.views + "。"], uncertainty: "可能是发布频次、封面/标题或样本时点差异，不能直接推断平台分发原因。" }),
    rule({ code: "NEGATIVE_FOLLOWER_DELTA", label: "周期关注净变化为负", layer: "engagement_conversion", status: contentCount >= 3 && summary.followersGained < 0 ? "triggered" : contentCount < 3 ? "insufficient" : "not_triggered", minimumSample: 3, evidence: ["周期新增关注 " + summary.followersGained + "。"], uncertainty: "需要核对账号整体波动、作品发布时间和粉丝统计窗口。" }),
  ];
  const layers: DiagnosticLayer[] = [
    { key: "data_quality", label: "数据质量层", status: contentCount < 3 || baselinePartial > 0 ? "watch" : "ready", confidence: sampleConfidence, evidence: ["纳入 " + contentCount + " 条作品。", "完整基线 " + (summary.baselineCoverage?.complete || 0) + " 条，部分基线 " + baselinePartial + " 条。"], missing: contentCount < 3 ? ["至少 3 条可比作品"] : baselinePartial > 0 ? ["部分作品期初快照"] : [] },
    { key: "distribution", label: "分发层", status: !hasViews || contentCount < 3 ? "insufficient" : "ready", confidence: sampleConfidence, evidence: ["周期新增播放 " + summary.views + "。", "可比组 " + (snapshot.peerGroups?.length || 0) + " 组。"], missing: !hasViews ? ["播放量快照"] : [] },
    { key: "retention", label: "留存层", status: !hasRetention || contentCount < 3 ? "insufficient" : averageCompletionRate !== null && averageCompletionRate < 35 ? "watch" : "ready", confidence: hasRetention ? sampleConfidence : "low", evidence: ["平均完播率 " + (averageCompletionRate === null ? "未提供" : averageCompletionRate.toFixed(2) + "%")], missing: hasRetention ? [] : ["完播率或平均播放时长"] },
    { key: "engagement_conversion", label: "互动/转化层", status: contentCount < 3 ? "insufficient" : summary.leads === 0 ? "watch" : "ready", confidence: sampleConfidence, evidence: ["互动 " + summary.interactions + "，线索 " + summary.leads + "，新增关注 " + summary.followersGained + "。"], missing: summary.leads === 0 ? ["稳定的线索归因"] : [] },
    { key: "attribution", label: "内容归因层", status: contentCount < 3 || !snapshot.topContent.length ? "insufficient" : "watch", confidence: contentCount >= 8 ? "medium" : "low", evidence: snapshot.topContent.slice(0, 3).map((item) => "《" + item.title + "》新增播放 " + item.views + "，互动 " + item.interactions + "。"), missing: contentCount < 3 ? ["同类对照样本"] : [] },
  ];
  return {
    version: "performance-diagnostics.v1",
    layers,
    rules,
    peerGroups: snapshot.peerGroups || [],
    evidence: snapshot.evidence || [],
    attributionNotice: "诊断展示相关性线索，不等同因果结论；任何回流记忆都必须经管理员确认。",
  };
}