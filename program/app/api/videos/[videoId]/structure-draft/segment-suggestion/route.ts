import { z } from "zod";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../../db/runtime";
import { readAccountDisclosureBoundaries } from "../../../../../../lib/account-questionnaire";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseModelJson } from "../../../../../../lib/content-production";
import { ModelConfigurationError, ModelRequestError, readContentModelConfig } from "../../../../../../lib/model-adapter";
import { readEffectiveModelRuntime } from "../../../../../../lib/model-settings";
import { checkOrganizationQuota } from "../../../../../../lib/operations";
import { assertProjectGenerationContext, buildProjectGenerationContext, finishGenerationSourceManifest, insertGenerationSourceManifest, redactedGenerationInput, type ProjectGenerationSource } from "../../../../../../lib/project-generation-context";
import { createProjectWriteAssertion, projectWriteAccessBindings, projectWriteAccessCondition } from "../../../../../../lib/project-write-access";
import { invokeRecordedContentRequest, type ContentModelRequestRecord } from "../../../../../../lib/recorded-content-model";
import { readSegmentSuggestion, SEGMENT_SUGGESTION_SYSTEM, SEGMENT_SUGGESTION_VERSION, segmentSuggestionContext } from "../../../../../../lib/reference-segment-suggestion";
import { readRequestIdentity } from "../../../../../../lib/request-auth";
import { referenceCreationInputSchema } from "../../../../../../lib/structure-creation";
import { confirmStructureDraft, readStructureDraftPreview, StructureDraftError } from "../../../../../../lib/structure-draft";
import { readStudioIdea } from "../../../../../../lib/studio-ideas";

