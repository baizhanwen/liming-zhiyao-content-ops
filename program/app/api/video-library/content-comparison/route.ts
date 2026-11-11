import { z } from "zod";
import { canAccessOrganizationVideoLibrary, getD1, getOrganizationAccess, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { assessAnalysisQuality } from "../../../../lib/analysis-quality";
import { readBoundedJson } from "../../../../lib/bounded-request-body";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { aggregateContentComparison, contentDurationBuckets, contentTaxonomy, projectContentComparisonEntry, readVideoContentAnalysis, type ContentComparisonEntry, type ContentComparisonExclusion, type ContentComparisonInput, type ContentComparisonResponse } from "../../../../lib/video-content-analysis";

export const dynamic = "force-dynamic";
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const filterTag = (dimensionId: string) => z.string().min(1).max(200).refine(value => contentTaxonomy.dimensions.find(dimension => dimension.id === dimensionId)?.tags.some(tag => tag.id === value && !tag.disabled));
const requestSchema = z.object({ organizationId: z.string().trim().min(1).max(100), scope: z.enum(["library", "benchmark"]), projectId: z.string().trim().max(100).optional(), entryIds: z.array(z.string().trim().min(1).max(100)).min(2).max(100), filters: z.object({ topicCategory: filterTag("topic.category").optional(), contentForm: filterTag("content.form").optional(), durationBucket: z.enum(contentDurationBuckets).optional() }).strict().optional() }).strict();
type LibraryRow = { entry_id: string; video_id: string; title: string | null };
type AnalysisRow = { id: string; video_id: string; schema_version: string; report_json: string; created_at: string };

/** Explicit selection only. This endpoint reads no model and writes no business state. */
export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再比较素材。", 401);
  try {
    const parsed = requestSchema.safeParse(await readBoundedJson(request, 32 * 1024, "比较请求过大，请减少所选素材。"));
    if (!parsed.success) return apiError("INVALID_CONTENT_COMPARISON", "请选择 2 至 100 个素材，并提供明确的公司和比较范围。", 400);
    const { organizationId, scope, projectId = "", filters = {} } = parsed.data;
    const entryIds = [...new Set(parsed.data.entryIds)];
    if (entryIds.length < 2) return apiError("CONTENT_COMPARISON_SELECTION_REQUIRED", "去重后至少需要两个素材。", 400);
    if (scope === "benchmark" && !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "对标比较需要指定项目。", 400);
    const canRead = async () => {
      const access = await getOrganizationAccess(identity.authSubject, organizationId);
      if (!access || !await canAccessOrganizationVideoLibrary(access)) return false;
      return scope !== "benchmark" || Boolean(await getProjectAccess(identity.authSubject, organizationId, projectId));
    };
    if (!await canRead()) return apiError("ACCESS_DENIED", "当前账号不能读取所选公司或项目的素材。", 403);
    const db = getD1();
    const selection = JSON.stringify(entryIds);
    const selectedQuery = `SELECT library.id AS entry_id, v.id AS video_id, v.title
      FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id
      WHERE library.organization_id=? AND library.id IN (SELECT value FROM json_each(?)) AND v.deleted_at IS NULL
      ${scope === "benchmark" ? "AND EXISTS(SELECT 1 FROM project_video_references refs WHERE refs.organization_id=library.organization_id AND refs.library_entry_id=library.id AND refs.project_id=? AND refs.purpose='benchmark' AND refs.status='active')" : ""}`;
    const selectedBindings = [organizationId, selection, ...(scope === "benchmark" ? [projectId] : [])];
    const selectedRows = (await db.prepare(selectedQuery).bind(...selectedBindings).all<LibraryRow>()).results;
    if (selectedRows.length !== entryIds.length) return apiError("CONTENT_COMPARISON_SELECTION_UNAVAILABLE", "所选素材已删除、不在当前范围内，或对标引用已失效；请刷新后重新选择。", 404);
    const byEntry = new Map(selectedRows.map(row => [row.entry_id, row]));
    const videoIds = [...new Set(selectedRows.map(row => row.video_id))];
    const videos = JSON.stringify(videoIds);
    // Measure before reading large JSON, including all v10 revisions needed to
    // find the latest accepted one. Never silently truncate the selected sample.
    const cost = await db.prepare(`SELECT COUNT(*) AS report_count, COALESCE(SUM(length(CAST(report_json AS BLOB))),0) AS report_bytes FROM video_analyses
      WHERE organization_id=? AND video_id IN (SELECT value FROM json_each(?)) AND schema_version='analysis.v10'`).bind(organizationId, videos).first<{ report_count: number; report_bytes: number }>();
    if (Number(cost?.report_bytes) > MAX_REPORT_BYTES || Number(cost?.report_count) > 5_000) return apiError("CONTENT_COMPARISON_TOO_LARGE", "所选报告总量过大，请减少素材后再比较；本次未截取部分样本。", 413);
    const [reports, available] = await Promise.all([
      db.prepare("SELECT id, video_id, schema_version, report_json, created_at FROM video_analyses WHERE organization_id=? AND video_id IN (SELECT value FROM json_each(?)) AND schema_version='analysis.v10' ORDER BY created_at DESC, rowid DESC").bind(organizationId, videos).all<AnalysisRow>(),
      db.prepare("SELECT video_id, COUNT(*) AS report_count, MAX(CASE WHEN schema_version NOT IN ('analysis.v1','analysis.v2','analysis.v3','analysis.v4','analysis.v5','analysis.v6','analysis.v7','analysis.v8','analysis.v9','analysis.v10') THEN 1 ELSE 0 END) AS unknown_schema FROM video_analyses WHERE organization_id=? AND video_id IN (SELECT value FROM json_each(?)) GROUP BY video_id").bind(organizationId, videos).all<{ video_id: string; report_count: number; unknown_schema: number }>(),
    ]);
    const accepted = new Map<string, { row: AnalysisRow; content: ContentComparisonInput["contentAnalysis"] }>();
    const rejected = new Map<string, ContentComparisonExclusion>();
    let actualReportBytes = 0;
    for (const row of reports.results) {
      const rawReport = row.report_json;
      actualReportBytes += new TextEncoder().encode(rawReport).byteLength;
      // Release large raw bodies after parsing, rather than retaining them in
      // both the database result and the accepted-revision snapshot.
      row.report_json = "";
      if (actualReportBytes > MAX_REPORT_BYTES) return apiError("CONTENT_COMPARISON_TOO_LARGE", "报告总量在读取期间超过安全限制，请减少素材后重试。", 413);
      if (accepted.has(row.video_id)) continue;
      let report: Record<string, unknown>;
      try { report = JSON.parse(rawReport) as Record<string, unknown>; }
      catch { if (!rejected.has(row.video_id)) rejected.set(row.video_id, "invalid_contract"); continue; }
      if (!report || typeof report !== "object" || Array.isArray(report)) { if (!rejected.has(row.video_id)) rejected.set(row.video_id, "invalid_contract"); continue; }
      const content = readVideoContentAnalysis(report.content_analysis);
      if (content.status !== "valid") {
        if (!rejected.has(row.video_id)) rejected.set(row.video_id, content.status === "unsupported" ? "unsupported_taxonomy" : "invalid_contract");
      } else if (!assessAnalysisQuality(row.schema_version, report).accepted) {
        if (!rejected.has(row.video_id)) rejected.set(row.video_id, "quality_failed");
      } else accepted.set(row.video_id, { row, content: content.value });
    }
    const history = new Map(available.results.map(row => [row.video_id, row]));
    const excluded: Record<ContentComparisonExclusion, number> = { missing: 0, legacy: 0, quality_failed: 0, invalid_contract: 0, unsupported_schema: 0, unsupported_taxonomy: 0, duplicate_video: 0, filtered_out: 0 };
    const aggregateRows: ContentComparisonInput[] = [];
    const seen = new Set<string>();
    const entries: ContentComparisonEntry[] = entryIds.map(entryId => {
      const row = byEntry.get(entryId)!;
      const candidate = accepted.get(row.video_id);
      const duplicate = seen.has(row.video_id); seen.add(row.video_id);
      const matchesTag = (dimensionId: string, tag: string | undefined) => !tag || candidate?.content.classifications.some(classification => classification.dimension_id === dimensionId && classification.state === "known" && classification.tags?.includes(tag));
      const matchesFilters = matchesTag("topic.category", filters.topicCategory) && matchesTag("content.form", filters.contentForm) && (!filters.durationBucket || candidate?.content.metrics.media.duration_bucket === filters.durationBucket);
      const reason = duplicate ? "duplicate_video" : candidate ? matchesFilters ? null : "filtered_out" : rejected.get(row.video_id) ?? (history.get(row.video_id)?.unknown_schema ? "unsupported_schema" : history.has(row.video_id) ? "legacy" : "missing");
      if (reason) excluded[reason] += 1;
      if (candidate && !reason) aggregateRows.push({ entryId, videoId: row.video_id, title: row.title || "未命名素材", analysisId: candidate.row.id, analysisCreatedAt: candidate.row.created_at, contentAnalysis: candidate.content });
      return { entryId, videoId: row.video_id, title: row.title || "未命名素材", status: reason ? "excluded" : "included", excludedReason: reason, analysisId: candidate?.row.id ?? null, analysisCreatedAt: candidate?.row.created_at ?? null, contentAnalysis: candidate && !reason ? projectContentComparisonEntry(candidate.content) : null };
    });
    if ((await readRequestIdentity(request))?.authSubject !== identity.authSubject || !await canRead()) return apiError("ACCESS_DENIED", "登录状态或读取权限已改变，请刷新后重试。", 403);
    const currentSelection = (await db.prepare(selectedQuery).bind(...selectedBindings).all<LibraryRow>()).results;
    if (currentSelection.length !== entryIds.length || currentSelection.some(row => byEntry.get(row.entry_id)?.video_id !== row.video_id)) return apiError("CONTENT_COMPARISON_SELECTION_CHANGED", "素材或对标引用在读取期间已改变，请重新选择后比较。", 409);
    const result: ContentComparisonResponse = {
      version: "content-comparison.v1", scope,
      snapshot: { analysisSchemaVersion: "analysis.v10", contentSchemaVersion: "content-analysis.v1", taxonomyVersion: contentTaxonomy.version, selection: "latest_accepted_per_video", requestedEntryIds: entryIds, filters, generatedAt: new Date().toISOString(), analyses: aggregateRows.map(row => ({ entryId: row.entryId, videoId: row.videoId, analysisId: row.analysisId, createdAt: row.analysisCreatedAt })) },
      summary: { selectedEntries: entryIds.length, selectedVideos: videoIds.length, includedVideos: aggregateRows.length, excludedVideos: videoIds.length - aggregateRows.length },
      entries, excluded, ...aggregateContentComparison(aggregateRows),
    };
    const body = JSON.stringify(result);
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) return apiError("CONTENT_COMPARISON_TOO_LARGE", "比较结果超过安全体积，请减少素材后重试；本次未截取部分样本。", 413);
    return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
