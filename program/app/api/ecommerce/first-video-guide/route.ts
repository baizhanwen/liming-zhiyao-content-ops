import { getD1 } from "../../../../db/runtime";
import { readCoreContentStrategy } from "../../../../lib/content-strategy-policy";
import { authorize, EcommerceError, endpoint, queryScope } from "../../../../lib/ecommerce/access";
import { componentSchema, productPublicSchema } from "../../../../lib/ecommerce/contracts";
import type { FirstVideoGuideData, FirstVideoProduct, FirstVideoTask } from "../../../../lib/ecommerce/first-video-guide";

export const dynamic = "force-dynamic";

type ProductRow = {
  id: string; name: string; sku: string; status: string; current_version: number; version_id: string;
  public_json: string; confirmed_by: string | null; confirmed_at: string | null;
};
type EvidenceRow = { id: string; product_id: string; kind: string; status: string; confirmed_by: string | null; confirmed_at: string | null; valid_until: string | null; attachment_available: number };
type TaskRow = {
  id: string; title: string; status: string; product_id: string; product_version_id: string;
  current_version: number; revision: number; version_id: string | null; pack_present: number;
  snapshot_revision: number | null; validation_ok: number | null; pending_count: number | null;
};
const productProjection = `SELECT p.id,p.name,p.sku,p.status,p.current_version,v.id AS version_id,v.public_json,v.confirmed_by,v.confirmed_at
  FROM ecommerce_products p INNER JOIN ecommerce_product_versions v ON v.product_id=p.id AND v.version=p.current_version
    AND v.organization_id=p.organization_id AND v.project_id=p.project_id
  WHERE p.organization_id=? AND p.project_id=?`;
function parseJson(value: string | null): unknown { try { return value === null ? null : JSON.parse(value); } catch { return null; } }
function notExpired(value: string | null, now: number) { return value === null || Number.isFinite(Date.parse(value)) && Date.parse(value) > now; }
function evidenceReady(row: EvidenceRow, now: number) { return row.status === "confirmed" && Boolean(row.confirmed_by && row.confirmed_at && row.attachment_available) && notExpired(row.valid_until, now); }

function productSummary(row: ProductRow, evidence: EvidenceRow[], now: number): FirstVideoProduct {
  const parsed = productPublicSchema.safeParse(parseJson(row.public_json));
  const publicData = parsed.success ? parsed.data : null;
  const own = evidence.filter(item => item.product_id === row.id), available = own.filter(item => evidenceReady(item, now));
  const readyClaimIds = publicData?.claims.filter(claim => {
    if (claim.status !== "confirmed" || !notExpired(claim.validUntil, now)) return false;
    const backing = available.filter(item => claim.evidenceIds.includes(item.id));
    if (!backing.length) return false;
    return claim.kind !== "offer" || publicData.priceCents !== null && publicData.offerValidUntil !== null
      && notExpired(publicData.offerValidUntil, now) && backing.some(item => item.kind === "offer");
  }).map(claim => claim.id) ?? [];
  const problems: string[] = [];
  if (!publicData) problems.push("商品资料格式失效，请重新保存商品");
  else {
    if (!publicData.category.trim()) problems.push("补充商品品类");
    if (!publicData.audience.user.trim() || !publicData.audience.buyer.trim()) problems.push("选择或填写使用者和购买者");
    if (!publicData.scenarios.trim()) problems.push("选择或填写商品使用场景");
    if (!publicData.prohibited.trim()) problems.push("填写不能说的内容");
    if (!own.length) problems.push("添加一条商品证据");
    else if (!available.length) problems.push("确认一条未过期且附件可用的商品证据");
    if (!readyClaimIds.length) {
      const hasOffer = publicData.claims.some(claim => claim.status === "confirmed" && claim.kind === "offer");
      problems.push(hasOffer ? "补齐价格卖点的价格、有效期和活动证据，或选择其他有效卖点" : "确认一条关联有效证据的卖点");
    }
  }
  if (row.status === "revoked") problems.push("商品已撤回，请重新核对后确认");
  else if (row.status !== "confirmed" || !row.confirmed_by || !row.confirmed_at) problems.push("确认当前商品版本");
  return {
    id: row.id, name: row.name, sku: row.sku, status: row.status, currentVersion: row.current_version,
    versionId: row.version_id, confirmedAt: row.confirmed_at, publicData,
    evidenceCount: own.length, readyEvidenceCount: available.length, readyClaimIds,
    ready: problems.length === 0, problems,
  };
}

function taskSummary(row: TaskRow): FirstVideoTask {
  const hasDraft = Boolean(row.version_id && row.pack_present === 1 && row.snapshot_revision === row.revision);
  return {
    id: row.id, title: row.title, status: row.status, productId: row.product_id, productVersionId: row.product_version_id,
    currentVersion: row.current_version, versionId: row.version_id,
    hasDraft, pendingConfirmationCount: row.pending_count,
    readyForFilming: hasDraft && row.validation_ok === 1 && row.pending_count === 0 && row.status !== "archived",
  };
}

