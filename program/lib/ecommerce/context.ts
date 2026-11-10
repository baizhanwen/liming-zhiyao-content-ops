import { getD1 } from "../../db/runtime";
import { readCoreContentStrategy, strategyForTask } from "../content-strategy-policy";
import { EcommerceError, type EcommerceAccess } from "./access";
import { componentSchema, productPublicSchema, taskBriefSchema, taskReferenceMode, type ComponentInput, type TaskBrief } from "./contracts";
import { hashJson } from "./products";
import { readTask, validateTaskReferences } from "./tasks";
import { readCaseSource } from "./cases";

export type MethodCard = Omit<ComponentInput, "organizationId" | "projectId" | "id" | "revision">;
export type Candidate = { id: string; versionId: string; revision: number; scope: string; card: Omit<MethodCard, "requiredFilming">; score: number; reasons: string[] };
export type EvidenceSource = { id: string; revision: number; kind: string; body: string; title: string; sourceLocator: string; conditions: string; mediaAssetId: string | null; validUntil: string | null; virtualProductVersionId?: string };
export type ContextSource = { id: string; type: "claim" | "evidence" | "knowledge" | "component" | "case"; version: string; title: string; text: string };
export type CaseSource = { id: string; revision: number; referenceId: string; analysisId: string; title: string; text: string; structure: string; transferable: string; nonTransferable: string; direct?: boolean; transcriptId?: string | null; videoId?: string };
export type DirectCaseSnapshot = { id: string; videoId: string; reportJson: string; transcriptId: string | null; transcriptText: string };
const targetNames = { product_click: "商品点击", live_entry: "直播进房", purchase: "成交" };
const kinds = ["hook", "structure"] as const;
const kindNames = { hook: "开头", structure: "文案结构" };
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
  if (!kinds.some(kind => kind === card.kind) || card.requiredFilming.length) rejected.push("拍摄方法不用于文案");
  if (card.requiresPrice && !priceReady) rejected.push("缺少有效价格或活动证据");
  const context = [brief.scene, brief.barrier, brief.instructions, ...brief.excludedConditions].join("\n").toLowerCase();
  if (card.forbiddenConditions.some(value => context.includes(value.toLowerCase()))) rejected.push("命中组件禁用条件");
  const query = terms([brief.scene, brief.barrier, brief.audience.user, category].join(" "));
  const source = [card.problem, card.name, card.instruction].join(" ").toLowerCase();
  const matched = query.filter(word => source.includes(word));
  return { rejected, score: matched.length, reasons: ["平台和转化目标适配", "证据与文案条件满足", ...(matched.length ? [`匹配当前场景：${matched.slice(0, 5).join("、")}`] : ["可用的通用方法，暂无额外场景匹配"])] };
}

