import { contentTaxonomy, getDimensionLabel, getTagLabel, type ContentAnalysis, type ContentClassification, type ContentEvidence } from "./video-content-analysis";
import { isActiveAnalysisDimension } from "./content-report-contract";

export const contentStateLabels = { known: "已判断", unknown: "无法判断", not_acquired: "未获取材料", not_applicable: "不适用" } as const;
export const contentModuleLabels: Record<string, string> = {
  text_topic_structure_audience: "选题、结构与人群",
  text_expression_value: "开头、情绪、价值与语言",
  visual: "首帧、画面与镜头",
  synthesis: "图文配合与综合判断",
};
export const contentSegmentLabels: Record<string, string> = {
  topic_subject: "具体选题", topic_problem: "具体问题", audience_use_case: "人群使用场景", content_template: "内容模板",
  hook_first_sentence: "第一句话", hook_first_3s: "开头转写片段", structure: "段落结构", cta: "行动引导", emotion: "情绪变化", repetition: "重复表达",
};
export const contentSourceLabels: Record<ContentEvidence["source"], string> = {
  transcript: "转写原文", ocr: "画面文字", vision: "画面观察", frame: "关键帧", temporal: "有序画面组",
};
const reasonLabels: Record<string, string> = {
  classification_not_returned: "模型未返回这个分类。",
  absence_not_verifiable_from_representative_sample: "当前取样不足以确认全片未出现。",
  required_evidence_omitted_by_input_budget: "输入预算内未保留这项判断需要的材料。",
  cta_events_not_identified: "尚未识别出可核对的行动引导片段。",
  structure_roles_not_segmented: "尚未识别出对应的结构段落。",
  information_units_not_identified: "尚未识别出对应的信息单元。",
  specific_topic_problem_not_identified: "尚未提取到具体问题。",
  specific_topic_subject_not_identified: "尚未提取到具体选题。",
  representative_evidence_sample: "使用代表性材料取样，不能确认未取样处的内容。",
  required_opening_evidence_incomplete: "开头的必要取证不完整。",
  required_evidence_not_acquired: "尚未取得本模块需要的材料。",
  no_evidence_within_input_budget: "预算内没有可用于本模块的材料。",
  input_budget_exceeded: "本模块输入超过预算，未继续调用模型。",
  classification_request_failed: "本模块的模型调用未完成。",
  no_audio_or_usable_sampled_text: "源视频没有音轨，成功检查的取样画面也未发现可用文字；文字分析不适用。",
  no_video_track: "来源只有音频轨，画面与镜头分析不适用。",
};
export function contentReasonLabel(reason: string) {
  return reasonLabels[reason] || (reason.endsWith("_evidence_not_acquired") ? "尚未取得这项判断需要的材料。" : reason);
}
export function contentModuleCoverageText(value: ContentAnalysis["module_status"][keyof ContentAnalysis["module_status"]]) {
  const status = { completed: "已完成", failed: "未完成", not_acquired: "未取得材料", not_applicable: "不适用" }[value.status];
  const coverage = value.source_coverage;
  return [status, coverage ? `纳入 ${coverage.included_evidence_count} / ${coverage.available_evidence_count} 条证据；${coverage.complete ? "本模块材料全部纳入" : "代表性取样"}；开头${coverage.required_opening_complete === null ? "检查不适用" : coverage.required_opening_complete ? "取证完整" : "取证不完整"}；有序画面组 ${coverage.temporal_groups_included.length} / ${coverage.temporal_groups_available.length}` : null, value.reason ? contentReasonLabel(value.reason) : null].filter(Boolean).join(" · ");
}
export function contentTimeLabel(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "时间未确定";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}${milliseconds % 1000 ? `.${Math.floor(milliseconds % 1000).toString().padStart(3, "0")}` : ""}`;
}
export function classificationText(row: ContentClassification) {
  if (row.state !== "known") return contentStateLabels[row.state];
  if (!row.tags?.length) return "确认未出现";
  return row.tags.map(tag => `${getTagLabel(row.dimension_id, tag)}${tag === row.primary_tag ? "（主类型）" : ""}`).join("、");
}
const numberText = (value: number | null, suffix = "") => value === null || !Number.isFinite(value) ? "未取得" : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${suffix}`;
export const durationBucketLabels: Record<string, string> = { under_15s: "不足15秒", "15_to_under_30s": "15–不足30秒", "30_to_under_60s": "30–不足60秒", "60_to_under_180s": "60–不足180秒", "180s_and_above": "180秒及以上" };
export function contentMetricRows(content: Pick<ContentAnalysis, "metrics">) {
  const { media, shot_detection: shots, transcript_statistics: transcript } = content.metrics;
  return [
    ["原始时长", numberText(media.status === "measured" ? media.duration_seconds : null, "秒")],
    ["时长分组", media.duration_bucket ? durationBucketLabels[media.duration_bucket] || media.duration_bucket : "未取得"],
    ["显示画幅", media.aspect_category === "other" ? `其他（${media.display_aspect_ratio || "未知比例"}）` : media.aspect_category || (media.aspect_status === "not_applicable" ? "不适用" : "无法判断")],
    ["转写有效字符", numberText(transcript.character_count, "字")],
    ["转写字符／全片秒", numberText(transcript.characters_per_video_second)],
    ["检测切换次数", numberText(shots.detected_cut_count, "次")],
    ["平均检测镜头时长", numberText(shots.mean_shot_seconds, "秒")],
    ["每分钟检测切换", numberText(shots.cuts_per_minute, "次")],
  ];
}
export function contentAnalysisMarkdown(content: ContentAnalysis) {
  const lines = ["## 标准化内容分析", "", `- 标签版本：${content.taxonomy_version}`, `- 测量口径：${content.metrics.version}`, `- 抽样策略：${content.methodology.sampling_strategy_id}`, `- 分类状态：${content.status === "complete" ? "已完成" : "部分待核对"}`, "", "### 可复核指标", "", ...contentMetricRows(content).map(([label, value]) => `- ${label}：${value}`), "", "转写速度是基于文字与时间戳的估算；检测切换可能漏检或误检，均不等同于声学或人工逐帧测量。"];
  for (const [moduleKey, moduleStatus] of Object.entries(content.module_status)) {
    lines.push("", `### ${contentModuleLabels[moduleKey] || moduleKey}`, "");
    lines.push(contentModuleCoverageText(moduleStatus), "");
    for (const dimension of contentTaxonomy.dimensions.filter(row => isActiveAnalysisDimension(row.id) && row.module === moduleKey)) {
      const classification = content.classifications.find(row => row.dimension_id === dimension.id);
      if (!classification) continue;
      lines.push(`- ${getDimensionLabel(dimension.id)}：${classificationText(classification)}${dimension.inferred ? "〔模型推断〕" : ""}${classification.reason ? `；${contentReasonLabel(classification.reason)}` : ""}${classification.evidence_ids.length ? `〔证据：${classification.evidence_ids.join("、")}〕` : ""}`);
    }
  }
  if (content.segments.length) {
    lines.push("", "### 内容片段", "");
    for (const row of content.segments) lines.push(`- [${contentTimeLabel(row.start_ms)}–${contentTimeLabel(row.end_ms)}] ${contentSegmentLabels[row.kind] || row.kind}：${row.text}〔${row.evidence_ids.join("、")}〕`);
  }
  if (content.information_units.length) {
    lines.push("", "### 信息单元", "", "以下由模型识别、程序去重计数，需结合证据核对。", "");
    for (const row of content.information_units) lines.push(`- ${row.id}：${getTagLabel("value.information_type", row.type_tag)}；${row.text}${row.duplicate_of ? `（与 ${row.duplicate_of} 重复）` : ""}〔${row.evidence_ids.join("、")}〕`);
  }
  lines.push("", "### 分类证据索引", "");
  for (const row of content.evidence_registry) lines.push(`- ${row.id} · ${contentSourceLabels[row.source]} · ${contentTimeLabel(row.start_ms)}–${contentTimeLabel(row.end_ms)}：${row.text}${row.asset_ref ? `〔画面ID：${row.asset_ref}〕` : ""}`);
  return lines.join("\n");
}
