import compiled from "../../resources/ecommerce-methodology.v2.json" with { type: "json" };
import type { EcommerceContext } from "./context";

export type MethodSource = { document: string; section: string; sha256: string; line: number; excerpt: string };
export type HookMethod = typeof compiled.hooks[number];
export type FrameworkMethod = typeof compiled.frameworks[number];
export type MethodologySelection = { hookId: string; frameworkId: string; supplementFrameworkId: string; reason: string };
export const ECOMMERCE_METHODOLOGY_CATALOG = compiled;
export const ECOMMERCE_METHODOLOGY_VERSION = `${compiled.version}:${compiled.sourceDigest.slice(0, 12)}`;

type CopyFacts = { content?: string; usage?: string; difference?: string; delivery?: string; limitations?: string; speakerExperience?: string };
const copyFactsFor = (context: EcommerceContext): CopyFacts => (context.input.product as typeof context.input.product & { copyFacts?: CopyFacts }).copyFacts ?? {};

/** Capability checks inspect only selected product facts/evidence, never method examples or a mere price. */
export function methodologyCapabilities(context: EcommerceContext) {
  const facts = copyFactsFor(context), { product, evidence } = context.input;
  return new Set([
    ...(evidence.some(item => item.kind === "demonstration") ? ["demonstration"] : []),
    ...(product.offer && evidence.some(item => item.kind === "offer") ? ["offer"] : []),
    ...(facts.speakerExperience?.trim() ? ["identity"] : []),
    ...(facts.difference?.trim() ? ["comparison"] : []),
    ...(evidence.some(item => item.kind === "customer_permission") ? ["feedback"] : []),
    ...(/[产原]地[：:]|生产地[：:]|工厂[：:]/u.test(facts.content ?? "") ? ["origin"] : []),
    ...(/春节|中秋|端午|七夕|母亲节|父亲节|儿童节|圣诞|开学|夏季|冬季|春季|秋季/u.test(context.input.task.brief.scene) ? ["season"] : []),
  ]);
}

/** Rank eligible mechanisms, then let the planning model select and explain. Ranking never creates facts. */
export function ecommerceMethodCandidates(context: EcommerceContext) {
  if (context.input.task.brief.referenceMode === "benchmark") return { hooks: [], frameworks: [] };
  const capabilities = methodologyCapabilities(context), facts = copyFactsFor(context), brief = context.input.task.brief;
  const query = `${context.input.product.category ?? ""} ${brief.barrier} ${brief.scene}`;
  const courseOrTool = /课程|知识|学习|培训|软件|工具|教程/u.test(query);
  const trust = /可靠|信任|真假|正品|资质|安全/u.test(brief.barrier);
  const comparison = /值|价格|便宜|选择|适合|区别|对比|踩坑/u.test(brief.barrier);
  const eligible = (method: { requires: string[] }) => method.requires.every(item => capabilities.has(item));
  const hookScore = (item: HookMethod) => {
    let score = ({ "hook.pain": 6, "hook.question": 5, "hook.audience": 4, "hook.curiosity": 3, "hook.reverse": 2, "hook.dialogue": 1 } as Record<string, number>)[item.id] ?? 0;
    if (courseOrTool && ["hook.reverse", "hook.curiosity"].includes(item.id)) score += 7;
    if (trust && ["hook.identity", "hook.feedback"].includes(item.id)) score += 9;
    if (comparison && ["hook.comparison", "hook.reverse"].includes(item.id)) score += 6;
    if (item.requires.includes("demonstration")) score += 9;
    if (item.requires.includes("offer")) score += 12;
    if (facts.usage?.trim() && item.id === "hook.metaphor") score += 3;
    return score;
  };
  const frameworkScore = (item: FrameworkMethod) => {
    let score = ({ "framework.pain": 6, "framework.selection": 5, "framework.curiosity": 4, "framework.upgrade": 2, "framework.emotion": 1 } as Record<string, number>)[item.id] ?? 0;
    if (courseOrTool && item.id === "framework.selection") score += 7;
    if (comparison && item.id === "framework.selection") score += 5;
    if (trust && item.id === "framework.trust") score += 10;
    if (item.requires.includes("demonstration")) score += 12;
    if (item.requires.includes("offer")) score += 14;
    if (facts.usage?.trim() && item.id === "framework.upgrade") score += 3;
    return score;
  };
  return {
    hooks: compiled.hooks.filter(eligible).sort((a, b) => hookScore(b) - hookScore(a) || a.id.localeCompare(b.id)).slice(0, 6),
    frameworks: compiled.frameworks.filter(eligible).sort((a, b) => frameworkScore(b) - frameworkScore(a) || a.id.localeCompare(b.id)).slice(0, 4),
  };
}

export function getMethodologySelection(context: EcommerceContext, selection: MethodologySelection | null | undefined) {
  if (!selection || context.input.task.brief.referenceMode === "benchmark") return null;
  const candidates = ecommerceMethodCandidates(context);
  const hook = candidates.hooks.find(item => item.id === selection.hookId);
  const framework = candidates.frameworks.find(item => item.id === selection.frameworkId);
  const supplement = selection.supplementFrameworkId ? candidates.frameworks.find(item => item.id === selection.supplementFrameworkId) : undefined;
  if (!hook || !framework || selection.supplementFrameworkId && !supplement) return null;
  return { hook, framework, supplement: supplement ?? null, reason: selection.reason };
}

export function methodologySelectionIssues(context: EcommerceContext, selection: MethodologySelection | null | undefined) {
  if (context.input.task.brief.referenceMode === "benchmark") return selection ? ["参考视频模式不额外选择方法框架"] : [];
  if (!selection) return ["请从本次方法候选中选择一个钩子和一个主框架"];
  const issues: string[] = [], selected = getMethodologySelection(context, selection);
  if (!selected) issues.push("所选钩子或框架不在本次适配候选中，或缺少对应事实依据");
  if (!selection.reason.trim()) issues.push("方法选择缺少与本次购买顾虑及商品细节对应的理由");
  if (selection.supplementFrameworkId && selection.supplementFrameworkId === selection.frameworkId) issues.push("补充框架不能与主框架重复");
  return issues;
}

export function ecommerceCategoryMethod(context: EcommerceContext) {
  const category = context.input.product.category ?? "";
  return [...compiled.categories].reverse().find(item => item.terms.some(term => category.includes(term))) ?? null;
}
