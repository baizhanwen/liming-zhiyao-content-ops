import { z } from "zod";
import { readContentAnalysis, type ContentAnalysis } from "./video-content-analysis.ts";
import { semanticRewriteFacts } from "./script-rewrite.ts";
import { CONTENT_REPORT_MAX_UTF16_UNITS } from "./content-report-contract.ts";

export const unifiedModuleKeys = ["text_topic_structure_audience", "text_expression_value", "visual", "synthesis"] as const;
export type UnifiedModuleKey = typeof unifiedModuleKeys[number];
export const unifiedFailureKinds = ["length", "overloaded", "timeout", "provider_error", "schema_invalid", "evidence_invalid", "input_budget", "canonical_failed"] as const;
const text = (limit: number) => z.string().trim().max(limit);
// Manuscript fields retain source spelling and whitespace. Their size is
// bounded by the same serialized-report budget as the evidence registry.
const manuscriptText = z.string().max(CONTENT_REPORT_MAX_UTF16_UNITS);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200);
const references = z.array(id).max(24);
const validation = z.object({ passed: z.boolean(), issues: z.array(text(300)).max(300) }).strict();
export const unifiedDiagnosticsSchema = z.object({
  failure_kind: z.enum(unifiedFailureKinds).nullable(), http_status: z.number().int().min(100).max(599).nullable(),
  finish_reason: text(40).nullable(), attempts: count, elapsed_ms: z.number().finite().nonnegative(),
  input_tokens: count.nullable(), output_tokens: count.nullable(), total_tokens: count.nullable(),
  reasoning_tokens: count.nullable(), output_budget: count.nullable(), reused: z.boolean(),
}).strict();
const finding = z.object({ id, title: text(80).min(1), text: text(500).min(1), evidence_ids: references.min(1) }).strict();
const section = z.object({ key: z.enum(unifiedModuleKeys), status: z.enum(["completed", "failed", "not_acquired", "not_applicable"]),
  findings: z.array(finding).max(6), reason: text(2_000).nullable(), diagnostics: unifiedDiagnosticsSchema }).strict();
const canonicalSegment = z.object({ source_segment_id: z.string().regex(/^transcript:\d{4,}$/), start_ms: count, end_ms: count,
  text: manuscriptText, original_text: manuscriptText, evidence_ids: references }).strict();
