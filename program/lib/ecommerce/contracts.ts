import { z } from "zod";

const id = z.string().trim().min(1).max(100);
const text = (max = 2000) => z.string().trim().max(max);
const required = (max = 2000) => text(max).min(1);
const ids = z.array(id).max(30).refine(values => new Set(values).size === values.length, "不能重复选择来源");
const timestamp = z.iso.datetime({ offset: true });
const nullableTime = timestamp.nullable().default(null);
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null);
export const scopeSchema = z.object({ organizationId: id, projectId: id });
export const confirmationSchema = z.enum(["draft", "pending", "confirmed", "revoked"]);
export const targetSchema = z.enum(["product_click", "live_entry", "purchase"]);
export const platformSchema = z.enum(["douyin", "wechat_channels", "xiaohongshu", "other"]);
export const componentKindSchema = z.enum(["hook", "visual", "structure", "sop"]);
export const filmingSchema = z.enum(["product", "hands", "presenter", "location", "comparison", "screen"]);

export const settingsSchema = scopeSchema.extend({
  enabled: z.boolean(), revision: z.number().int().min(0),
  maxConcurrent: z.number().int().min(1).max(3).default(1),
  monthlyCallLimit: z.number().int().min(1).max(10000).default(100),
}).strict();

export const audienceSchema = z.object({
  user: text(300).default(""), buyer: text(300).default(""), situation: text(1000).default(""),
  trigger: text(1000).default(""), alternative: text(1000).default(""), barrier: text(1000).default(""),
  concerns: text(1000).default(""), viewingContext: text(500).default(""), source: text(1000).default(""),
  status: z.enum(["hypothesis", "confirmed"]).default("hypothesis"),
}).strict();

export const claimSchema = z.object({
  id, statement: required(1000), kind: z.enum(["specification", "demonstration", "experience", "offer"]),
  allowedExpression: required(1000), conditions: text(1000).default(""), evidenceIds: ids,
  validUntil: nullableTime, status: confirmationSchema.default("draft"),
}).strict();