/** Project-scoped, public fact projection only. A refresh never writes readiness. */
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), db = getD1();
    const scope = [access.organizationId, access.projectId], query = new URL(request.url).searchParams;
    const explicitSelection = query.has("productId"), requestedProductId = query.get("productId")?.trim() ?? "";
    if (requestedProductId.length > 100) throw new EcommerceError("INVALID_PRODUCT", "请选择当前空间的商品。", 400);
    const [productRows, taskRows, cards, strategy] = await Promise.all([
      db.prepare(`${productProjection} ORDER BY p.updated_at DESC,p.id LIMIT 200`).bind(...scope).all<ProductRow>(),
      db.prepare(`SELECT t.id,t.title,t.status,t.product_id,t.product_version_id,t.current_version,t.revision,
        v.id AS version_id,json_extract(v.input_snapshot_json,'$.taskRevision') AS snapshot_revision,
        json_extract(v.validation_json,'$.ok') AS validation_ok,
        CASE WHEN json_type(v.pack_json,'$.pendingConfirmations')='array' THEN json_array_length(v.pack_json,'$.pendingConfirmations') ELSE NULL END AS pending_count,
        CASE WHEN json_type(v.pack_json,'$.segments')='array' AND json_array_length(v.pack_json,'$.segments') BETWEEN 2 AND 20
          AND json_type(v.pack_json,'$.applications')='array' AND json_type(v.pack_json,'$.pendingConfirmations')='array'
          AND json_type(v.pack_json,'$.filmingChecklist')='array' AND json_array_length(v.pack_json,'$.filmingChecklist') > 0
          AND json_type(v.pack_json,'$.title')='text' AND length(trim(json_extract(v.pack_json,'$.title'))) > 0
          AND NOT EXISTS (SELECT 1 FROM json_each(v.pack_json,'$.segments') segment WHERE CASE WHEN segment.type != 'object' THEN 1
            WHEN COALESCE(json_type(segment.value,'$.script'),'') != 'text' OR length(trim(json_extract(segment.value,'$.script'))) = 0
              OR COALESCE(json_type(segment.value,'$.visual'),'') != 'text' OR length(trim(json_extract(segment.value,'$.visual'))) = 0 THEN 1 ELSE 0 END = 1)
          AND NOT EXISTS (SELECT 1 FROM json_each(v.pack_json,'$.filmingChecklist') item WHERE item.type != 'text' OR length(trim(item.value)) = 0)
          THEN 1 ELSE 0 END AS pack_present
        FROM ecommerce_tasks t LEFT JOIN ecommerce_versions v ON v.task_id=t.id AND v.version=t.current_version
          AND v.product_id=t.product_id AND v.product_version_id=t.product_version_id AND v.organization_id=t.organization_id AND v.project_id=t.project_id
        WHERE t.organization_id=? AND t.project_id=? ORDER BY t.updated_at DESC,t.id LIMIT 200`).bind(...scope).all<TaskRow>(),
      db.prepare(`SELECT c.kind,v.body_json FROM ecommerce_components c INNER JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version
        WHERE c.status='confirmed' AND ((c.scope='project' AND c.organization_id=? AND c.project_id=?) OR c.scope='system') ORDER BY c.id LIMIT 1000`).bind(...scope).all<{ kind: string; body_json: string }>(),
      readCoreContentStrategy(db, access),
    ]);
    if (explicitSelection && requestedProductId && !productRows.results.some(row => row.id === requestedProductId)) {
      const selected = await db.prepare(`${productProjection} AND p.id=?`).bind(...scope, requestedProductId).first<ProductRow>();
      if (!selected) throw new EcommerceError("PRODUCT_UNAVAILABLE", "商品不存在或不属于当前企业空间，请重新选择。", 404);
      productRows.results.unshift(selected);
    }
    const evidence = productRows.results.length ? (await db.prepare(`SELECT e.id,e.product_id,e.kind,e.status,e.confirmed_by,e.confirmed_at,e.valid_until,
      CASE WHEN e.media_asset_id IS NULL OR m.id IS NOT NULL THEN 1 ELSE 0 END AS attachment_available
      FROM ecommerce_evidence e LEFT JOIN media_assets m ON m.id=e.media_asset_id AND m.organization_id=e.organization_id AND m.project_id=e.project_id AND m.status='active'
      WHERE e.organization_id=? AND e.project_id=? AND e.product_id IN (SELECT value FROM json_each(?))`)
      .bind(...scope, JSON.stringify(productRows.results.map(row => row.id))).all<EvidenceRow>()).results : [];
    const now = Date.now(), products = productRows.results.map(row => productSummary(row, evidence, now));
    const selectedProduct = explicitSelection ? products.find(row => row.id === requestedProductId) ?? null : products.find(row => row.ready) ?? products[0] ?? null;
    const counts = { hook: 0, visual: 0, structure: 0, sop: 0 };
    const cardSchema = componentSchema.omit({ organizationId: true, projectId: true, id: true, revision: true });
    for (const row of cards.results) {
      const card = cardSchema.safeParse(parseJson(row.body_json));
      if (card.success && card.data.status === "confirmed" && notExpired(card.data.validUntil, now) && card.data.kind === row.kind) counts[card.data.kind] += 1;
    }
    const strategyReady = Boolean(strategy?.positioning.trim() && strategy.targetAudience.trim());
    const methodsReady = Object.values(counts).every(value => value > 0);
    const tasks = taskRows.results.map(taskSummary).map(task => ({
      ...task,
      readyForFilming: task.readyForFilming && Boolean(access.settings.enabled) && strategyReady && methodsReady
        && products.some(product => product.id === task.productId && product.versionId === task.productVersionId && product.ready),
    }));
    const data: FirstVideoGuideData = {
      observedAt: new Date(now).toISOString(), settings: access.settings, canManage: access.organizationRole === "admin",
      products, selectedProductId: selectedProduct?.id ?? null, selectedProduct, tasks,
      strategy: { ready: strategyReady, positioning: strategy?.positioning ?? "", targetAudience: strategy?.targetAudience ?? "", styleNotes: strategy?.styleNotes ?? "" },
      methods: { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0), ready: methodsReady },
    };
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  });
}
