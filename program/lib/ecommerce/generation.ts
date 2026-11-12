import { env } from "cloudflare:workers";
import { z } from "zod";
import { getD1 } from "../../db/runtime";
import { isGenerationFrozen } from "../generation-freeze.mjs";
import { checkOrganizationQuota } from "../operations";
import { readEffectiveModelRuntime } from "../model-settings";
import { invokeContentModel, readContentModelConfig, ModelConfigurationError } from "../model-adapter";
import { authorize, auditStatement, enabledGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import { buildEcommerceContext, generationSourceDocument } from "./context";
import { generationActorGuard, generationSourceGuard } from "./source-guard";
import { packSchema, runSchema, type EcommercePack } from "./contracts";
import { ECOMMERCE_PROMPT_VERSION, ECOMMERCE_SYSTEM, copyDraftForModel, copyPackModelSchema, copyPackSchema, copyPatchModelSchema, copyPatchSchema, copyReviewModelSchema, copyReviewSchema, materializeEcommercePlan, materializeEditorialReview, mergeEcommercePatch, patchSchema, planIssues, planModelSchema, planSchema, reviewIssues, validateEcommercePack, type EcommercePlan } from "./generation-contract";
import { hashJson } from "./products";
import { activeRunPredicate } from "./runs";
import { ecommerceGenerationGuide } from "./generation-guide";
import { readModelUsage, readModelFailureUsage, preserveInterruptedModelUsage } from "../model-usage";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition, ProjectWriteAccessChangedError } from "../project-write-access";
import type { ContentModelRequestRecord } from "../recorded-content-model";

type RunInput = z.infer<typeof runSchema>;
type RunRow = { id: string; input_hash: string; status: string; result_version_id: string | null; error_code: string | null; error_message: string | null };
type VersionRow = { id: string; pack_json: string; input_snapshot_json: string; product_version_id: string };
const frozen = () => isGenerationFrozen((env as typeof env & { GENERATION_P0_FREEZE?: string }).GENERATION_P0_FREEZE);
function requireUnfrozen() { if (frozen()) throw new EcommerceError("GENERATION_FROZEN", "当前生成已暂停。", 409); }

async function assertLiveAccess(request: Request, access: EcommerceAccess) {
  const current = await authorize(request, access, true);
  if (current.userId !== access.userId) throw new EcommerceError("PROJECT_WRITE_ACCESS_CHANGED", "登录用户已改变，请刷新后再操作。", 403);
  try { await assertProjectWriteAccess(getD1(), access); }
  catch (error) { if (error instanceof ProjectWriteAccessChangedError) throw new EcommerceError(error.code, error.message, 403); throw error; }
}
const runCondition = `EXISTS (SELECT 1 FROM ecommerce_generation_runs r
  INNER JOIN ecommerce_tasks t ON t.id=r.task_id AND t.organization_id=r.organization_id AND t.project_id=r.project_id
  WHERE r.id=? AND r.organization_id=? AND r.project_id=? AND r.status='running'
    AND t.status!='archived' AND t.revision=r.task_revision AND t.current_version=r.base_version)`;
async function assertRunActive(access: EcommerceAccess, runId: string) {
  if (!await getD1().prepare(`SELECT 1 WHERE ${runCondition}`).bind(runId, access.organizationId, access.projectId).first()) {
    throw new EcommerceError("RUN_ENDED", "本次运行已结束或任务已修改，已停止后续请求，未覆盖原稿；已发出的模型请求仍计入用量。请刷新运行记录后再操作。", 409);
  }
}

function parseModelObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch { throw new EcommerceError("MODEL_INVALID_JSON", "模型返回格式不完整，请查看本次运行记录后重试。", 502); }
}

