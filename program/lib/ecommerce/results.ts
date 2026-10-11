import { z } from "zod";
import { getD1 } from "../../db/runtime";
import { auditStatement, assertMutationAccess, commitMutation, writeBindings, writeGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import { buildEcommerceContext } from "./context";
import { metricsSchema, packSchema, publicationSchema, type MetricInput } from "./contracts";
import { hashJson } from "./products";
import { generationActorGuard, generationSourceGuard } from "./source-guard";
import { readTask } from "./tasks";
import { readVersion } from "./workflow";
import { validateEcommercePack } from "./generation-contract";

export async function savePublication(request: Request, access: EcommerceAccess, taskId: string, input: z.infer<typeof publicationSchema>) {
  const task = await readTask(access, taskId), version = await readVersion(access, taskId, input.versionId), db = getD1(), scope = [access.organizationId, access.projectId];
  if (!["publish_ready", "published"].includes(task.status) || task.current_version !== version.version) throw new EcommerceError("APPROVED_VERSION_REQUIRED", "请选择当前已审核通过的版本登记发布。", 409);
  if (!await db.prepare("SELECT id FROM ecommerce_reviews WHERE task_id=? AND version_id=? AND organization_id=? AND project_id=? AND decision='approved'").bind(taskId, version.id, ...scope).first()) throw new EcommerceError("APPROVED_VERSION_REQUIRED", "该版本尚未审核通过。", 409);
  const account = await db.prepare("SELECT id FROM social_accounts WHERE id=? AND organization_id=? AND project_id=? AND status='active' AND account_type='owned' AND platform=?").bind(input.accountId, ...scope, input.platform).first();
  if (!account) throw new EcommerceError("ACCOUNT_UNAVAILABLE", "请选择当前空间中平台一致的自有账号。", 409);
  if (Date.parse(input.publishedAt) > Date.now() + 60000) throw new EcommerceError("FUTURE_PUBLICATION", "发布登记时间不能在未来。", 400);
  const context = await buildEcommerceContext(access, taskId), pack = packSchema.parse(JSON.parse(version.pack_json));
  if (context.input.task.brief.platform !== input.platform || context.input.task.brief.traffic !== input.traffic) throw new EcommerceError("PUBLICATION_TARGET_CHANGED", "实际平台或流量类型与任务不同，请调整任务并重新审核。", 409);
  if (JSON.parse(version.input_snapshot_json).taskRevision !== task.revision || version.product_version_id !== task.product_version_id || !validateEcommercePack(pack, context).ok || pack.pendingConfirmations.length)
    throw new EcommerceError("SOURCE_CHANGED", "商品、任务或来源已改变，请重新核对稿件。", 409);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const result = await commitMutation(request, access, [
    db.prepare(`WITH expected AS (SELECT ? AS doc) UPDATE ecommerce_tasks SET status='published',updated_by=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND current_version=? AND revision=? AND status IN ('publish_ready','published')
      AND ${writeGuard} AND ${generationSourceGuard} AND ${generationActorGuard}
      AND EXISTS(SELECT 1 FROM social_accounts a WHERE a.id=? AND a.organization_id=ecommerce_tasks.organization_id AND a.project_id=ecommerce_tasks.project_id AND a.account_type='owned' AND a.status='active' AND a.platform=?)
      AND NOT EXISTS(SELECT 1 FROM ecommerce_generation_runs r WHERE r.task_id=ecommerce_tasks.id AND r.status='running')`)
      .bind(JSON.stringify(context.input), access.userId, now, taskId, ...scope, version.version, task.revision, ...writeBindings(access), access.userId, input.accountId, input.platform),
    db.prepare(`INSERT INTO ecommerce_publications (id,organization_id,project_id,task_id,version_id,account_id,platform,external_id,external_url,published_at,traffic,ad_plan,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(id, ...scope, taskId, version.id, input.accountId, input.platform, input.externalId, input.externalUrl, input.publishedAt, input.traffic, input.adPlan, access.userId, now),
    auditStatement(access, "ecommerce.publication.saved", taskId, { publicationId: id, versionId: version.id }),
  ]); requireChanged(result);
  return { id, taskId, versionId: version.id };
}

export function metricSummary(value: MetricInput) {
  const ratio = (numerator: number | null, denominator: number | null) => numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
  return {
    roas: ratio(value.revenueCents, value.spendCents), revenueBasis: value.revenueBasis,
    completionRate: ratio(value.completedViews, value.views), stayRate: ratio(value.stayedViews, value.views),
    productClickRate: ratio(value.productClicks, value.views),
    canAttributeToVideo: value.scope === "video",
    attributionNotice: value.scope === "video" ? "人工回填数据，仅说明该作品在此统计口径下的表现，不证明某个组件导致成交。" : "商品或直播间整体数据，不能归因到某条视频或其组件。",
  };
}

export async function saveMetricSnapshot(request: Request, access: EcommerceAccess, input: MetricInput) {
  const db = getD1(), scope = [access.organizationId, access.projectId];
  const publication = await db.prepare("SELECT id,task_id,published_at,traffic FROM ecommerce_publications WHERE id=? AND organization_id=? AND project_id=?").bind(input.publicationId, ...scope).first<{ id: string; task_id: string; published_at: string; traffic: string }>();
  if (!publication) throw new EcommerceError("PUBLICATION_UNAVAILABLE", "发布记录不可用。", 404);
  const metrics = [input.impressions, input.views, input.stayedViews, input.completedViews, input.productClicks, input.liveEntries, input.carts, input.orders, input.revenueCents, input.spendCents, input.refundOrders, input.refundCents];
  if (metrics.every(v => v === null)) throw new EcommerceError("METRICS_REQUIRED", "至少填写一项实际观测指标；未采集项请留空。", 400);
  if (Date.parse(input.observedAt) > Date.now() + 60000 || Date.parse(input.observedAt) < Date.parse(publication.published_at)) throw new EcommerceError("INVALID_OBSERVATION_TIME", "观察时间须在发布后，且不能在未来。", 400);
  if (publication.traffic === "organic" && input.spendCents !== null && input.spendCents > 0) throw new EcommerceError("TRAFFIC_MISMATCH", "自然流记录不能填写广告消耗，请核对发布流量类型。", 409);
  const contentHash = await hashJson(input);
  const duplicate = await db.prepare("SELECT id FROM ecommerce_metric_snapshots WHERE publication_id=? AND organization_id=? AND project_id=? AND content_hash=?").bind(input.publicationId, ...scope, contentHash).first<{ id: string }>();
  if (duplicate) { await assertMutationAccess(request, access); return { id: duplicate.id, duplicate: true, summary: metricSummary(input) }; }
  if (!input.replacesId && await db.prepare("SELECT id FROM ecommerce_metric_snapshots WHERE publication_id=? AND organization_id=? AND project_id=? AND observed_at=? AND period_start=? AND period_end=? AND attribution_scope=? LIMIT 1")
    .bind(input.publicationId, ...scope, input.observedAt, input.periodStart, input.periodEnd, input.scope).first())
    throw new EcommerceError("CORRECTION_REQUIRED", "同一观察时点已有数据，修改时请选择要修正的快照。", 409);
  if (input.replacesId) {
    const original = await db.prepare(`SELECT m.body_json FROM ecommerce_metric_snapshots m WHERE m.id=? AND m.publication_id=? AND m.organization_id=? AND m.project_id=? AND NOT EXISTS(SELECT 1 FROM ecommerce_metric_snapshots r WHERE r.replaces_id=m.id)`).bind(input.replacesId, input.publicationId, ...scope).first<{ body_json: string }>();
    if (!original) throw new EcommerceError("CORRECTION_UNAVAILABLE", "只能修正本作品尚未被替代的回填记录。", 409);
    const old = metricsSchema.parse(JSON.parse(original.body_json));
    if (old.scope !== input.scope || old.periodStart !== input.periodStart || old.periodEnd !== input.periodEnd) throw new EcommerceError("CORRECTION_SCOPE_CHANGED", "修正须保持统计范围和区间；新的统计区间应另存快照。", 409);
  }
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const result = await commitMutation(request, access, [
    db.prepare(`INSERT INTO ecommerce_metric_snapshots (id,organization_id,project_id,publication_id,observed_at,period_start,period_end,attribution_scope,body_json,content_hash,replaces_id,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${writeGuard}
      AND EXISTS(SELECT 1 FROM ecommerce_publications WHERE id=? AND organization_id=? AND project_id=?)
      AND (? IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ecommerce_metric_snapshots WHERE publication_id=? AND organization_id=? AND project_id=? AND observed_at=? AND period_start=? AND period_end=? AND attribution_scope=?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM ecommerce_metric_snapshots old WHERE old.id=? AND old.publication_id=? AND old.organization_id=? AND old.project_id=? AND NOT EXISTS(SELECT 1 FROM ecommerce_metric_snapshots newer WHERE newer.replaces_id=old.id)))
      ON CONFLICT(publication_id,content_hash) DO NOTHING`)
      .bind(id, ...scope, input.publicationId, input.observedAt, input.periodStart, input.periodEnd, input.scope, JSON.stringify(input), contentHash, input.replacesId, access.userId, now, ...writeBindings(access), input.publicationId, ...scope, input.replacesId, input.publicationId, ...scope, input.observedAt, input.periodStart, input.periodEnd, input.scope, input.replacesId, input.replacesId, input.publicationId, ...scope),
    auditStatement(access, "ecommerce.metrics.saved", publication.task_id, { snapshotId: id, publicationId: input.publicationId, replacesId: input.replacesId }),
  ]);
  if (!result[0].meta.changes) {
    const replay = await db.prepare("SELECT id FROM ecommerce_metric_snapshots WHERE publication_id=? AND organization_id=? AND project_id=? AND content_hash=?").bind(input.publicationId, ...scope, contentHash).first<{ id: string }>();
    if (replay) { await assertMutationAccess(request, access); return { id: replay.id, duplicate: true, summary: metricSummary(input) }; }
    throw new EcommerceError("CORRECTION_REQUIRED", "观察数据已被其他人保存或修正，未覆盖原记录。请刷新后核对，再选择当前快照追加修正。", 409);
  }
  return { id, duplicate: false, summary: metricSummary(input) };
}
