import type { EcommercePack, MetricInput, ProductPublic, TaskBrief } from "../../lib/ecommerce/contracts";
import type { TaskRow } from "../../lib/ecommerce/tasks";
import type { Candidate, CaseSource, ContextSource } from "../../lib/ecommerce/context";
import type { CoreContentStrategy } from "../../lib/content-strategy-policy";

export type { TaskRow };
export type ProductOption = { id: string; name: string; sku: string; status: string; current_version: number; version_id: string; version: number; public_json: string; confirmed_at: string | null };
export type BenchmarkReference = { reference_id: string; analysis_id: string; video_id: string; title: string; analyzed_at: string };
export type TaskCaseOption = { id: string; title: string; referenceId?: string; analysisId?: string; transcriptId?: string | null };
export type TaskOptions = { products: ProductOption[]; knowledge: { id: string; title: string; body: string; current_version: number }[]; accounts: Account[]; strategy: CoreContentStrategy | null };
export type Account = { id: string; display_name: string; handle: string; platform: string; profile_url: string | null };
export type Version = { id: string; version: number; mode: string; pack_json: string; input_snapshot_json: string; validation_json: string; source_manifest_json: string; created_at: string; change_summary: string; product_version_id: string };
export type Run = { id: string; status: string; operation: string; call_count: number; active_calls: number; last_activity_at: string; error_code: string | null; error_message: string | null; created_at: string; completed_at: string | null; idempotency_key: string };
export type Publication = { id: string; task_id: string; version_id: string; account_id: string; platform: string; external_url: string; external_id: string; published_at: string; traffic: "organic" | "paid"; ad_plan: string };
export type TaskDetail = { task: TaskRow; versions: Version[]; runs: Run[]; publications: Publication[]; reviews: { id: string; version_id: string; decision: string; note: string; created_by: string; created_at: string }[] };
export type Recommendation = { ready: boolean; missing: string[]; candidates: Candidate[]; rejected: { id: string; name: string; reasons: string[] }[]; cases: CaseSource[]; strategy: CoreContentStrategy | null; inputHash: string; caseNotice: string; copyReadiness?: { ready: boolean; missing: { field: string; label: string; reason: string; example?: string }[]; summary: string } };
export type SourceSnapshot = {
  sources: ContextSource[];
  product: { id: string; name: string; sku: string; versionId: string; claim: ProductPublic["claims"][number] };
  strategy: CoreContentStrategy | null; taskRevision: number; candidates: Candidate[];
  task?: { brief: TaskBrief };
  plan?: {
    copyDirection?: { hook: string; bridge: string; proof: string; cta: string; referenceAdaptation: string };
    methodSelection?: { hookId: string; frameworkId: string; supplementFrameworkId: string | null; reason: string } | null;
    sellingPointFocus?: string;
    factPlan?: { sourceId: string; sourceQuote: string; buyerMeaning: string }[];
    outline?: { id: string; role: string; purpose: string; methodBeats: string[]; durationSec: number }[];
  } | null;
  copyMethodology?: {
    version: string; sources?: { path: string; section: string }[];
    selectedMethods?: { hook: SnapshotMethod; framework: SnapshotMethod; supplement: SnapshotMethod | null; reason: string } | null;
    sourceExcerpts?: SnapshotMethod["source"][];
  };
};
export type SnapshotMethod = { id: string; name: string; beats: string[]; source: { document: string; section: string; sha256: string; line: number; excerpt: string } };
export type Snapshot = { id: string; publication_id: string; version_id: string; task_id: string; product_id: string; product_version_id: string; source_manifest_json: string; body_json: string; observed_at: string; superseded: number; created_at: string; summary: { roas: number | null; completionRate: number | null; productClickRate: number | null; stayRate: number | null; attributionNotice: string } };
export const taskStates: Record<string, string> = { draft: "草稿", internal_review: "待审核", publish_ready: "已审核", published: "已发布", reviewed: "已复盘", archived: "已归档" };
export const roles = { hook: "开头钩子", problem: "购买顾虑", claim: "主卖点", evidence: "事实依据", transition: "衔接", cta: "行动引导" };
export const writingKinds = { hook: "开头钩子", structure: "文案结构" };
export const sourceTypes = { component: "文案方法", case: "参考案例", claim: "商品卖点", evidence: "商品证据", knowledge: "品牌知识" };
export const metricLabels: Partial<Record<keyof MetricInput, string>> = { impressions: "曝光", views: "播放", stayedViews: "停留播放", completedViews: "完播", productClicks: "商品点击", liveEntries: "直播进房", carts: "加购", orders: "成交订单", refundOrders: "退款订单" };
export function scriptText(pack: EcommercePack) { return pack.segments.map(s => s.script).join("\n\n"); }

/** Update only the located draft quote when a user edits that segment. */
export function editSegment(pack: EcommercePack, segmentId: string, values: Partial<EcommercePack["segments"][number]>): EcommercePack {
  const next = { ...pack, segments: pack.segments.map(s => s.id === segmentId ? { ...s, ...values } : s) };
  return { ...next, applications: next.applications.map(a => {
    if (!a.used || !a.segmentIds.includes(segmentId)) return a;
    const located = a.segmentIds.map(id => next.segments.find(s => s.id === id)).filter(s => s !== undefined);
    const raw = located.map(s => `${s.script}\n${s.visual}`).join("\n");
    return raw.includes(a.draftQuote) ? a : { ...a, draftQuote: located[0]?.script ?? "" };
  }) };
}