async function invokeRecorded(request: Request, access: EcommerceAccess, runId: string, stage: string, payload: unknown, outputSchema: unknown) {
  requireUnfrozen();
  await assertLiveAccess(request, access);
  const db = getD1(), now = new Date().toISOString(), month = now.slice(0, 7) + "-01T00:00:00.000Z", callId = crypto.randomUUID(), scope = [access.organizationId, access.projectId];
  const quota = await checkOrganizationQuota(access.organizationId, access.userId, "modelCalls");
  if (!quota.allowed) throw new EcommerceError("MODEL_QUOTA_EXCEEDED", "公司本月模型调用额度已用尽。", 429);
  const config = readContentModelConfig("max", await readEffectiveModelRuntime(access.organizationId));
  const user = JSON.stringify({ stage, payload, outputSchema });
  const callHash = await hashJson({ system: ECOMMERCE_SYSTEM, user });
  await assertLiveAccess(request, access); requireUnfrozen();
  const registered = await db.batch([
    db.prepare(`UPDATE ecommerce_generation_runs SET call_count=call_count+1 WHERE id=? AND organization_id=? AND project_id=? AND status='running' AND call_count<5
      AND ${runCondition} AND ${projectWriteAccessCondition}
      AND EXISTS(SELECT 1 FROM ecommerce_project_settings s WHERE s.organization_id=? AND s.project_id=? AND s.enabled=1
        AND (SELECT COUNT(*) FROM model_calls m WHERE m.organization_id=s.organization_id AND m.project_id=s.project_id AND m.task_type LIKE 'ecommerce.%' AND m.created_at>=?) < s.monthly_call_limit)
      AND (SELECT COUNT(*) FROM model_calls WHERE organization_id=? AND created_at>=?) < MIN(?,COALESCE((SELECT monthly_model_call_quota FROM organization_settings WHERE organization_id=?),?))`)
      .bind(runId, ...scope, runId, ...scope, ...projectWriteAccessBindings(access), ...scope, month, access.organizationId, month, quota.limit, access.organizationId, quota.limit),
    db.prepare(`INSERT INTO model_calls (id,organization_id,project_id,task_type,provider,model_name,model_profile,prompt_version,status,input_hash,input_json,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,'started',?,?,?,? WHERE changes()=1`)
      .bind(callId, ...scope, `ecommerce.${stage}`, config.provider, config.model, config.profile, ECOMMERCE_PROMPT_VERSION, callHash, JSON.stringify({ runId, system: ECOMMERCE_SYSTEM, user }), access.userId, now),
  ]);
  if (!registered[0].meta.changes) {
    await assertLiveAccess(request, access); await assertRunActive(access, runId);
    const budget = await db.prepare("SELECT (SELECT COUNT(*) FROM model_calls WHERE organization_id=? AND created_at>=?) AS used, MIN(?,COALESCE((SELECT monthly_model_call_quota FROM organization_settings WHERE organization_id=?),?)) AS allowed").bind(access.organizationId, month, quota.limit, access.organizationId, quota.limit).first<{ used: number; allowed: number }>();
    if (budget && budget.used >= budget.allowed) throw new EcommerceError("MODEL_QUOTA_EXCEEDED", "公司本月模型调用额度已用尽，本次未发出新的请求。", 429);
    throw new EcommerceError("ECOMMERCE_CALL_LIMIT", "电商调用预算已用尽、运行已结束或功能已暂停。", 409);
  }
  const started = Date.now();
  let record: ContentModelRequestRecord = { id: callId, step: stage, status: "failed", latencyMs: 0, ...readModelUsage(null) };
  let content: string | undefined;
  const receipt = () => JSON.stringify({ ...(content !== undefined ? { content } : {}), usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens }, modelRequests: [record] });
  try {
    const response = await invokeContentModel({ organizationId: access.organizationId, system: ECOMMERCE_SYSTEM, user, profile: "max", maxTokens: stage === "plan" ? 6000 : 12000, temperature: stage === "review" ? .1 : stage === "plan" ? .35 : .65 }, { config });
    record = { id: callId, step: stage, status: "completed", latencyMs: response.latencyMs, ...readModelUsage(response.raw) };
    content = response.content.slice(0, 200_000);
    const saved = await db.prepare("UPDATE model_calls SET output_json=?,latency_ms=? WHERE id=? AND organization_id=? AND project_id=? AND status='started'").bind(receipt(), response.latencyMs, callId, ...scope).run();
    if (!saved.meta.changes) {
      // Late receipts clarify cost without reviving a recovered request or
      // replacing its terminal reason and other recovery metadata.
      await preserveInterruptedModelUsage(db,{id:callId,organizationId:access.organizationId,projectId:access.projectId},record);
      throw new EcommerceError("RUN_ENDED", "本次请求已恢复或结束，迟到结果仅补记实际用量，不会保存为稿件。", 409);
    }
    await assertLiveAccess(request, access); await assertRunActive(access, runId); requireUnfrozen();
    const parsed = parseModelObject(response.content);
    const recorded = await db.prepare(`UPDATE model_calls SET status='completed',completed_at=? WHERE id=? AND organization_id=? AND project_id=? AND status='started' AND ${projectWriteAccessCondition} AND ${enabledGuard} AND ${runCondition}`)
      .bind(new Date().toISOString(), callId, ...scope, ...projectWriteAccessBindings(access), ...scope, runId, ...scope).run();
    if (!recorded.meta.changes) { await assertLiveAccess(request, access); throw new EcommerceError("RUN_ENDED", "本次运行已结束或任务已修改，迟到结果不会保存。", 409); }
    return parsed;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "MODEL_CALL_FAILED";
    if (content === undefined) record = { ...record,latencyMs:Date.now()-started,...readModelFailureUsage(error) };
    const saved = await db.prepare("UPDATE model_calls SET status='failed',error_code=?,error_message=?,output_json=?,latency_ms=?,completed_at=? WHERE id=? AND organization_id=? AND project_id=? AND status='started'")
      .bind(code, error instanceof EcommerceError ? error.message.slice(0, 1000) : "模型调用或回执保存失败，未保存稿件。已发出的请求仍计入用量，缺失回执需与供应商核对。", receipt(), record.latencyMs, new Date().toISOString(), callId, ...scope).run();
    if (!saved.meta.changes) await preserveInterruptedModelUsage(db,{id:callId,organizationId:access.organizationId,projectId:access.projectId},record);
    throw error instanceof EcommerceError ? error : new EcommerceError(code, "模型调用失败，未覆盖原稿。请检查模型服务后使用新的运行重试。", 502);
  }
}