export const dynamic = "force-dynamic";
const id = z.string().trim().min(1).max(200);
const inputSchema = z.object({
  organizationId: id, projectId: id, libraryEntryId: id.optional(), segmentId: id,
  referenceCreation: referenceCreationInputSchema, materialQuestion: z.string().trim().max(300).default(""),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const ledger: ContentModelRequestRecord[] = [];
  let callId = "", traceId = "";
  try {
    const parsed = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("INVALID_SEGMENT_INPUT", "请确认选题、段落和本段要用的材料。", 400);
    const { organizationId, projectId, libraryEntryId, segmentId, referenceCreation, materialQuestion } = parsed.data;
    const { videoId } = await context.params;
    if (referenceCreation.videoId !== videoId) return apiError("REFERENCE_MISMATCH", "参考视频与当前段落不一致。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能为此空间生成段落建议。", 403);
    const db = getD1();
    const scope = { organizationId, projectId };
    const user = await ensureUser(identity);
    const writeScope = { ...scope, userId: user.id };
    const assertAccess = createProjectWriteAssertion(db, writeScope, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    async function readContext() {
      const [preview, boundaries] = await Promise.all([
        readStructureDraftPreview(db, { ...scope, videoId, analysisId: referenceCreation.analysisId, libraryEntryId }),
        readAccountDisclosureBoundaries(db, scope),
      ]);
      const confirmed = confirmStructureDraft(preview, referenceCreation);
      const idea = referenceCreation.idea;
      if (idea && (await readStudioIdea(db, scope, idea.kind, idea.id))?.title !== confirmed.topic)
        throw new StructureDraftError("REFERENCE_CHANGED", "所选灵感已经变化，请重新选择或直接输入选题。", 409);
      return segmentSuggestionContext(confirmed, segmentId, materialQuestion, boundaries);
    }
    const data = await readContext();
    if (materialQuestion && !data.sources.length) return Response.json({ kind: "missing", question: materialQuestion });
    const quota = await checkOrganizationQuota(organizationId, user.id, "modelCalls");
    if (!quota.allowed) return apiError("MODEL_QUOTA_EXCEEDED", "公司本月模型调用额度已用尽。", 429);

    const sources: ProjectGenerationSource[] = [
      { sourceType: "video_analysis", sourceId: referenceCreation.analysisId, title: "参考段序", text: JSON.stringify(data.structure), ...scope },
      { sourceType: "topic", sourceId: "segment:" + segmentId, title: "本次创作", text: JSON.stringify({ topic: data.topic, focus: data.focus, materialQuestion, note: data.sources.find(row => row.sourceId === "note")?.text }), ...scope },
      ...data.sources.filter(row => row.sourceId.startsWith("material:")).map(row => ({
        sourceType: "knowledge" as const, sourceId: row.sourceId.slice("material:".length), title: row.title, text: row.text, ...scope,
      })),
    ];
    if (data.strategy) sources.push({ sourceType: "strategy", sourceId: data.strategy.id, title: data.strategy.name, text: JSON.stringify(data.strategy), ...scope });
    const generation = await buildProjectGenerationContext({ authSubject: identity.authSubject, ...writeScope, capability: "content", sources });
    if (!generation.ok) return apiError(generation.code, generation.message, generation.status, generation.details);
    const modelConfig = readContentModelConfig("max", await readEffectiveModelRuntime(organizationId));
    const prompt = JSON.stringify(data);
    const inputHash = await sha256Hex(new TextEncoder().encode(prompt));
    await insertGenerationSourceManifest({ context: generation.context, userId: user.id, modelProvider: modelConfig.provider, modelName: modelConfig.model });
    traceId = generation.context.traceId;
    const assertCurrent = async () => {
      await assertAccess();
      const current = await assertProjectGenerationContext({ authSubject: identity.authSubject, context: generation.context });
      if (!current.ok) throw new StructureDraftError(current.code, current.message, current.status);
      if (JSON.stringify(await readContext()) !== prompt) throw new StructureDraftError("REFERENCE_CONTEXT_CHANGED", "本段资料或账号公开范围已变化，请刷新后重新生成。", 409);
    };
    callId = crypto.randomUUID();
    const result = await invokeRecordedContentRequest({
      profile: "max", system: SEGMENT_SUGGESTION_SYSTEM, user: prompt, nativeJson: true, temperature: 0.2, maxTokens: 1500,
    }, {
      ...writeScope, id: callId, rootCallId: callId, topicId: null, promptTemplateId: null, taskType: "reference_segment_suggestion",
      promptVersion: SEGMENT_SUGGESTION_VERSION, modelConfig, provider: modelConfig.provider, model: modelConfig.model,
      step: "segment_suggestion", ledger, inputHash, inputJson: redactedGenerationInput({ videoId, analysisId: referenceCreation.analysisId, segmentId, traceId }, generation.context.sourceManifest),
      monthlyLimit: quota.limit, enforceProjectWriteAccess: true, assertWriteAccess: assertCurrent,
    });
    let output: unknown;
    try { output = parseModelJson(result.content); }
    catch { throw new StructureDraftError("INVALID_SEGMENT_SUGGESTION", "模型未返回有效的本段建议，请重试。", 502); }
    const suggestion = readSegmentSuggestion(output, data);
    const saved = await db.prepare(`UPDATE model_calls SET status='completed', completed_at=?, output_json=? WHERE id=? AND organization_id=? AND project_id=? AND status='started' AND ${projectWriteAccessCondition}`)
      .bind(new Date().toISOString(), JSON.stringify({ kind: suggestion.kind, modelRequests: ledger }), callId, organizationId, projectId, ...projectWriteAccessBindings(writeScope)).run();
    if (!saved.meta.changes) {
      await assertAccess();
      throw new StructureDraftError("MODEL_REQUEST_INTERRUPTED", "本次调用已经结束，请重新获取建议。", 409);
    }
    // The completed provider call is authoritative even if its trace cannot be closed.
    await finishGenerationSourceManifest(traceId, "completed", { promptHash: inputHash }).catch(() => {});
    return Response.json(suggestion);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "SEGMENT_SUGGESTION_FAILED";
    if (callId) await getD1().prepare("UPDATE model_calls SET status='failed', error_code=?, error_message=?, output_json=?, completed_at=? WHERE id=? AND status='started'")
      .bind(code, error instanceof Error ? error.message.slice(0, 1000) : "本段建议生成失败", JSON.stringify({ modelRequests: ledger }), new Date().toISOString(), callId).run().catch(() => {});
    if (traceId) await finishGenerationSourceManifest(traceId, "failed", { errorCode: code }).catch(() => {});
    if (error instanceof StructureDraftError) return apiError(error.code, error.message, error.status);
    if (error instanceof ModelConfigurationError) return apiError("CONTENT_MODEL_NOT_CONFIGURED", error.message, 503);
    if (error instanceof ModelRequestError) return apiError(error.code, error.message, error.code === "MODEL_QUOTA_EXCEEDED" ? 429 : error.code === "MODEL_REQUEST_INTERRUPTED" ? 409 : 502);
    return errorResponse(error);
  }
}