const unifiedV1Schema = z.object({
  version: z.literal("unified-report.v1"), status: z.enum(["complete", "partial"]), summary: text(1_200), sections: z.array(section).length(4),
  canonical: z.object({ version: z.literal("canonical-transcript.v1"), status: z.enum(["completed", "failed", "not_applicable"]),
    segments: z.array(canonicalSegment).max(50_000), paragraphs: z.array(manuscriptText).max(10_000), validation,
    changes: z.array(z.object({ source_segment_id: id, before: manuscriptText, after: manuscriptText, evidence_ids: references }).strict()).max(50_000),
  }).strict(),
  source_signature: z.string().regex(/^[a-f0-9]{64}$/),
  methodology: z.object({ pipeline_version: z.literal("unified-analysis.v1"), canonical_version: z.literal("canonical-transcript.v1"),
    module_protocol_version: z.literal("content-module-wire.v1"), transcript_basis: z.literal("canonical"), evidence_version: z.literal("content-evidence.v1") }).strict(),
  timing: z.object({ elapsed_ms: z.number().finite().nonnegative(), canonical_elapsed_ms: z.number().finite().nonnegative(),
    modules_elapsed_ms: z.number().finite().nonnegative(), cache_reused_count: count }).strict(), validation,
}).strict();
const canonicalV2Schema = z.object({
  version: z.literal("canonical-transcript.v2"), status: z.enum(["completed", "needs_review", "failed", "not_applicable"]),
  segments: z.array(canonicalSegment.extend({ candidate_text: manuscriptText.nullable(), review_status: z.enum(["accepted", "needs_review"]), issues: z.array(text(300)).max(100) }).strict()).max(50_000),
  paragraphs: z.array(manuscriptText).max(10_000), validation,
}).strict();
const unifiedV2Schema = unifiedV1Schema.extend({
  version: z.literal("unified-report.v2"), canonical: canonicalV2Schema,
  outcome: z.object({ processing: z.literal("completed"), report: z.enum(["complete", "partial"]),
    manuscript: z.enum(["verified", "needs_review", "unavailable", "not_applicable"]), review_segment_count: count }).strict(),
  methodology: z.object({ pipeline_version: z.literal("unified-analysis.v2"), canonical_version: z.literal("canonical-transcript.v2"),
    module_protocol_version: z.literal("content-module-wire.v1"), transcript_basis: z.literal("canonical"), evidence_version: z.literal("content-evidence.v1") }).strict(),
}).strict();
const unifiedSchema = z.discriminatedUnion("version", [unifiedV1Schema, unifiedV2Schema]);
export type UnifiedReportV1 = z.infer<typeof unifiedV1Schema>;
export type UnifiedReportV2 = z.infer<typeof unifiedV2Schema>;
export type CanonicalTranscriptV2 = z.infer<typeof canonicalV2Schema>;
export type UnifiedReport = UnifiedReportV1 | UnifiedReportV2;
export type UnifiedDiagnostics = z.infer<typeof unifiedDiagnosticsSchema>;
export type UnifiedReportReadResult = { status: "valid"; value: UnifiedReport; issues: [] } | { status: "missing" | "invalid" | "unsupported"; value: null; issues: string[] };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function explicitNumbers(value: string) {
  const digits: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  const normalized = value.normalize("NFKC").replace(/(\d+|[零〇一二两三四五六七八九十百千]+)点([\d零〇一二两三四五六七八九]+)/gu, (match, integer: string, fraction: string) => {
    const fact = /^\d+$/u.test(integer) ? integer : semanticRewriteFacts(`${integer}元`).find(row => /^\d+(?:\.\d+)?$/u.test(row));
    return fact ? `${fact}.${[...fraction].map(character => digits[character] ?? character).join("")}` : match;
  });
  const numbers = semanticRewriteFacts(normalized).flatMap(fact => fact.match(/\d+(?:\.\d+)*%?/gu) ?? []).map(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const version = new RegExp(`(?:[A-Za-z][A-Za-z_./-]*|版本|第)\\s*${escaped}`, "u").test(normalized);
    if (version || !/^\d+(?:\.\d+)?%?$/u.test(token)) return token;
    const [integer, fraction = ""] = token.replace(/%$/u, "").split(".");
    const decimals = fraction.replace(/0+$/u, "");
    return `${integer.replace(/^0+(?=\d)/u, "")}${decimals ? `.${decimals}` : ""}${token.endsWith("%") ? "%" : ""}`;
  });
  return [...new Set(numbers)].sort();
}

