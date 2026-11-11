import { z } from "zod";
import taxonomyResource from "../services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json" with { type: "json" };

export const CONTENT_ANALYSIS_SCHEMA = "content-analysis.v1";
export const CONTENT_ANALYSIS_REPORT_SCHEMA = "analysis.v10";
export type ContentState = "known" | "unknown" | "not_acquired" | "not_applicable";
export type ContentDimension = { id: string; label: string; module: string; cardinality: "single" | "multiple"; primary_required: boolean; requires: "text" | "visual" | "temporal" | "any"; requires_text?: boolean; allow_empty: boolean; none_tag_id: string | null; tags: Array<{ id: string; label: string; disabled?: boolean; excluded_reason?: string; requires?: "text" | "visual" | "temporal" | "any" }>; inferred?: boolean; definition?: string };
export const contentTaxonomy = taxonomyResource as Omit<typeof taxonomyResource, "dimensions"> & { dimensions: ContentDimension[] };
const dimensions = new Map<string, ContentDimension>(contentTaxonomy.dimensions.map(dimension => [dimension.id, dimension]));
export const getDimensionLabel = (id: string) => dimensions.get(id)?.label ?? id;
export const getTagLabel = (dimensionId: string, tagId: string) => dimensions.get(dimensionId)?.tags.find(tag => tag.id === tagId)?.label ?? tagId;

