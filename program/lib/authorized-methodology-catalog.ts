import {
  ANALYSIS_RUBRIC_DIMENSIONS,
  AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
  AUTHORIZED_METHODOLOGY_ENTRIES,
  CONTENT_HOOK_TYPES,
  CONTENT_STRATEGY_FAMILIES,
  selectAuthorizedMethodologyPlan,
  type AuthorizedMethodKind,
  type AuthorizedMethodMode,
  type AuthorizedMethodPlatform,
  type AuthorizedMethodStage,
  type AuthorizedMethodTask,
  type AuthorizedMethodologyEntry,
} from "./authorized-methodology-router.ts";

export type AuthorizedMethodologyCatalogQuery = Readonly<{
  task?: AuthorizedMethodTask;
  kind?: AuthorizedMethodKind;
  stage?: AuthorizedMethodStage;
  platform?: AuthorizedMethodPlatform;
  mode?: AuthorizedMethodMode;
  q?: string;
}>;

const TASKS = ["topic", "content", "analysis"] as const satisfies readonly AuthorizedMethodTask[];

export const AUTHORIZED_METHODOLOGY_FILTERS = {
  tasks: TASKS,
  kinds: ["core_playbook", "module", "rule"] as const satisfies readonly AuthorizedMethodKind[],
  stages: ["routing", "planning", "hook", "structure", "drafting", "evidence", "diagnosis", "verification"] as const satisfies readonly AuthorizedMethodStage[],
  platforms: ["generic", "douyin", "xiaohongshu", "wechat", "kuaishou"] as const satisfies readonly AuthorizedMethodPlatform[],
  modes: ["standard", "complete-script", "benchmark-structure", "hook-testing", "published-performance"] as const satisfies readonly AuthorizedMethodMode[],
} as const;

const TASK_LABELS: Record<AuthorizedMethodTask, string> = {
  topic: "选题方法",
  content: "内容创作方法",
  analysis: "视频分析方法",
};

const TASK_DESCRIPTIONS: Record<AuthorizedMethodTask, string> = {
  topic: "确定受众、核心问题、内容目标和可兑现边界。",
  content: "规划钩子、结构、口播表达，并执行事实与合规门禁。",
  analysis: "用时间码、转写、画面和指标证据完成可追溯诊断。",
};

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function entryMatchesTask(entry: AuthorizedMethodologyEntry, task: AuthorizedMethodTask | undefined) {
  return !task || entry.task === "all" || entry.task === task;
}

function entryMatchesSearch(entry: AuthorizedMethodologyEntry, q: string) {
  if (!q) return true;
  const haystack = normalize([
    entry.id,
    entry.title,
    entry.instruction,
    ...entry.keywords,
    ...entry.requiredEvidence,
    entry.source.package,
    entry.source.document,
  ].join(" "));
  return q.split(" ").filter(Boolean).every((term) => haystack.includes(term));
}

function serializeEntry(entry: AuthorizedMethodologyEntry) {
  return {
    id: entry.id,
    title: entry.title,
    task: entry.task,
    kind: entry.kind,
    stage: entry.stage,
    platform: entry.platform,
    mode: entry.mode,
    risk: entry.risk,
    version: entry.version,
    instruction: entry.instruction,
    requiredEvidence: [...entry.requiredEvidence],
    keywords: [...entry.keywords],
    source: {
      package: entry.source.package,
      document: entry.source.document,
      revision: entry.source.revision,
      note: entry.source.note,
    },
  };
}

function countBy<T extends string>(values: readonly T[]) {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

/**
 * Produce the read-only presentation model for the methodology library.
 *
 * This deliberately exposes curated methods and deterministic plan previews,
 * never the raw authorized-knowledge atoms that may contain duplicate or
 * unreviewed source text.
 */
export function buildAuthorizedMethodologyCatalog(query: AuthorizedMethodologyCatalogQuery = {}) {
  const q = normalize((query.q ?? "").slice(0, 500));
  const entries = AUTHORIZED_METHODOLOGY_ENTRIES.filter((entry) => (
    entryMatchesTask(entry, query.task)
    && (!query.kind || entry.kind === query.kind)
    && (!query.stage || entry.stage === query.stage)
    && (!query.platform || entry.platform === "all" || entry.platform === query.platform)
    && (!query.mode || entry.mode === "all" || entry.mode === query.mode)
    && entryMatchesSearch(entry, q)
  ));

  const taskCounts = countBy(TASKS);
  const kindCounts = countBy(AUTHORIZED_METHODOLOGY_FILTERS.kinds);
  for (const entry of AUTHORIZED_METHODOLOGY_ENTRIES) {
    if (entry.task === "all") for (const task of TASKS) taskCounts[task] += 1;
    else taskCounts[entry.task] += 1;
    kindCounts[entry.kind] += 1;
  }

  const serializedEntries = entries.map(serializeEntry);
  const visibleTasks = query.task ? [query.task] : [...TASKS];
  const groups = visibleTasks.map((task) => ({
    task,
    label: TASK_LABELS[task],
    description: TASK_DESCRIPTIONS[task],
    entries: serializedEntries.filter((entry) => entry.task === "all" || entry.task === task),
  }));

  const plans = visibleTasks.map((task) => {
    const plan = selectAuthorizedMethodologyPlan({
      task,
      query: q || TASK_LABELS[task],
      platform: query.platform,
      mode: query.mode,
      hasBenchmarks: query.mode === "benchmark-structure",
    });
    return {
      id: plan.id,
      version: plan.version,
      task: plan.task,
      platform: plan.platform,
      mode: plan.mode,
      corePlaybookId: plan.corePlaybook.id,
      moduleIds: plan.modules.map((entry) => entry.id),
      ruleIds: plan.rules.map((entry) => entry.id),
      selectedIds: [...plan.selectedIds],
    };
  });

  return {
    catalog: {
      id: "liming-authorized-methodology",
      name: "利明智耀授权方法论",
      version: AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
      readOnly: true,
      entryCount: AUTHORIZED_METHODOLOGY_ENTRIES.length,
      taskCounts,
      kindCounts,
      frameworks: {
        contentStrategyFamilyCount: CONTENT_STRATEGY_FAMILIES.length,
        contentHookTypeCount: CONTENT_HOOK_TYPES.length,
        analysisRubricDimensionCount: ANALYSIS_RUBRIC_DIMENSIONS.length,
        contentStrategyFamilies: CONTENT_STRATEGY_FAMILIES.map((item) => ({ ...item })),
        contentHookTypes: [...CONTENT_HOOK_TYPES],
        analysisRubricDimensions: ANALYSIS_RUBRIC_DIMENSIONS.map((item) => ({ ...item })),
      },
    },
    activeFilters: { ...query, q },
    filters: AUTHORIZED_METHODOLOGY_FILTERS,
    resultCount: serializedEntries.length,
    groups,
    entries: serializedEntries,
    plans,
  };
}