/** Stored reports are checked against their own registry, never the latest ASR. */
export function readVideoUnifiedReport(value: unknown, content: ContentAnalysis | null): UnifiedReportReadResult {
  if (value === undefined || value === null) return { status: "missing", value: null, issues: ["缺少统一分析报告。"] };
  if (record(value) && !["unified-report.v1", "unified-report.v2"].includes(String(value.version))) return { status: "unsupported", value: null, issues: ["统一报告版本不受支持。"] };
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > CONTENT_REPORT_MAX_UTF16_UNITS) return { status: "invalid", value: null, issues: ["统一报告超出报告体积限制。"] };
  } catch { return { status: "invalid", value: null, issues: ["统一报告无法序列化。"] }; }
  const parsed = unifiedSchema.safeParse(value);
  if (!parsed.success) return { status: "invalid", value: null, issues: ["统一报告字段、状态或计量格式无效。"] };
  const report = parsed.data, issues: string[] = [];
  const add = (message: string) => { if (!issues.includes(message)) issues.push(message); };
  if (!content) add("统一报告缺少可验证的内容证据注册表。");
  const registry = new Map(content?.evidence_registry.map(row => [row.id, row]) ?? []);
  const findingIds = new Set<string>();
  report.sections.forEach((row, index) => {
    if (row.key !== unifiedModuleKeys[index]) add("统一报告的四个内容模块必须按固定顺序各出现一次。");
    if (content && content.module_status[row.key].status !== row.status) add("统一报告与分类模块状态不一致。");
    if (row.status === "completed" && (!row.findings.length || row.diagnostics.failure_kind !== null)) add("已完成模块必须有可核对结论且没有失败标记。");
    if (row.status !== "completed" && !row.reason?.trim()) add("未完成或不适用模块必须保留明确原因。");
    if (row.status === "not_applicable" && row.findings.length) add("不适用模块不能同时声明内容结论。");
    for (const entry of row.findings) {
      if (findingIds.has(entry.id)) add("统一报告结论标识重复。");
      findingIds.add(entry.id);
      if (new Set(entry.evidence_ids).size !== entry.evidence_ids.length || entry.evidence_ids.some(ref => !registry.has(ref))) add("统一报告结论包含不存在或重复的证据引用。");
      if (report.version === "unified-report.v2") {
        const sources = entry.evidence_ids.flatMap(ref => registry.has(ref) ? [registry.get(ref)!.source] : []);
        if (!sources.some(source => ["transcript", "ocr", "vision"].includes(source))) add("内容结论必须引用实际文字或画面理解，不能只引用空帧或帧组。");
        if (row.key === "visual" && !sources.includes("vision")) add("画面结论必须引用真实视觉观察，不能仅凭OCR、空帧或帧组判断。");
      }
    }
  });
  const sourceIds = new Set<string>(), acceptedIds = new Set<string>();
  const reviewed = report.version === "unified-report.v2" ? report : null;
  const uncertain = reviewed?.canonical.segments.filter(segment => segment.review_status === "needs_review") ?? [];
  const uncertainIds = new Set(uncertain.map(segment => segment.source_segment_id));
  if (reviewed) {
    if (reviewed.outcome.report !== reviewed.status) add("统一报告处理结果与安全内容状态不一致。");
    const expectedManuscript = { completed: "verified", needs_review: "needs_review", failed: "unavailable", not_applicable: "not_applicable" }[reviewed.canonical.status];
    if (reviewed.outcome.manuscript !== expectedManuscript || reviewed.outcome.review_segment_count !== uncertain.length) add("稿件核对状态或待核对句数不一致。");
    const coverage = content?.methodology.transcript_review;
    if (!coverage || coverage.total_segments !== reviewed.canonical.segments.length
      || coverage.accepted_segments !== reviewed.canonical.segments.length - uncertain.length
      || coverage.first_source_segment_id !== (reviewed.canonical.segments[0]?.source_segment_id ?? null)
      || JSON.stringify([...coverage.uncertain_segment_ids].sort()) !== JSON.stringify([...uncertainIds].sort())
      || coverage.uncertain_ranges.some(range => !uncertain.some(segment => segment.source_segment_id === range.source_segment_id && segment.start_ms === range.start_ms && segment.end_ms === range.end_ms))) add("稿件核对覆盖范围与原始片段不一致。");
    reviewed.canonical.segments.forEach((segment, index) => {
      if (segment.source_segment_id !== `transcript:${String(index + 1).padStart(4, "0")}`) add("逐句核对必须保留原始编号与全部片段，不能跳段或重新编号。");
      if (segment.review_status === "needs_review" && (segment.text !== segment.original_text || !segment.issues.length)) add("待核对句必须保留原文和明确疑点，不能把候选稿当作正文。");
      if (segment.review_status === "accepted" && segment.issues.length) add("已核对句不能同时保留未处理疑点。");
    });
    if (reviewed.canonical.status === "needs_review" && (!uncertain.length || reviewed.canonical.validation.passed)
      || reviewed.canonical.status === "completed" && uncertain.length) add("逐句核对状态与待核对片段不一致。");
    if ([...registry.keys()].some(id => uncertainIds.has(id))) add("待核对文案不得进入可分析证据注册表。");
  }
  let previousStart = -1;
  for (const segment of report.canonical.segments) {
    if (sourceIds.has(segment.source_segment_id) || segment.start_ms < previousStart || segment.end_ms < segment.start_ms) add("校正文本来源标识、顺序或时间区间无效。");
    sourceIds.add(segment.source_segment_id); previousStart = segment.start_ms;
    // A final ASR tail outside the decodable media duration may intentionally
    // remain in the complete manuscript while absent from the timed registry.
    if (segment.evidence_ids.some(ref => !registry.has(ref) && ref !== segment.source_segment_id)) add("校正文本引用了不存在的证据。");
    const source = registry.get(segment.source_segment_id);
    const accepted = reviewed ? !uncertainIds.has(segment.source_segment_id) : report.canonical.status === "completed";
    if (accepted) acceptedIds.add(segment.source_segment_id);
    if (accepted && source && (source.source !== "transcript" || source.text !== segment.text || reviewed && (source.start_ms !== segment.start_ms || source.end_ms !== segment.end_ms))) add("内容分类没有使用同一份已核对文本与来源时间。");
    if (accepted && JSON.stringify(explicitNumbers(segment.original_text)) !== JSON.stringify(explicitNumbers(segment.text))) add("校正文本改变了原文中的数字、金额或版本，必须保留候选并人工复核。");
  }
  if ((reviewed || report.canonical.status === "completed") && [...registry.values()].some(row => row.source === "transcript" && !(reviewed ? acceptedIds : sourceIds).has(row.id))) add("内容分析所引用的转写片段没有通过逐句核对。");
  for (const change of report.version === "unified-report.v1" ? report.canonical.changes : []) {
    const segment = report.canonical.segments.find(row => row.source_segment_id === change.source_segment_id);
    if (!segment || change.before !== segment.original_text || change.after !== segment.text || change.evidence_ids.some(ref => !registry.has(ref))) add("校正改动与其来源文本或证据不一致。");
  }
  for (const gate of [report.validation, report.canonical.validation]) if (gate.passed !== (gate.issues.length === 0)) add("统一报告验收状态与问题列表不一致。");
  if (report.canonical.status === "completed" && (!report.canonical.validation.passed || !report.canonical.segments.length || !report.canonical.paragraphs.some(row => row.trim()))) add("校正成功状态缺少有效全文或验收结果。");
  if (report.canonical.status === "not_applicable" && (report.canonical.segments.length || report.canonical.paragraphs.length || !report.canonical.validation.passed)) add("不适用的口播校正状态与文本内容不一致。");
  if (report.canonical.status === "not_applicable" && [...registry.values()].some(row => row.source === "transcript" && row.text.trim())) add("已有口播转写时不能将口播校正标为不适用。");
  if (report.status === "complete" && (!report.validation.passed || !reviewed && (report.canonical.status === "failed" || !report.canonical.validation.passed) || report.sections.some(row => !["completed", "not_applicable"].includes(row.status)))) add("统一报告完整状态与模块验收不一致。");
  return issues.length ? { status: "invalid", value: null, issues } : { status: "valid", value: report, issues: [] };
}