const shortText = z.string().trim().max(2_000);
const identifier = z.string().min(1).max(200);
const milliseconds = z.number().int().nonnegative().max(86_400_000);
const nonnegative = z.number().finite().nonnegative();
const validationSchema = z.object({ passed: z.boolean(), issues: z.array(z.string().max(300)).max(300) }).strict();
const evidenceSchema = z.object({ id: identifier, source: z.enum(["transcript", "ocr", "vision", "frame", "temporal"]), text: shortText, start_ms: milliseconds.nullable(), end_ms: milliseconds.nullable(), asset_ref: z.string().max(500).nullable(), frame_group_id: identifier.nullable() }).strict();
const classificationSchema = z.object({ dimension_id: identifier, state: z.enum(["known", "unknown", "not_acquired", "not_applicable"]), tags: z.array(identifier).max(100).nullable(), primary_tag: identifier.nullable(), reason: z.string().trim().max(600).nullable(), evidence_ids: z.array(identifier).max(24) }).strict();
const segmentSchema = z.object({ id: identifier, kind: identifier, dimension_id: identifier.nullable(), tags: z.array(identifier).max(100), start_ms: milliseconds.nullable(), end_ms: milliseconds.nullable(), text: z.string().trim().min(1).max(2_000), evidence_ids: z.array(identifier).max(24) }).strict();
const informationUnitSchema = z.object({ id: identifier, type_tag: identifier, text: z.string().trim().min(1).max(1_200), evidence_ids: z.array(identifier).max(24), duplicate_of: identifier.nullable() }).strict();
const sourceCoverageSchema = z.object({ complete: z.boolean(), included_evidence_count: z.number().int().nonnegative(), available_evidence_count: z.number().int().nonnegative(), required_opening_complete: z.boolean().nullable(), temporal_groups_available: z.array(identifier).max(5_000), temporal_groups_included: z.array(identifier).max(5_000), input_token_limit: z.number().int().positive(), estimated_payload_tokens: z.number().int().nonnegative() }).strict();
const moduleSchema = z.object({ status: z.enum(["completed", "failed", "not_acquired", "not_applicable"]), reason: shortText.nullable(), validation: validationSchema, source_coverage: sourceCoverageSchema.nullable().optional() }).strict();
const metricsSchema = z.object({
  version: z.literal("content-metrics.v1"),
  media: z.object({ status: z.enum(["measured", "unknown"]), duration_ms: milliseconds, duration_seconds: nonnegative, duration_bucket: z.string().max(100).nullable(), encoded_width: nonnegative.nullable(), encoded_height: nonnegative.nullable(), rotation_degrees: z.number().finite(), sample_aspect_ratio: z.string().max(100).nullable(), display_aspect_ratio: z.string().max(100).nullable(), aspect_category: z.string().max(100).nullable(), aspect_status: z.enum(["measured", "unknown", "not_applicable"]), aspect_reason: shortText.nullable() }).strict(),
  shot_detection: z.object({ status: z.enum(["measured", "unknown", "not_applicable"]), method: identifier, threshold: nonnegative.nullable(), boundaries_ms: z.array(milliseconds).max(100_000), segments: z.array(z.object({ start_ms: milliseconds, end_ms: milliseconds, duration_ms: milliseconds }).strict()).max(100_000), detected_cut_count: nonnegative.int().nullable(), detected_shot_count: nonnegative.int().nullable(), mean_shot_seconds: nonnegative.nullable(), cuts_per_minute: nonnegative.nullable(), limitations: z.array(shortText).max(10) }).strict(),
  transcript_statistics: z.object({ status: z.enum(["estimated", "unavailable"]), source: identifier, character_count: nonnegative.int().nullable(), character_count_method: identifier, characters_per_video_second: nonnegative.nullable(), segments: z.array(z.object({ source_segment_id: identifier, start_ms: z.number().int(), end_ms: z.number().int(), character_count: nonnegative.int(), characters_per_second: nonnegative.nullable(), status: z.enum(["estimated", "unknown"]) }).strict()).max(50_000), limitations: z.array(shortText).max(10) }).strict(),
  methodology: z.object({ version: z.literal("content-metrics.v1"), time_unit: z.literal("milliseconds"), aspect_category_relative_tolerance: nonnegative, character_count_method: identifier, audio_analysis: z.literal("out_of_scope"), profile_invariant: z.literal(true) }).strict(),
}).strict();
const contentSchema = z.object({
  schema_version: z.literal(CONTENT_ANALYSIS_SCHEMA), taxonomy_version: z.literal(contentTaxonomy.version), profile: z.enum(["standard", "max"]), status: z.enum(["complete", "partial"]),
  evidence_registry: z.array(evidenceSchema).max(30_000), classifications: z.array(classificationSchema).length(contentTaxonomy.dimensions.length),
  segments: z.array(segmentSchema).max(5_000), information_units: z.array(informationUnitSchema).max(5_000), metrics: metricsSchema,
  methodology: z.object({ transcript_source: shortText, sampling_strategy_id: identifier, sampling_config: z.record(z.string(), z.unknown()), evidence_version: identifier, temporal_min_frames: z.literal(3) }).strict(),
  module_status: z.object({ text_topic_structure_audience: moduleSchema, text_expression_value: moduleSchema, visual: moduleSchema, synthesis: moduleSchema }).strict(), validation: validationSchema,
}).strict();