export async function buildEcommerceContext(access: EcommerceAccess, taskId: string) {
  const db = getD1(), task = await readTask(access, taskId), scope = [access.organizationId, access.projectId];
  const brief = taskBriefSchema.parse(JSON.parse(task.brief_json)), mode = taskReferenceMode(brief);
  if (brief.knowledgeIds.length > 5 || brief.evidenceIds.length > 5 || brief.caseIds.length > 3 || brief.componentIds.length > 4)
    throw new EcommerceError("SOURCE_LIMIT", "每次最多选择 5 条证据、5 条品牌知识、3 个案例和每类 1 个组件。", 400);
  const { writingComponentIds } = await validateTaskReferences(access, task.product_id, task.product_version_id, brief);
  // Do not SELECT internal_json: private commercial fields never enter this process.
  const row = await db.prepare(`SELECT v.id,v.name,v.sku,v.public_json,v.confirmed_by,v.version,p.current_version,p.revision,p.status FROM ecommerce_product_versions v
    INNER JOIN ecommerce_products p ON p.id=v.product_id AND p.organization_id=v.organization_id AND p.project_id=v.project_id
    WHERE v.id=? AND v.product_id=? AND v.organization_id=? AND v.project_id=?`)
    .bind(task.product_version_id, task.product_id, ...scope).first<{ id: string; name: string; sku: string; public_json: string; confirmed_by: string | null; version: number; current_version: number; revision: number; status: string }>();
  if (!row || row.status !== "confirmed" || !row.confirmed_by) throw new EcommerceError("PRODUCT_NOT_CONFIRMED", "请先确认所选商品版本。", 409);
  const product = productPublicSchema.parse(JSON.parse(row.public_json));
  const simpleBenchmark = mode === "benchmark" && !brief.claimId && !brief.evidenceIds.length;
  const virtualProductSnapshot = simpleBenchmark ? { versionId: row.id, publicJson: row.public_json, name: row.name } : null;
  let claim: typeof product.claims[number];
  const evidence: EvidenceSource[] = [];
  if (simpleBenchmark) {
    if (row.version !== row.current_version) throw new EcommerceError("PRODUCT_VERSION_CHANGED", "商品信息已有新版本，请重新选择当前商品版本。", 409);
    const body = ["用户确认的商品资料（不等同于外部实验或认证）", `商品名称：${row.name}`, `品类：${product.category}`,
      product.specification ? `规格：${product.specification}` : "", product.sellingPoints ? `用户确认的录入卖点（只作表达重点，不自动证明功效、销量、资质或保证）：${product.sellingPoints}` : "", product.priceCents !== null ? `用户确认的录入价格：${product.priceCents / 100} ${product.currency}` : "",
      `使用者：${product.audience.user}`, `购买者：${product.audience.buyer}`, `使用场景：${product.scenarios}`, `表达禁区：${product.prohibited}`].filter(Boolean).join("\n");
    const evidenceId = `product-facts:${row.id}`;
    claim = { id: `product-claim:${row.id}`, statement: `${row.name}的已确认商品信息`, kind: "specification", allowedExpression: body,
      conditions: "仅可描述上述用户确认的基础信息，不推断功效、材质、资质、销量、优惠或使用体验。", evidenceIds: [evidenceId], validUntil: null, status: "confirmed" };
    evidence.push({ id: evidenceId, revision: row.revision, kind: "manual_confirmation", title: "用户确认的商品资料", body,
      sourceLocator: `当前商品资料版本 ${row.version}`, conditions: claim.conditions, mediaAssetId: null, validUntil: null, virtualProductVersionId: row.id });
  } else {
    claim = product.claims.find(c => c.id === brief.claimId)!;
    if (!claim || claim.status !== "confirmed" || isExpired(claim.validUntil)) throw new EcommerceError("CLAIM_UNAVAILABLE", "请选择一条已确认且未过期的主卖点。", 409);
    if (!brief.evidenceIds.length || brief.evidenceIds.some(id => !claim.evidenceIds.includes(id))) throw new EcommerceError("CLAIM_EVIDENCE_REQUIRED", "请选择属于本次主卖点的证据。", 409);
    for (const id of brief.evidenceIds) {
      const e = await db.prepare("SELECT id,revision,kind,body_json,status,valid_until,confirmed_by,media_asset_id FROM ecommerce_evidence WHERE id=? AND product_id=? AND organization_id=? AND project_id=?")
        .bind(id, task.product_id, ...scope).first<{ id: string; revision: number; kind: string; body_json: string; status: string; valid_until: string | null; confirmed_by: string | null; media_asset_id: string | null }>();
      if (!e || e.status !== "confirmed" || !e.confirmed_by || isExpired(e.valid_until)) throw new EcommerceError("EVIDENCE_UNAVAILABLE", "所选证据已失效或尚未确认。", 409);
      if (e.media_asset_id && !await db.prepare("SELECT id FROM media_assets WHERE id=? AND organization_id=? AND project_id=? AND status='active'").bind(e.media_asset_id, ...scope).first())
        throw new EcommerceError("MEDIA_UNAVAILABLE", "证据附件已失效。", 409);
      const body = JSON.parse(e.body_json) as Record<string, unknown>;
      evidence.push({ id: e.id, revision: e.revision, kind: e.kind, title: String(body.title ?? ""), body: String(body.body ?? ""), sourceLocator: String(body.sourceLocator ?? ""), conditions: String(body.conditions ?? ""), mediaAssetId: e.media_asset_id, validUntil: e.valid_until });
    }
  }
  const priceReady = claim.kind === "offer" && product.priceCents !== null && !isExpired(product.offerValidUntil) && (!product.offer.trim() || Boolean(product.offerValidUntil)) && evidence.some(e => e.kind === "offer");
  if (claim.kind === "offer" && !priceReady) throw new EcommerceError("OFFER_UNAVAILABLE", "价格信息需要已录入价格和已确认的价格证据；促销活动还需要有效期，已过期的价格信息不能使用。", 409);
  const configuredStrategy = strategyForTask(await readCoreContentStrategy(db, access), targetNames[brief.target]);
  const strategy = configuredStrategy?.positioning.trim() && configuredStrategy.targetAudience.trim() ? configuredStrategy : null;
  if (!strategy && mode === "method") throw new EcommerceError("STRATEGY_REQUIRED", "请先补齐当前空间的核心内容策略。", 409);
  const missing: string[] = [];
  if (!brief.audience.user || !brief.audience.buyer) missing.push("本次购买者和使用者");
  if (!brief.scene) missing.push("购买场景"); if (!brief.barrier) missing.push("主要购买障碍");
  if (!brief.destination) missing.push("商品卡或直播间承接位置");

  const knowledge: Array<{ id: string; versionId: string; title: string; text: string }> = [];
  for (const id of brief.knowledgeIds) {
    const k = await db.prepare(`SELECT k.id,k.title,v.id AS version_id,v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id=k.id AND v.organization_id=k.organization_id AND v.project_id=k.project_id
      WHERE k.id=? AND k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL ORDER BY v.version DESC LIMIT 1`).bind(id, ...scope)
      .first<{ id: string; title: string; version_id: string; body: string }>();
    if (!k) throw new EcommerceError("KNOWLEDGE_UNAVAILABLE", "所选品牌知识版本不可用。", 409);
    knowledge.push({ id: k.id, versionId: k.version_id, title: k.title, text: k.body.slice(0, 6000) });
  }
  const cards = await db.prepare(`SELECT c.id,c.scope,c.status,c.revision,v.id AS version_id,v.body_json FROM ecommerce_components c INNER JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version
    WHERE ((c.scope='project' AND c.organization_id=? AND c.project_id=?) OR c.scope='system') ORDER BY c.id LIMIT 1000`).bind(...scope)
    .all<{ id: string; scope: string; status: string; revision: number; version_id: string; body_json: string }>();
  const candidates: Candidate[] = [], nonWritingComponentIds: string[] = [], rejected: Array<{ id: string; name: string; reasons: string[] }> = [];
  const cardSchema = componentSchema.omit({ organizationId: true, projectId: true, id: true, revision: true });
  for (const c of cards.results) {
    const parsed = cardSchema.safeParse(JSON.parse(c.body_json));
    if (!parsed.success) { rejected.push({ id: c.id, name: "格式失效的组件", reasons: ["组件字段不完整"] }); continue; }
    if (!["hook", "structure"].includes(parsed.data.kind) || parsed.data.requiredFilming.length) nonWritingComponentIds.push(c.id);
    const eligibility = candidateEligibility({ ...parsed.data, status: c.status as MethodCard["status"] }, brief, product.category, evidence, priceReady);
    if (eligibility.rejected.length) rejected.push({ id: c.id, name: parsed.data.name, reasons: eligibility.rejected });
    else candidates.push({ id: c.id, versionId: c.version_id, revision: c.revision, scope: c.scope, card: componentSchema.omit({ organizationId: true, projectId: true, id: true, revision: true, requiredFilming: true }).strip().parse(parsed.data), score: eligibility.score, reasons: eligibility.reasons });
  }
  for (const id of writingComponentIds) if (!candidates.some(c => c.id === id)) throw new EcommerceError("SELECTED_COMPONENT_UNSUITABLE", "指定组件不满足当前任务条件，请查看筛选原因。", 409);
  const selectedCandidates = mode === "benchmark" ? [] : kinds.flatMap(kind => {
    const group = candidates.filter(c => c.card.kind === kind).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const pinned = group.filter(c => writingComponentIds.includes(c.id));
    if (pinned.length > 1) throw new EcommerceError("DUPLICATE_COMPONENT_KIND", "每类只能指定一个组件。", 400);
    if (!group.length) missing.push(`适配的${kindNames[kind]}组件`);
    return pinned.length ? pinned : group.slice(0, 5);
  });
  const cases: CaseSource[] = [], directCaseSnapshots: DirectCaseSnapshot[] = [];
  if (mode === "benchmark" && brief.benchmark) {
    const selected = brief.benchmark;
    const source = await readCaseSource(access, selected.referenceId, selected.analysisId, selected.transcriptId);
    const transcriptText = selected.transcriptId ? (await db.prepare("SELECT full_text FROM video_transcripts WHERE id=? AND video_id=? AND organization_id=?").bind(selected.transcriptId, source.video_id, access.organizationId).first<{ full_text: string }>())?.full_text ?? "" : "";
    const text = source.sourceText.slice(0, 48_000);
    if (!text.trim()) throw new EcommerceError("CASE_SOURCE_EMPTY", "对标视频还没有可用的文案或分析内容，请先完成分析。", 409);
    cases.push({ id: selected.referenceId, revision: 1, direct: true, referenceId: selected.referenceId, analysisId: selected.analysisId, transcriptId: selected.transcriptId, videoId: source.video_id,
      title: source.title, text, structure: "依据所选视频的实际文案和分析，保留可迁移的叙事顺序、开头与收束机制。", transferable: "只借鉴文案结构与表达机制，所有商品事实换成本商品已确认的证据。", nonTransferable: "不迁移原作者身份、经历、销量、价格、效果、资质、用户反馈或承诺。" });
    directCaseSnapshots.push({ id: selected.referenceId, videoId: source.video_id, reportJson: source.report_json, transcriptId: selected.transcriptId, transcriptText });
  } else if (mode === "benchmark") {
    const c = await db.prepare(`SELECT c.id,c.revision,c.reference_id,c.analysis_id,c.body_json,c.source_snapshot FROM ecommerce_case_profiles c
      INNER JOIN project_video_references r ON r.id=c.reference_id AND r.organization_id=c.organization_id AND r.project_id=c.project_id
      INNER JOIN videos v ON v.id=c.video_id AND v.organization_id=c.organization_id
      WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.status='confirmed' AND r.status='active' AND r.purpose='benchmark' AND v.deleted_at IS NULL AND v.status!='archived'`).bind(brief.caseIds[0], ...scope)
      .first<{ id: string; revision: number; reference_id: string; analysis_id: string; body_json: string; source_snapshot: string }>();
    if (!c) throw new EcommerceError("CASE_UNAVAILABLE", "指定案例已经不可用。", 409);
    const body = JSON.parse(c.body_json) as Record<string, unknown>;
    cases.push({ id: c.id, revision: c.revision, referenceId: c.reference_id, analysisId: c.analysis_id, title: String(body.title ?? ""), text: [body.structure, body.transferable, body.nonTransferable, c.source_snapshot].join("\n"), structure: String(body.structure ?? ""), transferable: String(body.transferable ?? ""), nonTransferable: String(body.nonTransferable ?? "") });
  }

  const sources: ContextSource[] = [
    { type: "claim", id: claim.id, version: row.id, title: "本次主卖点", text: [claim.statement, claim.allowedExpression, claim.conditions].join("\n") },
    ...evidence.map(e => ({ type: "evidence" as const, id: e.id, version: String(e.revision), title: e.title, text: [e.body, e.conditions].join("\n") })),
    ...knowledge.map(k => ({ type: "knowledge" as const, id: k.id, version: k.versionId, title: k.title, text: k.text })),
    ...selectedCandidates.map(c => ({ type: "component" as const, id: c.id, version: c.versionId, title: c.card.name, text: [c.card.instruction, c.card.problem, c.card.inputContract, c.card.outputContract].join("\n") })),
    ...cases.map(c => ({ type: "case" as const, id: c.id, version: `${c.analysisId}:${c.revision}`, title: c.title, text: c.text })),
  ];
  const publicProduct = { id: task.product_id, versionId: row.id, revision: row.revision, name: row.name, category: product.category,
    price: product.priceCents !== null ? { amountCents: product.priceCents, currency: product.currency, verification: "用户录入价格；只有所选商品主张或证据明确支持时才写入文案，不代表已核实优惠。" } : null,
    specification: product.specification, sellingPoints: product.sellingPoints, prohibited: product.prohibited, purchaseConcerns: product.purchaseConcerns,
    claim: { id: claim.id, statement: claim.statement, allowedExpression: claim.allowedExpression, conditions: claim.conditions, validUntil: claim.validUntil },
    offer: priceReady ? { priceCents: product.priceCents, currency: product.currency, offer: product.offer, validUntil: product.offerValidUntil } : null };
  const copyBrief = taskBriefSchema.omit({ filming: true, filmingNotes: true }).strip().parse({ ...brief, referenceMode: mode, benchmark: mode === "benchmark" ? brief.benchmark : null, caseIds: mode === "benchmark" ? brief.caseIds : [], componentIds: writingComponentIds });
  const input = { task: { id: task.id, title: task.title, revision: task.revision, brief: copyBrief }, product: publicProduct, strategy, evidence, knowledge, candidates: selectedCandidates, cases, sources };
  const manifest = await Promise.all(sources.map(async s => ({ sourceType: s.type, sourceId: s.id, version: s.version, contentHash: await hashJson(s.text), organizationId: access.organizationId, projectId: access.projectId })));
  return { task, input, manifest, inputHash: await hashJson({ ...input, directCaseSnapshots }), ready: missing.length === 0, missing, rejected, nonWritingComponentIds, directCaseSnapshots, virtualProductSnapshot, optionalStrategySnapshot: strategy ? null : configuredStrategy };
}
export type EcommerceContext = Awaited<ReturnType<typeof buildEcommerceContext>>;

/** Exact direct-reference snapshots are used by the final transaction, never sent to the writing model. */
export function generationSourceDocument(context: EcommerceContext) { return { ...context.input, directCaseSnapshots: context.directCaseSnapshots, virtualProductSnapshot: context.virtualProductSnapshot, optionalStrategySnapshot: context.optionalStrategySnapshot }; }
