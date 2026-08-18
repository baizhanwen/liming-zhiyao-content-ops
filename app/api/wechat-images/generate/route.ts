import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { authorizedKnowledgeSearchTerms, retrieveAuthorizedKnowledge } from "../../../../lib/authorized-knowledge";
import { invokeContentModel, ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../lib/model-adapter";
import { checkOrganizationQuota } from "../../../../lib/operations";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { parseWechatImageContent, WECHAT_IMAGE_LAYOUT_PROMPT, WECHAT_IMAGE_PROMPT_VERSION, WECHAT_IMAGE_SYSTEM_PROMPT, wechatImageRatioIds, wechatImageTemplateIds } from "../../../../lib/wechat-image-generation";

export const dynamic = "force-dynamic";

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再生成公众号图片。", 401);
  let modelCallId: string | null = null;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    const topic = text(payload.topic, 180);
    const templateId = text(payload.templateId, 40);
    const ratioId = text(payload.ratioId, 12);
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "请先选择客户项目。", 400);
    if (topic.length < 4) return apiError("WECHAT_IMAGE_TOPIC_REQUIRED", "选题至少需要 4 个字符。", 400);
    if (!wechatImageTemplateIds.includes(templateId as (typeof wechatImageTemplateIds)[number])) return apiError("INVALID_WECHAT_IMAGE_TEMPLATE", "请选择有效的图片模板。", 400);
    if (!wechatImageRatioIds.includes(ratioId as (typeof wechatImageRatioIds)[number])) return apiError("INVALID_WECHAT_IMAGE_RATIO", "请选择有效的图片比例。", 400);

    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能生成公众号图片。", 403);
    const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "modelCalls");
    if (!quota.allowed) return apiError("MODEL_QUOTA_EXCEEDED", `本月模型调用已达到 ${quota.limit} 次套餐上限。`, 429);

    const db = getD1();
    const config = readContentModelConfig("standard");
    const [project, strategy, knowledgeRows] = await Promise.all([
      db.prepare("SELECT name, client_name FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL").bind(projectId, organizationId).first<{ name: string; client_name: string }>(),
      db.prepare("SELECT name, positioning, persona, target_audience, pain_points_json, pillars_json, objectives_json, style_notes, conversion_path FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").bind(organizationId, projectId).first<Record<string, string | null>>(),
      db.prepare(`SELECT k.id, k.category, k.title, v.body
        FROM knowledge_items k INNER JOIN knowledge_item_versions v
          ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
        WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
        ORDER BY k.updated_at DESC LIMIT 60`).bind(organizationId, projectId).all<{ id: string; category: string; title: string; body: string }>(),
    ]);
    const brandSearchTerms = authorizedKnowledgeSearchTerms(topic, 14);
    const knowledge = knowledgeRows.results.map((item, index) => {
      const searchable = `${item.title}\n${item.body}`.toLowerCase();
      const relevance = brandSearchTerms.reduce((score, term) => score + (searchable.includes(term.toLowerCase()) ? 1 + Math.min(term.length, 6) : 0), 0);
      return { item, relevance, recency: knowledgeRows.results.length - index };
    }).sort((left, right) => right.relevance - left.relevance || right.recency - left.recency).slice(0, 12).map(({ item }) => item);
    const perKnowledgeLimit = knowledge.length ? Math.min(2_500, Math.floor(24_000 / knowledge.length)) : 0;
    const methodAtoms = await retrieveAuthorizedKnowledge(db, `${topic}\n${JSON.stringify(strategy ?? {})}\n${knowledge.map((item) => `${item.title}\n${item.body.slice(0, 600)}`).join("\n")}`, { task: "content", limit: 5 });
    const context = {
      topic,
      templateId,
      ratioId,
      brandName: project?.client_name || project?.name || "当前客户品牌",
      activeStrategy: strategy ?? null,
      selectedBrandKnowledge: knowledge.map((item) => ({ id: item.id, category: item.category, title: item.title, body: item.body.slice(0, perKnowledgeLimit) })),
      authorizedMethodKnowledge: methodAtoms.map((atom) => ({ id: atom.id, knowledge: atom.knowledge, original: atom.original, type: atom.atom_type })),
    };
    const inputJson = JSON.stringify(context);
    const inputHash = await sha256Hex(new TextEncoder().encode(inputJson));
    const now = new Date().toISOString();
    modelCallId = crypto.randomUUID();
    await db.prepare("INSERT INTO model_calls (id, organization_id, project_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at) VALUES (?, ?, ?, 'wechat_image', ?, ?, 'standard', ?, 'started', ?, ?, ?, ?)")
      .bind(modelCallId, organizationId, projectId, config.provider, config.model, WECHAT_IMAGE_PROMPT_VERSION, inputHash, inputJson, user.id, now).run();

    let generated: ReturnType<typeof parseWechatImageContent> | null = null;
    let latencyMs = 0;
    let correction = "";
    for (let attempt = 0; attempt < 2 && !generated; attempt += 1) {
      let invocation;
      try {
        invocation = await invokeContentModel({
          system: `${WECHAT_IMAGE_SYSTEM_PROMPT}\n${WECHAT_IMAGE_LAYOUT_PROMPT}`,
          user: `请为以下信息生成公众号知识长图文案：\n${inputJson}${correction}`,
          profile: "standard",
          nativeJson: attempt === 0,
        });
      } catch (error) {
        if (attempt === 0 && error instanceof ModelRequestError && error.code === "MODEL_EMPTY_RESPONSE") {
          correction = "\n\n原生 JSON 模式没有返回正文，请使用普通文本模式并仅输出完整 JSON 对象。";
          continue;
        }
        throw error;
      }
      latencyMs += invocation.latencyMs;
      try { generated = parseWechatImageContent(invocation.content, { topic, brandName: context.brandName }); }
      catch (error) {
        if (attempt === 1) throw new ModelRequestError("模型返回的图片文案结构不完整，系统已自动修复并重试但仍未通过。请重新生成一次。", "INVALID_WECHAT_IMAGE_OUTPUT");
        correction = `\n\n上次输出格式无效：${error instanceof Error ? error.message : "字段缺失"}。请严格输出满足约束的完整 JSON。`;
      }
    }
    if (!generated) throw new ModelRequestError("内容模型没有生成有效的图片文案。", "INVALID_WECHAT_IMAGE_OUTPUT");

    const completedAt = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE model_calls SET status = 'completed', output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'started'").bind(JSON.stringify(generated), latencyMs, completedAt, modelCallId, organizationId, projectId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'wechat_image.generated', 'project', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ templateId, ratioId, modelCallId, brandKnowledgeIds: knowledge.map((item) => item.id), authorizedKnowledgeIds: methodAtoms.map((atom) => atom.id) }), completedAt),
    ]);
    return Response.json({
      generated,
      modelCallId,
      contextUsed: { brandKnowledgeCount: knowledge.length, brandKnowledgeTitles: knowledge.map((item) => item.title), hasActiveStrategy: Boolean(strategy), methodKnowledgeCount: methodAtoms.length },
    });
  } catch (error) {
    if (modelCallId) {
      try {
        const code = error instanceof ModelRequestError ? error.code : "WECHAT_IMAGE_GENERATION_FAILED";
        await getD1().prepare("UPDATE model_calls SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'started'").bind(code, error instanceof Error ? error.message.slice(0, 1_000) : "公众号图片生成失败", new Date().toISOString(), modelCallId).run();
      } catch { /* Best-effort trace only. */ }
    }
    if (error instanceof ModelConfigurationError) return apiError("CONTENT_MODEL_NOT_CONFIGURED", error.message, 503);
    if (error instanceof ModelRequestError) return apiError(error.code, error.message, 502);
    return errorResponse(error);
  }
}