export function readUnifiedReport(report: unknown): UnifiedReport | null {
  const result = readVideoUnifiedReport(record(report) ? report.unified_report : null, readContentAnalysis(report));
  return result.status === "valid" ? result.value : null;
}

/** Models and derived knowledge receive accepted evidence, never review candidates or a full pending manuscript. */
export function projectSafeAnalysisReport(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  const meta = record(value.analysis_meta) ? value.analysis_meta : null;
  const member = record(value.unified_report) ? value.unified_report : null;
  if (member && !["unified-report.v1", "unified-report.v2"].includes(String(member.version))) return null;
  if (typeof meta?.contract_version === "string" && !/^analysis\.v(?:[1-9]|1[0-2])$/u.test(meta.contract_version)) return null;
  if (meta?.contract_version !== "analysis.v12" && member?.version !== "unified-report.v2") return value;
  const unified = readUnifiedReport(value), content = readContentAnalysis(value);
  if (!unified || unified.version !== "unified-report.v2" || !content) return null;
  const byModule = (key: UnifiedModuleKey) => unified.sections.find(section => section.key === key)?.findings ?? [];
  const asText = (key: UnifiedModuleKey) => byModule(key).map(finding => finding.text);
  const accepted = unified.canonical.segments.filter(segment => segment.review_status === "accepted");
  return {
    summary: asText("synthesis").join("\n") || asText("text_topic_structure_audience")[0] || "",
    structure: asText("text_topic_structure_audience"), viral_points: asText("text_expression_value"),
    visual: asText("visual"), recommendations: asText("synthesis"),
    spoken_script: accepted.map(segment => segment.text),
    evidence: content.evidence_registry.filter(row => ["transcript", "ocr", "vision"].includes(row.source)).map(row => ({ source: row.source, start_ms: row.start_ms, end_ms: row.end_ms, text: row.text })),
    review_coverage: { total_segments: unified.canonical.segments.length, accepted_segments: accepted.length,
      uncertain_segments: unified.outcome.review_segment_count, manuscript: unified.outcome.manuscript },
  };
}