export const productPublicSchema = z.object({
  category: text(300).default(""), specification: text(1000).default(""), sellingPoints: text(3000).default(""),
  copyFacts: z.object({
    content: text(2500).default(""), usage: text(2000).default(""), difference: text(2000).default(""),
    delivery: text(2000).default(""), limitations: text(1500).default(""), speakerExperience: text(2000).default(""),
  }).strict().prefault({}),
  audience: audienceSchema, scenarios: text(2000).default(""),
  claims: z.array(claimSchema).max(30).refine(values => new Set(values.map(v => v.id)).size === values.length, "卖点 ID 重复"),
  prohibited: text(3000).default(""), purchaseConcerns: text(2000).default(""),
  priceCents: money, currency: z.string().regex(/^[A-Z]{3}$/).default("CNY"),
  offer: text(1000).default(""), offerValidUntil: nullableTime,
  landingUrl: z.union([z.url().max(2000).refine(url => /^https?:\/\//.test(url), "仅支持网页链接"), z.literal("")]).default(""),
}).strict();

export const productInternalSchema = z.object({
  costCents: money, marginNotes: text(1000).default(""), stock: z.number().int().min(0).nullable().default(null),
  stockObservedAt: nullableTime, refundReasons: text(3000).default(""), negativeReviews: text(3000).default(""),
}).strict();

export const productSchema = scopeSchema.extend({
  id: id.optional(), revision: z.number().int().min(0).default(0), sku: required(100), name: required(300),
  status: confirmationSchema.default("draft"), publicData: productPublicSchema, internalData: productInternalSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status !== "confirmed") return;
  const p = value.publicData;
  if (!p.category || !p.audience.user || !p.audience.buyer || !p.scenarios || !p.prohibited)
    ctx.addIssue({ code: "custom", message: "确认商品前请补齐品类、购买与使用人群、场景及表达禁区", path: ["publicData"] });
});

export const evidenceSchema = scopeSchema.extend({
  productId: id, title: required(300), kind: z.enum(["specification", "demonstration", "customer_permission", "manual_confirmation", "offer"]),
  body: required(8000), sourceLocator: required(2000), mediaAssetId: id.nullable().default(null),
  conditions: text(2000).default(""), validUntil: nullableTime, status: confirmationSchema.default("draft"),
}).strict();

export const componentSchema = scopeSchema.extend({
  id: id.optional(), revision: z.number().int().min(0).default(0), name: required(300), kind: componentKindSchema,
  instruction: required(4000), problem: required(1000), categories: z.array(required(100)).max(30).default([]),
  platforms: z.array(platformSchema).min(1).max(4), targets: z.array(targetSchema).min(1).max(3),
  requiredEvidenceKinds: z.array(evidenceSchema.shape.kind).max(5).default([]),
  requiredFilming: z.array(filmingSchema).max(6).default([]),
  forbiddenConditions: z.array(required(300)).max(20).default([]),
  requiresPrice: z.boolean().default(false), inputContract: required(2000), outputContract: required(2000),
  sourceLocator: required(2000), sourceVersion: required(300), authorization: required(1000),
  validUntil: nullableTime, status: confirmationSchema.default("draft"),
}).strict();

export const caseSchema = scopeSchema.extend({
  referenceId: id, analysisId: id, transcriptId: id.nullable().default(null),
  title: required(300), audience: required(1000), target: targetSchema, hook: required(1000),
  structure: required(4000), evidenceMethod: required(2000), cta: required(1000),
  transferable: required(2000), nonTransferable: required(2000),
  sourceQuote: required(4000), hasSalesData: z.boolean().nullable().default(null),
  salesDataSource: text(2000).default(""), status: confirmationSchema.default("draft"),
}).strict().superRefine((v, ctx) => {
  if (v.hasSalesData === true && !v.salesDataSource) ctx.addIssue({ code: "custom", message: "成交数据须注明可核验来源", path: ["salesDataSource"] });
});

export const benchmarkReferenceSchema = z.object({ referenceId: id, analysisId: id, transcriptId: id.nullable().default(null) }).strict();
export const taskBriefSchema = z.object({
  referenceMode: z.enum(["method", "benchmark"]).optional(), benchmark: benchmarkReferenceSchema.nullable().default(null),
  audience: audienceSchema, scene: text(2000).default(""), barrier: text(1000).default(""),
  claimId: text(100).default(""), evidenceIds: ids.default([]), platform: platformSchema.default("douyin"),
  traffic: z.enum(["organic", "paid"]).default("organic"), target: targetSchema.default("product_click"),
  destination: text(2000).default(""), durationSec: z.number().int().min(10).max(180).default(30),
  filming: z.array(filmingSchema).max(6).default([]), filmingNotes: text(1000).default(""),
  knowledgeIds: ids.default([]), caseIds: ids.default([]), componentIds: ids.default([]),
  excludedConditions: z.array(required(300)).max(30).default([]),
  strategyException: text(2000).default(""), instructions: text(2000).default(""),
}).strict();
export const taskSchema = scopeSchema.extend({
  id: id.optional(), revision: z.number().int().min(0).default(0), title: required(300), productId: id,
  productVersionId: id, brief: taskBriefSchema,
}).strict();

export const segmentSchema = z.object({
  id, role: z.enum(["hook", "problem", "claim", "evidence", "transition", "cta"]),
  script: required(2000), visual: text(2000).default(""), durationSec: z.number().int().min(1).max(180),
  componentIds: ids, claimIds: ids, evidenceIds: ids, knowledgeIds: ids.default([]), caseIds: ids.default([]),
}).strict();
export const applicationSchema = z.object({
  sourceId: id, sourceType: z.enum(["component", "case", "claim", "evidence", "knowledge"]),
  used: z.boolean(), sourceQuote: text(4000), segmentIds: ids, draftQuote: text(4000),
  reason: required(2000), notTransferred: text(2000).default(""),
}).strict();
export const packSchema = z.object({
  title: required(300), segments: z.array(segmentSchema).min(2).max(20),
  applications: z.array(applicationSchema).max(100), filmingChecklist: z.array(required(1000)).max(30).default([]),
  pendingConfirmations: z.array(required(1000)).max(30), target: targetSchema,
}).strict();

export const runSchema = scopeSchema.extend({
  revision: z.number().int().min(1), baseVersion: z.number().int().min(0), idempotencyKey: id,
  replace: z.enum(["hook", "evidence", "cta"]).optional(), instructions: text(2000).default(""),
}).strict();

export const publicationSchema = scopeSchema.extend({
  versionId: id, accountId: id, platform: platformSchema, externalId: text(300).default(""),
  externalUrl: z.url().max(2000).refine(url => /^https?:\/\//.test(url), "仅支持网页链接"),
  publishedAt: timestamp, traffic: z.enum(["organic", "paid"]), adPlan: text(300).default(""),
}).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null);
export const metricsSchema = scopeSchema.extend({
  publicationId: id, observedAt: timestamp, periodStart: timestamp, periodEnd: timestamp,
  attributionWindow: required(300), source: required(2000), scope: z.enum(["video", "product", "live"]),
  currency: z.string().regex(/^[A-Z]{3}$/).default("CNY"), methodology: required(2000),
  replacesId: id.nullable().default(null), impressions: count, views: count, stayedViews: count,
  staySeconds: z.number().int().min(1).max(180).nullable().default(null), completedViews: count,
  productClicks: count, liveEntries: count, carts: count, orders: count,
  revenueCents: money, spendCents: money, refundOrders: count, refundCents: money,
  revenueBasis: z.enum(["before_refunds", "after_refunds"]).default("before_refunds"),
  platformRoi: z.number().finite().min(0).nullable().default(null), platformRoiDefinition: text(1000).default(""),
  comments: text(3000).default(""), nextAction: text(2000).default(""),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.periodStart) > Date.parse(v.periodEnd) || Date.parse(v.periodEnd) > Date.parse(v.observedAt))
    ctx.addIssue({ code: "custom", message: "统计区间与观察时间不一致" });
  if (v.stayedViews !== null && v.staySeconds === null) ctx.addIssue({ code: "custom", message: "请注明停留秒数" });
  if (v.views !== null && [v.stayedViews, v.completedViews].some(n => n !== null && n > v.views!))
    ctx.addIssue({ code: "custom", message: "停留及完播数不能超过播放数" });
  if (v.platformRoi !== null && !v.platformRoiDefinition) ctx.addIssue({ code: "custom", message: "请注明平台 ROI 口径" });
});

export type ProductPublic = z.infer<typeof productPublicSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type TaskBrief = z.infer<typeof taskBriefSchema>;
/** Old tasks with explicitly selected profiles retain their reference workflow. */
export const taskReferenceMode = (brief: Pick<TaskBrief, "referenceMode" | "benchmark" | "caseIds">) => brief.referenceMode ?? (brief.benchmark || brief.caseIds.length ? "benchmark" : "method");
export type ComponentInput = z.infer<typeof componentSchema>;
export type EcommercePack = z.infer<typeof packSchema>;
export type MetricInput = z.infer<typeof metricsSchema>;
