import { readBenchmarkFeedback, materialFeedbackFromRow } from "../../../../../lib/benchmark-feedback";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { readCoreContentStrategy, strategyForTask } from "../../../../../lib/content-strategy-policy";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { CONTENT_OUTPUT_SCHEMA, CONTENT_PROMPT_NAME, CONTENT_PROMPT_VERSION, CONTENT_SYSTEM_PROMPT, analysisReportSourceText, buildSourceUsageReport, citationQuoteMatchesSource, generateContentSchema, normalizeGeneratedProductionPackTextBounds, parseModelJson, partitionContentPromptSources, productionPackSchema, productionPackValidationIssue } from "../../../../../lib/content-production";
import { invokeContentModel, ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../../lib/model-adapter";
import { buildPublishedCopyProfile, publishedCopyPromptSource, selectRelevantPublishedCopies, validateHistoricalStyleApplication, type PublishedCopyRecord } from "../../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../../lib/operations";
import { retrieveGenerationMethodologySources } from "../../../../../lib/generation-context-sources";
import { methodologyPlanPromptSource, selectAuthorizedMethodologyPlan } from "../../../../../lib/authorized-methodology-router";
import { materialFeedbackPrompt } from "../../../../../lib/material-recommendation";
import { assertProjectGenerationContext, buildProjectGenerationContext, finishGenerationSourceManifest, insertGenerationSourceManifest, redactedGenerationInput, untrustedReferencePrompt } from "../../../../../lib/project-generation-context";
import { benchmarkDirectPerformancePrompt, inspectSelectedBenchmarkCoverage, type BenchmarkDirectPerformance } from "../../../../../lib/benchmark-generation-context";
import { applyCitationRepair, buildCitationDraftAnchors, buildCitationSourceAnchors, CITATION_REPAIR_SYSTEM, deduplicateTraceableCitations, isCitationRepairError } from "../../../../../lib/content-citation-recovery";
import { incompleteScriptReason } from "../../../../../lib/content-writing-intent";

import { topicKnowledgeSelection } from "../../../../../lib/topic-knowledge-selection";
import { BENCHMARK_CONTENT_GUIDANCE } from "../../../../../lib/benchmark-content-policy";
import { BENCHMARK_PLAN_SYSTEM, BENCHMARK_REVIEW_SYSTEM, BENCHMARK_REWRITE_GUIDANCE, BENCHMARK_REWRITE_VERSION, benchmarkRewriteBounds, benchmarkRewriteBudget, benchmarkRewriteRevision, benchmarkRewriteReviewSchema, readBenchmarkRewriteSource, rewriteCharacterCount, validateBenchmarkRewriteDraft, validateBenchmarkRewritePlan, type BenchmarkRewritePlan, type BenchmarkRewriteSource } from "../../../../../lib/single-benchmark-rewrite";

export const dynamic = "force-dynamic";

type Source = { sourceType: "topic" | "memory" | "knowledge" | "video_atom" | "inspiration" | "video_analysis" | "strategy" | "benchmark" | "method_knowledge" | "historical_copy"; sourceId: string; title: string; text: string; systemMethodology?: boolean };
type BenchmarkRow = {
  library_entry_id: string;
  title: string;
  analysis_id: string;
  report_json: string;
  video_id: string;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  followers_gained: number | null;
  collected_at: string | null;
};

function directBenchmarkPerformance(row: BenchmarkRow): BenchmarkDirectPerformance {
  return {
    plays: row.plays,
    likes: row.likes,
    comments: row.comments,
    favorites: row.favorites,
    shares: row.shares,
    followersGained: row.followers_gained,
    collectedAt: row.collected_at,
  };
}

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成内容。", 401);
  let modelCallId: string | null = null;
  let traceId = "";
  let sourceManifestInserted = false;
  try {
    const parsed = generateContentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_GENERATION_INPUT", "内容生成参数无效。", 400);
    const { organizationId, projectId, benchmarkEntryIds, recommendedBenchmarkIds, creationMode, writingIntent } = parsed.data;
    const singleBenchmark = creationMode === "single_benchmark";
    if (singleBenchmark && benchmarkEntryIds.length !== 1) return apiError("SINGLE_BENCHMARK_REQUIRED", "单条对标仿写需要且只能选择 1 条参考视频。", 400);
    if (new Set(benchmarkEntryIds).size !== benchmarkEntryIds.length) return apiError("DUPLICATE_BENCHMARK", "参考视频不能重复选择。", 400);
    const promptVersion = singleBenchmark ? BENCHMARK_REWRITE_VERSION : CONTENT_PROMPT_VERSION;
    const systemPrompt = singleBenchmark ? CONTENT_SYSTEM_PROMPT + BENCHMARK_REWRITE_GUIDANCE : CONTENT_SYSTEM_PROMPT;
    const modelProfile = "max" as const;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能生成内容。", 403);
    const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "modelCalls");
    if (!quota.allowed) return apiError("MODEL_QUOTA_EXCEEDED", `本月模型调用已达到 ${quota.limit} 次套餐上限。`, 429, { usage: quota.current, limit: quota.limit });
    const config = readContentModelConfig(modelProfile);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare(`
      SELECT c.id, c.title, c.current_version, c.topic_id, t.title AS topic_title, t.angle, t.pillar, t.audience, t.objective, t.hook, t.rationale, t.selected_knowledge_ids_json
      FROM content_items c INNER JOIN topic_ideas t ON t.id = c.topic_id AND t.organization_id = c.organization_id AND t.project_id = c.project_id
      WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND c.status NOT IN ('published', 'reviewed', 'archived')
    `).bind(contentId, organizationId, projectId).first<{ id: string; title: string; current_version: number; topic_id: string; topic_title: string; angle: string | null; pillar: string | null; audience: string | null; objective: string | null; hook: string | null; rationale: string | null; selected_knowledge_ids_json: string }>();
    if (!item) return apiError("CONTENT_NOT_GENERATABLE", "内容不存在、已归档或当前状态不可生成。", 409);
    const selectedKnowledgeSourceIds = new Set(topicKnowledgeSelection(item.selected_knowledge_ids_json));
    const [strategy, knowledgeRows, citationRows, historicalRows] = await Promise.all([
      readCoreContentStrategy(db, { organizationId, projectId }),
      selectedKnowledgeSourceIds.size ? db.prepare(`SELECT k.id, k.title, k.category, v.body FROM knowledge_items k
        INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
        WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
          AND k.id IN (${[...selectedKnowledgeSourceIds].map(() => "?").join(",")})`).bind(organizationId, projectId, ...selectedKnowledgeSourceIds).all<{ id: string; title: string; category: string; body: string }>() : { results: [] as { id: string; title: string; category: string; body: string }[] },
      db.prepare("SELECT citation_type, citation_id, quote FROM topic_citations WHERE organization_id = ? AND project_id = ? AND topic_id = ? ORDER BY created_at ASC").bind(organizationId, projectId, item.topic_id).all<{ citation_type: string; citation_id: string; quote: string | null }>(),
      { results: [] as PublishedCopyRecord[] },
    ]);
    const benchmarkRows = benchmarkEntryIds.length ? await db.prepare(`
      SELECT library.id AS library_entry_id, v.id AS video_id, COALESCE(v.title, v.source_url, '未命名素材') AS title, analysis.id AS analysis_id, analysis.report_json,
        metrics.plays, metrics.likes, metrics.comments, metrics.favorites, metrics.shares, metrics.followers_gained, metrics.collected_at
      FROM project_video_references refs
      INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
      INNER JOIN video_analyses analysis ON analysis.id = (
        SELECT latest.id FROM video_analyses latest
        WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id
        ORDER BY latest.created_at DESC LIMIT 1
      )
      LEFT JOIN video_metric_snapshots metrics ON metrics.id = (
        SELECT latest_metric.id FROM video_metric_snapshots latest_metric WHERE latest_metric.organization_id = v.organization_id AND latest_metric.video_id = v.id ORDER BY latest_metric.collected_at DESC, latest_metric.created_at DESC LIMIT 1
      )
      WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
        AND library.id IN (${benchmarkEntryIds.map(() => "?").join(", ")})
      LIMIT 5
    `).bind(organizationId, projectId, ...benchmarkEntryIds).all<BenchmarkRow>() : { results: [] as BenchmarkRow[] };
    if (benchmarkRows.results.length !== benchmarkEntryIds.length) return apiError("BENCHMARK_SOURCE_NOT_READY", "所选素材不在当前企业空间的对标内容库中，或尚未完成视频分析。", 409);
    let rewriteSource: BenchmarkRewriteSource | null = null;
    if (singleBenchmark) {
      const row = benchmarkRows.results[0];
      const transcript = await db.prepare("SELECT t.full_text FROM video_transcripts t INNER JOIN videos v ON v.id = t.video_id AND v.organization_id = t.organization_id AND v.project_id = t.project_id WHERE t.organization_id = ? AND t.video_id = ? ORDER BY t.version DESC, t.created_at DESC LIMIT 1")
        .bind(organizationId, row.video_id).first<{ full_text: string }>();
      const sourceTextResult = readBenchmarkRewriteSource(row.report_json, transcript?.full_text);
      if (!sourceTextResult) return apiError("BENCHMARK_SCRIPT_REQUIRED", "这条视频没有可用的完整原口播稿，请先完成原稿校正或转写，再进行单条仿写。", 409);
      if (rewriteCharacterCount(sourceTextResult.sourceScript) < 40 || sourceTextResult.sourceScript.length > 8_000) return apiError("BENCHMARK_SCRIPT_LENGTH", "单条仿写目前支持 40–8000 字的完整原稿，请选择篇幅合适的参考视频。", 409);
      rewriteSource = { sourceId: row.library_entry_id, sourceTitle: row.title, ...sourceTextResult };
    }
    const benchmarkFeedbackRows = await readBenchmarkFeedback(db, { organizationId, projectId, entryIds: benchmarkEntryIds });
    const benchmarkFeedback = new Map(benchmarkFeedbackRows.results.map((row) => [row.entry_id, materialFeedbackFromRow(row)]));
    if (!strategy?.id) return apiError("ACTIVE_STRATEGY_REQUIRED", "请先启用该项目的内容策略，再生成生产包。", 409);
    if (knowledgeRows.results.length !== selectedKnowledgeSourceIds.size) return apiError("SELECTED_KNOWLEDGE_UNAVAILABLE", "选题指定的品牌知识已失效或不属于当前空间，请先核对选题引用。", 409);
    const topicText = [`本次创作选题标题：${item.topic_title}`, item.angle, item.pillar, item.audience, item.objective, item.hook, item.rationale].filter(Boolean).join("\n");
    const historicalQuery = [topicText, strategy.positioning, strategy.targetAudience].filter(Boolean).join("\n");
    const historicalMatches = selectRelevantPublishedCopies(historicalRows.results, historicalQuery, 5);
    const methodologySources = await retrieveGenerationMethodologySources({ query: historicalQuery, task: "content" });
    const methodologyPlan = selectAuthorizedMethodologyPlan({
      task: "content",
      query: historicalQuery,
      mode: benchmarkRows.results.length ? "benchmark-structure" : undefined,
      availableMethodSources: methodologySources,
      hasBenchmarks: benchmarkRows.results.length > 0,
      hasHistoricalCopies: historicalMatches.length > 0,
    });
    const methodologyPlanText = methodologyPlanPromptSource(methodologyPlan);
    const sources = new Map<string, Source>();
    for (const source of methodologySources) {
      const sourceType = source.sourceType === "system_methodology" ? "method_knowledge" : source.sourceType;
      sources.set(sourceType + ":" + source.sourceId, { sourceType, sourceId: source.sourceId, title: source.title, text: source.text, systemMethodology: source.systemMethodology });
    }
    sources.set(`method_knowledge:${methodologyPlan.id}`, {
      sourceType: "method_knowledge",
      sourceId: methodologyPlan.id,
      title: `本次确定性方法计划：${methodologyPlan.mode}`,
      text: methodologyPlanText,
      systemMethodology: true,
    });
    sources.set(`topic:${item.topic_id}`, { sourceType: "topic", sourceId: item.topic_id, title: item.topic_title, text: topicText });
    const strategyText = JSON.stringify(strategyForTask(strategy, item.objective));
    if (strategy?.id) {
      sources.set(`strategy:${strategy.id}`, { sourceType: "strategy", sourceId: strategy.id, title: "核心内容策略：" + strategy.name, text: strategyText });
    }
    for (const row of knowledgeRows.results) sources.set(`knowledge:${row.id}`, { sourceType: "knowledge", sourceId: row.id, title: row.title, text: row.body.slice(0, 4_000) });
    for (const row of citationRows.results) {
      if (row.citation_type !== "video_analysis" || !row.quote) continue;
      sources.set(`video_analysis:${row.citation_id}`, { sourceType: "video_analysis", sourceId: row.citation_id, title: "选题引用的视频分析", text: row.quote });
    }
    for (const row of benchmarkRows.results) sources.set(`benchmark:${row.library_entry_id}`, {
      sourceType: "benchmark",
      sourceId: row.library_entry_id,
      title: row.title,
      text: `${rewriteSource ? `[本次仿写完整原稿]\n${rewriteSource.sourceScript}\n\n` : ""}${analysisReportSourceText(row.report_json)}\n\n${benchmarkDirectPerformancePrompt(directBenchmarkPerformance(row))}\n\n[系统历史反馈]\n${materialFeedbackPrompt(benchmarkFeedback.get(row.library_entry_id))}`,
    });
    for (const match of historicalMatches) sources.set(`historical_copy:${match.record.id}`, { sourceType: "historical_copy", sourceId: match.record.id, title: match.record.title, text: publishedCopyPromptSource(match.record) });
    const sourceList = Array.from(sources.values()); const historicalStyleProfile = buildPublishedCopyProfile(historicalRows.results);
    const promptSourceLayers = partitionContentPromptSources(sourceList);
    const contextResult = await buildProjectGenerationContext({ authSubject: identity.authSubject, userId: user.id, organizationId, projectId, capability: "content", sources: sourceList });
    if (!contextResult.ok) return apiError(contextResult.code, contextResult.message, contextResult.status, contextResult.details);
    const generationContext = contextResult.context; traceId = generationContext.traceId;
    const topicBrief = { id: item.topic_id, title: item.topic_title, angle: item.angle, pillar: item.pillar, audience: item.audience, objective: item.objective, hook: item.hook, rationale: item.rationale };
    const outputSchema = singleBenchmark ? {
      ...CONTENT_OUTPUT_SCHEMA,
      required: [...CONTENT_OUTPUT_SCHEMA.required, "benchmarkRewriteSegments"],
      properties: { ...CONTENT_OUTPUT_SCHEMA.properties, benchmarkRewriteSegments: { type: "array", minItems: 2, maxItems: 24, items: { type: "object", additionalProperties: false, required: ["index", "text", "application"], properties: { index: { type: "integer", minimum: 1, maximum: 24 }, text: { type: "string", minLength: 1, maxLength: 8000 }, application: { type: "string", minLength: 1, maxLength: 500 } } } } },
    } : CONTENT_OUTPUT_SCHEMA;
    const generationInput = {
      taskBrief: {
        task: "short_video_production_pack",
        instruction: singleBenchmark ? "按单条参考的逐段结构映射仿写新选题，篇幅、钩子、衔接与 CTA 对齐；通用方法仅作辅助检查。" : "围绕选题完成可直接念出的原创口播稿；没有用户素材时可使用稳定通用知识。公司事实只使用已选资料，方法计划只指导写法。",
        writingIntent,
        companyKnowledgeSelected: selectedKnowledgeSourceIds.size > 0,
        topic: topicBrief,
      },
      // Legacy alias retained for old clients and stored snapshots.
      topic: topicBrief,
      materialSelection: {
        creationMode,
        autoRecommendedIds: recommendedBenchmarkIds,
        selectedIds: benchmarkEntryIds,
        selectedKnowledgeIds: [...selectedKnowledgeSourceIds],
        manuallyAddedIds: benchmarkEntryIds.filter((id) => !recommendedBenchmarkIds.includes(id)),
        manuallyRemovedIds: recommendedBenchmarkIds.filter((id) => !benchmarkEntryIds.includes(id)),
      },
      benchmarkUsageRequirements: benchmarkRows.results.map((row) => ({
        sourceId: row.library_entry_id,
        title: row.title,
        directPerformance: directBenchmarkPerformance(row),
        requirement: "沿用现有方法借鉴或反例规避说明，并在 citations 与 qualityReview.benchmarkMethods 中逐条记录该 sourceId。内容按相关性与价值选择性借鉴，不强制采用；采用时在 application 说明具体内容与落点，并引用相关来源原文。",
      })),
      historicalStyleProfile,
      methodologyPlan: methodologyPlan.snapshot,
      contextLayers: {
        taskSources: untrustedReferencePrompt(promptSourceLayers.taskSources),
        projectFacts: untrustedReferencePrompt(promptSourceLayers.projectFacts),
        strategyGuidance: untrustedReferencePrompt(promptSourceLayers.strategyGuidance),
        methodology: methodologyPlanText,
        supportingMethodReferences: untrustedReferencePrompt(promptSourceLayers.methodology.filter((source) => source.sourceId !== methodologyPlan.id)),
        referenceExamples: untrustedReferencePrompt(promptSourceLayers.referenceExamples),
      },
      sourceIndex: sourceList.map((source) => ({ sourceType: source.sourceType, sourceId: source.sourceId, title: source.title })),
      singleBenchmarkTemplate: rewriteSource ? { ...rewriteSource, bounds: benchmarkRewriteBounds(rewriteSource.sourceScript), budget: null as ReturnType<typeof benchmarkRewriteBudget> | null, plan: null as BenchmarkRewritePlan | null } : null,
      outputSchema,
    };
    let promptInputJson = JSON.stringify(generationInput);
    let inputJson = redactedGenerationInput({ taskBrief: generationInput.taskBrief, topic: generationInput.topic, materialSelection: generationInput.materialSelection, methodologyPlan: methodologyPlan.snapshot, singleBenchmarkTemplate: generationInput.singleBenchmarkTemplate, outputSchema }, generationContext.sourceManifest);
    let inputHash = await sha256Hex(new TextEncoder().encode(promptInputJson)); const now = new Date().toISOString(); const promptTemplateId = crypto.randomUUID();
    await insertGenerationSourceManifest({ context: generationContext, userId: user.id, modelProvider: config.provider, modelName: config.model }); sourceManifestInserted = true;
    let prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, promptVersion).first<{ id: string }>();
    if (!prompt) {
      await db.batch([
        db.prepare("UPDATE prompt_templates SET status = 'retired', updated_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND status = 'active' AND version != ?").bind(user.id, now, organizationId, projectId, promptVersion),
        db.prepare("INSERT OR IGNORE INTO prompt_templates (id, organization_id, project_id, task_type, version, name, status, system_prompt, output_schema_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'content_draft', ?, ?, 'active', ?, ?, ?, ?, ?, ?)").bind(promptTemplateId, organizationId, projectId, promptVersion, singleBenchmark ? "单条对标拆解、映射与仿写校对" : CONTENT_PROMPT_NAME, systemPrompt, JSON.stringify(outputSchema), user.id, user.id, now, now),
      ]);
      prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, promptVersion).first<{ id: string }>();
    }
    if (!prompt) { await finishGenerationSourceManifest(traceId, "failed", { promptHash: inputHash, errorCode: "PROMPT_REGISTRY_FAILED" }); return apiError("PROMPT_REGISTRY_FAILED", "提示词版本无法注册。", 500); }
    modelCallId = crypto.randomUUID();
    await db.prepare("INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'content_draft', ?, ?, ?, ?, 'started', ?, ?, ?, ?)").bind(modelCallId, organizationId, projectId, item.topic_id, prompt.id, config.provider, config.model, modelProfile, promptVersion, inputHash, inputJson, user.id, now).run();
    const finalContextCheck = await assertProjectGenerationContext({ authSubject: identity.authSubject, context: generationContext });
    if (!finalContextCheck.ok) { await finishGenerationSourceManifest(traceId, "blocked", { promptHash: inputHash, errorCode: finalContextCheck.code }); return apiError(finalContextCheck.code, finalContextCheck.message, finalContextCheck.status, finalContextCheck.details); }
    let pack: ReturnType<typeof productionPackSchema.parse> | null = null; let totalLatencyMs = 0; let correction = "";
    let citationDraft: ReturnType<typeof productionPackSchema.parse> | null = null;
    let previousErrorCode = "";
    const responseAttempts: Array<{ kind: string; content: string; truncated: boolean; latencyMs: number }> = [];
    const recordStep = async (kind: string, invocation: { content: string; latencyMs: number }) => {
      totalLatencyMs += invocation.latencyMs;
      responseAttempts.push({ kind, content: invocation.content.slice(0, 200_000), truncated: invocation.content.length > 200_000, latencyMs: invocation.latencyMs });
      await db.prepare("UPDATE model_calls SET output_json = ?, latency_ms = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'")
        .bind(JSON.stringify({ format: "content-generation-diagnostic.v1", validated: false, attempts: responseAttempts }), totalLatencyMs, modelCallId, organizationId, projectId).run();
    };
    if (generationInput.singleBenchmarkTemplate) {
      let planError = "";
      for (let step = 0; step < 2; step += 1) {
        const invocation = await invokeContentModel({ system: BENCHMARK_PLAN_SYSTEM, user: JSON.stringify({ source: rewriteSource, topic: topicBrief, projectFacts: generationInput.contextLayers.projectFacts, correction: planError }), profile: modelProfile, nativeJson: step === 0, temperature: 0.2 });
        await recordStep("benchmark_structure", invocation);
        try { generationInput.singleBenchmarkTemplate.plan = validateBenchmarkRewritePlan(rewriteSource!.sourceScript, parseModelJson(invocation.content)); break; }
        catch (error) { planError = error instanceof Error ? error.message : "原稿拆解无效"; }
      }
      if (!generationInput.singleBenchmarkTemplate.plan) throw new ModelRequestError(`原稿结构未通过校验：${planError}`, "BENCHMARK_PLAN_INVALID");
      generationInput.singleBenchmarkTemplate.budget = benchmarkRewriteBudget(rewriteSource!.sourceScript, generationInput.singleBenchmarkTemplate.plan);
      promptInputJson = JSON.stringify(generationInput);
      inputJson = redactedGenerationInput({ taskBrief: generationInput.taskBrief, topic: topicBrief, materialSelection: generationInput.materialSelection, methodologyPlan: methodologyPlan.snapshot, singleBenchmarkTemplate: generationInput.singleBenchmarkTemplate, outputSchema }, generationContext.sourceManifest);
      inputHash = await sha256Hex(new TextEncoder().encode(promptInputJson));
      await db.prepare("UPDATE model_calls SET input_json = ?, input_hash = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(inputJson, inputHash, modelCallId, organizationId, projectId).run();
    }
    let draftGenerations = 0;
    const maxAttempts = singleBenchmark ? 5 : 3;
    for (let attempt = 0; attempt < maxAttempts && !pack; attempt += 1) {
      try {
        const repairOnly = Boolean(attempt > 0 && citationDraft && (isCitationRepairError(previousErrorCode) || previousErrorCode === "CITATION_REPAIR_FAILED"));
        const rewriteRevision = !repairOnly && singleBenchmark && citationDraft && generationInput.singleBenchmarkTemplate?.plan
          ? benchmarkRewriteRevision(rewriteSource!.sourceScript, generationInput.singleBenchmarkTemplate.plan, citationDraft, correction)
          : null;
        const attemptInputJson = rewriteRevision ? JSON.stringify({ ...generationInput, rewriteRevision }) : promptInputJson;
        if (!repairOnly) draftGenerations += 1;
        const invocation = await invokeContentModel(repairOnly ? {
          system: CITATION_REPAIR_SYSTEM,
          user: JSON.stringify({
            draft: citationDraft,
            draftAnchors: buildCitationDraftAnchors(citationDraft!),
            sourceAnchors: buildCitationSourceAnchors(sourceList),
            methodologyPlan: methodologyPlan.snapshot,
            sources: sourceList,
            required: {
              strategy: strategy.id,
              method_knowledge: methodologyPlan.id,
              knowledge: citationDraft!.citations.filter((citation) => citation.sourceType === "knowledge").map((citation) => citation.sourceId),
              benchmark: benchmarkEntryIds,
              benchmarkMethods: benchmarkEntryIds,
              video_analysis: sourceList.some((source) => source.sourceType === "video_analysis"),
              historical_copy: historicalMatches.length > 0,
            },
            error: correction,
          }),
          profile: modelProfile,
          nativeJson: true,
          temperature: 0.1,
          maxTokens: 6000,
        } : {
          system: systemPrompt,
          user: `${singleBenchmark ? "请按 singleBenchmarkTemplate.plan 逐段仿写；若含 rewriteRevision 则编辑其 previousDraft，按逐段预算修正而不是重新构思。必须返回完整生产包、benchmarkRewriteSegments 和有效引用。" : "请根据以下 JSON 输入生成生产包。严格遵守 contextLayers 的事实、方法与案例边界；methodologyPlan 已在调用前由系统确定，不要自行改写计划。benchmarkUsageRequirements 中每一条已勾选参考素材都要逐条记录：每条都要各有一个 benchmark citation，并在 qualityReview.benchmarkMethods 中用相同 sourceId 说明方法应用或反例规避方式；内容借鉴可选，不强制采用："}\n${attemptInputJson}${rewriteRevision ? "" : correction}`,
          profile: modelProfile,
          temperature: rewriteRevision ? 0.2 : undefined,
          nativeJson: attempt === 0,
        });
        totalLatencyMs += invocation.latencyMs;
        // Persist unvalidated responses separately from completed content versions.
        // A failed repair must not erase the original draft response.
        responseAttempts.push({ kind: repairOnly ? "citation_repair" : rewriteRevision ? "benchmark_revision" : "generation", content: invocation.content.slice(0, 200_000), truncated: invocation.content.length > 200_000, latencyMs: invocation.latencyMs });
        await db.prepare("UPDATE model_calls SET output_json = ?, latency_ms = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'")
          .bind(JSON.stringify({ format: "content-generation-diagnostic.v1", validated: false, attempts: responseAttempts }), totalLatencyMs, modelCallId, organizationId, projectId).run();
        let modelOutput: unknown;
        try {
          const parsedOutput = parseModelJson(invocation.content);
          modelOutput = repairOnly && citationDraft
            ? applyCitationRepair(citationDraft, parsedOutput, sourceList, benchmarkEntryIds).pack
            : deduplicateTraceableCitations(normalizeGeneratedProductionPackTextBounds(parsedOutput), sourceList);
        } catch (reason) {
          throw new ModelRequestError(reason instanceof Error ? reason.message : "模型响应不是完整 JSON 对象。", repairOnly ? "CITATION_REPAIR_FAILED" : "INVALID_MODEL_OUTPUT");
        }
        if (modelOutput && typeof modelOutput === "object") {
          // Model-provided computed reports never become trusted metadata.
          delete (modelOutput as Record<string, unknown>).benchmarkRewrite;
          if (!singleBenchmark) delete (modelOutput as Record<string, unknown>).benchmarkRewriteSegments;
        }
        const candidate = productionPackSchema.safeParse(modelOutput);
        if (!candidate.success) throw new ModelRequestError(`模型输出未通过生产包校验：${productionPackValidationIssue(candidate.error, modelOutput)}`, "INVALID_MODEL_OUTPUT");
        const incomplete = incompleteScriptReason(candidate.data);
        if (incomplete) throw new ModelRequestError(incomplete, "INCOMPLETE_CONTENT_SCRIPT");
        if (!candidate.data.writingIntent) throw new ModelRequestError("请返回 writingIntent，说明本次实际采用的创作意图。", "WRITING_INTENT_REQUIRED");
        if (writingIntent !== "auto" && candidate.data.writingIntent.kind !== writingIntent) throw new ModelRequestError("实际创作意图与用户选择不一致，请按用户选择完成稿件。", "WRITING_INTENT_MISMATCH");
        citationDraft = candidate.data;
        const invalidCitation = candidate.data.citations.find((citation) => {
          const source = sources.get(`${citation.sourceType}:${citation.sourceId}`);
          return !source || !citationQuoteMatchesSource(source.text, citation.quote);
        });
        if (invalidCitation) {
          throw new ModelRequestError(
            `引用 ${invalidCitation.sourceType}:${invalidCitation.sourceId} 不是来源 text 中的连续原文。请从该来源直接复制 8–80 字短原文，不要改写或补全。`,
            "UNTRACEABLE_MODEL_CITATION",
          );
        }
        const hasCitation = (sourceType: Source["sourceType"], sourceIds?: Set<string>) => candidate.data.citations.some((citation) => citation.sourceType === sourceType && (!sourceIds || sourceIds.has(citation.sourceId)));
        if (!hasCitation("strategy")) throw new ModelRequestError("模型没有形成当前内容策略的可追溯引用。", "STRATEGY_CITATION_REQUIRED");
        if (!hasCitation("method_knowledge", new Set([methodologyPlan.id]))) throw new ModelRequestError("模型没有引用本次确定性方法计划，无法确认成稿按所选方法执行。", "METHODOLOGY_PLAN_CITATION_REQUIRED");
        if (sourceList.some((source) => source.sourceType === "video_analysis") && !hasCitation("video_analysis")) throw new ModelRequestError("模型没有实际引用选题关联的视频分析。", "VIDEO_ANALYSIS_CITATION_REQUIRED");
        const benchmarkMethods = candidate.data.qualityReview?.benchmarkMethods ?? [];
        const benchmarkCoverage = inspectSelectedBenchmarkCoverage({
          selectedIds: benchmarkEntryIds,
          citations: candidate.data.citations,
          methods: benchmarkMethods,
        });
        if (benchmarkCoverage.missingCitationIds.length) {
          throw new ModelRequestError(`以下已勾选参考素材没有逐条形成 benchmark 引用：${benchmarkCoverage.missingCitationIds.join("、")}。每条所选素材都必须引用其来源原文。`, "BENCHMARK_CITATION_REQUIRED");
        }
        if (historicalMatches.length && !candidate.data.citations.some((citation) => citation.sourceType === "historical_copy")) throw new ModelRequestError("模型没有实际引用本次自动检索到的品牌历史文案。", "HISTORICAL_COPY_CITATION_REQUIRED");
        const benchmarkSourceIds = new Set(benchmarkRows.results.map((row) => row.library_entry_id));
        if (benchmarkCoverage.unexpectedMethodIds.length || benchmarkMethods.some((method) => !benchmarkSourceIds.has(method.sourceId))) throw new ModelRequestError("质量诊断引用了本次未选择的对标样本。", "INVALID_BENCHMARK_METHOD_SOURCE");
        if (benchmarkCoverage.missingMethodIds.length) {
          throw new ModelRequestError(`以下已勾选参考素材没有说明采用的方法和具体落点：${benchmarkCoverage.missingMethodIds.join("、")}。qualityReview.benchmarkMethods 必须逐条覆盖全部所选素材。`, "BENCHMARK_METHOD_REQUIRED");
        }
        let candidateWithMethodology = candidate.data.qualityReview ? {
          ...candidate.data,
          qualityReview: {
            ...candidate.data.qualityReview,
            methodologyApplication: {
              planId: methodologyPlan.id,
              planVersion: methodologyPlan.version,
              mode: methodologyPlan.mode,
              selectedMethodIds: [...methodologyPlan.selectedIds],
            },
          },
        } : candidate.data;
        if (rewriteSource && generationInput.singleBenchmarkTemplate?.plan) {
          const plan = generationInput.singleBenchmarkTemplate.plan;
          try {
            const alignment = validateBenchmarkRewriteDraft(rewriteSource, plan, candidate.data.fullScript, candidate.data.benchmarkRewriteSegments);
            const alignedScript = alignment.segments.map(segment => segment.text).join("\n\n");
            const reviewInvocation = await invokeContentModel({ system: BENCHMARK_REVIEW_SYSTEM, user: JSON.stringify({ source: rewriteSource, plan, topic: topicBrief, projectFacts: generationInput.contextLayers.projectFacts, draft: candidate.data.fullScript }), profile: modelProfile, nativeJson: true, temperature: 0.1, maxTokens: 2500 });
            await recordStep("benchmark_review", reviewInvocation);
            const review = benchmarkRewriteReviewSchema.parse(parseModelJson(reviewInvocation.content));
            if (!review.passed) throw new Error(review.issues.join("；"));
            candidateWithMethodology = { ...candidateWithMethodology, fullScript: alignedScript, benchmarkRewriteSegments: undefined, benchmarkRewrite: {
              version: "single-benchmark.v1", ...rewriteSource, sourceCharacters: rewriteCharacterCount(rewriteSource.sourceScript),
              ...alignment, generatedScript: alignedScript, status: "aligned", plan, review,
            } };
          } catch (error) {
            if (error instanceof ModelRequestError) throw error;
            throw new ModelRequestError(`单条仿写校对未通过：${error instanceof Error ? error.message : "结构或篇幅不匹配"}`, "BENCHMARK_ALIGNMENT_FAILED");
          }
        }
        if (historicalMatches.length) {
          const historicalSourceIds = candidate.data.citations.filter((citation) => citation.sourceType === "historical_copy").map((citation) => citation.sourceId);
          const application = validateHistoricalStyleApplication(candidate.data.fullScript, historicalStyleProfile, historicalMatches.map((match) => match.record), historicalSourceIds);
          if (application.status === "rewrite") {
            const mismatches = application.checks.filter((check) => !check.matched).map((check) => `${check.label}应为“${check.expected}”，实际为“${check.actual}”`);
            if (!application.originality.passed) mismatches.push(`与历史文案连续重复 ${application.originality.longestSharedCharacters} 字：“${application.originality.phrase || "重复片段"}”`);
            throw new ModelRequestError(`历史文案应用验收未通过：${mismatches.join("；")}。请只重写 fullScript 及受影响的分镜、短版和发布文案，保留可追溯引用。`, "HISTORICAL_STYLE_VALIDATION_FAILED");
          }
          const candidateWithHistory = { ...candidateWithMethodology, historicalStyleApplication: application };
          pack = { ...candidateWithHistory, sourceUsageReport: buildSourceUsageReport(sourceList, candidate.data.citations, selectedKnowledgeSourceIds) };
        } else pack = { ...candidateWithMethodology, sourceUsageReport: buildSourceUsageReport(sourceList, candidate.data.citations, selectedKnowledgeSourceIds) };
      } catch (error) {
        if (!(error instanceof ModelRequestError) || attempt === maxAttempts - 1) throw error;
        const citationFailure = citationDraft && (isCitationRepairError(error.code) || error.code === "CITATION_REPAIR_FAILED");
        // Standard generation keeps its existing budget. Template mode allows two edits of the actual draft.
        if ((!singleBenchmark && attempt === 1 && !citationFailure) || (singleBenchmark && draftGenerations >= 3 && !citationFailure)) throw error;
        previousErrorCode = error.code;
        correction = citationFailure
          ? `上次引用校验失败：${error.message}。仅返回引用修复 JSON，不要返回完整生产包或修改正文。保留系统已有的有效引用；从 draftAnchors 选择真实片段 id，补齐 required 中缺失的引用及方法说明。没有指定 knowledge 时不需要补充品牌知识。`
          : singleBenchmark
          ? `\n\n上次单条仿写未通过：${error.message}。按 singleBenchmarkTemplate.plan 修正具体偏离，保持原稿钩子、衔接与 CTA 类型；返回完整生产包及 benchmarkRewriteSegments，正文必须等于逐段新稿。保留有效引用，不编造用户经历。`
          : error.code === "HISTORICAL_STYLE_VALIDATION_FAILED"
          ? `\n\n上次生成未通过历史文案应用验收：${error.message}。请依据 historicalStyleProfile 修正完整口播稿，并同步修正 shortScript、storyboard、hooks、commentPrompt 和 adaptations。不要输出 historicalStyleApplication，该字段由系统计算；仍需返回完整 JSON。`
          : `\n\n上次原生 JSON 生成未完成：${error.message}。本次已切换兼容模式。请直接返回一个完整 JSON 对象，不要使用 Markdown 或代码围栏；严格按 Schema 输出全部字段和 qualityReview；只从 contextLayers.projectFacts 提取客户事实，并用对应来源的连续 8–80 字原文形成 citations；contextLayers.methodology 只指导写法，contextLayers.referenceExamples 中已选 benchmark 可以选择性借鉴有归属的外部内容，其他参考仍只指导结构，均不能支撑客户事实；必须引用当前 strategy 和 methodologyPlan.planId 对应的 method_knowledge；选题指定 knowledge 时引用至少一条指定来源，未指定时不得补充品牌知识或编造 knowledge 来源；输入含 video_analysis 或 historical_copy 时分别至少逐字引用一条实际采用的来源；对于 benchmarkUsageRequirements 中的每个 sourceId，不得遗漏：必须逐条生成一个 benchmark citation，并逐条生成一个 qualityReview.benchmarkMethods 项，明确 method 和 application。${BENCHMARK_CONTENT_GUIDANCE}`;
      }
    }
    if (!pack) throw new ModelRequestError("内容模型未生成有效生产包。", "INVALID_MODEL_OUTPUT");
    const benchmarkUsage = benchmarkRows.results.map((row) => ({
      id: row.library_entry_id,
      title: row.title,
      directPerformance: directBenchmarkPerformance(row),
      citation: pack.citations.find((citation) => citation.sourceType === "benchmark" && citation.sourceId === row.library_entry_id)?.quote || null,
      method: pack.qualityReview?.benchmarkMethods.find((method) => method.sourceId === row.library_entry_id) || null,
    }));
    const nextVersion = item.current_version + 1; const versionId = crypto.randomUUID(); const completedAt = new Date().toISOString(); const packJson = JSON.stringify(pack);
    const statements = [
      db.prepare("UPDATE content_items SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(nextVersion, user.id, completedAt, contentId, organizationId, projectId, item.current_version),
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, prompt_version, model_call_id, input_snapshot_json, input_snapshot_hash, source_manifest_json, context_snapshot_id, created_by, created_at) SELECT ?, organization_id, project_id, id, ?, 'ai', ?, ?, ?, 'AI 生成口播稿与生产包', ?, ?, ?, ?, ?, ?, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(versionId, nextVersion, packJson, pack.fullScript, pack.shortScript, promptVersion, modelCallId, inputJson, inputHash, JSON.stringify(generationContext.sourceManifest), null, user.id, completedAt, contentId, organizationId, projectId, nextVersion),
      db.prepare("UPDATE model_calls SET status = 'completed', output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(packJson, totalLatencyMs, completedAt, modelCallId, organizationId, projectId),
      ...pack.citations.map((citation) => db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) SELECT ?, ?, ?, ?, id, ?, ?, ?, ?, ? FROM content_versions WHERE id = ? AND organization_id = ? AND project_id = ?").bind(crypto.randomUUID(), organizationId, projectId, contentId, citation.sourceType, citation.sourceId, citation.quote, user.id, completedAt, versionId, organizationId, projectId)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, organization_id, project_id, ?, 'content.generated', 'content_item', id, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(crypto.randomUUID(), user.id, JSON.stringify({ version: nextVersion, modelCallId, promptVersion, creationMode, methodologyPlan: methodologyPlan.snapshot, benchmarkEntryIds, recommendedBenchmarkIds, manuallyAddedBenchmarkIds: benchmarkEntryIds.filter((id) => !recommendedBenchmarkIds.includes(id)), manuallyRemovedBenchmarkIds: recommendedBenchmarkIds.filter((id) => !benchmarkEntryIds.includes(id)), benchmarkCitations: pack.citations.filter((citation) => citation.sourceType === "benchmark").length, benchmarkUsage, historicalCopyIds: historicalMatches.map((match) => match.record.id), historicalCopyCitations: pack.citations.filter((citation) => citation.sourceType === "historical_copy").length, historicalStyleStatus: pack.historicalStyleApplication?.status || null, historicalStyleMatchedChecks: pack.historicalStyleApplication?.matchedChecks || 0, historicalStyleTotalChecks: pack.historicalStyleApplication?.totalChecks || 0 }), completedAt, contentId, organizationId, projectId, nextVersion),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) { await finishGenerationSourceManifest(traceId, "failed", { promptHash: inputHash, errorCode: "CONTENT_VERSION_CONFLICT" }); return apiError("CONTENT_VERSION_CONFLICT", "生成期间内容已被其他成员更新，本次结果未覆盖新版本。", 409); }
    try { await finishGenerationSourceManifest(traceId, "completed", { promptHash: inputHash }); } catch { /* best-effort security trace */ }
    return Response.json({ item: { id: contentId, current_version: nextVersion, version_id: versionId, generation_mode: "ai", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, prompt_version: promptVersion, model_call_id: modelCallId, updated_at: completedAt }, methodologyPlan: methodologyPlan.snapshot, sourcesUsed: generationContext.sourceManifest, benchmarksUsed: benchmarkUsage, historicalCopiesUsed: historicalMatches.filter((match) => pack.citations.some((citation) => citation.sourceType === "historical_copy" && citation.sourceId === match.record.id)).map((match) => ({ id: match.record.id, title: match.record.title, characterCount: match.record.character_count, monetizationTypes: JSON.parse(match.record.monetization_types_json || "[]") })) });
  } catch (error) {
    console.error("[content.generate] Unhandled generation error", error);
    if (modelCallId) {
      try {
        const db = getD1(); const code = error instanceof ModelRequestError ? error.code : "MODEL_GENERATION_FAILED";
        await db.prepare("UPDATE model_calls SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'started'").bind(code, error instanceof Error ? error.message.slice(0, 1000) : "内容生成失败", new Date().toISOString(), modelCallId).run();
      } catch { /* best-effort failure trace */ }
    }
    if (sourceManifestInserted && traceId) { try { await finishGenerationSourceManifest(traceId, "failed", { errorCode: error instanceof ModelRequestError ? error.code : "MODEL_GENERATION_FAILED" }); } catch { /* best-effort security trace */ } }
    if (error instanceof ModelConfigurationError) return apiError("CONTENT_MODEL_NOT_CONFIGURED", error.message, 503);
    if (error instanceof ModelRequestError) {
      const message = error.code === "MODEL_EMPTY_RESPONSE"
        ? "DeepSeek 连续两次返回空内容。系统已尝试原生 JSON 和兼容模式，请稍后重试或缩短输入资料。"
        : error.code === "CITATION_REPAIR_FAILED"
          ? "引用与正文仍未匹配，自动纠正未成功。本次未保存新版本，已有版本不受影响，请重试生成。"
        : error.message;
      return apiError(error.code, message, 502);
    }
    const hostname = new URL(request.url).hostname.toLowerCase();
    const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
    if (isLoopback && error instanceof Error) {
      return apiError("INTERNAL_ERROR", "服务暂时无法完成请求。", 500, { diagnostic: error.message.slice(0, 500) });
    }
    return errorResponse(error);
  }
}
