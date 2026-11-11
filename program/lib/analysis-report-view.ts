import { readUnifiedReport, unifiedModuleKeys, type UnifiedModuleKey } from "./unified-report";
import { readContentAnalysis, getDimensionLabel, getTagLabel, contentTaxonomy, type ContentClassification, type ContentEvidence } from "./video-content-analysis";

export const reportModuleNames: Record<UnifiedModuleKey, string> = {
  text_topic_structure_audience: "选题、结构与人群",
  text_expression_value: "文案、价值与行动",
  visual: "画面与镜头",
  synthesis: "综合判断与建议",
};
export const reportFailureNames: Record<string, string> = {
  length: "模型输出没有完整返回", overloaded: "模型服务暂时繁忙", timeout: "模型响应超时",
  provider_error: "模型调用未完成", schema_invalid: "返回内容没有通过格式检查",
  evidence_invalid: "部分结论缺少有效来源", input_budget: "材料超出了本模块的处理范围",
  canonical_failed: "需要先完成口播校正", classification_request_failed: "模型未返回有效结果",
  required_evidence_not_acquired: "缺少分析所需的材料", no_video_track: "音频素材不适用画面分析",
  upstream_module_failed: "需要先完成前面的分析部分",
  not_requested: "本次没有重试这一部分",
  no_audio_or_usable_sampled_text: "画面中未发现可分析的文字，且来源没有音轨",
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const texts = (value: unknown): string[] => typeof value === "string" ? value.trim() ? [value.trim()] : [] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()) : [];
export type ReportFindingView = { id: string; title: string; text: string; evidenceIds: string[] };
export type ReportClassificationView = {
  dimensionId: string; label: string; state: ContentClassification["state"];
  tags: Array<{ id: string; label: string; primary: boolean }>;
  value: string; reason: string | null; featured: boolean;
};
export type ReportSectionView = { key: UnifiedModuleKey; name: string; status: string; reason: string | null; findings: ReportFindingView[]; classifications: ReportClassificationView[] };
export type AnalysisReportView = { legacy: boolean; invalid: boolean; complete: boolean; summary: string; sections: ReportSectionView[]; script: string[]; scriptStatus: string; changes: Array<{ sourceId: string; before: string; after: string; evidenceIds: string[] }>; evidence: ContentEvidence[]; content: ReturnType<typeof readContentAnalysis>; unified: ReturnType<typeof readUnifiedReport> };
const legacyGroups: Record<UnifiedModuleKey, Array<[string, string]>> = {
  text_topic_structure_audience: [["hook", "开头"], ["hook_analysis", "开头设计"], ["structure", "结构"], ["audience", "目标人群"]],
  text_expression_value: [["language", "文案表达"], ["emotion_curve", "文案情绪"], ["viral_points", "内容价值"], ["conversion_design", "行动引导"]],
  visual: [["visual", "画面表现"], ["rhythm_analysis", "镜头与节奏"]],
  synthesis: [["highlights", "有效亮点"], ["risks", "问题与缺口"], ["recommendations", "复用建议"]],
};
const featuredDimensions: Record<UnifiedModuleKey, readonly string[]> = {
  text_topic_structure_audience: ["topic.category", "topic.problem", "topic.purpose", "structure.type", "audience.role", "audience.need"],
  text_expression_value: ["hook.type", "emotion.expressed", "value.type", "value.actionability", "language.tone", "cta.action"],
  visual: ["content.form", "visual.first_frame_style", "visual.opening", "visual.broll", "visual.composition", "visual.cut_pattern"],
  synthesis: ["synthesis.visual_text_relation", "synthesis.retention", "synthesis.opening_fulfillment", "synthesis.problem"],
};
const classificationStateNames = { known: "未发现该特征", unknown: "无法判断", not_acquired: "未取得所需材料", not_applicable: "不适用" };
function classificationReason(row: ContentClassification) {
  const reason = row.reason;
  if (!reason) return null;
  const names: Record<string, string> = {
    model_could_not_determine_from_available_evidence: "现有依据不足以确定这一项。",
    absence_not_verifiable_from_representative_sample: "现有抽样不足以确认该特征是否未出现。",
    required_evidence_not_available_for_classification: "缺少判断这一项所需的材料。",
    dimension_not_applicable_to_this_content: "这项分类不适用于当前内容。",
    classification_not_returned: "这一项尚未形成有效判断。",
    no_video_track: "这是音频素材，不适用画面分类。",
    no_audio_or_usable_sampled_text: "素材没有口播，也没有取得可分析的画面文字。",
  };
  if (names[reason]) return names[reason];
  // Internal validation codes are useful in diagnostics, not in classification rows.
  if (/^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(reason)) return row.state === "known" ? null
    : row.state === "not_acquired" ? "缺少判断这一项所需的材料。"
      : row.state === "not_applicable" ? "这项分类不适用于当前内容。" : "现有依据不足以确定这一项。";
  return reason;
}