export type ContentAnalysis = z.infer<typeof contentSchema>;
export type ContentEvidence = ContentAnalysis["evidence_registry"][number];
export type ContentClassification = ContentAnalysis["classifications"][number];
export type ContentAnalysisReadResult = { status: "valid"; value: ContentAnalysis; issues: [] } | { status: "missing" | "invalid" | "unsupported"; value: null; issues: string[] };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Validate stored facts; never infer taxonomy labels from prose or library tags. */
export function readVideoContentAnalysis(value: unknown): ContentAnalysisReadResult {
  if (value === undefined || value === null) return { status: "missing", value: null, issues: ["缺少结构化内容分析。"] };
  if (isRecord(value) && (value.schema_version !== CONTENT_ANALYSIS_SCHEMA || value.taxonomy_version !== contentTaxonomy.version)) return { status: "unsupported", value: null, issues: ["结构化分析或标签词表版本不受支持。"] };
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) return { status: "invalid", value: null, issues: [...new Set(parsed.error.issues.slice(0, 12).map(issue => `结构化分析字段无效：${issue.path.slice(0, 6).join(".") || "content_analysis"}`))] };
  const content = parsed.data;
  const issues: string[] = [];
  const add = (code: string) => { if (issues.length < 30 && !issues.includes(code)) issues.push(code); };
  const evidenceById = new Map<string, ContentEvidence>();
  const duration = content.metrics.media.duration_ms;
  for (const row of content.evidence_registry) {
    if (evidenceById.has(row.id)) add("证据 ID 重复。");
    evidenceById.set(row.id, row);
    if (row.source !== "temporal" && !new RegExp(`^${row.source}:\\d{4,}$`, "u").test(row.id) || row.source === "temporal" && (row.id !== `temporal:${row.frame_group_id}` || !/^[A-Za-z0-9_-]{1,80}$/u.test(row.frame_group_id ?? ""))) add("证据 ID 不符合固定来源编号规则。");
    if (row.source !== "frame" && !row.text.trim()) add("文字或视觉观察证据不能为空。");
    if (row.start_ms !== null && (duration > 0 && row.start_ms > duration || row.end_ms !== null && row.end_ms < row.start_ms) || row.end_ms !== null && duration > 0 && row.end_ms > duration) add("证据时间码越界。");
    if (row.asset_ref && !/^[A-Za-z0-9_-]{1,160}$/u.test(row.asset_ref)) add("证据只能引用存储 ID，不能包含本地路径或外部 URL。");
  }
  const resolve = (ids: string[]) => {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !evidenceById.has(id))) add("结论缺少有效证据引用。");
    return ids.flatMap(id => evidenceById.has(id) ? [evidenceById.get(id)!] : []);
  };
  const validTags = (dimension: ContentDimension, tags: string[], primary: string | null, requirePrimary = true) => {
    if (new Set(tags).size !== tags.length || tags.some(id => !dimension.tags.some(tag => tag.id === id && !tag.disabled))) add("标签不属于当前维度，或标签已停用。");
    if (dimension.cardinality === "single" && tags.length > 1 || !dimension.allow_empty && !tags.length) add("标签数量不符合维度规则。");
    if (dimension.none_tag_id && (tags.length === 0 || tags.includes(dimension.none_tag_id) && tags.length > 1)) add("明确无标签必须独占使用。");
    if (primary !== null && !tags.includes(primary) || requirePrimary && dimension.primary_required && tags.length > 0 && primary === null) add("主标签必须为已选择的标签。");
  };
  const frameTimes = new Set(content.evidence_registry.filter(item => item.source === "frame").map(item => item.start_ms));
  const visionTimes = new Set(content.evidence_registry.filter(item => item.source === "vision").map(item => item.start_ms));
  const checkedTemporal = new Set<string>();
  const validateSources = (requirement: ContentDimension["requires"], cited: ContentEvidence[]) => {
    if (requirement === "text" && !cited.some(item => item.source === "transcript" || item.source === "ocr")) add("文字分类缺少文字证据。");
    if (requirement === "visual" && !cited.some(item => item.source === "vision")) add("视觉分类缺少真实视觉观察。");
    if (requirement === "any" && !cited.some(item => ["transcript", "ocr", "vision"].includes(item.source))) add("分类缺少可解释的文字或视觉证据。");
    if (requirement !== "temporal") return;
    const temporal = cited.filter(item => item.source === "temporal" && item.frame_group_id);
    if (!temporal.length) add("时序分类缺少连续帧证据。");
    for (const group of temporal) {
      if (checkedTemporal.has(group.id)) continue;
      checkedTemporal.add(group.id);
      let metadata: unknown = null;
      try { metadata = JSON.parse(group.text); } catch { /* An unstructured claim is not temporal evidence. */ }
      const timestamps = isRecord(metadata) && Array.isArray(metadata.timestamps_ms) ? metadata.timestamps_ms : [];
      if (timestamps.length < 3 || timestamps.some((time, index) => !Number.isInteger(time) || !frameTimes.has(time) || !visionTimes.has(time) || index > 0 && (time <= timestamps[index - 1] || time - timestamps[index - 1] > 750)) || timestamps[0] !== group.start_ms || timestamps.at(-1) !== group.end_ms) add("时序分类至少需要三张按时间连续排列且经过视觉理解的真实帧。");
    }
    if (!cited.some(item => item.source === "vision")) add("时序分类缺少真实视觉观察引用。");
  };
  const validateDimensionSources = (dimension: ContentDimension, tags: string[], cited: ContentEvidence[]) => {
    validateSources(dimension.requires, cited);
    if (dimension.requires_text) validateSources("text", cited);
    for (const tag of tags) { const requirement = dimension.tags.find(item => item.id === tag)?.requires; if (requirement) validateSources(requirement, cited); }
  };
  content.classifications.forEach((row, index) => {
    const dimension = contentTaxonomy.dimensions[index];
    if (row.dimension_id !== dimension.id) { add("分类维度必须完整且按词表顺序唯一排列。"); return; }
    if (row.state !== "known") {
      if (row.tags !== null || row.primary_tag !== null || !row.reason?.trim()) add("未确定分类须保留空标签和明确原因。");
      if (row.evidence_ids.length) resolve(row.evidence_ids);
      return;
    }
    if (row.tags === null) { add("已确定分类必须提供标签数组。"); return; }
    validTags(dimension, row.tags, row.primary_tag);
    if (row.tags.some(tag => tag.endsWith(".other")) && !row.reason?.trim()) add("其他分类必须说明具体原因。");
    const cited = resolve(row.evidence_ids);
    validateDimensionSources(dimension, row.tags, cited);
    if (dimension.id.startsWith("visual.first_frame")) {
      const frameTimes = content.evidence_registry.filter(item => item.source === "frame" && item.frame_group_id === "first_frame" && item.start_ms !== null).map(item => item.start_ms!);
      const first = frameTimes.length ? Math.min(...frameTimes) : 0;
      if (!cited.some(item => item.source === "vision" && item.start_ms === first)) add("首帧分类必须引用首帧的视觉观察。");
    }
    if (dimension.id === "visual.opening" && !cited.some(item => item.source === "vision" && item.start_ms !== null && item.start_ms < 3_000)) add("开头画面分类必须引用前三秒的视觉观察。");
  });
  const segmentIds = new Set<string>();
  for (const row of content.segments) {
    if (segmentIds.has(row.id)) add("内容片段 ID 重复。"); segmentIds.add(row.id);
    if (!(contentTaxonomy.rules.open_text_segment_kinds as string[]).includes(row.kind)) add("内容片段类型无效。");
    const cited = resolve(row.evidence_ids);
    const dimension = row.dimension_id === null ? null : dimensions.get(row.dimension_id);
    if (row.dimension_id !== null && !dimension || !dimension && row.tags.length) add("内容片段的分类维度无效。");
    if (dimension) { validTags(dimension, row.tags, null, false); validateDimensionSources(dimension, row.tags, cited); }
    const starts = cited.flatMap(item => item.start_ms === null ? [] : [item.start_ms]);
    const ends = cited.flatMap(item => item.end_ms === null ? item.start_ms === null ? [] : [item.start_ms] : [item.end_ms]);
    if ((row.start_ms === null) !== (row.end_ms === null) || row.start_ms !== null && (duration > 0 && row.start_ms > duration || starts.length === 0 || row.start_ms !== Math.min(...starts)) || row.end_ms !== null && (duration > 0 && row.end_ms > duration || ends.length === 0 || row.end_ms !== Math.max(...ends)) || row.start_ms !== null && row.end_ms !== null && row.end_ms < row.start_ms) add("内容片段须保留完整来源时间范围，不能伪造更细的对齐。");
    if (row.kind === "hook_first_3s" && cited.some(item => ["transcript", "ocr"].includes(item.source) && item.end_ms !== null && item.end_ms > 3_000)) add("前三秒文案不能假造跨越三秒的逐词对齐。");
    if (["hook_first_sentence", "hook_first_3s"].includes(row.kind) && !cited.some(item => ["transcript", "ocr"].includes(item.source) && item.text.replace(/\s/gu, "").includes(row.text.replace(/\s/gu, "")))) add("开头原文须来自可定位的连续文字证据。");
    if (row.kind === "cta" && (row.dimension_id !== "cta.action" || !row.tags.length || row.tags.some(tag => tag === dimensions.get("cta.action")?.none_tag_id) || !cited.some(item => ["transcript", "ocr"].includes(item.source)))) add("CTA事件须引用实际文字与非空动作，不能把无CTA计为一次事件。");
  }
  const unitIds = new Set<string>();
  const unitTypes = dimensions.get("value.information_type")?.tags.filter(tag => !tag.disabled).map(tag => tag.id) ?? [];
  for (const unit of content.information_units) {
    if (unitIds.has(unit.id) || unit.duplicate_of !== null && !unitIds.has(unit.duplicate_of)) add("信息单元重复关系必须指向前面的唯一单元。");
    if (!unitTypes.includes(unit.type_tag)) add("信息单元类型无效。");
    if (!resolve(unit.evidence_ids).some(item => ["transcript", "ocr", "vision"].includes(item.source))) add("信息单元缺少可解释的文字或视觉证据。");
    unitIds.add(unit.id);
  }
  const sameSource = (left: string[], right: string[]) => left.some(id => right.includes(id));
  for (const classification of content.classifications) {
    if (classification.state !== "known" || !classification.tags?.length) continue;
    const dimension = dimensions.get(classification.dimension_id)!;
    const positiveTags = classification.tags.filter(tag => tag !== dimension.none_tag_id);
    if (!positiveTags.length) continue;
    const segments = content.segments.filter(segment => sameSource(classification.evidence_ids, segment.evidence_ids));
    if (classification.dimension_id === "cta.action" && positiveTags.some(tag => !segments.some(segment => segment.kind === "cta" && segment.dimension_id === "cta.action" && segment.tags.includes(tag)))) add("CTA动作分类缺少同标签、同来源的实际CTA事件。");
    if (classification.dimension_id === "cta.position" && !segments.some(segment => segment.kind === "cta")) add("CTA位置分类缺少同来源的实际CTA事件。");
    if (classification.dimension_id === "value.information_type" && positiveTags.some(tag => !content.information_units.some(unit => unit.type_tag === tag && sameSource(classification.evidence_ids, unit.evidence_ids)))) add("信息类型分类缺少同类型、同来源的信息单元。");
    if (classification.dimension_id === "structure.role" && positiveTags.some(tag => !segments.some(segment => segment.kind === "structure" && segment.dimension_id === "structure.role" && segment.tags.includes(tag)))) add("结构功能分类缺少同标签、同来源的结构段。");
    if (classification.dimension_id === "structure.type" && positiveTags.some(tag => tag !== "structure.type.weak") && !segments.some(segment => segment.kind === "structure")) add("结构类型分类缺少同来源的结构段。");
    if (classification.dimension_id === "topic.problem" && !segments.some(segment => segment.kind === "topic_problem")) add("问题分类缺少同来源的具体问题文本。");
    if (classification.dimension_id === "topic.granularity" && positiveTags.some(tag => tag !== "topic.granularity.broad") && !segments.some(segment => segment.kind === "topic_subject")) add("细分选题缺少同来源的具体主题文本。");
  }
  if (JSON.stringify(content.methodology.sampling_config).length > 20_000) add("采样配置超过允许大小。");
  if ([content.validation, ...Object.values(content.module_status).map(module => module.validation)].some(validation => validation.passed !== (validation.issues.length === 0))) add("验收结论与问题列表不一致。");
  if (content.status === "complete" && (!content.validation.passed || Object.values(content.module_status).some(module => !["completed", "not_applicable"].includes(module.status) || !module.validation.passed))) add("完整报告与模块验收状态不一致。");
  return issues.length ? { status: "invalid", value: null, issues } : { status: "valid", value: content, issues: [] };
}

