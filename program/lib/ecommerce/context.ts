import { getD1 } from "../../db/runtime";
import { readCoreContentStrategy, strategyForTask } from "../content-strategy-policy";
import { EcommerceError, type EcommerceAccess } from "./access";
import { componentSchema, productPublicSchema, taskBriefSchema, type ComponentInput, type TaskBrief } from "./contracts";
import { hashJson } from "./products";
import { readTask, validateTaskReferences } from "./tasks";

export type MethodCard = Omit<ComponentInput, "organizationId" | "projectId" | "id" | "revision">;
export type Candidate = { id: string; versionId: string; revision: number; scope: string; card: MethodCard; score: number; reasons: string[] };
export type EvidenceSource = { id: string; revision: number; kind: string; body: string; title: string; sourceLocator: string; conditions: string; mediaAssetId: string | null; validUntil: string | null };
export type ContextSource = { id: string; type: "claim" | "evidence" | "knowledge" | "component" | "case"; version: string; title: string; text: string };
export type CaseSource = { id: string; revision: number; referenceId: string; analysisId: string; title: string; text: string; structure: string; transferable: string; nonTransferable: string };
const targetNames = { product_click: "商品点击", live_entry: "直播进房", purchase: "成交" };
const kinds = ["hook", "visual", "structure", "sop"] as const;
const kindNames = { hook: "钩子", visual: "卖点可视化", structure: "素材结构", sop: "拍摄 SOP" };
export const isExpired = (value: string | null, now = Date.now()) => Boolean(value && Date.parse(value) <= now);

function terms(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? [])];
}
export function candidateEligibility(card: MethodCard, brief: TaskBrief, category: string, evidence: EvidenceSource[], priceReady: boolean) {
  const rejected: string[] = [];
  if (!card.platforms.includes(brief.platform)) rejected.push("平台不匹配");
  if (!card.targets.includes(brief.target)) rejected.push("转化目标不匹配");
  if (card.categories.length && !card.categories.includes(category)) rejected.push("商品品类不匹配");
  if (isExpired(card.validUntil) || card.status !== "confirmed") rejected.push("组件未确认或已过期");
  if (card.requiredEvidenceKinds.some(kind => !evidence.some(e => e.kind === kind))) rejected.push("缺少所需类型的证据");
  if (card.requiredFilming.some(item => !brief.filming.includes(item))) rejected.push("拍摄条件不足");
  if (card.requiresPrice && !priceReady) rejected.push("缺少有效价格或活动证据");
  const context = [brief.scene, brief.barrier, brief.instructions, brief.filmingNotes, ...brief.excludedConditions].join("\n").toLowerCase();
  if (card.forbiddenConditions.some(value => context.includes(value.toLowerCase()))) rejected.push("命中组件禁用条件");
  const query = terms([brief.scene, brief.barrier, brief.audience.user, category].join(" "));
  const source = [card.problem, card.name, card.instruction].join(" ").toLowerCase();
  const matched = query.filter(word => source.includes(word));
  return { rejected, score: matched.length, reasons: ["平台和转化目标适配", "证据与拍摄条件满足", ...(matched.length ? [`匹配当前场景：${matched.slice(0, 5).join("、")}`] : ["可用的通用方法，暂无额外场景匹配"])] };
}

