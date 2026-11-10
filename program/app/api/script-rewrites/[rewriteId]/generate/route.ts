import { readEffectiveModelRuntime } from "../../../../../lib/model-settings";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { parseModelJson } from "../../../../../lib/content-production";
import { invokeContentModel, ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../../lib/model-adapter";
import { checkOrganizationQuota } from "../../../../../lib/operations";
import {
  batchScriptUnits, buildRestructureLengthTargets, buildScriptUnits, compactRestructureOutline, estimateRewriteUsage, fallbackRestructureOutline, immutableRewriteFacts, mergeRewriteParagraphRows,
  isReviewableLightRewrite, normalizeRewriteText, readRewriteModelUsage, repairRestructureOutline, rewriteParagraphTargets, rewriteValidationQualityScore,
  rewriteVariantLabel, semanticRewriteFacts, SCRIPT_REWRITE_MAX_CHARACTERS,
  SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS, SCRIPT_REWRITE_MICRO_BATCH_UNITS, SCRIPT_REWRITE_PROMPT_VERSION, validateLightRewrite, validateRestructuredRewrite,
  validateRestructurePlan, validateRewriteFactCards, type RewriteFactCard, type RewriteOutlineSection, type RewriteParagraph, type RewriteValidation,
  type ScriptRewriteVariant, type ScriptUnit,
} from "../../../../../lib/script-rewrite";
import {
  EQUIVALENT_AUDITOR_PROMPT, EQUIVALENT_BODY_REPAIR_PROMPT, EQUIVALENT_FACT_EXTRACTOR_PROMPT,
  EQUIVALENT_FACT_REPAIR_PROMPT, EQUIVALENT_PLANNER_PROMPT, EQUIVALENT_SEMANTIC_REPAIR_PROMPT,
  EQUIVALENT_WRITER_PROMPT, MICRO_HOMOMORPHIC_AUDITOR_PROMPT, MICRO_HOMOMORPHIC_REPAIR_PROMPT,
  MICRO_HOMOMORPHIC_WRITER_PROMPT,
} from "../../../../../lib/script-rewrite-prompts";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const asRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

class RewriteContractError extends Error {
  constructor(message: string, readonly code: string, readonly validation: unknown = {}) { super(message); }
}

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
type TrackedCall = { id: string; provider: string; model: string; latencyMs: number; usage: Usage; json: unknown };
type GenerationResult = { text: string; paragraphs: string[]; sourceMapping: string[]; outline: RewriteOutlineSection[]; validation: RewriteValidation; calls: TrackedCall[] };
type GeneratedRewriteSection = { sectionId: string; factIds: string[]; paragraphs: string[] };
type RewriteSourceProfile = {
  theme: string;
  communicationPurpose: string;
  targetAudience: string;
  platformContext: string;
  tone: string;
  emotionIntensity: string;
  languageDifficulty: string;
  ctaType: string;
  productionNotes: string[];
};

function addUsage(total: Usage, next: Usage) {
  total.inputTokens += next.inputTokens; total.outputTokens += next.outputTokens; total.totalTokens += next.totalTokens;
}

async function invokeTrackedModel(input: {
  organizationId: string; projectId: string; userId: string; runId: string; taskType: string; system: string; payload: unknown; maxTokens: number; temperature: number;
}) {
  const quota = await checkOrganizationQuota(input.organizationId, input.userId, "modelCalls", 1);
  if (!quota.allowed) throw new RewriteContractError("当前月度模型调用额度已用完，未继续产生新的调用。", "MODEL_QUOTA_EXCEEDED", { current: quota.current, limit: quota.limit });
  const db = getD1(); const config = readContentModelConfig("max", await readEffectiveModelRuntime(input.organizationId)); const id = crypto.randomUUID(); const now = new Date().toISOString();
  const userJson = JSON.stringify(input.payload); const inputJson = JSON.stringify({ runId: input.runId, payload: input.payload }); const inputHash = await sha256Hex(new TextEncoder().encode(`${input.system}\n${userJson}`));
  await db.prepare(`INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'max', ?, 'started', ?, ?, ?, ?)`).bind(id, input.organizationId, input.projectId, input.taskType, config.provider, config.model, SCRIPT_REWRITE_PROMPT_VERSION, inputHash, inputJson, input.userId, now).run();
  let accumulatedLatencyMs = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const invocation = await invokeContentModel({ organizationId: input.organizationId, system: input.system, user: userJson, profile: "max", nativeJson: attempt === 0, temperature: input.temperature, maxTokens: input.maxTokens }, { config });
      accumulatedLatencyMs += invocation.latencyMs;
      let json: unknown;
      try {
        json = parseModelJson(invocation.content);
      } catch (reason) {
        throw new ModelRequestError(reason instanceof Error ? reason.message : "改写模型没有返回完整 JSON。", "INVALID_MODEL_OUTPUT");
      }
      const usage = readRewriteModelUsage(invocation.raw); const completedAt = new Date().toISOString();
      await db.prepare("UPDATE model_calls SET status = 'completed', output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(JSON.stringify({ response: json, usage }), accumulatedLatencyMs, completedAt, id, input.organizationId, input.projectId).run();
      return { id, provider: invocation.provider, model: invocation.model, latencyMs: accumulatedLatencyMs, usage, json } satisfies TrackedCall;
    } catch (error) {
      const retryable = attempt === 0 && error instanceof ModelRequestError
        && ["INVALID_MODEL_OUTPUT", "MODEL_OUTPUT_TRUNCATED", "MODEL_EMPTY_RESPONSE"].includes(error.code);
      if (retryable) continue;
      const code = error instanceof ModelRequestError ? error.code : "REWRITE_MODEL_RESPONSE_INVALID";
      await db.prepare("UPDATE model_calls SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(code, error instanceof Error ? error.message.slice(0, 1000) : "改写模型调用失败", new Date().toISOString(), id, input.organizationId, input.projectId).run();
      throw error;
    }
  }
  throw new ModelRequestError("改写模型两次都没有返回完整 JSON。", "INVALID_MODEL_OUTPUT");
}

function readParagraphRows(value: unknown): RewriteParagraph[] {
  const root = asRecord(value); const values = Array.isArray(root?.paragraphs) ? root.paragraphs : [];
  return values.flatMap((item) => {
    const row = asRecord(item); const paragraphId = clean(row?.paragraph_id ?? row?.paragraphId, 40); const text = clean(row?.text, SCRIPT_REWRITE_MAX_CHARACTERS);
    return paragraphId && text ? [{ paragraphId, text }] : [];
  });
}

function readFactCards(value: unknown): RewriteFactCard[] {
  const root = asRecord(value); const values = Array.isArray(root?.facts) ? root.facts : Array.isArray(root?.propositions) ? root.propositions : [];
  return values.flatMap((item, index) => {
    const row = asRecord(item); if (!row) return [];
    const idsValue = row.source_paragraph_ids ?? row.sourceParagraphIds; const sourceParagraphIds = Array.isArray(idsValue) ? idsValue.map((id) => clean(id, 40)).filter(Boolean) : [];
    const immutableValue = row.immutable_facts ?? row.immutableFacts; const immutableFacts = Array.isArray(immutableValue) ? immutableValue.map((fact) => clean(fact, 160)).filter(Boolean) : [];
    const factId = clean(row.fact_id ?? row.factId, 40) || "f-" + String(index + 1).padStart(3, "0");
    const statement = clean(row.statement, 1_500); const kind = clean(row.kind, 60) || "claim";
    return statement && sourceParagraphIds.length ? [{ factId, statement, kind, sourceParagraphIds, immutableFacts }] : [];
  });
}

function readSourceProfile(value: unknown): RewriteSourceProfile {
  const root = asRecord(value); const profile = asRecord(root?.profile ?? root?.writing_profile ?? root?.writingProfile);
  const notesValue = profile?.production_notes ?? profile?.productionNotes;
  return {
    theme: clean(profile?.theme, 300),
    communicationPurpose: clean(profile?.communication_purpose ?? profile?.communicationPurpose, 500),
    targetAudience: clean(profile?.target_audience ?? profile?.targetAudience, 500),
    platformContext: clean(profile?.platform_context ?? profile?.platformContext, 300),
    tone: clean(profile?.tone, 300),
    emotionIntensity: clean(profile?.emotion_intensity ?? profile?.emotionIntensity, 200),
    languageDifficulty: clean(profile?.language_difficulty ?? profile?.languageDifficulty, 200),
    ctaType: clean(profile?.cta_type ?? profile?.ctaType, 300),
    productionNotes: Array.isArray(notesValue) ? notesValue.map((item) => clean(item, 500)).filter(Boolean) : [],
  };
}

function mergeSourceProfiles(profiles: RewriteSourceProfile[]): RewriteSourceProfile {
  const merge = (selector: (profile: RewriteSourceProfile) => string, maximum: number) => [...new Set(profiles.map(selector).filter(Boolean))].join("；").slice(0, maximum);
  return {
    theme: merge((item) => item.theme, 500),
    communicationPurpose: merge((item) => item.communicationPurpose, 800),
    targetAudience: merge((item) => item.targetAudience, 800),
    platformContext: merge((item) => item.platformContext, 500),
    tone: merge((item) => item.tone, 500),
    emotionIntensity: merge((item) => item.emotionIntensity, 300),
    languageDifficulty: merge((item) => item.languageDifficulty, 300),
    ctaType: merge((item) => item.ctaType, 500),
    productionNotes: [...new Set(profiles.flatMap((item) => item.productionNotes))].slice(0, 100),
  };
}

function readOutline(value: unknown, facts: RewriteFactCard[]): RewriteOutlineSection[] {
  const root = asRecord(value); const values = Array.isArray(root?.outline) ? root.outline : Array.isArray(root?.sections) ? root.sections : [];
  const factSources = new Map(facts.map((item) => [item.factId, item.sourceParagraphIds]));
  return values.flatMap((item, index) => {
    const row = asRecord(item); if (!row) return [];
    const factsValue = row.fact_ids ?? row.factIds; const factIds = Array.isArray(factsValue) ? factsValue.map((id) => clean(id, 40)).filter(Boolean) : [];
    const sourceParagraphIds = [...new Set(factIds.flatMap((id) => factSources.get(id) ?? []))];
    const sectionId = clean(row.section_id ?? row.sectionId, 40) || `s-${String(index + 1).padStart(2, "0")}`;
    const title = clean(row.title, 160); const role = clean(row.role, 300);
    return title && role && factIds.length ? [{ sectionId, title, role, factIds, sourceParagraphIds }] : [];
  });
}

function readRestructuredSections(value: unknown) {
  const root = asRecord(value); const values = Array.isArray(root?.sections) ? root.sections : [];
  const sections: GeneratedRewriteSection[] = [];
  for (const item of values) {
    const row = asRecord(item); if (!row) continue;
    const sectionId = clean(row.section_id ?? row.sectionId, 40);
    const idsValue = row.fact_ids ?? row.factIds; const ids = Array.isArray(idsValue) ? idsValue.map((id) => clean(id, 40)).filter(Boolean) : [];
    const textValues = Array.isArray(row.paragraphs) ? row.paragraphs.map((text) => clean(text, 20_000)).filter(Boolean) : [];
    if (!sectionId || !ids.length || !textValues.length) continue;
    sections.push({ sectionId, factIds: ids, paragraphs: textValues });
  }
  return flattenGeneratedSections(sections);
}

function flattenGeneratedSections(sections: GeneratedRewriteSection[]) {
  return {
    sections,
    paragraphs: sections.flatMap((item) => item.paragraphs),
    factMapping: sections.flatMap((item) => item.factIds),
  };
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mergeGeneratedSections(outline: RewriteOutlineSection[], current: GeneratedRewriteSection[], replacements: GeneratedRewriteSection[]) {
  const currentById = new Map(current.map((item) => [item.sectionId, item]));
  const replacementById = new Map(replacements.map((item) => [item.sectionId, item]));
  return outline.flatMap((section) => {
    const replacement = replacementById.get(section.sectionId);
    if (replacement && sameIds(replacement.factIds, section.factIds)) return [replacement];
    const existing = currentById.get(section.sectionId);
    return existing && sameIds(existing.factIds, section.factIds) ? [existing] : [];
  });
}

function completeGeneratedSections(outline: RewriteOutlineSection[], facts: RewriteFactCard[], generated: GeneratedRewriteSection[]) {
  const generatedById = new Map(generated.map((item) => [item.sectionId, item]));
  const factById = new Map(facts.map((item) => [item.factId, item]));
  return outline.map((section) => {
    const existing = generatedById.get(section.sectionId);
    if (existing && sameIds(existing.factIds, section.factIds) && existing.paragraphs.some((item) => clean(item, SCRIPT_REWRITE_MAX_CHARACTERS))) {
      return existing;
    }
    const statements = section.factIds.flatMap((factId) => {
      const fact = factById.get(factId);
      if (!fact) return [];
      const missingProtected = fact.immutableFacts.filter((item) => item && !semanticRewriteFacts(fact.statement).includes(item.toLocaleLowerCase("zh-CN")));
      const suffix = missingProtected.length ? ` 关键信息：${missingProtected.join("、")}。` : "";
      return [`${fact.statement.replace(/[。！？!?；;]+$/u, "")}。${suffix}`];
    });
    return { sectionId: section.sectionId, factIds: section.factIds, paragraphs: [statements.join("")] };
  });
}

function batchRepairSections(sections: RewriteOutlineSection[], targetById: Map<string, { target_characters: number }>) {
  const batches: RewriteOutlineSection[][] = [];
  let current: RewriteOutlineSection[] = [];
  let targetCharacters = 0;
  for (const section of sections) {
    const nextTarget = targetById.get(section.sectionId)?.target_characters ?? 0;
    if (current.length && (current.length >= 2 || targetCharacters + nextTarget > 760)) {
      batches.push(current);
      current = [];
      targetCharacters = 0;
    }
    current.push(section);
    targetCharacters += nextTarget;
  }
  if (current.length) batches.push(current);
  return batches;
}

function sectionQuality(input: {
  section: GeneratedRewriteSection | undefined;
  outline: RewriteOutlineSection;
  target: { target_characters: number; minimum_characters: number; maximum_characters: number };
  facts: RewriteFactCard[];
  forbiddenSpans: string[];
}) {
  const section = input.section;
  if (!section || !sameIds(section.factIds, input.outline.factIds)) return -1_000_000;
  const text = section.paragraphs.join("\n");
  const characters = normalizeRewriteText(text).length;
  const expectedFacts = new Set(semanticRewriteFacts(input.facts.map((item) => `${item.statement}\n${item.immutableFacts.join("\n")}`).join("\n")));
  const actualFacts = new Set(semanticRewriteFacts(text));
  const missing = [...expectedFacts].filter((item) => !actualFacts.has(item)).length;
  const unexpected = [...actualFacts].filter((item) => !expectedFacts.has(item)).length;
  const copied = input.forbiddenSpans.filter((span) => normalizeRewriteText(span) && normalizeRewriteText(text).includes(normalizeRewriteText(span))).length;
  const insideTarget = characters >= input.target.minimum_characters && characters <= input.target.maximum_characters;
  return (insideTarget ? 20_000 : 0)
    - Math.abs(characters - input.target.target_characters) * 10
    - missing * 100_000
    - unexpected * 100_000
    - copied * 50_000;
}

function readRetentionPercent(value: unknown) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
}

function readLightAudit(value: unknown): NonNullable<RewriteValidation["semanticAudit"]> {
  const root = asRecord(value);
  const missingValue = root?.missing_paragraph_ids ?? root?.missingParagraphIds;
  const problemValue = root?.problem_paragraph_ids ?? root?.problemParagraphIds ?? root?.issue_paragraph_ids ?? root?.issueParagraphIds;
  const addedValue = root?.added_claims ?? root?.addedClaims; const notesValue = root?.notes;
  const missingFactIds = Array.isArray(missingValue) ? missingValue.map((item) => clean(item, 80)).filter(Boolean) : [];
  const problemParagraphIds = Array.isArray(problemValue) ? problemValue.map((item) => clean(item, 80)).filter(Boolean) : [];
  const addedClaims = Array.isArray(addedValue) ? addedValue.map((item) => clean(item, 400)).filter(Boolean) : [];
  const notes = Array.isArray(notesValue) ? notesValue.map((item) => clean(item, 400)).filter(Boolean) : [];
  const coreInformationRetention = readRetentionPercent(root?.core_information_retention ?? root?.coreInformationRetention);
  const structureAligned = root?.structure_aligned === true || root?.structureAligned === true;
  const styleAligned = root?.style_aligned === true || root?.styleAligned === true;
  const conclusionAligned = root?.conclusion_aligned === true || root?.conclusionAligned === true;
  const productionNotesPreserved = root?.production_notes_preserved === true || root?.productionNotesPreserved === true;
  const risk = clean(root?.copy_risk ?? root?.copyRisk, 20); const copyRisk = risk === "low" || risk === "medium" ? risk : "high";
  const passed = missingFactIds.length === 0 && problemParagraphIds.length === 0 && addedClaims.length === 0 && coreInformationRetention >= 90
    && structureAligned && styleAligned && conclusionAligned && productionNotesPreserved && copyRisk === "low";
  return {
    passed, missingFactIds, problemParagraphIds, addedClaims, structureRebuilt: false, copyRisk, notes, coreInformationRetention,
    structureAligned, styleAligned, conclusionAligned, productionNotesPreserved,
  };
}

function readRestructureAudit(value: unknown): NonNullable<RewriteValidation["semanticAudit"]> {
  const root = asRecord(value);
  const missingValue = root?.missing_fact_ids ?? root?.missingFactIds; const addedValue = root?.added_claims ?? root?.addedClaims; const notesValue = root?.notes;
  const missingFactIds = Array.isArray(missingValue) ? missingValue.map((item) => clean(item, 80)).filter(Boolean) : [];
  const addedClaims = Array.isArray(addedValue) ? addedValue.map((item) => clean(item, 400)).filter(Boolean) : [];
  const notes = Array.isArray(notesValue) ? notesValue.map((item) => clean(item, 400)).filter(Boolean) : [];
  const structureRebuilt = root?.structure_rebuilt === true || root?.structureRebuilt === true;
  const coreInformationRetention = readRetentionPercent(root?.core_information_retention ?? root?.coreInformationRetention);
  const purposePreserved = root?.purpose_preserved === true || root?.purposePreserved === true;
  const conclusionAligned = root?.conclusion_preserved === true || root?.conclusionPreserved === true;
  const styleAligned = root?.style_aligned === true || root?.styleAligned === true;
  const productionNotesPreserved = root?.production_notes_preserved === true || root?.productionNotesPreserved === true;
  const logicCoherent = root?.logic_coherent === true || root?.logicCoherent === true;
  const riskExpanded = root?.risk_expanded === true || root?.riskExpanded === true;
  const risk = clean(root?.copy_risk ?? root?.copyRisk, 20); const copyRisk = risk === "low" || risk === "medium" ? risk : "high";
  const passed = missingFactIds.length === 0 && addedClaims.length === 0 && coreInformationRetention >= 90
    && purposePreserved && conclusionAligned && styleAligned && productionNotesPreserved && logicCoherent
    && !riskExpanded && structureRebuilt && copyRisk === "low";
  return {
    passed, missingFactIds, addedClaims, structureRebuilt, copyRisk, notes, coreInformationRetention,
    purposePreserved, conclusionAligned, styleAligned, productionNotesPreserved, logicCoherent, riskExpanded,
  };
}

function withLightSemanticAudit(deterministic: RewriteValidation, audit: NonNullable<RewriteValidation["semanticAudit"]>): RewriteValidation {
  const auditChecks: RewriteValidation["checks"] = [
    { key: "semantic_coverage", label: "核心信息保留度不低于 90%", passed: audit.missingFactIds.length === 0 && (audit.coreInformationRetention ?? 0) >= 90, value: `${audit.coreInformationRetention ?? 0}%` },
    { key: "no_added_claims", label: "语义审计确认无新增主张", passed: audit.addedClaims.length === 0, value: audit.addedClaims.length },
    { key: "homomorphic_structure", label: "段落功能、顺序与逻辑保持同构", passed: audit.structureAligned === true, value: audit.structureAligned ? "对齐" : "漂移" },
    { key: "style_alignment", label: "语气、节奏与平台风格对齐", passed: audit.styleAligned === true, value: audit.styleAligned ? "对齐" : "漂移" },
    { key: "conclusion_alignment", label: "原稿结论保持不变", passed: audit.conclusionAligned === true, value: audit.conclusionAligned ? "一致" : "不一致" },
    { key: "production_notes", label: "必要制作信息已保留", passed: audit.productionNotesPreserved === true, value: audit.productionNotesPreserved ? "完整" : "有遗漏" },
    { key: "semantic_copy_risk", label: "语义审计未发现照搬风险", passed: audit.copyRisk === "low", value: audit.copyRisk },
  ];
  return { ...deterministic, passed: deterministic.passed && audit.passed, checks: [...deterministic.checks, ...auditChecks], semanticAudit: audit };
}

function withSemanticAudit(deterministic: RewriteValidation, audit: NonNullable<RewriteValidation["semanticAudit"]>): RewriteValidation {
  const auditChecks: RewriteValidation["checks"] = [
    { key: "semantic_coverage", label: "核心信息保留度不低于 90%", passed: audit.missingFactIds.length === 0 && (audit.coreInformationRetention ?? 0) >= 90, value: `${audit.coreInformationRetention ?? 0}%` },
    { key: "no_added_claims", label: "语义审计确认无新增主张", passed: audit.addedClaims.length === 0, value: audit.addedClaims.length },
    { key: "purpose_and_conclusion", label: "传播目的与结论保持不变", passed: audit.purposePreserved === true && audit.conclusionAligned === true, value: audit.purposePreserved && audit.conclusionAligned ? "一致" : "有偏移" },
    { key: "style_and_logic", label: "风格对齐且逻辑连贯", passed: audit.styleAligned === true && audit.logicCoherent === true, value: audit.styleAligned && audit.logicCoherent ? "通过" : "未通过" },
    { key: "production_notes", label: "必要制作信息已保留", passed: audit.productionNotesPreserved === true, value: audit.productionNotesPreserved ? "完整" : "有遗漏" },
    { key: "risk_control", label: "未扩大原稿事实风险", passed: audit.riskExpanded === false, value: audit.riskExpanded ? "已扩大" : "未扩大" },
    { key: "independent_narrative", label: "模型复核为独立叙事结构", passed: audit.structureRebuilt && audit.copyRisk === "low", value: audit.copyRisk },
  ];
  return { ...deterministic, passed: deterministic.passed && audit.passed, checks: [...deterministic.checks, ...auditChecks], semanticAudit: audit };
}

function withUnavailableSemanticAudit(deterministic: RewriteValidation, error: unknown): RewriteValidation {
  const message = error instanceof Error ? error.message.slice(0, 300) : "语义审计暂不可用";
  return {
    ...deterministic,
    passed: false,
    checks: [...deterministic.checks, { key: "semantic_audit", label: "语义审计可用", passed: false, value: "待人工复核" }],
    semanticAudit: {
      passed: false,
      missingFactIds: [],
      addedClaims: [],
      structureRebuilt: validationCheckPassed(deterministic, "structure"),
      copyRisk: "medium",
      notes: [`审计调用未完成，已保留当前最佳正文：${message}`],
    },
  };
}

function paragraphTargetPayload(units: ScriptUnit[]) {
  return rewriteParagraphTargets(units).map((target) => ({
    paragraph_id: target.paragraphId,
    source_characters: target.sourceCharacters,
    minimum_characters: target.minimumCharacters,
    maximum_characters: target.maximumCharacters,
  }));
}

function deterministicFailurePayload(validation: RewriteValidation, units: ScriptUnit[]) {
  return {
    failed_checks: validation.checks.filter((item) => !item.passed),
    source_normalized_characters: rewriteParagraphTargets(units).reduce((sum, item) => sum + item.sourceCharacters, 0),
    candidate_to_source_length_ratio: validation.lengthRatio,
    missing_immutable_facts: validation.missingImmutableFacts,
    unexpected_immutable_facts: validation.unexpectedImmutableFacts ?? [],
    copied_paragraph_ids: (validation.copiedParagraphIndexes ?? []).map((index) => units[index]?.paragraphId).filter(Boolean),
    forbidden_copied_spans: validation.copiedSpans ?? [],
  };
}

function validationCheckPassed(validation: RewriteValidation, key: string) {
  return validation.checks.find((item) => item.key === key)?.passed === true;
}

function isReviewableDraft(validation: RewriteValidation, variant: ScriptRewriteVariant) {
  if (variant === "light_rewrite") {
    // A usable micro rewrite should not disappear merely because its length is
    // slightly outside the preferred 90%-110% band. Keep the preferred band as
    // a visible quality check, but save drafts that preserve facts/mapping and
    // contain no copied paragraph so the user can review them.
    return isReviewableLightRewrite(validation);
  }
  // Once every fact-card slot is present in the generated body and the approved
  // new outline was followed, the body is saveable. Numeric drift, length,
  // originality and audit findings remain visible quality checks and mark the
  // version for review; they never make already-generated content disappear.
  const required = ["content", "coverage", "plan_execution", "structure"];
  return required.every((key) => validationCheckPassed(validation, key));
}

function factLedgerQualityScore(validation: ReturnType<typeof validateRewriteFactCards>) {
  const passedChecks = validation.checks.filter((item) => item.passed).length;
  return passedChecks * 1_000
    - validation.missingImmutableFacts.length * 200
    + validation.detailRatio * 100
    - validation.leakingFactIds.length;
}

async function generateLightRewrite(scope: { organizationId: string; projectId: string; userId: string; runId: string }, units: ScriptUnit[]): Promise<GenerationResult> {
  const sourceParagraphs = units.map((item) => ({ paragraph_id: item.paragraphId, text: item.text }));
  const calls: TrackedCall[] = [];
  const outline = units.map((item, index) => ({
    sectionId: `s-${String(index + 1).padStart(2, "0")}`,
    title: `对应原稿第 ${index + 1} 段`,
    role: "保持原段落的叙事功能、顺序与节奏",
    factIds: [],
    sourceParagraphIds: [item.paragraphId],
  }));
  const batches = batchScriptUnits(units, SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS, SCRIPT_REWRITE_MICRO_BATCH_UNITS);
  let rows: RewriteParagraph[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchText = batch.map((item) => item.text).join("\n\n");
    const batchSourceParagraphs = batch.map((item) => ({ paragraph_id: item.paragraphId, text: item.text }));
    const bodyCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_micro_homomorphic_body_batch", temperature: 0.55,
      maxTokens: Math.min(13_000, Math.max(1_500, Math.ceil(batchText.length * 1.15) + 1_000)),
      system: MICRO_HOMOMORPHIC_WRITER_PROMPT,
      payload: {
        task: "write_micro_homomorphic_script_batch",
        batch: { index: index + 1, count: batches.length },
        target_length_ratio: "0.90-1.10",
        paragraph_targets: paragraphTargetPayload(batch),
        immutable_facts: immutableRewriteFacts(batchText),
        source_paragraphs: batchSourceParagraphs,
      },
    });
    calls.push(bodyCall);
    let batchRows = readParagraphRows(bodyCall.json);
    let batchValidation = validateLightRewrite(batch, batchRows);
    for (let attempt = 1; attempt <= 2 && !batchValidation.passed; attempt += 1) {
      const repairCall = await invokeTrackedModel({
        ...scope,
        taskType: attempt === 1 ? "script_rewrite_micro_homomorphic_batch_repair" : "script_rewrite_micro_homomorphic_batch_repair_retry",
        temperature: attempt === 1 ? 0.72 : 0.82,
        maxTokens: Math.min(13_000, Math.max(1_800, Math.ceil(batchText.length * 1.15) + 1_200)),
        system: MICRO_HOMOMORPHIC_REPAIR_PROMPT,
        payload: {
          task: "repair_micro_homomorphic_batch_without_regression",
          submitted_attempt: attempt,
          batch: { index: index + 1, count: batches.length },
          ...deterministicFailurePayload(batchValidation, batch),
          paragraph_targets: paragraphTargetPayload(batch),
          immutable_facts: immutableRewriteFacts(batchText),
          best_draft: batchRows.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
          rejected_draft: batchRows.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
          source_paragraphs: batchSourceParagraphs,
        },
      });
      calls.push(repairCall);
      const candidateRows = readParagraphRows(repairCall.json);
      const candidateValidation = validateLightRewrite(batch, candidateRows);
      if (candidateValidation.passed || rewriteValidationQualityScore(candidateValidation) > rewriteValidationQualityScore(batchValidation)) {
        batchRows = candidateRows;
        batchValidation = candidateValidation;
      }
    }
    if (!batchValidation.passed && !isReviewableDraft(batchValidation, "light_rewrite")) {
      throw new RewriteContractError(`微调同构第 ${index + 1} 批修订后仍未通过段落映射、逐段篇幅、事实或防照搬硬校验。`, "LIGHT_VALIDATION_FAILED", batchValidation);
    }
    rows = mergeRewriteParagraphRows(units, rows, batchRows);
  }
  let deterministicValidation = validateLightRewrite(units, rows);
  if (!deterministicValidation.passed && !isReviewableDraft(deterministicValidation, "light_rewrite")) {
    throw new RewriteContractError("微调同构分批合并后未通过全稿篇幅、事实或防照搬硬校验。", "LIGHT_VALIDATION_FAILED", deterministicValidation);
  }
  const auditPayload = (candidateRows: RewriteParagraph[]) => ({
    task: "audit_micro_homomorphic_script",
    source_paragraphs: sourceParagraphs,
    candidate_paragraphs: candidateRows.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
  });
  let auditCall: TrackedCall;
  try {
    auditCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_micro_homomorphic_audit", temperature: 0,
      maxTokens: Math.min(3_000, Math.max(1_000, units.length * 160 + 700)),
      system: MICRO_HOMOMORPHIC_AUDITOR_PROMPT,
      payload: auditPayload(rows),
    });
  } catch (error) {
    const validation = withUnavailableSemanticAudit(deterministicValidation, error);
    const paragraphs = rows.map((item) => item.text);
    return { text: paragraphs.join("\n\n"), paragraphs, sourceMapping: rows.map((item) => item.paragraphId), outline, validation, calls };
  }
  calls.push(auditCall);
  let audit = readLightAudit(auditCall.json);
  let validation = withLightSemanticAudit(deterministicValidation, audit);
  if (!validation.passed && !audit.passed) {
    const knownIds = new Set(units.map((item) => item.paragraphId));
    const repairIds = [...new Set([...(audit.problemParagraphIds ?? []), ...audit.missingFactIds])].filter((id) => knownIds.has(id));
    if (!repairIds.length && !isReviewableDraft(deterministicValidation, "light_rewrite")) {
      throw new RewriteContractError("微调同构语义审计未通过，但审计结果没有定位到具体段落，系统未重写整篇合格初稿。", "LIGHT_AUDIT_LOCATION_MISSING", validation);
    }
    if (repairIds.length) {
      const repairIdSet = new Set(repairIds);
      const repairUnits = units.filter((item) => repairIdSet.has(item.paragraphId));
      const repairSourceText = repairUnits.map((item) => item.text).join("\n\n");
      const rejectedRows = rows.filter((item) => repairIdSet.has(item.paragraphId));
      const rejectedTargetValidation = validateLightRewrite(repairUnits, rejectedRows);
      const repairCall = await invokeTrackedModel({
        ...scope, taskType: "script_rewrite_micro_homomorphic_repair", temperature: 0.72,
        maxTokens: Math.min(13_000, Math.max(1_800, Math.ceil(repairSourceText.length * 1.15) + 1_200)),
        system: MICRO_HOMOMORPHIC_REPAIR_PROMPT,
        payload: {
          task: "repair_only_audit_problem_paragraphs",
          submitted_attempt: 1,
          ...deterministicFailurePayload(rejectedTargetValidation, repairUnits),
          failed_semantic_checks: validation.checks.filter((item) => !item.passed),
          audit: {
            missing_paragraph_ids: audit.missingFactIds,
            problem_paragraph_ids: repairIds,
            added_claims: audit.addedClaims,
            copy_risk: audit.copyRisk,
            notes: audit.notes,
          },
          paragraph_targets: paragraphTargetPayload(repairUnits),
          immutable_facts: immutableRewriteFacts(repairSourceText),
          best_draft: rejectedRows.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
          rejected_draft: rejectedRows.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
          source_paragraphs: repairUnits.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })),
        },
      });
      calls.push(repairCall);
      const repairedRows = readParagraphRows(repairCall.json);
      const candidateRows = mergeRewriteParagraphRows(units, rows, repairedRows);
      const candidateValidation = validateLightRewrite(units, candidateRows);
      if (candidateValidation.passed || rewriteValidationQualityScore(candidateValidation) > rewriteValidationQualityScore(deterministicValidation)) {
        rows = candidateRows;
        deterministicValidation = candidateValidation;
        try {
          auditCall = await invokeTrackedModel({
            ...scope, taskType: "script_rewrite_micro_homomorphic_audit_retry", temperature: 0,
            maxTokens: Math.min(3_000, Math.max(1_000, units.length * 160 + 700)),
            system: MICRO_HOMOMORPHIC_AUDITOR_PROMPT,
            payload: auditPayload(rows),
          });
          calls.push(auditCall);
          audit = readLightAudit(auditCall.json);
          validation = withLightSemanticAudit(deterministicValidation, audit);
        } catch (error) {
          validation = withUnavailableSemanticAudit(deterministicValidation, error);
        }
      }
    }
  }
  if (!validation.passed && !isReviewableDraft(deterministicValidation, "light_rewrite")) throw new RewriteContractError("微调同构未通过信息保真、结构同构、风格对齐或原创表达验收。", "LIGHT_VALIDATION_FAILED", validation);
  const paragraphs = rows.map((item) => item.text);
  const sourceMapping = rows.map((item) => item.paragraphId);
  return { text: paragraphs.join("\n\n"), paragraphs, sourceMapping, outline, validation, calls };
}