/** Accept either a stored report body or its content_analysis member. */
export function readContentAnalysis(report: unknown): ContentAnalysis | null {
  const result = readVideoContentAnalysis(isRecord(report) && "content_analysis" in report ? report.content_analysis : report);
  return result.status === "valid" ? result.value : null;
}

export type ContentComparisonInput = { entryId: string; videoId: string; title: string; analysisId: string; analysisCreatedAt: string; contentAnalysis: ContentAnalysis };
export function projectContentComparisonEntry(content: ContentAnalysis) {
  const { media, shot_detection: shot, transcript_statistics: transcript } = content.metrics;
  return {
    schema_version: content.schema_version, taxonomy_version: content.taxonomy_version, profile: content.profile, status: content.status,
    classifications: content.classifications, methodology: content.methodology,
    metrics: { version: content.metrics.version, media, shot_detection: { status: shot.status, method: shot.method, threshold: shot.threshold, detected_cut_count: shot.detected_cut_count, detected_shot_count: shot.detected_shot_count, mean_shot_seconds: shot.mean_shot_seconds, cuts_per_minute: shot.cuts_per_minute, limitations: shot.limitations }, transcript_statistics: { status: transcript.status, source: transcript.source, character_count: transcript.character_count, character_count_method: transcript.character_count_method, characters_per_video_second: transcript.characters_per_video_second, limitations: transcript.limitations } },
    informationUnitCount: content.information_units.length, uniqueInformationUnitCount: content.information_units.filter(unit => unit.duplicate_of === null).length,
    ctaOccurrenceCount: content.segments.filter(segment => segment.kind === "cta").length,
  };
}
export type ContentComparisonExclusion = "missing" | "legacy" | "quality_failed" | "invalid_contract" | "unsupported_schema" | "unsupported_taxonomy" | "duplicate_video" | "filtered_out";
export const contentDurationBuckets = ["under_15s", "15_to_under_30s", "30_to_under_60s", "60_to_under_180s", "180s_and_above"] as const;
export type ContentComparisonFilters = { topicCategory?: string; contentForm?: string; durationBucket?: typeof contentDurationBuckets[number] };
export type ContentComparisonEntry = { entryId: string; videoId: string; title: string; status: "included" | "excluded"; analysisId: string | null; analysisCreatedAt: string | null; excludedReason: ContentComparisonExclusion | null; contentAnalysis: ReturnType<typeof projectContentComparisonEntry> | null };
export type ContentDimensionDistribution = { dimensionId: string; label: string; cardinality: "single" | "multiple"; totalVideos: number; knownCount: number; stateCounts: Record<ContentState, number>; tags: Array<{ id: string; label: string; count: number; percent: number | null; primaryCount: number; primaryPercent: number | null }> };
const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : isRecord(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const percent = (count: number, denominator: number) => denominator ? Math.round(count * 10_000 / denominator) / 100 : null;

function distributionsFor(rows: ContentComparisonInput[]): ContentDimensionDistribution[] {
  return contentTaxonomy.dimensions.map(dimension => {
    const stateCounts: Record<ContentState, number> = { known: 0, unknown: 0, not_acquired: 0, not_applicable: 0 };
    const counts = new Map<string, number>(), primary = new Map<string, number>();
    for (const entry of rows) {
      const classification = entry.contentAnalysis.classifications.find(row => row.dimension_id === dimension.id)!;
      stateCounts[classification.state] += 1;
      if (classification.state !== "known") continue;
      for (const tag of new Set(classification.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (classification.primary_tag) primary.set(classification.primary_tag, (primary.get(classification.primary_tag) ?? 0) + 1);
    }
    return { dimensionId: dimension.id, label: dimension.label, cardinality: dimension.cardinality, totalVideos: rows.length, knownCount: stateCounts.known, stateCounts,
      tags: dimension.tags.filter(tag => !tag.disabled).map(tag => ({ id: tag.id, label: tag.label, count: counts.get(tag.id) ?? 0, percent: percent(counts.get(tag.id) ?? 0, stateCounts.known), primaryCount: primary.get(tag.id) ?? 0, primaryPercent: percent(primary.get(tag.id) ?? 0, stateCounts.known) })) };
  });
}

/** One selected analysis per video, with incompatible measurement methods kept apart. */
export function aggregateContentComparison(input: ContentComparisonInput[]) {
  const unique = [...new Map(input.map(entry => [entry.videoId, entry])).values()];
  const grouped = new Map<string, ContentComparisonInput[]>();
  for (const entry of unique) {
    const content = entry.contentAnalysis;
    const key = canonicalJson({ taxonomyVersion: content.taxonomy_version, metricsVersion: content.metrics.version, samplingStrategy: content.methodology.sampling_strategy_id, samplingConfig: content.methodology.sampling_config, evidenceVersion: content.methodology.evidence_version });
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  const groupings = [...grouped].map(([key, entries], index) => ({
    id: `group-${index + 1}`, compatibilityKey: key, taxonomyVersion: entries[0].contentAnalysis.taxonomy_version, metricsVersion: entries[0].contentAnalysis.metrics.version,
    samplingStrategy: entries[0].contentAnalysis.methodology.sampling_strategy_id, samplingConfig: entries[0].contentAnalysis.methodology.sampling_config, evidenceVersion: entries[0].contentAnalysis.methodology.evidence_version,
    videoCount: entries.length, entryIds: entries.map(entry => entry.entryId), distributions: distributionsFor(entries),
    metricsTotals: {
      informationUnits: entries.reduce((total, entry) => total + entry.contentAnalysis.information_units.length, 0),
      uniqueInformationUnits: entries.reduce((total, entry) => total + entry.contentAnalysis.information_units.filter(unit => unit.duplicate_of === null).length, 0),
      ctaOccurrences: entries.reduce((total, entry) => total + entry.contentAnalysis.segments.filter(segment => segment.kind === "cta").length, 0),
      videosWithCtaOccurrences: entries.filter(entry => entry.contentAnalysis.segments.some(segment => segment.kind === "cta")).length,
      totalDurationMs: entries.reduce((total, entry) => total + entry.contentAnalysis.metrics.media.duration_ms, 0),
    },
  }));
  return { distributions: groupings.length === 1 ? groupings[0].distributions : [], groupings, coverage: { includedVideos: unique.length, compatibleGroups: groupings.length, dimensions: groupings.length === 1 ? groupings[0].distributions.map(row => ({ dimensionId: row.dimensionId, knownCount: row.knownCount, totalVideos: row.totalVideos, knownPercent: percent(row.knownCount, row.totalVideos), stateCounts: row.stateCounts })) : [] } };
}

export type ContentComparisonResponse = ReturnType<typeof aggregateContentComparison> & {
  version: "content-comparison.v1"; scope: "library" | "benchmark";
  snapshot: { analysisSchemaVersion: "analysis.v10"; contentSchemaVersion: "content-analysis.v1"; taxonomyVersion: string; selection: "latest_accepted_per_video"; requestedEntryIds: string[]; filters: ContentComparisonFilters; generatedAt: string; analyses: Array<{ entryId: string; videoId: string; analysisId: string; createdAt: string }> };
  summary: { selectedEntries: number; selectedVideos: number; includedVideos: number; excludedVideos: number };
  entries: ContentComparisonEntry[]; excluded: Record<ContentComparisonExclusion, number>;
};
