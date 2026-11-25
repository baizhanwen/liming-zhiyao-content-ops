import {
  applyRewriteAdaptationPlan, readRewriteBrandAudit, validateRewriteBrandOutput, rewriteVoiceExamples,
  REWRITE_ADAPTATION_AUDIT_PROMPT, REWRITE_ADAPTATION_PLAN_PROMPT, REWRITE_ADAPTATION_REPAIR_PROMPT,
  type RewriteAdaptationPlan, type RewriteBrief,
} from "./script-rewrite-adaptation";
import type { RewriteBrandContext } from "./script-rewrite-brand";
import type { RewriteAdaptationSnapshot } from "./script-rewrite-options";
import { buildScriptUnits, SCRIPT_REWRITE_MAX_CHARACTERS } from "./script-rewrite";

export type AdaptationModelStep = { taskType: string; system: string; payload: unknown; maxTokens: number; temperature: number };
type Invoke = (step: AdaptationModelStep) => Promise<{ json: unknown }>;

export class RewriteAdaptationError extends Error {
  constructor(readonly code: string, message: string, readonly validation: unknown = {}) { super(message); }
}

export function rewriteBrief(snapshot: RewriteAdaptationSnapshot): RewriteBrief {
  return { goal: snapshot.goal, audience: snapshot.audience, scene: snapshot.scenario };
}

export async function planRewriteAdaptation(source: string, snapshot: RewriteAdaptationSnapshot, brand: RewriteBrandContext | null, invoke: Invoke): Promise<RewriteAdaptationPlan> {
  if (snapshot.mode === "preserve") return { text: source, mappings: [], protectedParties: [], unresolved: [] };
  const payload = { task: "plan_brand_adaptation", mode: snapshot.mode, brief: rewriteBrief(snapshot), targetName: snapshot.targetName, sources: snapshot.sources, voice_examples: rewriteVoiceExamples(source),
    source_paragraphs: buildScriptUnits(source, SCRIPT_REWRITE_MAX_CHARACTERS).map(unit => ({ paragraphId: unit.paragraphId, text: unit.text })) };
  const step = { taskType: "script_rewrite_brand_plan", system: REWRITE_ADAPTATION_PLAN_PROMPT, maxTokens: 4500, temperature: 0 };
  const proposed = await invoke({ ...step, payload });
  try {
    return applyRewriteAdaptationPlan(proposed.json, source, snapshot.mode, brand);
  } catch (error) {
    const issue = error instanceof Error ? error.message : "无法核对原文和资料";
    const repair = await invoke({ ...step, taskType: "script_rewrite_brand_plan_repair",
      system: step.system + "\n根据程序定位的问题纠正映射。保留合法条目；找不到原文或资料时，把缺口列入 unresolved。不要编写资料或擅自修改原文引句。",
      payload: { ...payload, task: "repair_brand_plan", rejected_plan: proposed.json, issue } });
    try {
      return applyRewriteAdaptationPlan(repair.json, source, snapshot.mode, brand);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "无法核对品牌映射与原稿，请检查资料。";
      throw new RewriteAdaptationError("REWRITE_BRAND_PLAN_INVALID", message, { issues: [message] });
    }
  }
}

export async function verifyAdaptedRewrite(input: {
  source: string; paragraphs: string[]; plan: RewriteAdaptationPlan; snapshot: RewriteAdaptationSnapshot;
  brand: RewriteBrandContext | null; invoke: Invoke; initialFactIssues: string[]; validateRepair: (paragraphs: string[]) => Promise<void>;
}) {
  const { source, plan, snapshot, brand, invoke } = input;
  const evidence = { mode: snapshot.mode, brief: rewriteBrief(snapshot), original: source, targetName: snapshot.targetName,
    sources: snapshot.sources, mappings: plan.mappings, voice_examples: rewriteVoiceExamples(source), protectedParties: plan.protectedParties, unresolved: plan.unresolved };
  async function audit(paragraphs: string[], factIssues: string[] = []) {
    const issues = [...factIssues, ...validateRewriteBrandOutput(paragraphs.join("\n\n"), plan, snapshot.mode, brand)];
    const call = await invoke({ taskType: "script_rewrite_brand_audit", system: REWRITE_ADAPTATION_AUDIT_PROMPT, maxTokens: 2500,
      temperature: 0, payload: { task: "audit_brand_adaptation", ...evidence, paragraphs } });
    const review = readRewriteBrandAudit(call.json);
    return { passed: !issues.length && review.passed, issues: [...issues, ...review.issues], qualityNotes: review.qualityNotes };
  }
  const review = await audit(input.paragraphs, input.initialFactIssues);
  if (review.passed) return { paragraphs: input.paragraphs, qualityNotes: review.qualityNotes };
  const repaired = await invoke({ taskType: "script_rewrite_brand_repair", system: REWRITE_ADAPTATION_REPAIR_PROMPT,
    maxTokens: Math.min(16000, source.length * 2 + 1600), temperature: 0.2,
    payload: { task: "repair_brand_adaptation", ...evidence, paragraphs: input.paragraphs, issues: review.issues } });
  const rows = (repaired.json as { paragraphs?: unknown } | null)?.paragraphs;
  if (!Array.isArray(rows) || rows.length !== input.paragraphs.length || rows.some(row => typeof row !== "string" || !row.trim()) ||
      rows.join("\n\n").length > SCRIPT_REWRITE_MAX_CHARACTERS * 1.5) {
    throw new RewriteAdaptationError("REWRITE_BRAND_VALIDATION_FAILED", "品牌修订未保留原有段落，请检查本次适配说明。", { issues: review.issues });
  }
  const paragraphs: string[] = rows.map((row: string) => row.trim());
  const final = await audit(paragraphs);
  if (!final.passed) throw new RewriteAdaptationError("REWRITE_BRAND_VALIDATION_FAILED", "修订后仍有品牌或事实归属无法核对，本次未保存新版本。", { issues: final.issues });
  await input.validateRepair(paragraphs);
  return { paragraphs, qualityNotes: final.qualityNotes };
}