async function generateRestructuredRewrite(scope: { organizationId: string; projectId: string; userId: string; runId: string }, units: ScriptUnit[]): Promise<GenerationResult> {
  const sourceText = units.map((item) => item.text).join("\n\n");
  const factCalls: TrackedCall[] = []; const profileParts: RewriteSourceProfile[] = []; let facts: RewriteFactCard[] = []; const factBatches = batchScriptUnits(units, 5_000, 12);
  for (let index = 0; index < factBatches.length; index += 1) {
    const batch = factBatches[index]; const batchText = batch.map((item) => item.text).join("\n\n");
    const batchCharacters = normalizeRewriteText(batchText).length;
    const factCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_restructure_facts_batch", temperature: 0.1,
      maxTokens: Math.min(8_000, Math.max(4_000, Math.ceil(batchText.length * 1.5) + 2_000)),
      system: EQUIVALENT_FACT_EXTRACTOR_PROMPT,
      payload: { task: "extract_equivalent_content_facts", batch: { index: index + 1, count: factBatches.length }, detail_target: { source_characters: batchCharacters, minimum_ledger_characters: Math.ceil(batchCharacters * (batchCharacters >= 1_000 ? 0.45 : 0.3)) }, immutable_facts: semanticRewriteFacts(batchText), source_paragraphs: batch.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })) },
    });
    factCalls.push(factCall);
    profileParts.push(readSourceProfile(factCall.json));
    for (const fact of readFactCards(factCall.json)) facts.push({ ...fact, factId: "f-" + String(facts.length + 1).padStart(3, "0") });
  }
  let sourceProfile = mergeSourceProfiles(profileParts);
  let factValidation = validateRewriteFactCards(units, facts);
  if (!factValidation.passed) {
    const repairCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_restructure_facts_abstraction_repair", temperature: 0.25,
      maxTokens: Math.min(13_000, Math.max(2_500, facts.length * 180 + 1_500)),
      system: EQUIVALENT_FACT_REPAIR_PROMPT,
      payload: { task: "repair_semantic_fact_ledger", failed_checks: factValidation.checks.filter((item) => !item.passed), missing_immutable_facts: factValidation.missingImmutableFacts, detail_target: { source_characters: normalizeRewriteText(sourceText).length, minimum_ledger_characters: Math.ceil(normalizeRewriteText(sourceText).length * (normalizeRewriteText(sourceText).length >= 1_000 ? 0.45 : 0.3)) }, source_profile: sourceProfile, rejected_facts: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, source_paragraph_ids: item.sourceParagraphIds, immutable_facts: item.immutableFacts })), source_paragraphs: units.map((item) => ({ paragraph_id: item.paragraphId, text: item.text })) },
    });
    factCalls.push(repairCall);
    const repairedFacts = readFactCards(repairCall.json);
    const repairedFactValidation = validateRewriteFactCards(units, repairedFacts);
    if (repairedFactValidation.passed || factLedgerQualityScore(repairedFactValidation) > factLedgerQualityScore(factValidation)) {
      facts = repairedFacts;
      factValidation = repairedFactValidation;
      sourceProfile = mergeSourceProfiles([sourceProfile, readSourceProfile(repairCall.json)]);
    }
  }
  if (!factValidation.passed) throw new RewriteContractError("内容等价重构的命题清单不完整，未继续生成正文。", "RESTRUCTURE_FACTS_INVALID", factValidation);
  const planCalls: TrackedCall[] = [];
  let outline: RewriteOutlineSection[] = [];
  try {
    const planCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_restructure_plan", temperature: 0.35, maxTokens: Math.min(7_000, Math.max(1_500, facts.length * 220 + 1_200)),
      system: EQUIVALENT_PLANNER_PROMPT,
      payload: { task: "design_new_narrative_architecture", source_profile: sourceProfile, requirements: { useEveryFactExactlyOnce: true, preserveMeaning: true, rebuildOpeningArgumentAndEnding: true }, facts: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })) },
    });
    planCalls.push(planCall);
    outline = readOutline(planCall.json, facts);
  } catch {
    // A deterministic reordered outline below keeps the content pipeline alive.
  }
  let planValidation = validateRestructurePlan(units, facts, outline);
  if (!planValidation.passed) {
    try {
      const planRepairCall = await invokeTrackedModel({
        ...scope, taskType: "script_rewrite_restructure_plan_repair", temperature: 0.55,
        maxTokens: Math.min(7_000, Math.max(1_800, facts.length * 240 + 1_400)),
        system: `${EQUIVALENT_PLANNER_PROMPT}\n上一份提纲没有实质改变开场、命题顺序或组合方式。请根据 failed_checks 重新设计，不能只把原顺序分组或交换相邻命题。`,
        payload: { task: "repair_new_narrative_architecture", failed_checks: planValidation.checks, source_profile: sourceProfile, rejected_outline: outline.map((item) => ({ section_id: item.sectionId, title: item.title, role: item.role, fact_ids: item.factIds })), facts: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })) },
      });
      planCalls.push(planRepairCall);
      outline = readOutline(planRepairCall.json, facts);
      if (outline.length) outline = repairRestructureOutline(facts, outline);
      planValidation = validateRestructurePlan(units, facts, outline);
    } catch {
      // The deterministic fallback below is the final plan recovery path.
    }
  }
  if (!planValidation.passed) {
    outline = fallbackRestructureOutline(facts);
    planValidation = validateRestructurePlan(units, facts, outline);
  }
  if (!planValidation.passed) throw new RewriteContractError("内容等价重构提纲无法覆盖完整命题。", "RESTRUCTURE_PLAN_INVALID", planValidation);
  outline = compactRestructureOutline(facts, outline, 8);
  planValidation = validateRestructurePlan(units, facts, outline);
  if (!planValidation.passed) {
    outline = fallbackRestructureOutline(facts);
    planValidation = validateRestructurePlan(units, facts, outline);
  }
  if (!planValidation.passed) throw new RewriteContractError("内容等价重构提纲无法覆盖完整命题。", "RESTRUCTURE_PLAN_INVALID", planValidation);
  const lengthTargets = buildRestructureLengthTargets(sourceText, facts, outline);
  const lengthTargetPayload = {
    source_characters: lengthTargets.sourceCharacters,
    target_characters: lengthTargets.targetCharacters,
    minimum_characters: lengthTargets.minimumCharacters,
    maximum_characters: lengthTargets.maximumCharacters,
  };
  const sectionTargetPayload = lengthTargets.sections.map((item) => ({ section_id: item.sectionId, target_characters: item.targetCharacters, minimum_characters: item.minimumCharacters, maximum_characters: item.maximumCharacters }));
  const verbatimRiskSpans = facts.filter((item) => factValidation.leakingFactIds.includes(item.factId)).map((item) => item.statement);
  const bodyCall = await invokeTrackedModel({
    ...scope, taskType: "script_rewrite_restructure_body", temperature: 0.6,
    maxTokens: Math.min(13_000, Math.max(1_800, Math.ceil(sourceText.length * 1.25) + 1_200)),
    system: EQUIVALENT_WRITER_PROMPT,
    payload: { task: "write_equivalent_content_from_fact_ledger", source_profile: sourceProfile, target: { acceptedLengthRatio: "0.5-1.25", preferredLengthRatio: "0.8-1.05", spokenNaturalness: "strong", independentStructure: true }, length_target: lengthTargetPayload, section_targets: sectionTargetPayload, verbatim_risk_fact_ids: factValidation.leakingFactIds, forbidden_copied_spans: verbatimRiskSpans, outline: outline.map((item) => ({ section_id: item.sectionId, title: item.title, role: item.role, fact_ids: item.factIds })), facts: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })) },
  });
  const generationCalls = [...factCalls, ...planCalls, bodyCall];
  const generatedBody = readRestructuredSections(bodyCall.json);
  let body = flattenGeneratedSections(completeGeneratedSections(outline, facts, generatedBody.sections));
  let deterministicValidation = validateRestructuredRewrite(units, facts, body.paragraphs, body.factMapping, outline);
  const targetById = new Map(sectionTargetPayload.map((item) => [item.section_id, item]));
  const factById = new Map(facts.map((item) => [item.factId, item]));
  for (let attempt = 1; attempt <= 2 && !deterministicValidation.passed; attempt += 1) {
    const currentById = new Map(body.sections.map((item) => [item.sectionId, item]));
    const forbiddenSpans = [...new Set([...verbatimRiskSpans, ...(deterministicValidation.copiedSpans ?? [])])];
    const repairOutline = outline.filter((section) => {
      const current = currentById.get(section.sectionId);
      const target = targetById.get(section.sectionId);
      if (!current || !target || !sameIds(current.factIds, section.factIds)) return true;
      const text = current.paragraphs.join("\n");
      const characters = normalizeRewriteText(text).length;
      const expectedFacts = new Set(semanticRewriteFacts(section.factIds.map((id) => {
        const fact = factById.get(id);
        return fact ? `${fact.statement}\n${fact.immutableFacts.join("\n")}` : "";
      }).join("\n")));
      const actualFacts = new Set(semanticRewriteFacts(text));
      const numericDrift = [...expectedFacts].some((item) => !actualFacts.has(item)) || [...actualFacts].some((item) => !expectedFacts.has(item));
      const copied = forbiddenSpans.some((span) => normalizeRewriteText(span) && normalizeRewriteText(text).includes(normalizeRewriteText(span)));
      return characters < target.minimum_characters || characters > target.maximum_characters || numericDrift || copied;
    });
    if (!repairOutline.length) break;
    let acceptedAny = false;
    let repairUnavailable = false;
    for (const repairBatch of batchRepairSections(repairOutline, targetById)) {
      const repairSectionIds = new Set(repairBatch.map((item) => item.sectionId));
      const currentSections = body.sections.filter((item) => repairSectionIds.has(item.sectionId));
      const repairFactIds = new Set(repairBatch.flatMap((item) => item.factIds));
      const repairFacts = facts.filter((item) => repairFactIds.has(item.factId));
      const repairTargets = repairBatch.flatMap((item) => {
        const target = targetById.get(item.sectionId);
        return target ? [target] : [];
      });
      const repairLengthTarget = {
        source_characters: repairTargets.reduce((sum, item) => sum + item.target_characters, 0),
        target_characters: repairTargets.reduce((sum, item) => sum + item.target_characters, 0),
        minimum_characters: repairTargets.reduce((sum, item) => sum + item.minimum_characters, 0),
        maximum_characters: repairTargets.reduce((sum, item) => sum + item.maximum_characters, 0),
      };
      let repairCall: TrackedCall;
      try {
        repairCall = await invokeTrackedModel({
          ...scope,
          taskType: attempt === 1 ? "script_rewrite_restructure_section_repair" : "script_rewrite_restructure_section_repair_retry",
          temperature: attempt === 1 ? 0.68 : 0.78,
          maxTokens: Math.min(6_000, Math.max(1_600, Math.ceil(repairLengthTarget.target_characters * 1.8) + 900)),
          system: EQUIVALENT_BODY_REPAIR_PROMPT,
          payload: {
            task: "repair_equivalent_sections",
            submitted_attempt: attempt,
            source_profile: sourceProfile,
            failed_checks: deterministicValidation.checks.filter((item) => !item.passed),
            forbidden_copied_spans: forbiddenSpans,
            length_target: repairLengthTarget,
            section_targets: repairTargets,
            repair_sections: repairBatch.map((item) => ({ section_id: item.sectionId, title: item.title, role: item.role, fact_ids: item.factIds })),
            facts: repairFacts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })),
            current_sections: currentSections.map((item) => ({ section_id: item.sectionId, fact_ids: item.factIds, paragraphs: item.paragraphs })),
            best_draft: { sections: currentSections.map((item) => ({ section_id: item.sectionId, fact_ids: item.factIds, paragraphs: item.paragraphs })) },
            rejected_draft: { sections: currentSections.map((item) => ({ section_id: item.sectionId, fact_ids: item.factIds, paragraphs: item.paragraphs })) },
          },
        });
      } catch {
        // The original body is already available. A failed optional repair must
        // never erase it or turn an otherwise reviewable version into a failed run.
        repairUnavailable = true;
        break;
      }
      generationCalls.push(repairCall);
      const candidate = readRestructuredSections(repairCall.json);
      const candidateById = new Map(candidate.sections.map((item) => [item.sectionId, item]));
      const replacements: GeneratedRewriteSection[] = [];
      for (const section of repairBatch) {
        const target = targetById.get(section.sectionId);
        if (!target) continue;
        const sectionFacts = section.factIds.flatMap((id) => {
          const fact = factById.get(id);
          return fact ? [fact] : [];
        });
        const candidateSection = candidateById.get(section.sectionId);
        const currentSection = currentById.get(section.sectionId);
        const candidateScore = sectionQuality({ section: candidateSection, outline: section, target, facts: sectionFacts, forbiddenSpans });
        const currentScore = sectionQuality({ section: currentSection, outline: section, target, facts: sectionFacts, forbiddenSpans });
        if (candidateSection && candidateScore > currentScore) replacements.push(candidateSection);
      }
      if (replacements.length) {
        body = flattenGeneratedSections(mergeGeneratedSections(outline, body.sections, replacements));
        acceptedAny = true;
      }
    }
    deterministicValidation = validateRestructuredRewrite(units, facts, body.paragraphs, body.factMapping, outline);
    if (repairUnavailable || !acceptedAny) break;
  }
  if (!deterministicValidation.passed && !isReviewableDraft(deterministicValidation, "restructured")) throw new RewriteContractError("内容等价重构未通过事实覆盖、结构重建或局部照搬硬校验。", "RESTRUCTURE_VALIDATION_FAILED", deterministicValidation);
  let candidateText = body.paragraphs.join("\n\n");
  const auditSystem = EQUIVALENT_AUDITOR_PROMPT;
  const auditPayload = (text: string) => ({ task: "audit_equivalent_restructure", source_text: sourceText, source_profile: sourceProfile, fact_ledger: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })), planned_outline: outline.map((item) => ({ section_id: item.sectionId, role: item.role, fact_ids: item.factIds })), candidate_text: text });
  const auditCalls: TrackedCall[] = [];
  let validation = deterministicValidation;
  try {
    const auditCall = await invokeTrackedModel({
      ...scope, taskType: "script_rewrite_restructure_audit", temperature: 0,
      maxTokens: Math.min(2_500, Math.max(900, facts.length * 90 + 600)),
      system: auditSystem,
      payload: auditPayload(candidateText),
    });
    auditCalls.push(auditCall);
    const audit = readRestructureAudit(auditCall.json);
    validation = withSemanticAudit(deterministicValidation, audit);
    if (!validation.passed && !audit.passed) {
      try {
        const semanticRepairCall = await invokeTrackedModel({
          ...scope, taskType: "script_rewrite_restructure_semantic_repair", temperature: 0.35,
          maxTokens: Math.min(13_000, Math.max(2_000, Math.ceil(sourceText.length * 1.25) + 1_400)),
          system: EQUIVALENT_SEMANTIC_REPAIR_PROMPT,
          payload: { task: "repair_semantic_audit_failures", source_profile: sourceProfile, audit: { missing_fact_ids: audit.missingFactIds, added_claims: audit.addedClaims, notes: audit.notes }, length_target: lengthTargetPayload, section_targets: sectionTargetPayload, forbidden_copied_spans: [...new Set([...verbatimRiskSpans, ...(deterministicValidation.copiedSpans ?? [])])], verbatim_risk_fact_ids: factValidation.leakingFactIds, outline: outline.map((item) => ({ section_id: item.sectionId, title: item.title, role: item.role, fact_ids: item.factIds })), fact_ledger: facts.map((item) => ({ fact_id: item.factId, kind: item.kind, statement: item.statement, immutable_facts: item.immutableFacts })), best_draft: body, rejected_draft: body },
        });
        generationCalls.push(semanticRepairCall);
        const candidateBody = readRestructuredSections(semanticRepairCall.json);
        const candidateValidation = validateRestructuredRewrite(units, facts, candidateBody.paragraphs, candidateBody.factMapping, outline);
        if (candidateValidation.passed || rewriteValidationQualityScore(candidateValidation) > rewriteValidationQualityScore(deterministicValidation)) {
          body = candidateBody;
          deterministicValidation = candidateValidation;
          candidateText = body.paragraphs.join("\n\n");
          try {
            const retryAuditCall = await invokeTrackedModel({
              ...scope, taskType: "script_rewrite_restructure_audit_retry", temperature: 0,
              maxTokens: Math.min(2_500, Math.max(900, facts.length * 90 + 600)),
              system: auditSystem,
              payload: auditPayload(candidateText),
            });
            auditCalls.push(retryAuditCall);
            validation = withSemanticAudit(deterministicValidation, readRestructureAudit(retryAuditCall.json));
          } catch (error) {
            validation = withUnavailableSemanticAudit(deterministicValidation, error);
          }
        }
      } catch {
        // Semantic repair is best-effort. Keep the audited draft and surface its
        // review notes instead of reporting that generation itself failed.
      }
    }
  } catch (error) {
    validation = withUnavailableSemanticAudit(deterministicValidation, error);
  }
  if (!validation.passed && !isReviewableDraft(deterministicValidation, "restructured")) throw new RewriteContractError("内容等价重构未通过命题覆盖、结构差异或语义审计。", "RESTRUCTURE_VALIDATION_FAILED", validation);
  return { text: candidateText, paragraphs: body.paragraphs, sourceMapping: body.factMapping, outline, validation, calls: [...generationCalls, ...auditCalls] };
}