function classificationView(row: ContentClassification, key: UnifiedModuleKey): ReportClassificationView {
  const tags = row.state === "known" ? (row.tags ?? []).map(id => ({ id, label: getTagLabel(row.dimension_id, id), primary: id === row.primary_tag })) : [];
  return { dimensionId: row.dimension_id, label: getDimensionLabel(row.dimension_id), state: row.state, tags,
    value: tags.length ? tags.map(tag => tag.label).join("、") : classificationStateNames[row.state],
    reason: classificationReason(row), featured: featuredDimensions[key].includes(row.dimension_id) };
}

function legacyCtaFindings(report: Record<string, unknown>, evidence: ContentEvidence[]): ReportFindingView[] {
  const cta = record(report.cta_analysis) ?? record(report.ctaAnalysis) ?? record(report.cta);
  if (!cta) return [];
  const first = (row: Record<string, unknown>, keys: string[]) => keys.flatMap(key => texts(row[key]))[0] || "";
  const assessment = first(cta, ["overall_assessment", "overallAssessment", "summary"]);
  if (cta.present === false || cta.detected === false || cta.has_cta === false) return [{ id: "legacy:cta:none", title: "行动引导", text: assessment || "该历史报告明确记录未识别到行动引导。", evidenceIds: [] }];
  const rows = Array.isArray(cta.items) ? cta.items : Array.isArray(cta.ctas) ? cta.ctas : [];
  const result = rows.flatMap((value, index) => {
    const row = record(value); if (!row) return [];
    const quote = first(row, ["evidence_text", "quote", "text"]);
    const action = first(row, ["target_action", "targetAction", "action"]);
    const path = first(row, ["handoff_path", "conversion_path", "handoffPath", "conversionPath"]);
    const effect = first(row, ["effectiveness", "assessment"]);
    const text = [quote ? `原文：${quote}` : "", action ? `目标动作：${action}` : "", path ? `承接：${path}` : "", effect].filter(Boolean).join("；");
    if (!text) return [];
    return [{ id: `legacy:cta:${index}`, title: first(row, ["cta_type", "ctaType", "type"]) || "行动引导", text,
      evidenceIds: quote ? evidence.filter(source => source.text && (source.text.includes(quote) || quote.includes(source.text))).map(source => source.id) : [] }];
  });
  if (assessment) result.push({ id: "legacy:cta:assessment", title: "行动引导整体判断", text: assessment, evidenceIds: [] });
  return result;
}

