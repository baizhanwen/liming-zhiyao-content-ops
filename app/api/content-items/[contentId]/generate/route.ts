import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { CONTENT_OUTPUT_SCHEMA, CONTENT_PROMPT_NAME, CONTENT_PROMPT_VERSION, CONTENT_SYSTEM_PROMPT, analysisReportSourceText, buildSourceUsageReport, citationQuoteMatchesSource, generateContentSchema, normalizeGeneratedProductionPackTextBounds, parseModelJson, partitionContentPromptSources, productionPackSchema, productionPackValidationIssue } from "../../../../../lib/content-production";
import { invokeContentModel, ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../../lib/model-adapter";
import { buildPublishedCopyProfile, publishedCopyPromptSource, selectRelevantPublishedCopies, validateHistoricalStyleApplication, type PublishedCopyRecord } from "../../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../../lib/operations";
import { retrieveDefaultProjectGenerationSources } from "../../../../../lib/generation-context-sources";
import { methodologyPlanPromptSource, selectAuthorizedMethodologyPlan } from "../../../../../lib/authorized-methodology-router";
import { materialFeedbackPrompt, type MaterialFeedback } from "../../../../../lib/material-recommendation";
import { assertProjectGenerationContext, buildProjectGenerationContext, finishGenerationSourceManifest, insertGenerationSourceManifest, redactedGenerationInput, untrustedReferencePrompt } from "../../../../../lib/project-generation-context";
import { benchmarkDirectPerformancePrompt, inspectSelectedBenchmarkCoverage, type BenchmarkDirectPerformance } from "../../../../../lib/benchmark-generation-context";

export const dynamic = "force-dynamic";

type Source = { sourceType: "topic" | "memory" | "knowledge" | "video_atom" | "inspiration" | "video_analysis" | "strategy" | "benchmark" | "method_knowledge" | "historical_copy"; sourceId: string; title: string; text: string; systemMethodology?: boolean };
type BenchmarkRow = {
  library_entry_id: string;
  title: string;
  analysis_id: string;
  report_json: string;
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
    const { organizationId, projectId, benchmarkEntryIds, recommendedBenchmarkIds } = parsed.data;
    const modelProfile = "max" as const;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能生成内容。", 403);
    const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "modelCalls");
    if (!quota.allowed) return apiError("MODEL_QUOTA_EXCEEDED", `本月模型调用已达到 ${quota.limit} 次套餐上限。`, 429, { usage: quota.current, limit: quota.limit });
    const config = readContentModelConfig(modelProfile);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare(`
      SELECT c.id, c.title, c.current_version, c.topic_id, t.title AS topic_title, t.angle, t.pillar, t.audience, t.objective, t.hook, t.rationale
      FROM content_items c INNER JOIN topic_ideas t ON t.id = c.topic_id AND t.organization_id = c.organization_id AND t.project_id = c.project_id
      WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND c.status NOT IN ('published', 'reviewed', 'archived')
    `).bind(contentId, organizationId, projectId).first<{ id: string; title: string; current_version: number; topic_id: string; topic_title: string; angle: string | null; pillar: string | null; audience: string | null; objective: string | null; hook: string | null; rationale: string | null }>();
    if (!item) return apiError("CONTENT_NOT_GENERATABLE", "内容不存在、已归档或当前状态不可生成。", 409);
    const [strategy, knowledgeRows, citationRows, historicalRows] = await Promise.all([
      db.prepare("SELECT id, name, positioning, persona, target_audience, pain_points_json, pillars_json, style_notes, cadence, conversion_path, objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").bind(organizationId, projectId).first<Record<string, string | null>>(),
      db.prepare(`
        SELECT k.id, k.title, k.category, v.body FROM knowledge_items k
        INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
        LEFT JOIN topic_citations selected ON selected.organization_id = k.organization_id AND selected.project_id = k.project_id AND selected.topic_id = ? AND selected.citation_type = 'knowledge' AND selected.citation_id = k.id
        WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
        ORDER BY CASE WHEN selected.id IS NOT NULL THEN 0 ELSE 1 END, CASE k.category WHEN 'compliance' THEN 0 WHEN 'brand_voice' THEN 1 WHEN 'client_preference' THEN 2 ELSE 3 END, k.updated_at DESC LIMIT 36
      `).bind(item.topic_id, organizationId, projectId).all<{ id: string; title: string; category: string; body: string }>(),
      db.prepare("SELECT citation_type, citation_id, quote FROM topic_citations WHERE organization_id = ? AND project_id = ? AND topic_id = ? ORDER BY created_at ASC").bind(organizationId, projectId, item.topic_id).all<{ citation_type: string; citation_id: string; quote: string | null }>(),
      db.prepare(`SELECT pc.id, pc.title, pc.body, pc.platform, pc.content_format, pc.source_type, pc.published_at, pc.external_url,
        pc.character_count, pc.paragraph_count, pc.monetization_types_json, pc.monetization_detail, pc.analysis_json,
        CASE WHEN latest.id IS NULL THEN pc.performance_json ELSE json_set(
          COALESCE(NULLIF(pc.performance_json, ''), '{}'),
          '$.views', latest.views, '$.likes', latest.likes, '$.saves', latest.saves, '$.leads', latest.leads
        ) END AS performance_json,
        pc.created_at, pc.updated_at
        FROM published_copy_records pc
        LEFT JOIN publication_metric_snapshots latest ON latest.id = (
          SELECT snapshot.id FROM publication_metric_snapshots snapshot
          WHERE snapshot.organization_id = pc.organization_id AND snapshot.project_id = pc.project_id AND snapshot.publication_id = pc.publication_id
          ORDER BY snapshot.observed_at DESC, snapshot.created_at DESC LIMIT 1
        )
        WHERE pc.organization_id = ? AND pc.project_id = ? AND pc.deleted_at IS NULL
        ORDER BY COALESCE(pc.published_at, pc.created_at) DESC LIMIT 200`).bind(organizationId, projectId).all<PublishedCopyRecord>(),
    ]);
    const benchmarkRows = benchmarkEntryIds.length ? await db.prepare(`
      SELECT library.id AS library_entry_id, COALESCE(v.title, v.source_url, '未命名素材') AS title, analysis.id AS analysis_id, analysis.report_json,
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
    const benchmarkFeedbackRows = benchmarkEntryIds.length ? await db.prepare(`WITH cited AS (
        SELECT DISTINCT citation_id AS entry_id, content_item_id
        FROM content_citations WHERE organization_id = ? AND project_id = ? AND citation_type = 'benchmark'
      ), versions AS (
        SELECT cc.citation_id AS entry_id, COUNT(DISTINCT cc.content_item_id) AS usage_count,
          COUNT(DISTINCT CASE WHEN cv.generation_mode = 'manual' THEN cv.id END) AS manual_revision_count
        FROM content_citations cc INNER JOIN content_versions cv ON cv.id = cc.content_version_id
        WHERE cc.organization_id = ? AND cc.project_id = ? AND cc.citation_type = 'benchmark' GROUP BY cc.citation_id
      ), reviews AS (
        SELECT cited.entry_id,
          COUNT(DISTINCT CASE WHEN r.decision = 'approved' THEN r.id END) AS approved_count,
          COUNT(DISTINCT CASE WHEN r.decision = 'changes_requested' THEN r.id END) AS changes_requested_count
        FROM cited LEFT JOIN content_reviews r ON r.content_item_id = cited.content_item_id AND r.organization_id = ? AND r.project_id = ? GROUP BY cited.entry_id
      ), comments AS (
        SELECT cited.entry_id, COUNT(DISTINCT c.id) AS comment_count FROM cited
        LEFT JOIN content_comments c ON c.content_item_id = cited.content_item_id AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL GROUP BY cited.entry_id
      ), published AS (
        SELECT cited.entry_id, COUNT(DISTINCT p.id) AS published_count,
          COALESCE(SUM(m.views), 0) AS views, COALESCE(SUM(m.likes), 0) AS likes, COALESCE(SUM(m.comments), 0) AS comments,
          COALESCE(SUM(m.shares), 0) AS shares, COALESCE(SUM(m.saves), 0) AS saves,
          COALESCE(SUM(m.followers_gained), 0) AS followers_gained, COALESCE(SUM(m.leads), 0) AS leads,
          COALESCE(MAX(m.completion_rate_bps), 0) AS completion_rate_bps
        FROM cited LEFT JOIN publication_records p ON p.content_item_id = cited.content_item_id AND p.organization_id = ? AND p.project_id = ? AND p.status = 'published'
        LEFT JOIN publication_metric_snapshots m ON m.id = (SELECT latest.id FROM publication_metric_snapshots latest WHERE latest.publication_id = p.id ORDER BY latest.observed_at DESC, latest.created_at DESC LIMIT 1)
        GROUP BY cited.entry_id
      ) SELECT v.entry_id, v.usage_count, v.manual_revision_count,
        COALESCE(r.approved_count, 0) AS approved_count, COALESCE(r.changes_requested_count, 0) AS changes_requested_count,
        COALESCE(c.comment_count, 0) AS comment_count, COALESCE(p.published_count, 0) AS published_count,
        COALESCE(p.views, 0) AS views, COALESCE(p.likes, 0) AS likes, COALESCE(p.comments, 0) AS comments,
        COALESCE(p.shares, 0) AS shares, COALESCE(p.saves, 0) AS saves, COALESCE(p.followers_gained, 0) AS followers_gained,
        COALESCE(p.leads, 0) AS leads, COALESCE(p.completion_rate_bps, 0) AS completion_rate_bps
      FROM versions v LEFT JOIN reviews r ON r.entry_id = v.entry_id LEFT JOIN comments c ON c.entry_id = v.entry_id LEFT JOIN published p ON p.entry_id = v.entry_id
      WHERE v.entry_id IN (${benchmarkEntryIds.map(() => "?").join(", ")})`).bind(
        organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, ...benchmarkEntryIds,
      ).all<{ entry_id: string; usage_count: number; manual_revision_count: number; approved_count: number; changes_requested_count: number; comment_count: number; published_count: number; views: number; likes: number; comments: number; shares: number; saves: number; followers_gained: number; leads: number; completion_rate_bps: number }>() : { results: [] };
    const benchmarkFeedback = new Map<string, MaterialFeedback>(benchmarkFeedbackRows.results.map((row) => [row.entry_id, {
      usageCount: Number(row.usage_count || 0), manualRevisionCount: Number(row.manual_revision_count || 0), approvedCount: Number(row.approved_count || 0), changesRequestedCount: Number(row.changes_requested_count || 0), commentCount: Number(row.comment_count || 0), publishedCount: Number(row.published_count || 0),
      performance: { views: Number(row.views || 0), likes: Number(row.likes || 0), comments: Number(row.comments || 0), shares: Number(row.shares || 0), saves: Number(row.saves || 0), followersGained: Number(row.followers_gained || 0), leads: Number(row.leads || 0), completionRateBps: Number(row.completion_rate_bps || 0) },
    }]));
    if (!strategy?.id) return apiError("ACTIVE_STRATEGY_REQUIRED", "请先启用该项目的内容策略，再生成生产包。", 409);
    if (!knowledgeRows.results.length) return apiError("CONFIRMED_KNOWLEDGE_REQUIRED", "请先确认至少一条品牌知识，再生成生产包。", 409);
    const selectedKnowledgeSourceIds = new Set(citationRows.results.filter((row) => row.citation_type === "knowledge").map((row) => row.citation_id));
    const topicText = [item.topic_title, item.angle, item.pillar, item.audience, item.objective, item.hook, item.rationale].filter(Boolean).join("\n");
    const historicalQuery = [topicText, strategy?.positioning, strategy?.target_audience, strategy?.conversion_path, strategy?.style_notes].filter(Boolean).join("\n");
    const historicalMatches = selectRelevantPublishedCopies(historicalRows.results, historicalQuery, 5);
    const defaultProjectSources = await retrieveDefaultProjectGenerationSources({
      organizationId,
      projectId,
      userId: user.id,
      purpose: "content_generation",
      query: historicalQuery,
      methodologyTask: "content",
      maxCharacters: 24_000,
    });
    const methodologyPlan = selectAuthorizedMethodologyPlan({
      task: "content",
      query: historicalQuery,
      mode: benchmarkRows.results.length ? "benchmark-structure" : undefined,
      availableMethodSources: defaultProjectSources.methodologySources,
      hasBenchmarks: benchmarkRows.results.length > 0,
      hasHistoricalCopies: historicalMatches.length > 0,
    });
    const methodologyPlanText = methodologyPlanPromptSource(methodologyPlan);
    const sources = new Map<string, Source>();
    for (const source of defaultProjectSources.sources) {
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
    const strategyText = [strategy.name, strategy.positioning, strategy.persona, strategy.target_audience, strategy.pain_points_json, strategy.pillars_json, strategy.style_notes, strategy.cadence, strategy.conversion_path, strategy.objectives_json].filter(Boolean).join("\n").slice(0, 8_000);
    if (strategy?.id) {
      sources.set(`strategy:${strategy.id}`, { sourceType: "strategy", sourceId: strategy.id, title: strategy.name || "当前内容策略", text: strategyText });
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
      text: `${analysisReportSourceText(row.report_json)}\n\n${benchmarkDirectPerformancePrompt(directBenchmarkPerformance(row))}\n\n[系统历史反馈]\n${materialFeedbackPrompt(benchmarkFeedback.get(row.library_entry_id))}`,
    });
    for (const match of historicalMatches) sources.set(`historical_copy:${match.record.id}`, { sourceType: "historical_copy", sourceId: match.record.id, title: match.record.title, text: publishedCopyPromptSource(match.record) });
    const sourceList = Array.from(sources.values()); const historicalStyleProfile = buildPublishedCopyProfile(historicalRows.results);
    const promptSourceLayers = partitionContentPromptSources(sourceList);
    const contextResult = await buildProjectGenerationContext({ authSubject: identity.authSubject, userId: user.id, organizationId, projectId, capability: "content", sources: sourceList });
    if (!contextResult.ok) return apiError(contextResult.code, contextResult.message, contextResult.status, contextResult.details);
    const generationContext = contextResult.context; traceId = generationContext.traceId;
    const topicBrief = { id: item.topic_id, title: item.topic_title, angle: item.angle, pillar: item.pillar, audience: item.audience, objective: item.objective, hook: item.hook, rationale: item.rationale };
    const generationInput = {
      taskBrief: {
        task: "short_video_production_pack",
        instruction: "依据项目事实完成原创短视频生产包；先执行确定性方法计划，再生成和自检。",
        topic: topicBrief,
      },
      // Legacy alias retained for old clients and stored snapshots.
      topic: topicBrief,
      materialSelection: {
        autoRecommendedIds: recommendedBenchmarkIds,
        selectedIds: benchmarkEntryIds,
        manuallyAddedIds: benchmarkEntryIds.filter((id) => !recommendedBenchmarkIds.includes(id)),
        manuallyRemovedIds: recommendedBenchmarkIds.filter((id) => !benchmarkEntryIds.includes(id)),
      },
      benchmarkUsageRequirements: benchmarkRows.results.map((row) => ({
        sourceId: row.library_entry_id,
        title: row.title,
        directPerformance: directBenchmarkPerformance(row),
        requirement: "必须实际采用一种可辨认的方法，并同时在 citations 与 qualityReview.benchmarkMethods 中逐条记录该 sourceId。",
      })),
      historicalStyleProfile,
      methodologyPlan: methodologyPlan.snapshot,
      contextLayers: {
        taskSources: untrustedReferencePrompt(promptSourceLayers.taskSources),
        projectFacts: untrustedReferencePrompt(promptSourceLayers.projectFacts),
        methodology: methodologyPlanText,
        supportingMethodReferences: untrustedReferencePrompt(promptSourceLayers.methodology.filter((source) => source.sourceId !== methodologyPlan.id)),
        referenceExamples: untrustedReferencePrompt(promptSourceLayers.referenceExamples),
      },
      sourceIndex: sourceList.map((source) => ({ sourceType: source.sourceType, sourceId: source.sourceId, title: source.title })),
      outputSchema: CONTENT_OUTPUT_SCHEMA,
    };
    const promptInputJson = JSON.stringify(generationInput); const inputJson = redactedGenerationInput({ topic: generationInput.topic, materialSelection: generationInput.materialSelection, methodologyPlan: methodologyPlan.snapshot, outputSchema: CONTENT_OUTPUT_SCHEMA }, generationContext.sourceManifest); const inputHash = await sha256Hex(new TextEncoder().encode(promptInputJson)); const now = new Date().toISOString(); const promptTemplateId = crypto.randomUUID();
    await insertGenerationSourceManifest({ context: generationContext, userId: user.id, modelProvider: config.provider, modelName: config.model }); sourceManifestInserted = true;
    let prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, CONTENT_PROMPT_VERSION).first<{ id: string }>();
    if (!prompt) {
      await db.batch([
        db.prepare("UPDATE prompt_templates SET status = 'retired', updated_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND status = 'active' AND version != ?").bind(user.id, now, organizationId, projectId, CONTENT_PROMPT_VERSION),
        db.prepare("INSERT OR IGNORE INTO prompt_templates (id, organization_id, project_id, task_type, version, name, status, system_prompt, output_schema_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'content_draft', ?, ?, 'active', ?, ?, ?, ?, ?, ?)").bind(promptTemplateId, organizationId, projectId, CONTENT_PROMPT_VERSION, CONTENT_PROMPT_NAME, CONTENT_SYSTEM_PROMPT, JSON.stringify(CONTENT_OUTPUT_SCHEMA), user.id, user.id, now, now),
      ]);
      prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, CONTENT_PROMPT_VERSION).first<{ id: string }>();
    }
    if (!prompt) { await finishGenerationSourceManifest(traceId, "failed", { promptHash: inputHash, errorCode: "PROMPT_REGISTRY_FAILED" }); return apiError("PROMPT_REGISTRY_FAILED", "提示词版本无法注册。", 500); }
    modelCallId = crypto.randomUUID();
    await db.prepare("INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'content_draft', ?, ?, ?, ?, 'started', ?, ?, ?, ?)").bind(modelCallId, organizationId, projectId, item.topic_id, prompt.id, config.provider, config.model, modelProfile, CONTENT_PROMPT_VERSION, inputHash, inputJson, user.id, now).run();
    const finalContextCheck = await assertProjectGenerationContext({ authSubject: identity.authSubject, context: generationContext });
    if (!finalContextCheck.ok) { await finishGenerationSourceManifest(traceId, "blocked", { promptHash: inputHash, errorCode: finalContextCheck.code }); return apiError(finalContextCheck.code, finalContextCheck.message, finalContextCheck.status, finalContextCheck.details); }
    let pack: ReturnType<typeof productionPackSchema.parse> | null = null; let totalLatencyMs = 0; let correction = "";
    for (let attempt = 0; attempt < 2 && !pack; attempt += 1) {
      try {
        const invocation = await invokeContentModel({
          system: CONTENT_SYSTEM_PROMPT,
          user: `请根据以下 JSON 输入生成生产包。严格遵守 contextLayers 的事实、方法与案例边界；methodologyPlan 已在调用前由系统确定，不要自行改写计划。benchmarkUsageRequirements 中每一条已勾选参考素材都是强制采用项：每条都要各有一个 benchmark citation，并在 qualityReview.benchmarkMethods 中用相同 sourceId 说明采用的方法及其在本稿中的具体落点：\n${promptInputJson}${correction}`,
          profile: modelProfile,
          nativeJson: attempt === 0,
        });
        totalLatencyMs += invocation.latencyMs;
        let modelOutput: unknown;
        try {
          modelOutput = normalizeGeneratedProductionPackTextBounds(parseModelJson(invocation.content));
        } catch (reason) {
          throw new ModelRequestError(reason instanceof Error ? reason.message : "模型响应不是完整 JSON 对象。", "INVALID_MODEL_OUTPUT");
        }
        const candidate = productionPackSchema.safeParse(modelOutput);
        if (!candidate.success) throw new ModelRequestError(`模型输出未通过生产包校验：${productionPackValidationIssue(candidate.error, modelOutput)}`, "INVALID_MODEL_OUTPUT");
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
        if (selectedKnowledgeSourceIds.size && !hasCitation("knowledge", selectedKnowledgeSourceIds)) throw new ModelRequestError("模型没有实际引用选题指定的品牌知识。", "SELECTED_KNOWLEDGE_CITATION_REQUIRED");
        if (!selectedKnowledgeSourceIds.size && knowledgeRows.results.length && !hasCitation("knowledge")) throw new ModelRequestError("模型没有实际引用项目品牌知识。", "BRAND_KNOWLEDGE_CITATION_REQUIRED");
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
        const candidateWithMethodology = candidate.data.qualityReview ? {
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
        if (attempt === 1 || !(error instanceof ModelRequestError)) throw error;
        correction = error.code === "HISTORICAL_STYLE_VALIDATION_FAILED"
          ? `\n\n上次生成未通过历史文案应用验收：${error.message}。请依据 historicalStyleProfile 修正完整口播稿，并同步修正 shortScript、storyboard、hooks、commentPrompt 和 adaptations。不要输出 historicalStyleApplication，该字段由系统计算；仍需返回完整 JSON。`
          : `\n\n上次原生 JSON 生成未完成：${error.message}。本次已切换兼容模式。请直接返回一个完整 JSON 对象，不要使用 Markdown 或代码围栏；严格按 Schema 输出全部字段和 qualityReview；只从 contextLayers.projectFacts 提取客户事实，并用对应来源的连续 8–80 字原文形成 citations；contextLayers.methodology 只指导写法，contextLayers.referenceExamples 只指导结构，二者都不能支撑客户事实；必须引用当前 strategy 和 methodologyPlan.planId 对应的 method_knowledge；必须引用选题指定的 knowledge（若没有指定则引用至少一条项目 knowledge）；输入含 video_analysis 或 historical_copy 时分别至少逐字引用一条实际采用的来源；对于 benchmarkUsageRequirements 中的每个 sourceId，不得遗漏：必须逐条生成一个 benchmark citation，并逐条生成一个 qualityReview.benchmarkMethods 项，明确 method 和 application。`;
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
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, prompt_version, model_call_id, input_snapshot_json, input_snapshot_hash, source_manifest_json, context_snapshot_id, created_by, created_at) SELECT ?, organization_id, project_id, id, ?, 'ai', ?, ?, ?, 'AI 生成口播稿与生产包', ?, ?, ?, ?, ?, ?, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(versionId, nextVersion, packJson, pack.fullScript, pack.shortScript, CONTENT_PROMPT_VERSION, modelCallId, inputJson, inputHash, JSON.stringify(generationContext.sourceManifest), defaultProjectSources.memorySnapshotId, user.id, completedAt, contentId, organizationId, projectId, nextVersion),
      db.prepare("UPDATE model_calls SET status = 'completed', output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(packJson, totalLatencyMs, completedAt, modelCallId, organizationId, projectId),
      ...pack.citations.map((citation) => db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) SELECT ?, ?, ?, ?, id, ?, ?, ?, ?, ? FROM content_versions WHERE id = ? AND organization_id = ? AND project_id = ?").bind(crypto.randomUUID(), organizationId, projectId, contentId, citation.sourceType, citation.sourceId, citation.quote, user.id, completedAt, versionId, organizationId, projectId)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, organization_id, project_id, ?, 'content.generated', 'content_item', id, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(crypto.randomUUID(), user.id, JSON.stringify({ version: nextVersion, modelCallId, promptVersion: CONTENT_PROMPT_VERSION, methodologyPlan: methodologyPlan.snapshot, benchmarkEntryIds, recommendedBenchmarkIds, manuallyAddedBenchmarkIds: benchmarkEntryIds.filter((id) => !recommendedBenchmarkIds.includes(id)), manuallyRemovedBenchmarkIds: recommendedBenchmarkIds.filter((id) => !benchmarkEntryIds.includes(id)), benchmarkCitations: pack.citations.filter((citation) => citation.sourceType === "benchmark").length, benchmarkUsage, historicalCopyIds: historicalMatches.map((match) => match.record.id), historicalCopyCitations: pack.citations.filter((citation) => citation.sourceType === "historical_copy").length, historicalStyleStatus: pack.historicalStyleApplication?.status || null, historicalStyleMatchedChecks: pack.historicalStyleApplication?.matchedChecks || 0, historicalStyleTotalChecks: pack.historicalStyleApplication?.totalChecks || 0 }), completedAt, contentId, organizationId, projectId, nextVersion),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) { await finishGenerationSourceManifest(traceId, "failed", { promptHash: inputHash, errorCode: "CONTENT_VERSION_CONFLICT" }); return apiError("CONTENT_VERSION_CONFLICT", "生成期间内容已被其他成员更新，本次结果未覆盖新版本。", 409); }
    try { await finishGenerationSourceManifest(traceId, "completed", { promptHash: inputHash }); } catch { /* best-effort security trace */ }
    return Response.json({ item: { id: contentId, current_version: nextVersion, version_id: versionId, generation_mode: "ai", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, prompt_version: CONTENT_PROMPT_VERSION, model_call_id: modelCallId, updated_at: completedAt }, methodologyPlan: methodologyPlan.snapshot, sourcesUsed: generationContext.sourceManifest, benchmarksUsed: benchmarkUsage, historicalCopiesUsed: historicalMatches.filter((match) => pack.citations.some((citation) => citation.sourceType === "historical_copy" && citation.sourceId === match.record.id)).map((match) => ({ id: match.record.id, title: match.record.title, characterCount: match.record.character_count, monetizationTypes: JSON.parse(match.record.monetization_types_json || "[]") })) });
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