export async function buildEcommerceContext(access: EcommerceAccess, taskId: string) {
  const db = getD1(), task = await readTask(access, taskId), scope = [access.organizationId, access.projectId];
  const brief = taskBriefSchema.parse(JSON.parse(task.brief_json));
  if (brief.knowledgeIds.length > 5 || brief.evidenceIds.length > 5 || brief.caseIds.length > 3 || brief.componentIds.length > 4)
    throw new EcommerceError("SOURCE_LIMIT", "每次最多选择 5 条证据、5 条品牌知识、3 个案例和每类 1 个组件。", 400);
  await validateTaskReferences(access, task.product_id, task.product_version_id, brief);
  // Do not SELECT internal_json: private commercial fields never enter this process.
  const row = await db.prepare(`SELECT v.id,v.name,v.sku,v.public_json,v.confirmed_by,v.version,p.revision,p.status FROM ecommerce_product_versions v
    INNER JOIN ecommerce_products p ON p.id=v.product_id AND p.organization_id=v.organization_id AND p.project_id=v.project_id
    WHERE v.id=? AND v.product_id=? AND v.organization_id=? AND v.project_id=?`)
    .bind(task.product_version_id, task.product_id, ...scope).first<{ id: string; name: string; sku: string; public_json: string; confirmed_by: string | null; version: number; revision: number; status: string }>();
  if (!row || row.status !== "confirmed" || !row.confirmed_by) throw new EcommerceError("PRODUCT_NOT_CONFIRMED", "请先确认所选商品版本。", 409);
  const product = productPublicSchema.parse(JSON.parse(row.public_json));
  const claim = product.claims.find(c => c.id === brief.claimId);
  if (!claim || claim.status !== "confirmed" || isExpired(claim.validUntil)) throw new EcommerceError("CLAIM_UNAVAILABLE", "请选择一条已确认且未过期的主卖点。", 409);
  if (!brief.evidenceIds.length || brief.evidenceIds.some(id => !claim.evidenceIds.includes(id))) throw new EcommerceError("CLAIM_EVIDENCE_REQUIRED", "请选择属于本次主卖点的证据。", 409);
  const evidence: EvidenceSource[] = [];
  for (const id of brief.evidenceIds) {
    const e = await db.prepare("SELECT id,revision,kind,body_json,status,valid_until,confirmed_by,media_asset_id FROM ecommerce_evidence WHERE id=? AND product_id=? AND organization_id=? AND project_id=?")
      .bind(id, task.product_id, ...scope).first<{ id: string; revision: number; kind: string; body_json: string; status: string; valid_until: string | null; confirmed_by: string | null; media_asset_id: string | null }>();
    if (!e || e.status !== "confirmed" || !e.confirmed_by || isExpired(e.valid_until)) throw new EcommerceError("EVIDENCE_UNAVAILABLE", "所选证据已失效或尚未确认。", 409);
    if (e.media_asset_id && !await db.prepare("SELECT id FROM media_assets WHERE id=? AND organization_id=? AND project_id=? AND status='active'").bind(e.media_asset_id, ...scope).first())
      throw new EcommerceError("MEDIA_UNAVAILABLE", "证据附件已失效。", 409);
    const body = JSON.parse(e.body_json) as Record<string, unknown>;
    evidence.push({ id: e.id, revision: e.revision, kind: e.kind, title: String(body.title ?? ""), body: String(body.body ?? ""), sourceLocator: String(body.sourceLocator ?? ""), conditions: String(body.conditions ?? ""), mediaAssetId: e.media_asset_id, validUntil: e.valid_until });
  }
  const priceReady = claim.kind === "offer" && product.priceCents !== null && Boolean(product.offerValidUntil) && !isExpired(product.offerValidUntil) && evidence.some(e => e.kind === "offer");
  if (claim.kind === "offer" && !priceReady) throw new EcommerceError("OFFER_UNAVAILABLE", "价格卖点需要有效价格、有效期及活动证据。", 409);
  const strategy = strategyForTask(await readCoreContentStrategy(db, access), targetNames[brief.target]);
  if (!strategy?.positioning || !strategy.targetAudience) throw new EcommerceError("STRATEGY_REQUIRED", "请先补齐当前空间的核心内容策略。", 409);
  const missing: string[] = [];
  if (!brief.audience.user || !brief.audience.buyer) missing.push("本次购买者和使用者");
  if (!brief.scene) missing.push("购买场景"); if (!brief.barrier) missing.push("主要购买障碍");
  if (!brief.destination) missing.push("商品卡或直播间承接位置"); if (!brief.filming.length) missing.push("拍摄条件");

  const knowledge: Array<{ id: string; versionId: string; title: string; text: string }> = [];
  for (const id of brief.knowledgeIds) {
    const k = await db.prepare(`SELECT k.id,k.title,v.id AS version_id,v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id=k.id AND v.organization_id=k.organization_id AND v.project_id=k.project_id
      WHERE k.id=? AND k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL ORDER BY v.version DESC LIMIT 1`).bind(id, ...scope)
      .first<{ id: string; title: string; version_id: string; body: string }>();
    if (!k) throw new EcommerceError("KNOWLEDGE_UNAVAILABLE", "所选品牌知识版本不可用。", 409);
    knowledge.push({ id: k.id, versionId: k.version_id, title: k.title, text: k.body.slice(0, 6000) });
  }
  const cards = await db.prepare(`SELECT c.id,c.scope,c.revision,v.id AS version_id,v.body_json FROM ecommerce_components c INNER JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version
    WHERE c.status='confirmed' AND ((c.scope='project' AND c.organization_id=? AND c.project_id=?) OR c.scope='system') ORDER BY c.id LIMIT 1000`).bind(...scope)
    .all<{ id: string; scope: string; revision: number; version_id: string; body_json: string }>();
  const candidates: Candidate[] = [], rejected: Array<{ id: string; name: string; reasons: string[] }> = [];
  const cardSchema = componentSchema.omit({ organizationId: true, projectId: true, id: true, revision: true });
  for (const c of cards.results) {
    const parsed = cardSchema.safeParse(JSON.parse(c.body_json));
    if (!parsed.success) { rejected.push({ id: c.id, name: "格式失效的组件", reasons: ["组件字段不完整"] }); continue; }
    const eligibility = candidateEligibility(parsed.data, brief, product.category, evidence, priceReady);
    if (eligibility.rejected.length) rejected.push({ id: c.id, name: parsed.data.name, reasons: eligibility.rejected });
    else candidates.push({ id: c.id, versionId: c.version_id, revision: c.revision, scope: c.scope, card: parsed.data, score: eligibility.score, reasons: eligibility.reasons });
  }
  for (const id of brief.componentIds) if (!candidates.some(c => c.id === id)) throw new EcommerceError("SELECTED_COMPONENT_UNSUITABLE", "指定组件不满足当前任务条件，请查看筛选原因。", 409);
  const selectedCandidates = kinds.flatMap(kind => {
    const group = candidates.filter(c => c.card.kind === kind).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const pinned = group.filter(c => brief.componentIds.includes(c.id));
    if (pinned.length > 1) throw new EcommerceError("DUPLICATE_COMPONENT_KIND", "每类只能指定一个组件。", 400);
    if (!group.length) missing.push(`适配的${kindNames[kind]}组件`);
    return pinned.length ? pinned : group.slice(0, 5);
  });
  const caseRows = await db.prepare(`SELECT c.id,c.revision,c.reference_id,c.analysis_id,c.body_json,c.source_snapshot FROM ecommerce_case_profiles c
    INNER JOIN project_video_references r ON r.id=c.reference_id AND r.organization_id=c.organization_id AND r.project_id=c.project_id
    INNER JOIN videos v ON v.id=c.video_id AND v.organization_id=c.organization_id
    WHERE c.organization_id=? AND c.project_id=? AND c.status='confirmed' AND r.status='active' AND r.purpose='benchmark' AND v.deleted_at IS NULL AND v.status!='archived' ORDER BY c.id LIMIT 300`).bind(...scope)
    .all<{ id: string; revision: number; reference_id: string; analysis_id: string; body_json: string; source_snapshot: string }>();
  const caseQuery = terms([brief.scene, brief.barrier, brief.audience.user].join(" "));
  const cases: CaseSource[] = caseRows.results.map(c => {
    const body = JSON.parse(c.body_json) as Record<string, unknown>;
    const text = [body.structure, body.transferable, body.nonTransferable, c.source_snapshot].join("\n");
    const score = caseQuery.filter(q => text.toLowerCase().includes(q)).length;
    return { id: c.id, revision: c.revision, referenceId: c.reference_id, analysisId: c.analysis_id, title: String(body.title ?? ""), text, structure: String(body.structure ?? ""), transferable: String(body.transferable ?? ""), nonTransferable: String(body.nonTransferable ?? ""), score, target: body.target };
  }).filter(c => brief.caseIds.length ? brief.caseIds.includes(c.id) : c.target === brief.target && c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3)
    .map(({ score, target, ...c }) => { void score; void target; return c; });
  if (brief.caseIds.some(id => !cases.some(c => c.id === id))) throw new EcommerceError("CASE_UNAVAILABLE", "指定案例已经不可用。", 409);

  const sources: ContextSource[] = [
    { type: "claim", id: claim.id, version: row.id, title: "本次主卖点", text: [claim.statement, claim.allowedExpression, claim.conditions].join("\n") },
    ...evidence.map(e => ({ type: "evidence" as const, id: e.id, version: String(e.revision), title: e.title, text: [e.body, e.conditions].join("\n") })),
    ...knowledge.map(k => ({ type: "knowledge" as const, id: k.id, version: k.versionId, title: k.title, text: k.text })),
    ...selectedCandidates.map(c => ({ type: "component" as const, id: c.id, version: c.versionId, title: c.card.name, text: [c.card.instruction, c.card.problem, c.card.inputContract, c.card.outputContract].join("\n") })),
    ...cases.map(c => ({ type: "case" as const, id: c.id, version: `${c.analysisId}:${c.revision}`, title: c.title, text: c.text })),
  ];
  const publicProduct = { id: task.product_id, versionId: row.id, revision: row.revision, name: row.name, sku: row.sku, category: product.category,
    specification: product.specification, prohibited: product.prohibited, purchaseConcerns: product.purchaseConcerns,
    claim: { id: claim.id, statement: claim.statement, allowedExpression: claim.allowedExpression, conditions: claim.conditions, validUntil: claim.validUntil },
    offer: priceReady ? { priceCents: product.priceCents, currency: product.currency, offer: product.offer, validUntil: product.offerValidUntil } : null };
  const input = { task: { id: task.id, title: task.title, revision: task.revision, brief }, product: publicProduct, strategy, evidence, knowledge, candidates: selectedCandidates, cases, sources };
  const manifest = await Promise.all(sources.map(async s => ({ sourceType: s.type, sourceId: s.id, version: s.version, contentHash: await hashJson(s.text), organizationId: access.organizationId, projectId: access.projectId })));
  return { task, input, manifest, inputHash: await hashJson(input), ready: missing.length === 0, missing, rejected };
}
export type EcommerceContext = Awaited<ReturnType<typeof buildEcommerceContext>>;