/** A single presentation tree for each selected report; raw bodies stay intact. */
export function analysisReportView(schema: string, body: unknown): AnalysisReportView {
  const report = record(body) ?? {}, content = readContentAnalysis(body), unified = readUnifiedReport(body);
  const canonical = unified?.canonical;
  const scriptSet = record(report.spoken_script_set), corrected = record(scriptSet?.corrected_original) ?? record(scriptSet?.faithful_full);
  const script = canonical?.paragraphs ?? (texts(corrected?.paragraphs).length ? texts(corrected?.paragraphs) : texts(corrected?.text).length ? texts(corrected?.text) : texts(report.spoken_script));
  const scriptStatus = canonical?.status ?? (typeof corrected?.status === "string" ? corrected.status : script.length ? "historical" : "failed");
  const evidence: ContentEvidence[] = [...(content?.evidence_registry ?? [])];
  const legacyEvidence = Array.isArray(report.evidence) ? report.evidence : [];
  for (const [index, item] of legacyEvidence.entries()) {
    const row = record(item); if (!row || typeof row.text !== "string") continue;
    evidence.push({ id: `legacy:${index + 1}`, source: row.source === "ocr" || row.source === "vision" ? row.source : "transcript", text: row.text,
      start_ms: typeof row.start_ms === "number" ? row.start_ms : null, end_ms: typeof row.end_ms === "number" ? row.end_ms : null, asset_ref: null, frame_group_id: null });
  }
  const links = Array.isArray(report.insight_evidence) ? report.insight_evidence.map(record).filter(item => item !== null) : [];
  const sections = unifiedModuleKeys.map(key => {
    const sectionRecord = unified?.sections.find(row => row.key === key);
    const legacyState = content?.module_status[key];
    const classifications = legacyState?.status === "completed" && (!sectionRecord || sectionRecord.status === "completed")
      ? content!.classifications.filter(row => contentTaxonomyModule(row.dimension_id) === key).map(row => classificationView(row, key)) : [];
    const used = new Set<string>();
    const findings: ReportFindingView[] = sectionRecord ? sectionRecord.findings.map(row => ({ id: row.id, title: row.title, text: row.text, evidenceIds: row.evidence_ids })) :
      legacyGroups[key].flatMap(([field, title]) => texts(report[field]).flatMap((text, index) => {
        if (used.has(text)) return []; used.add(text);
        const references = links.filter(row => row.section === field && row.item_index === index).map(row => row.evidence_text);
        return [{ id: `legacy:${field}:${index}`, title, text, evidenceIds: evidence.filter(row => references.includes(row.text)).map(row => row.id) }];
      }));
    if (!sectionRecord && key === "text_expression_value") for (const finding of legacyCtaFindings(report, evidence)) {
      if (!used.has(finding.text)) { used.add(finding.text); findings.push(finding); }
    }
    const failure = sectionRecord?.diagnostics.failure_kind === "canonical_failed" ? "canonical_failed"
      : sectionRecord?.reason === "upstream_module_failed" ? "upstream_module_failed"
        : sectionRecord?.reason === "not_requested" ? "not_requested"
        : sectionRecord?.diagnostics.failure_kind || (sectionRecord?.status === "failed" ? sectionRecord.reason : legacyState?.status === "failed" ? legacyState.reason : null);
    return { key, name: reportModuleNames[key], status: sectionRecord?.status ?? (findings.length ? "historical" : legacyState?.status ?? "not_acquired"),
      reason: failure ? reportFailureNames[failure] || "本模块未完成" : sectionRecord?.status === "not_applicable" ? reportFailureNames[sectionRecord.reason || ""] || "本素材不适用这一项" : null, findings, classifications };
  });
  const meta = record(report.analysis_meta), audit = record(meta?.quality_audit);
  return { legacy: !unified, invalid: schema === "analysis.v11" && !unified,
    complete: schema === "analysis.v11" && !unified ? false : unified ? unified.status === "complete" : audit?.acceptance_passed === true,
    summary: unified?.summary || texts(report.summary).join("\n"), sections, script, scriptStatus,
    changes: canonical?.changes.map(row => ({ sourceId: row.source_segment_id, before: row.before, after: row.after, evidenceIds: row.evidence_ids })) ?? [],
    evidence, content, unified };
}

const dimensionModules = new Map(contentTaxonomy.dimensions.map(row => [row.id, row.module]));
const contentTaxonomyModule = (id: string) => dimensionModules.get(id);

export function unifiedReportMarkdown(title: string, view: AnalysisReportView, currentManuscript?: readonly string[]) {
  const status = view.invalid ? "报告尚未通过格式检查。" : view.legacy ? "历史分析报告。" : view.complete ? "分析已完成。" : "部分内容尚未完成，请结合各部分提示核对。";
  const lines = [`# ${title}`, "", status, "", view.summary, ""];
  if (currentManuscript?.length) lines.push("## 完整口播稿", "", "此处采用当前口播稿。下文分析与依据对应所选报告版本。", "",
    ...currentManuscript.flatMap(text => [text, ""]));
  else if (view.script.length) lines.push(view.scriptStatus === "failed" ? "## 待核对口播候选稿" : "## 完整口播稿", "",
    ...(view.scriptStatus === "failed" ? ["校正稿尚未通过核对，以下内容保留为候选稿。", ""] : []), ...view.script.flatMap(text => [text, ""]));
  const evidence = new Map(view.evidence.map(row => [row.id, row]));
  for (const section of view.sections) {
    lines.push(`## ${section.name}`, "");
    if (section.reason) lines.push(section.reason, "");
    for (const finding of section.findings) {
      lines.push(`### ${finding.title}`, "", finding.text, "");
      for (const id of finding.evidenceIds) {
        const row = evidence.get(id);
        if (row) lines.push(`> ${row.start_ms === null ? "时间未记录" : `${(row.start_ms / 1000).toFixed(3)}秒`} · ${row.text}`, "");
      }
    }
    if (section.classifications.length) {
      lines.push("### 内容分类", "", ...section.classifications.map(row => `- ${row.label}：${row.value}${row.reason ? `（${row.reason}）` : ""}`), "");
    }
  }
  return lines.join("\n");
}
