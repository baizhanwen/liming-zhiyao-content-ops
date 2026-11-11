"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { scopedFetch } from "../lib/client-scope";
import { readApiError } from "../lib/client-format";
import { contentTaxonomy, getDimensionLabel, type ContentComparisonEntry, type ContentComparisonResponse } from "../lib/video-content-analysis";
import { classificationText, durationBucketLabels } from "../lib/content-analysis-presentation";

const exclusionLabels: Record<string, string> = {
  missing: "尚无分析报告", legacy: "旧报告未按新版标注", quality_failed: "新版报告未通过验收", invalid_contract: "分类材料需要核对",
  unsupported_schema: "报告版本暂不支持", unsupported_taxonomy: "标签版本不同", duplicate_video: "同一视频已计入", filtered_out: "不符合本次筛选条件",
};
const matrixDimensions = ["topic.category", "content.form", "hook.type", "structure.type", "emotion.expressed"];
type Filters = { topicCategory: string; contentForm: string; durationBucket: string };
const defaultFilters: Filters = { topicCategory: "", contentForm: "", durationBucket: "" };
const finiteText = (value: number | null | undefined, suffix = "") => typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${suffix}` : "—";

export function ContentComparisonPanel({ organizationId, projectId, scope, entryIds, onClear }: { organizationId: string; projectId: string; scope: "library" | "benchmark"; entryIds: string[]; onClear: () => void }) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [result, setResult] = useState<{ key: string; body: ContentComparisonResponse } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dimensionId, setDimensionId] = useState("hook.type");
  const [groupId, setGroupId] = useState("");
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const key = JSON.stringify({ organizationId, projectId, scope, entryIds, filters });
  const data = result?.key === key ? result.body : null;
  const group = data?.groupings.find(row => row.id === groupId) ?? data?.groupings[0];
  const distribution = group?.distributions.find(row => row.dimensionId === dimensionId);
  const primaryRequired = contentTaxonomy.dimensions.find(row => row.id === dimensionId)?.primary_required;
  const groupEntries = data?.entries.filter(row => group?.entryIds.includes(row.entryId)) ?? [];
  const busy = busyKey === key;

  async function compare() {
    if (entryIds.length < 2 || entryIds.length > 100) return;
    controller.current?.abort();
    const current = ++generation.current, requestKey = key;
    const abort = new AbortController(); controller.current = abort;
    setBusyKey(requestKey); setError(null);
    try {
      const response = await scopedFetch("/api/video-library/content-comparison", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ organizationId, projectId, scope, entryIds, filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as ContentComparisonResponse;
      if (current === generation.current) { setResult({ key: requestKey, body }); setGroupId(body.groupings[0]?.id || ""); }
    } catch (reason) {
      if (!abort.signal.aborted && current === generation.current) setError({ key: requestKey, message: reason instanceof Error ? reason.message : "内容对比暂时无法完成。" });
    } finally { if (current === generation.current) setBusyKey(null); }
  }
  function classification(entry: ContentComparisonEntry, id: string) {
    const row = entry.contentAnalysis?.classifications.find(item => item.dimension_id === id);
    return row ? classificationText(row) : "未取得";
  }
  function analysisLink(entry: ContentComparisonEntry) {
    const params = new URLSearchParams({ organizationId, projectId, libraryEntryId: entry.entryId });
    if (entry.analysisId) params.set("analysisId", entry.analysisId);
    return `/analysis/${encodeURIComponent(entry.videoId)}?${params}`;
  }
  function download(format: "markdown" | "json") {
    if (!data) return;
    const lines = ["# 视频内容对比", "", `- 生成时间：${data.snapshot.generatedAt}`, `- 标签版本：${data.snapshot.taxonomyVersion}`, `- 所选视频：${data.summary.selectedVideos}`, `- 本次纳入：${data.summary.includedVideos}`, `- 未纳入：${data.summary.excludedVideos}`, "", "每条视频只使用一个已验收的新版报告；比例分母为该字段可判断的视频数，多选出现率合计可能超过100%。"];
    for (const item of data.groupings) {
      lines.push("", `## 可比组 ${item.id}（${item.videoCount} 条）`, "", `- 抽样策略：${item.samplingStrategy}`, `- 测量口径：${item.metricsVersion}`, `- 已标注CTA事件：${item.metricsTotals.ctaOccurrences}`, `- 去重信息单元：${item.metricsTotals.uniqueInformationUnits}`);
      for (const row of item.distributions) {
        lines.push("", `### ${row.label}`, "", `可判断 ${row.knownCount}/${row.totalVideos}；无法判断 ${row.stateCounts.unknown}；未获取 ${row.stateCounts.not_acquired}；不适用 ${row.stateCounts.not_applicable}。`);
        for (const tag of row.tags.filter(value => value.count > 0)) lines.push(`- ${tag.label}：${tag.count} 条，出现率 ${finiteText(tag.percent, "%")}${contentTaxonomy.dimensions.find(value => value.id === row.dimensionId)?.primary_required ? `，主类型 ${tag.primaryCount} 条（${finiteText(tag.primaryPercent, "%")}）` : ""}`);
      }
    }
    lines.push("", "## 报告版本快照", "");
    for (const entry of data.entries) lines.push(`- ${entry.title}：${entry.status === "included" ? `纳入；分析ID ${entry.analysisId}；${entry.analysisCreatedAt}` : exclusionLabels[entry.excludedReason || ""] || "未纳入"}`);
    lines.push("", "## 筛选条件", "", JSON.stringify(data.snapshot.filters ?? {}));
    const text = format === "json" ? JSON.stringify(data, null, 2) : lines.join("\n");
    const href = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = `视频内容对比-${data.snapshot.generatedAt.slice(0, 10)}.${format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(href);
  }
  return <section className="content-comparison-panel">
    <header><div><span className="section-kicker">跨视频内容对比</span><h2>选择素材，比较内容特征</h2><p>勾选卡片中的“内容对比”。每次比较2–100条，按统一口径计算；读取已有报告，不触发模型分析。</p></div><div className="content-comparison-actions"><span>已选 {entryIds.length} 条</span><button type="button" onClick={onClear} disabled={!entryIds.length}>清空选择</button><button type="button" className="primary-button" disabled={busy || entryIds.length < 2 || entryIds.length > 100} onClick={() => void compare()}>{busy ? "正在核对并计算…" : "生成内容对比"}</button></div></header>
    <div className="content-comparison-filters">
      <label>选题类别<select value={filters.topicCategory} onChange={event => setFilters({ ...filters, topicCategory: event.target.value })}><option value="">全部类别</option>{contentTaxonomy.dimensions.find(row => row.id === "topic.category")?.tags.filter(row => !row.disabled).map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label>内容形式<select value={filters.contentForm} onChange={event => setFilters({ ...filters, contentForm: event.target.value })}><option value="">全部形式</option>{contentTaxonomy.dimensions.find(row => row.id === "content.form")?.tags.filter(row => !row.disabled).map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label>时长分组<select value={filters.durationBucket} onChange={event => setFilters({ ...filters, durationBucket: event.target.value })}><option value="">全部时长</option>{Object.entries(durationBucketLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {entryIds.length > 100 && <p role="alert">本次选择超过100条，请减少后比较。</p>}
    {error?.key === key && <p role="alert" className="inline-alert">{error.message}</p>}
    {result && !data && <p className="content-comparison-stale" role="status">所选素材或筛选条件已改变，请重新生成对比。</p>}
    {data && <>
      <div className="content-comparison-summary"><strong>纳入 {data.summary.includedVideos} / {data.summary.selectedVideos} 条视频</strong><span>未纳入 {data.summary.excludedVideos} 条</span><span>{data.groupings.length} 组可比口径</span><button type="button" onClick={() => download("markdown")}>导出对比报告</button><button type="button" onClick={() => download("json")}>导出版本快照</button></div>
      {data.entries.some(entry => entry.status === "excluded") && <details className="content-comparison-excluded"><summary>查看未纳入的素材与原因</summary><ul>{data.entries.filter(entry => entry.status === "excluded").map(entry => <li key={entry.entryId}><Link href={analysisLink(entry)}>{entry.title}</Link>：{exclusionLabels[entry.excludedReason || ""] || "未纳入"}</li>)}</ul></details>}
      {group && <>
        <div className="content-comparison-filters"><label>可比样本组<select value={group.id} onChange={event => setGroupId(event.target.value)}>{data.groupings.map((row, index) => <option key={row.id} value={row.id}>组{index + 1} · {row.videoCount}条 · {row.entryIds.length && data.entries.find(entry => entry.entryId === row.entryIds[0])?.contentAnalysis?.profile === "max" ? "最高能力" : "标准模式"}</option>)}</select></label><label>分析维度<select value={dimensionId} onChange={event => setDimensionId(event.target.value)}>{contentTaxonomy.dimensions.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label></div>
        {data.groupings.length > 1 && <p>不同抽样或测量口径分别统计，请逐组查看。</p>}
        {distribution && <section className="content-distribution"><h3>{distribution.label}</h3><p>本组 {distribution.totalVideos} 条，可判断 {distribution.knownCount} 条；无法判断 {distribution.stateCounts.unknown} 条，未获取 {distribution.stateCounts.not_acquired} 条，不适用 {distribution.stateCounts.not_applicable} 条。</p><p>{distribution.cardinality === "multiple" ? "出现率以可判断视频数为分母，每条视频可有多个标签。" : "主类型占比以可判断视频数为分母。"}</p>{distribution.knownCount > 0 ? <div className="content-table-scroll"><table><thead><tr><th>分类标签</th><th>视频数</th><th>出现率</th>{primaryRequired && <><th>主类型数</th><th>主类型占比</th></>}</tr></thead><tbody>{distribution.tags.filter(tag => tag.count > 0).map(tag => <tr key={tag.id}><th scope="row">{tag.label}</th><td>{tag.count}</td><td>{finiteText(tag.percent, "%")}</td>{primaryRequired && <><td>{tag.primaryCount}</td><td>{finiteText(tag.primaryPercent, "%")}</td></>}</tr>)}</tbody></table></div> : <p>这一维度尚无可判断样本，暂不计算比例。</p>}</section>}
        <div className="content-comparison-totals"><span>已标注CTA {group.metricsTotals.ctaOccurrences} 次，分布在 {group.metricsTotals.videosWithCtaOccurrences} 条视频中</span><span>模型识别信息单元 {group.metricsTotals.informationUnits} 项，去重后 {group.metricsTotals.uniqueInformationUnits} 项</span></div>
        <div className="content-table-scroll"><table className="content-comparison-matrix"><caption>逐视频特征矩阵 · 固定所用分析版本</caption><thead><tr><th>视频</th>{matrixDimensions.map(id => <th key={id}>{getDimensionLabel(id)}</th>)}<th>时长</th><th>转写字符／秒</th><th>检测切换／分钟</th></tr></thead><tbody>{groupEntries.map(entry => <tr key={entry.entryId}><th scope="row"><Link href={analysisLink(entry)}>{entry.title}</Link><small>{entry.analysisCreatedAt ? new Date(entry.analysisCreatedAt).toLocaleString("zh-CN") : ""}</small></th>{matrixDimensions.map(id => <td key={id}>{classification(entry, id)}</td>)}<td>{finiteText(entry.contentAnalysis?.metrics.media.duration_seconds, "秒")}</td><td>{finiteText(entry.contentAnalysis?.metrics.transcript_statistics.characters_per_video_second)}</td><td>{finiteText(entry.contentAnalysis?.metrics.shot_detection.cuts_per_minute)}</td></tr>)}</tbody></table></div>
      </>}
      {!data.summary.includedVideos && <p className="list-empty">所选素材中没有满足本次筛选的已验收新版报告。可先查看单条报告，在来源空间主动重新分析后再比较。</p>}
    </>}
  </section>;
}