export async function POST(request: Request, context: { params: Promise<{ rewriteId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成口播改写。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = clean(payload.organizationId, 100); const projectId = clean(payload.projectId, 100);
    const variants = [...new Set((Array.isArray(payload.variants) ? payload.variants : []).filter((item): item is ScriptRewriteVariant => item === "light_rewrite" || item === "restructured"))];
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!variants.length) return apiError("REWRITE_VARIANT_REQUIRED", "请至少选择一种改写方式。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能生成口播改写。", 403);
    const { rewriteId } = await context.params; const db = getD1();
    const workspace = await db.prepare("SELECT id, source_text, source_hash FROM script_rewrite_workspaces WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'").bind(rewriteId, organizationId, projectId).first<{ id: string; source_text: string; source_hash: string }>();
    if (!workspace) return apiError("REWRITE_NOT_FOUND", "口播改写工作区不存在。", 404);
    if (workspace.source_text.length > SCRIPT_REWRITE_MAX_CHARACTERS) return apiError("REWRITE_SOURCE_TOO_LONG", `当前来源超过 ${SCRIPT_REWRITE_MAX_CHARACTERS.toLocaleString("zh-CN")} 字符，请拆分成多个改写任务后再生成。`, 413);
    const sourceVersion = await db.prepare("SELECT id FROM script_rewrite_versions WHERE organization_id = ? AND project_id = ? AND workspace_id = ? AND variant = 'source' ORDER BY version ASC LIMIT 1").bind(organizationId, projectId, rewriteId).first<{ id: string }>();
    if (!sourceVersion) return apiError("REWRITE_SOURCE_VERSION_MISSING", "来源快照不存在，不能继续生成。", 409);
    const retryOfRunId = clean(payload.retryOfRunId, 100);
    if (retryOfRunId) {
      if (variants.length !== 1) return apiError("REWRITE_RETRY_SINGLE_VARIANT", "单版重试一次只能选择一个版本。", 400);
      const retryRun = await db.prepare("SELECT id FROM script_rewrite_runs WHERE id = ? AND organization_id = ? AND project_id = ? AND workspace_id = ? AND variant = ?").bind(retryOfRunId, organizationId, projectId, rewriteId, variants[0]).first();
      if (!retryRun) return apiError("REWRITE_RETRY_NOT_FOUND", "要重试的运行记录不存在。", 404);
    }
    readContentModelConfig("max", await readEffectiveModelRuntime(organizationId));
    const estimate = estimateRewriteUsage(workspace.source_text, variants); const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "modelCalls", estimate.callCount);
    if (!quota.allowed) return apiError("MODEL_QUOTA_EXCEEDED", `本次预计调用 ${estimate.callCount} 次模型，当前月度剩余额度不足。`, 429, { usage: quota.current, limit: quota.limit, requested: estimate.callCount });
    const units = buildScriptUnits(workspace.source_text);
    const homomorphicUnits = buildScriptUnits(workspace.source_text, SCRIPT_REWRITE_MAX_CHARACTERS);
    const results: Array<Record<string, unknown>> = [];
    for (const variant of variants) {
      const variantEstimate = estimateRewriteUsage(workspace.source_text, [variant]); const runId = crypto.randomUUID(); const startedAt = new Date().toISOString();
      await db.prepare(`INSERT INTO script_rewrite_runs (id, organization_id, project_id, workspace_id, variant, status, source_version_id, result_version_id, retry_of_run_id, estimated_call_count, estimated_input_tokens, maximum_output_tokens, actual_input_tokens, actual_output_tokens, actual_total_tokens, model_call_id, prompt_version, validation_json, error_code, error_message, created_by, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'started', ?, NULL, ?, ?, ?, ?, 0, 0, 0, NULL, ?, '{}', NULL, NULL, ?, ?, NULL)`).bind(runId, organizationId, projectId, rewriteId, variant, sourceVersion.id, retryOfRunId || null, variantEstimate.callCount, variantEstimate.estimatedInputTokens, variantEstimate.maximumOutputTokens, SCRIPT_REWRITE_PROMPT_VERSION, user.id, startedAt).run();
      try {
        const generated = variant === "light_rewrite"
          ? await generateLightRewrite({ organizationId, projectId, userId: user.id, runId }, homomorphicUnits)
          : await generateRestructuredRewrite({ organizationId, projectId, userId: user.id, runId }, units);
        const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; generated.calls.forEach((call) => addUsage(usage, call.usage));
        const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM script_rewrite_versions WHERE organization_id = ? AND project_id = ? AND workspace_id = ?").bind(organizationId, projectId, rewriteId).first<{ version: number }>();
        const version = Number(latest?.version ?? 0) + 1; const versionId = crypto.randomUUID(); const completedAt = new Date().toISOString(); const firstCall = generated.calls[0];
        await db.batch([
          db.prepare(`INSERT INTO script_rewrite_versions (id, organization_id, project_id, workspace_id, version, variant, parent_version_id, run_id, text, paragraphs_json, source_mapping_json, outline_json, validation_json, model_provider, model_name, prompt_version, model_call_id, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(versionId, organizationId, projectId, rewriteId, version, variant, sourceVersion.id, runId, generated.text, JSON.stringify(generated.paragraphs), JSON.stringify(generated.sourceMapping), JSON.stringify(generated.outline), JSON.stringify(generated.validation), firstCall?.provider ?? null, firstCall?.model ?? null, SCRIPT_REWRITE_PROMPT_VERSION, firstCall?.id ?? null, `${rewriteVariantLabel(variant)}自动生成`, user.id, completedAt),
          db.prepare("UPDATE script_rewrite_runs SET status = 'completed', result_version_id = ?, actual_input_tokens = ?, actual_output_tokens = ?, actual_total_tokens = ?, model_call_id = ?, validation_json = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(versionId, usage.inputTokens, usage.outputTokens, usage.totalTokens, firstCall?.id ?? null, JSON.stringify(generated.validation), completedAt, runId, organizationId, projectId),
          db.prepare("UPDATE script_rewrite_workspaces SET updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(user.id, completedAt, rewriteId, organizationId, projectId),
          db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'script_rewrite.generated', 'script_rewrite_version', ?, ?, ?)`).bind(crypto.randomUUID(), organizationId, projectId, user.id, versionId, JSON.stringify({ workspaceId: rewriteId, runId, variant, version, sourceHash: workspace.source_hash, modelCallIds: generated.calls.map((call) => call.id), usage, validation: generated.validation }), completedAt),
        ]);
        results.push({ variant, status: "completed", runId, versionId, version, validation: generated.validation, usage });
      } catch (error) {
        const completedAt = new Date().toISOString(); const contract = error instanceof RewriteContractError ? error : null; const code = contract?.code ?? (error instanceof ModelRequestError ? error.code : "REWRITE_GENERATION_FAILED"); const message = error instanceof Error ? error.message.slice(0, 1000) : "改写生成失败";
        const callUsage = await db.prepare("SELECT COALESCE(SUM(CAST(json_extract(output_json, '$.usage.inputTokens') AS INTEGER)), 0) AS input_tokens, COALESCE(SUM(CAST(json_extract(output_json, '$.usage.outputTokens') AS INTEGER)), 0) AS output_tokens, COALESCE(SUM(CAST(json_extract(output_json, '$.usage.totalTokens') AS INTEGER)), 0) AS total_tokens, MIN(id) AS model_call_id FROM model_calls WHERE organization_id = ? AND project_id = ? AND created_by = ? AND json_extract(input_json, '$.runId') = ? AND task_type LIKE 'script_rewrite_%'").bind(organizationId, projectId, user.id, runId).first<{ input_tokens: number; output_tokens: number; total_tokens: number; model_call_id: string | null }>();
        await db.batch([
          db.prepare("UPDATE script_rewrite_runs SET status = 'failed', actual_input_tokens = ?, actual_output_tokens = ?, actual_total_tokens = ?, model_call_id = ?, validation_json = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(callUsage?.input_tokens ?? 0, callUsage?.output_tokens ?? 0, callUsage?.total_tokens ?? 0, callUsage?.model_call_id ?? null, JSON.stringify(contract?.validation ?? {}), code, message, completedAt, runId, organizationId, projectId),
          db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'script_rewrite.failed', 'script_rewrite_run', ?, ?, ?)`).bind(crypto.randomUUID(), organizationId, projectId, user.id, runId, JSON.stringify({ workspaceId: rewriteId, variant, code, validation: contract?.validation ?? {} }), completedAt),
        ]);
        results.push({ variant, status: "failed", runId, error: { code, message }, validation: contract?.validation ?? {} });
      }
    }
    const failed = results.filter((item) => item.status === "failed").length;
    return Response.json({ results, estimate, completion: failed === 0 ? "complete" : failed === results.length ? "failed" : "partial" }, { status: failed ? 207 : 201 });
  } catch (error) {
    if (error instanceof ModelConfigurationError) return apiError("CONTENT_MODEL_NOT_CONFIGURED", error.message, 409);
    if (error instanceof ModelRequestError) return apiError(error.code, error.message, 502);
    return errorResponse(error);
  }
}
