export type BenchmarkDirectPerformance = {
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  followersGained: number | null;
  collectedAt: string | null;
};

const promptMetric = (value: number | null) => value === null ? "未采集" : String(value);

/**
 * Keep source-video performance visible to the model without turning it into a
 * customer fact. Null is deliberately different from zero: zero is a real
 * observation, while "未采集" means the metric was absent from the snapshot.
 */
export function benchmarkDirectPerformancePrompt(performance: BenchmarkDirectPerformance) {
  return [
    "[原视频直接真实表现]",
    `采集时间：${performance.collectedAt || "未采集"}`,
    `播放：${promptMetric(performance.plays)}`,
    `点赞：${promptMetric(performance.likes)}`,
    `评论：${promptMetric(performance.comments)}`,
    `收藏：${promptMetric(performance.favorites)}`,
    `分享：${promptMetric(performance.shares)}`,
    `涨粉：${promptMetric(performance.followersGained)}`,
    "边界：这些指标只用于判断参考方法的适配优先级，不得写成当前企业空间的事实、成绩或因果结论。",
  ].join("\n");
}

export function inspectSelectedBenchmarkCoverage(input: {
  selectedIds: readonly string[];
  citations: readonly { sourceType: string; sourceId: string }[];
  methods: readonly { sourceId: string }[];
}) {
  const selectedIds = [...new Set(input.selectedIds)];
  const selected = new Set(selectedIds);
  const cited = new Set(input.citations.filter((citation) => citation.sourceType === "benchmark").map((citation) => citation.sourceId));
  const explained = new Set(input.methods.map((method) => method.sourceId));
  return {
    missingCitationIds: selectedIds.filter((id) => !cited.has(id)),
    missingMethodIds: selectedIds.filter((id) => !explained.has(id)),
    unexpectedMethodIds: [...explained].filter((id) => !selected.has(id)),
  };
}