/** Same request key returns its original outcome even after the task has moved on. */
async function replay(access: EcommerceAccess, key: string, requestHash: string) {
  const run = await getD1().prepare("SELECT id,input_hash,status,result_version_id,error_code,error_message FROM ecommerce_generation_runs WHERE organization_id=? AND project_id=? AND idempotency_key=?")
    .bind(access.organizationId, access.projectId, key).first<RunRow>();
  if (!run) return null;
  if (run.input_hash !== requestHash) throw new EcommerceError("IDEMPOTENCY_CONFLICT", "同一运行标识不能用于不同任务或参数。", 409);
  return { status: run.status === "running" ? 202 : run.status === "completed" ? 200 : 409, run };
}

export async function generateEcommerce(request: Request, access: EcommerceAccess, taskId: string, input: RunInput) {
  await assertLiveAccess(request, access);
  const requestHash = await hashJson({ taskId, input }), previous = await replay(access, input.idempotencyKey, requestHash);
  if (previous) return previous;
  requireUnfrozen();
  try { readContentModelConfig("max", await readEffectiveModelRuntime(access.organizationId)); } catch (error) { if (error instanceof ModelConfigurationError) throw new EcommerceError("MODEL_NOT_CONFIGURED", "请先配置内容模型。", 503); throw error; }
  const context = await buildEcommerceContext(access, taskId), task = context.task, db = getD1(), scope = [access.organizationId, access.projectId];
  if (!context.ready) throw new EcommerceError("TASK_INCOMPLETE", `请补齐：${context.missing.join("、")}`, 409);
  if (task.revision !== input.revision || task.current_version !== input.baseVersion || task.status === "archived") throw new EcommerceError("STATE_CHANGED", "任务或稿件已改变，请刷新后重试。", 409);
  const base = input.baseVersion ? await db.prepare("SELECT id,pack_json,input_snapshot_json,product_version_id FROM ecommerce_versions WHERE task_id=? AND version=? AND organization_id=? AND project_id=?").bind(taskId, input.baseVersion, ...scope).first<VersionRow>() : null;
  if (input.replace && (!base || base.product_version_id !== task.product_version_id)) throw new EcommerceError("PATCH_BASE_UNAVAILABLE", "局部替换需要同一商品版本的已有稿件。", 409);
  const runId = crypto.randomUUID(), now = new Date().toISOString();
  await assertLiveAccess(request, access);
  const inserted = await db.batch([
    db.prepare(`INSERT INTO ecommerce_generation_runs (id,organization_id,project_id,task_id,idempotency_key,input_hash,base_version,task_revision,operation,status,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,'running',?,? WHERE EXISTS(SELECT 1 FROM ecommerce_tasks WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND current_version=? AND status!='archived')
      AND EXISTS(SELECT 1 FROM ecommerce_project_settings s WHERE s.organization_id=? AND s.project_id=? AND s.enabled=1 AND (SELECT COUNT(*) FROM ecommerce_generation_runs r WHERE r.organization_id=s.organization_id AND r.project_id=s.project_id AND ${activeRunPredicate})<s.max_concurrent)
      AND NOT EXISTS(SELECT 1 FROM ecommerce_generation_runs r WHERE r.task_id=? AND ${activeRunPredicate}) AND ${projectWriteAccessCondition} ON CONFLICT(organization_id,project_id,idempotency_key) DO NOTHING`)
      .bind(runId, ...scope, taskId, input.idempotencyKey, requestHash, input.baseVersion, input.revision, input.replace ?? "generate", access.userId, now, taskId, ...scope, input.revision, input.baseVersion, ...scope, taskId, ...projectWriteAccessBindings(access)),
    auditStatement(access, "ecommerce.generation.started", taskId, { runId }),
  ]);
  if (!inserted[0].meta.changes) {
    await assertLiveAccess(request, access);
    const existing = await replay(access, input.idempotencyKey, requestHash);
    if (existing) return existing;
    throw new EcommerceError("GENERATION_BUSY", "任务正在生成、并发已满或状态已改变。", 409);
  }
  let manifestId: string | null = null;
  try {
    manifestId = crypto.randomUUID();
    await assertLiveAccess(request, access);
    const manifest = await db.prepare(`INSERT INTO generation_source_manifests (id,trace_id,user_id,organization_id,project_id,capability,source_manifest_json,prompt_hash,status,created_at) SELECT ?,?,?,?,?,'ecommerce',?,?,'started',? WHERE ${runCondition} AND ${projectWriteAccessCondition}`)
      .bind(manifestId, runId, access.userId, ...scope, JSON.stringify(context.manifest), context.inputHash, now, runId, ...scope, ...projectWriteAccessBindings(access)).run();
    if (!manifest.meta.changes) { await assertLiveAccess(request, access); await assertRunActive(access, runId); throw new EcommerceError("STATE_CHANGED", "来源记录未能保存，请刷新后重试。", 409); }
    let plan: EcommercePlan | undefined, pack: EcommercePack;
    if (input.replace && base) {
      const basePack = packSchema.parse(JSON.parse(base.pack_json));
      const basePlan = planSchema.safeParse(JSON.parse(base.input_snapshot_json).plan);
      if (basePlan.success) plan = basePlan.data;
      const response = await invokeRecorded(request, access, runId, "patch", {
        context: context.input, operation: input.replace, instructions: input.instructions, base: copyDraftForModel(basePack, context),
        generationGuide: ecommerceGenerationGuide(context, plan, basePack),
        requirements: "只返回指定 role 的段落，保持原 ID、role、数量。返回完整更新后的应用报告。其他段落由服务器原样保留；若新要求影响其他段落，报告依赖冲突，不擅自修改。",
      }, z.toJSONSchema(copyPatchModelSchema(context, plan)));
      const patch = copyPatchSchema.safeParse(response);
      if (!patch.success) throw new EcommerceError("PATCH_INVALID", "局部替换格式无效。", 502);
      try { pack = mergeEcommercePatch(basePack, patchSchema.parse(patch.data), input.replace); }
      catch { throw new EcommerceError("PATCH_SCOPE_CONFLICT", "局部修改超出指定段落，请调整任务或改为完整生成。", 409); }
    } else {
      const response = await invokeRecorded(request, access, runId, "plan", { context: context.input, instructions: input.instructions, generationGuide: ecommerceGenerationGuide(context), requirements: context.input.task.brief.referenceMode === "benchmark" ? "参考视频模式：choices 必须为空数组，只分析唯一所选对标文案的叙事顺序、开头、论证与行动引导机制，规划用本商品事实替换后的文案功能段，并在 copyDirection 交代本稿的开头、卖点衔接、依据、行动理由和参考改写边界。不复制参考作者身份、经历、销量、效果或承诺；不要求方法卡。" : "根据 copyMethodology 选择适合本次商品与购买障碍的钩子和结构，在 copyDirection 明确开头、卖点衔接、事实依据与行动理由。有候选方法卡时分别选择一个开头方法和一个结构方法；没有候选时 choices=[]，直接按内置方法论规划完整文案，不要求参考视频或额外配置。只规划文案功能段，不编造商品事实。按口播预算讲清一个例子。若已有账号策略与本任务明显冲突，在 strategyConflict 指明。" }, z.toJSONSchema(planModelSchema(context)));
      const parsed = planSchema.safeParse(response);
      if (!parsed.success) throw new EcommerceError("PLAN_INVALID", "模型结构计划格式无效。", 502);
      plan = materializeEcommercePlan(parsed.data, context);
      const problems = planIssues(plan, context);
      if (problems.length) throw new EcommerceError("PLAN_REJECTED", problems.join("；"), 409);
      const draft = await invokeRecorded(request, access, runId, "draft", { context: context.input, plan, instructions: input.instructions, generationGuide: ecommerceGenerationGuide(context, plan), requirements: "逐段执行 copyDirection 和字数预算，输出一条从开头到结尾的完整口播文案，兑现开头问题，围绕一个主卖点回答购买顾虑，给出单一行动及理由，避免空泛重复。依据 generationGuide.sourceRegister 完整记录每个来源采用与否。先写段落来源关联，再汇总应用说明；有方法卡时开头与结构两类都须有实际段落关联，无卡则 componentIds=[]；参考视频模式下绑定实际借用结构的所选 caseId 并说明不迁移的事实。只输出文案，不输出分镜或拍摄清单。引用只复制连续原句。主张与证据段绑定本商品主卖点及有效证据。" }, z.toJSONSchema(copyPackModelSchema(context, plan)));
      const parsedPack = copyPackSchema.safeParse(draft);
      if (!parsedPack.success) throw new EcommerceError("DRAFT_INVALID", "模型稿件结构不完整。", 502);
      pack = packSchema.parse(parsedPack.data);
    }
    let validation = validateEcommercePack(pack, context, plan, input.replace && base ? packSchema.parse(JSON.parse(base.pack_json)) : undefined);
    let repaired = false;
    // At most one repair: a semantic repair and its re-review fit five calls.
    if (!validation.ok && !input.replace) {
      repaired = true;
      const fixed = await invokeRecorded(request, access, runId, "repair", { context: context.input, plan, instructions: input.instructions, generationGuide: ecommerceGenerationGuide(context, plan, pack), previousDraft: copyDraftForModel(pack, context), errors: validation.issues, requirements: "先逐项修复 generationGuide.observed.missingFactBindings：role=claim和evidence的本段claimIds与evidenceIds都必须有值，不能把证据只放在相邻段落；内置方法ID不能出现在componentIds。再按实际字数与关联差异修复。超长时删减口播，不能只改时长数字；关联缺失时明确方法实际应用在哪些段落并同步两处ID；拼接引文改为一个关联段落内连续存在的原句。保留事实限制，不编造依据，不放宽验收条件。" }, z.toJSONSchema(copyPackModelSchema(context, plan)));
      const parsed = copyPackSchema.safeParse(fixed);
      if (!parsed.success) throw new EcommerceError("REPAIR_INVALID", "修订结果仍不完整，已保留原稿。", 502);
      pack = packSchema.parse(parsed.data); validation = validateEcommercePack(pack, context, plan);
    }
    if (!validation.ok) throw new EcommerceError("DRAFT_REJECTED", validation.issues.join("；"), 409);
    const reviewDraft = async () => {
      const raw = await invokeRecorded(request, access, runId, "review", { context: context.input, plan, instructions: input.instructions, generationGuide: ecommerceGenerationGuide(context, plan, pack), draft: copyDraftForModel(pack, context),
        requirements: "独立逐句检查全部文案及 copyMethodology.reviewChecklist，填写 qualityChecks。核查正文是否兑现钩子、单一主卖点是否回答购买顾虑、CTA是否清楚且有理由、是否真正改写所选参考。不要因机械秒数或轻微口语风格偏好阻断，轻微风格问题只记录 spokenNatural=false；实质问题在 issues 定位到真实段落并写明可执行修改建议。为每个商品事实列出 claimChecks，statement 必须是稿件原句，sourceIds 仅限真实商品主张、证据、明确选择的知识。检查无引用段落是否偷偷添加数字、效果、销量、身份或承诺。引用必须真正支持主张；不支持则 supported=false 并定位段落。检查 CTA 与已有策略冲突，不评估拍摄可行性。" }, z.toJSONSchema(copyReviewModelSchema(pack)));
      const parsed = copyReviewSchema.safeParse(raw);
      if (!parsed.success) throw new EcommerceError("REVIEW_INVALID", "独立校对未返回完整结果。", 502);
      return materializeEditorialReview(parsed.data, pack);
    };
    let review = await reviewDraft(), reviewProblems = reviewIssues(review, pack, context);
    if (review.editorialReview.verdict === "needs_facts") throw new EcommerceError("COPY_FACTS_REQUIRED", `还缺少支撑文案的具体内容：${review.editorialReview.missingFacts.join("；") || review.editorialReview.summary}`, 409);
    if (reviewProblems.length && !repaired && !input.replace) {
      const fixed = await invokeRecorded(request, access, runId, "repair", { context: context.input, plan, instructions: input.instructions, generationGuide: ecommerceGenerationGuide(context, plan, pack), previousDraft: copyDraftForModel(pack, context), review, errors: reviewProblems,
        requirements: "针对独立校对定位的问题修正文案。保留同一购买障碍、主卖点、计划段落ID与指定行动；兑现钩子、删无关卖点、用可支持的商品事实替换未经证实的表达，并同步来源关联及连续引文。不得把正文问题挪入待确认项后继续保留，也不得放宽检查条件。返回完整修订稿。" }, z.toJSONSchema(copyPackModelSchema(context, plan)));
      const parsed = copyPackSchema.safeParse(fixed);
      if (!parsed.success) throw new EcommerceError("REPAIR_INVALID", "修订结果仍不完整，已保留原稿。", 502);
      pack = packSchema.parse(parsed.data); validation = validateEcommercePack(pack, context, plan);
      if (!validation.ok) throw new EcommerceError("DRAFT_REJECTED", validation.issues.join("；"), 409);
      review = await reviewDraft(); reviewProblems = reviewIssues(review, pack, context);
    }
    if (reviewProblems.length) throw new EcommerceError("REVIEW_REJECTED", reviewProblems.join("；"), 409);
    requireUnfrozen(); await assertLiveAccess(request, access);
    const latest = await buildEcommerceContext(access, taskId);
    if (latest.inputHash !== context.inputHash) throw new EcommerceError("SOURCE_CHANGED", "生成期间商品、任务、策略或来源发生变化，请核对后重试。", 409);
    const versionId = crypto.randomUUID(), completedAt = new Date().toISOString();
    const snapshot = { ...context.input, plan: plan ?? null, copyMethodology: ecommerceGenerationGuide(context, plan).copyMethodology, taskRevision: task.revision };
    const saved = await db.batch([
      db.prepare(`WITH expected AS (SELECT ? AS doc) UPDATE ecommerce_tasks SET current_version=current_version+1,status='draft',updated_by=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND current_version=? AND status!='archived'
        AND ${enabledGuard} AND EXISTS(SELECT 1 FROM ecommerce_generation_runs WHERE id=? AND status='running') AND ${generationSourceGuard} AND ${generationActorGuard}`)
        .bind(JSON.stringify(generationSourceDocument(context)), access.userId, completedAt, taskId, ...scope, input.revision, input.baseVersion, ...scope, runId, access.userId),
      db.prepare(`INSERT INTO ecommerce_versions (id,organization_id,project_id,task_id,product_id,product_version_id,version,parent_version_id,run_id,mode,pack_json,input_snapshot_json,input_hash,source_manifest_json,validation_json,change_summary,prompt_version,created_by,created_at)
        SELECT ?,organization_id,project_id,id,product_id,product_version_id,current_version,?,?,?,?,?,?,?,?,?,?,?,? FROM ecommerce_tasks WHERE id=? AND organization_id=? AND project_id=? AND changes()=1`)
        .bind(versionId, base?.id ?? null, runId, input.replace ? "patch" : "ai", JSON.stringify(pack), JSON.stringify(snapshot), context.inputHash, JSON.stringify(context.manifest), JSON.stringify({ ...validation, review, humanReviewRequired: true, unchangedSegments: input.replace && base ? await unchangedSegmentHashes(packSchema.parse(JSON.parse(base.pack_json)), input.replace) : [] }), input.replace ? `替换 ${input.replace} 段落` : "电商文案完整生成", ECOMMERCE_PROMPT_VERSION, access.userId, completedAt, taskId, ...scope),
      auditStatement(access, "ecommerce.version.created", taskId, { versionId, runId }),
      db.prepare("UPDATE ecommerce_generation_runs SET status='completed',result_version_id=?,completed_at=? WHERE id=? AND organization_id=? AND project_id=? AND status='running' AND EXISTS(SELECT 1 FROM ecommerce_versions WHERE id=? AND run_id=?)")
        .bind(versionId, completedAt, runId, ...scope, versionId, runId),
      db.prepare("UPDATE generation_source_manifests SET status='completed',completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM ecommerce_versions WHERE id=? AND run_id=?)").bind(completedAt, manifestId, versionId, runId),
    ]); if (!saved[0].meta.changes) await assertLiveAccess(request, access); requireChanged(saved);
    return { status: 201, run: { id: runId, status: "completed", result_version_id: versionId }, version: { id: versionId, version: input.baseVersion + 1, pack } };
  } catch (error) {
    const failure = error instanceof EcommerceError ? error : new EcommerceError("GENERATION_FAILED", "生成未完成，已有版本保持不变。", 500);
    const endedAt = new Date().toISOString();
    await db.prepare("UPDATE ecommerce_generation_runs SET status='failed',error_code=?,error_message=?,completed_at=? WHERE id=? AND organization_id=? AND project_id=? AND status='running'")
      .bind(failure.code, failure.message.slice(0, 3000), endedAt, runId, ...scope).run();
    if (manifestId) await db.prepare("UPDATE generation_source_manifests SET status='failed',error_code=?,completed_at=? WHERE id=? AND status='started'").bind(failure.code, endedAt, manifestId).run();
    throw failure;
  }
}

async function unchangedSegmentHashes(base: EcommercePack, role: string) {
  return Promise.all(base.segments.filter(s => s.role !== role).map(async s => ({ segmentId: s.id, hash: await hashJson(s) })));
}
