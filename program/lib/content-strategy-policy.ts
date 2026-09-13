import type { ProjectAssistantDatabase } from "./project-memory-events.ts";

export type CoreContentStrategy = {
  id: string; name: string; positioning: string; targetAudience: string; styleNotes: string; defaultObjectives: string[];
};

export function coreContentStrategy(row: Record<string, string | null> | null): CoreContentStrategy | null {
  if (!row) return null;
  let objectives: unknown = [];
  try { objectives = JSON.parse(row.objectives_json || "[]"); } catch { /* No invented defaults. */ }
  return {
    id: row.id || "", name: row.name || "当前内容策略",
    positioning: (row.positioning || "").slice(0, 2000),
    targetAudience: (row.target_audience || "").slice(0, 1000),
    styleNotes: (row.style_notes || "").slice(0, 2000),
    defaultObjectives: Array.isArray(objectives) ? objectives.filter((value): value is string => typeof value === "string").map(value => value.trim().slice(0, 500)).filter(Boolean).slice(0, 10) : [],
  };
}

export async function readCoreContentStrategy(db: ProjectAssistantDatabase, scope: { organizationId: string; projectId: string }) {
  const row = await db.prepare("SELECT id, name, positioning, target_audience, style_notes, objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
    .bind(scope.organizationId, scope.projectId).first<Record<string, string | null>>();
  return coreContentStrategy(row ?? null);
}

export function strategyForTask(strategy: CoreContentStrategy | null, objective?: string | null): CoreContentStrategy | null {
  return strategy ? { ...strategy, defaultObjectives: objective?.trim() ? [] : strategy.defaultObjectives } : null;
}

export const CORE_STRATEGY_GUIDANCE = `核心内容策略自动读取，只约束账号定位、目标受众、基本表达风格及明确禁忌，不作为个人经历、案例或实验结果的事实依据。
本次任务的明确目标优先；defaultObjectives 只在本次未给目标时作回退，不能强行补入转化或评论引导。
先从本次问题、素材和受众需求找到具体切口，再检查账号适配度；内容支柱不是单条选题的必选菜单，不按支柱凑题，不为贴合定位额外插入实习、项目等无关话题。pillar 仅是对已确定选题的分类，不反过来决定内容。
表达风格中的时长、段数、钩子及收尾范式属于可调整的写法建议，不是每次必套模板；保持基本语气和明确禁忌，根据本题选择结构、案例与结尾。本次明确格式要求优先。
品牌知识是可选择采用的事实材料，按与本题的相关性和解释价值使用，不因已提供就拼入全部经历。没有合适案例时不强行举例，更不能补造经历。不要仅为体现账号特色重复同一经历、三段式或评论区结尾。`;
