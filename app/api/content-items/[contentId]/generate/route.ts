import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { CONTENT_OUTPUT_SCHEMA, CONTENT_PROMPT_NAME, CONTENT_PROMPT_VERSION, CONTENT_SYSTEM_PROMPT, analysisReportSourceText, generateContentSchema, parseModelJson, productionPackSchema } from "../../../../../lib/content-production";
import { invokeContentModel, ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../../lib/model-adapter";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../../lib/operations";

export const dynamic = "force-dynamic";

type Source = { sourceType: "topic" | "knowledge" | "video_analysis" | "strategy" | "benchmark"; sourceId: string; title: string; text: string };

function normalized(value: string) { return value.replace(/\s+/g, " ").trim(); }

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成内容。", 401);
  let modelCallId: string | null = null;
  try {
    const parsed = generateContentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_GENERATION_INPUT", "内容生成参数无效。", 400);
    const { organizationId, projectId, modelProfile, benchmarkEntryIds } = parsed.data;
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
    const [strategy, knowledgeRows, citationRows] = await Promise.all([
      db.prepare("SELECT id, name, positioning, persona, target_audience, pain_points_json, pillars_json, style_notes, cadence, conversion_path, objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").bind(organizationId, projectId).first<Record<string, string | null>>(),
      db.prepare(`
        SELECT k.id, k.title, k.category, v.body FROM knowledge_items k
        INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
        WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
        ORDER BY CASE k.category WHEN 'compliance' THEN 0 WHEN 'brand_voice' THEN 1 WHEN 'client_preference' THEN 2 ELSE 3 END, k.updated_at DESC LIMIT 16
      `).bind(organizationId, projectId).all<{ id: string; title: string; category: string; body: string }>(),
      db.prepare("SELECT citation_type, citation_id, quote FROM topic_citations WHERE organization_id = ? AND project_id = ? AND topic_id = ? ORDER BY created_at ASC").bind(organizationId, projectId, item.topic_id).all<{ citation_type: string; citation_id: string; quote: string | null }>(),
    ]);
    const benchmarkRows = benchmarkEntryIds.length ? await db.prepare(`
      SELECT library.id AS library_entry_id, COALESCE(v.title, v.filename, '未命名对标视频') AS title, analysis.id AS analysis_id, analysis.report_json
      FROM project_video_references refs
      INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
      INNER JOIN video_analyses analysis ON analysis.id = (
        SELECT latest.id FROM video_analyses latest
        WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id
        ORDER BY latest.created_at DESC LIMIT 1
      )
      WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark'
        AND library.id IN (${benchmarkEntryIds.map(() => "?").join(", ")})
      LIMIT 5
    `).bind(organizationId, projectId, ...benchmarkEntryIds).all<{ library_entry_id: string; title: string; analysis_id: string; report_json: string }>() : { results: [] as { library_entry_id: string; title: string; analysis_id: string; report_json: string }[] };
    if (benchmarkRows.results.length !== benchmarkEntryIds.length) return apiError("BENCHMARK_SOURCE_NOT_READY", "所选对标样本不存在、尚未分析完成或已经移出当前项目。", 409);
    if (!strategy?.id) return apiError("ACTIVE_STRATEGY_REQUIRED", "请先启用该项目的内容策略，再生成生产包。", 409);
    if (!knowledgeRows.results.length) return apiError("CONFIRMED_KNOWLEDGE_REQUIRED", "请先确认至少一条品牌知识，再生成生产包。", 409);
    const sources = new Map<string, Source>();
    const topicText = [item.topic_title, item.angle, item.pillar, item.audience, item.objective, item.hook, item.rationale].filter(Boolean).join("\n");
    sources.set(`topic:${item.topic_id}`, { sourceType: "topic", sourceId: item.topic_id, title: item.topic_title, text: topicText });
    if (strategy?.id) {
      const strategyText = [strategy.name, strategy.positioning, strategy.persona, strategy.target_audience, strategy.pain_points_json, strategy.pillars_json, strategy.style_notes, strategy.cadence, strategy.conversion_path, strategy.objectives_json].filter(Boolean).join("\n").slice(0, 8_000);
      sources.set(`strategy:${strategy.id}`, { sourceType: "strategy", sourceId: strategy.id, title: strategy.name || "当前内容策略", text: strategyText });
    }
    for (const row of knowledgeRows.results) sources.set(`knowledge:${row.id}`, { sourceType: "knowledge", sourceId: row.id, title: row.title, text: row.body.slice(0, 4_000) });
    for (const row of citationRows.results) {
      if (row.citation_type !== "video_analysis" || !row.quote) continue;
      sources.set(`video_analysis:${row.citation_id}`, { sourceType: "video_analysis", sourceId: row.citation_id, title: "选题引用的视频分析", text: row.quote });
    }
    for (const row of benchmarkRows.results) sources.set(`benchmark:${row.library_entry_id}`, { sourceType: "benchmark", sourceId: row.library_entry_id, title: row.title, text: analysisReportSourceText(row.report_json) });
    const sourceList = Array.from(sources.values());
    const generationInput = { topic: { id: item.topic_id, title: item.topic_title, angle: item.angle, pillar: item.pillar, audience: item.audience, objective: item.objective, hook: item.hook, rationale: item.rationale }, sources: sourceList, outputSchema: CONTENT_OUTPUT_SCHEMA };
    const inputJson = JSON.stringify(generationInput); const inputHash = await sha256Hex(new TextEncoder().encode(inputJson)); const now = new Date().toISOString(); const promptTemplateId = crypto.randomUUID();
    let prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, CONTENT_PROMPT_VERSION).first<{ id: string }>();
    if (!prompt) {
      await db.batch([
        db.prepare("UPDATE prompt_templates SET status = 'retired', updated_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND status = 'active' AND version != ?").bind(user.id, now, organizationId, projectId, CONTENT_PROMPT_VERSION),
        db.prepare("INSERT OR IGNORE INTO prompt_templates (id, organization_id, project_id, task_type, version, name, status, system_prompt, output_schema_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'content_draft', ?, ?, 'active', ?, ?, ?, ?, ?, ?)").bind(promptTemplateId, organizationId, projectId, CONTENT_PROMPT_VERSION, CONTENT_PROMPT_NAME, CONTENT_SYSTEM_PROMPT, JSON.stringify(CONTENT_OUTPUT_SCHEMA), user.id, user.id, now, now),
      ]);
      prompt = await db.prepare("SELECT id FROM prompt_templates WHERE organization_id = ? AND project_id = ? AND task_type = 'content_draft' AND version = ?").bind(organizationId, projectId, CONTENT_PROMPT_VERSION).first<{ id: string }>();
    }
    if (!prompt) return apiError("PROMPT_REGISTRY_FAILED", "提示词版本无法注册。", 500);
    modelCallId = crypto.randomUUID();
    await db.prepare("INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'content_draft', ?, ?, ?, ?, 'started', ?, ?, ?, ?)").bind(modelCallId, organizationId, projectId, item.topic_id, prompt.id, config.provider, config.model, modelProfile, CONTENT_PROMPT_VERSION, inputHash, inputJson, user.id, now).run();
    let pack: ReturnType<typeof productionPackSchema.parse> | null = null; let totalLatencyMs = 0; let correction = "";
    for (let attempt = 0; attempt < 2 && !pack; attempt += 1) {
      try {
        const invocation = await invokeContentModel({ system: CONTENT_SYSTEM_PROMPT, user: `请根据以下 JSON 输入生成生产包：\n${inputJson}${correction}`, profile: modelProfile });
        totalLatencyMs += invocation.latencyMs;
        const modelOutput = parseModelJson(invocation.content); const candidate = productionPackSchema.safeParse(modelOutput);
        if (!candidate.success) throw new ModelRequestError(`模型输出未通过生产包校验：${candidate.error.issues[0]?.message || "结构无效"}`, "INVALID_MODEL_OUTPUT");
        for (const citation of candidate.data.citations) {
          const source = sources.get(`${citation.sourceType}:${citation.sourceId}`);
          if (!source || !normalized(source.text).includes(normalized(citation.quote))) throw new ModelRequestError("模型输出包含无法追溯的引用。", "UNTRACEABLE_MODEL_CITATION");
        }
        if (benchmarkRows.results.length && !candidate.data.citations.some((citation) => citation.sourceType === "benchmark")) throw new ModelRequestError("模型没有实际引用所选对标样本。", "BENCHMARK_CITATION_REQUIRED");
        pack = candidate.data;
      } catch (error) {
        if (attempt === 1 || !(error instanceof ModelRequestError)) throw error;
        correction = `\n\n上次生成未完成：${error.message}。请重新生成完整 JSON，严格按 Schema 输出全部字段；若输入含 benchmark 来源，citations 至少逐字引用其中一条。`;
      }
    }
    if (!pack) throw new ModelRequestError("内容模型未生成有效生产包。", "INVALID_MODEL_OUTPUT");
    const nextVersion = item.current_version + 1; const versionId = crypto.randomUUID(); const completedAt = new Date().toISOString(); const packJson = JSON.stringify(pack);
    const statements = [
      db.prepare("UPDATE content_items SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(nextVersion, user.id, completedAt, contentId, organizationId, projectId, item.current_version),
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, prompt_version, model_call_id, created_by, created_at) SELECT ?, organization_id, project_id, id, ?, 'ai', ?, ?, ?, 'AI 生成口播稿与生产包', ?, ?, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(versionId, nextVersion, packJson, pack.fullScript, pack.shortScript, CONTENT_PROMPT_VERSION, modelCallId, user.id, completedAt, contentId, organizationId, projectId, nextVersion),
      db.prepare("UPDATE model_calls SET status = 'completed', output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(packJson, totalLatencyMs, completedAt, modelCallId, organizationId, projectId),
      ...pack.citations.map((citation) => db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) SELECT ?, ?, ?, ?, id, ?, ?, ?, ?, ? FROM content_versions WHERE id = ? AND organization_id = ? AND project_id = ?").bind(crypto.randomUUID(), organizationId, projectId, contentId, citation.sourceType, citation.sourceId, citation.quote, user.id, completedAt, versionId, organizationId, projectId)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, organization_id, project_id, ?, 'content.generated', 'content_item', id, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(crypto.randomUUID(), user.id, JSON.stringify({ version: nextVersion, modelCallId, promptVersion: CONTENT_PROMPT_VERSION, benchmarkEntryIds, benchmarkCitations: pack.citations.filter((citation) => citation.sourceType === "benchmark").length }), completedAt, contentId, organizationId, projectId, nextVersion),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("CONTENT_VERSION_CONFLICT", "生成期间内容已被其他成员更新，本次结果未覆盖新版本。", 409);
    return Response.json({ item: { id: contentId, current_version: nextVersion, version_id: versionId, generation_mode: "ai", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, prompt_version: CONTENT_PROMPT_VERSION, model_call_id: modelCallId, updated_at: completedAt }, benchmarksUsed: benchmarkRows.results.filter((row) => pack.citations.some((citation) => citation.sourceType === "benchmark" && citation.sourceId === row.library_entry_id)).map((row) => ({ id: row.library_entry_id, title: row.title })) });
  } catch (error) {
    if (modelCallId) {
      try {
        const db = getD1(); const code = error instanceof ModelRequestError ? error.code : "MODEL_GENERATION_FAILED";
        await db.prepare("UPDATE model_calls SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'started'").bind(code, error instanceof Error ? error.message.slice(0, 1000) : "内容生成失败", new Date().toISOString(), modelCallId).run();
      } catch { /* best-effort failure trace */ }
    }
    if (error instanceof ModelConfigurationError) return apiError("CONTENT_MODEL_NOT_CONFIGURED", error.message, 503);
    if (error instanceof ModelRequestError) return apiError(error.code, error.message, 502);
    return errorResponse(error);
  }
}
