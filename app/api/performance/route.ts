import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { douyinPerformanceImportSchema, performanceImportSchema } from "../../../lib/performance-analytics";
import { readRequestIdentity, type RequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

function normalizedUrl(value: string | null | undefined) { return (value || "").trim().replace(/\/$/, ""); }
function normalizedWorkTitle(value: string) { return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN"); }

async function importDouyinSnapshot(identity: RequestIdentity, body: unknown) {
  const parsed = douyinPerformanceImportSchema.safeParse(body);
  if (!parsed.success) return apiError("INVALID_DOUYIN_METRIC_IMPORT", parsed.error.issues[0]?.message || "抖音 16 字段导入格式无效。", 400);
  const { organizationId, projectId, format, asOfAt, filename, rows } = parsed.data;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
  if (!access || !canWriteProjectAccess(access)) return apiError("IMPORT_ACCESS_DENIED", "当前角色不能导入抖音数据。", 403);
  const db = getD1(); const user = await ensureUser(identity); const now = new Date().toISOString(); const sourceHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ format, asOfAt, rows })));
  const duplicate = await db.prepare("SELECT id, status FROM platform_metric_import_batches WHERE project_id = ? AND source_hash = ? AND as_of_at = ?").bind(projectId, sourceHash, asOfAt).first<{ id: string; status: string }>();
  if (duplicate && duplicate.status !== "failed") return apiError("DUPLICATE_PLATFORM_METRIC_IMPORT", "相同文件和数据截至时间已经导入，请勿重复提交。", 409, { importId: duplicate.id });
  const batchId = duplicate?.id || crypto.randomUUID();
  if (duplicate) await db.batch([
    db.prepare("DELETE FROM platform_metric_snapshots WHERE import_batch_id = ? AND organization_id = ? AND project_id = ?").bind(batchId, organizationId, projectId),
    db.prepare("DELETE FROM platform_metric_import_errors WHERE import_batch_id = ? AND organization_id = ? AND project_id = ?").bind(batchId, organizationId, projectId),
    db.prepare("UPDATE platform_metric_import_batches SET status = 'processing', row_count = ?, accepted_count = 0, rejected_count = 0, errors_json = NULL, imported_by = ?, created_at = ?, completed_at = NULL WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'failed'").bind(rows.length, user.id, now, batchId, organizationId, projectId),
  ]); else await db.prepare("INSERT INTO platform_metric_import_batches (id, organization_id, project_id, platform, as_of_at, source_hash, original_filename, status, row_count, imported_by, created_at) VALUES (?, ?, ?, 'douyin', ?, ?, ?, 'processing', ?, ?, ?)").bind(batchId, organizationId, projectId, asOfAt, sourceHash, filename || null, rows.length, user.id, now).run();
  const warnings: Array<{ row: number; code: string; message: string }> = []; const statements = [] as ReturnType<typeof db.prepare>[]; let accepted = 0;
  const flushStatements = async () => { if (!statements.length) return; await db.batch(statements.splice(0, statements.length)); };
  try {
    for (const [index, row] of rows.entries()) {
      const titleNormalized = normalizedWorkTitle(row.title); const matches = row.platformWorkId
        ? await db.prepare("SELECT id, content_item_id, publication_id, match_status FROM platform_works WHERE organization_id = ? AND project_id = ? AND platform = 'douyin' AND platform_work_id = ? LIMIT 2").bind(organizationId, projectId, row.platformWorkId).all<{ id: string; content_item_id: string | null; publication_id: string | null; match_status: string }>()
        : await db.prepare("SELECT id, content_item_id, publication_id, match_status FROM platform_works WHERE organization_id = ? AND project_id = ? AND platform = 'douyin' AND title_normalized = ? AND published_at = ? AND COALESCE(genre, '') = COALESCE(?, '') LIMIT 3").bind(organizationId, projectId, titleNormalized, row.publishedAt, row.genre || null).all<{ id: string; content_item_id: string | null; publication_id: string | null; match_status: string }>();
      const ambiguous = matches.results.length > 1; const matched = ambiguous ? undefined : matches.results[0]; const workId = matched?.id || crypto.randomUUID(); const matchStatus = ambiguous ? "ambiguous" : matched ? matched.match_status : "unmatched";
      if (ambiguous) warnings.push({ row: index + 2, code: "AMBIGUOUS_WORK_MATCH", message: `作品“${row.title}”存在多个候选，已保留为待人工映射。` });
      if (!matched) statements.push(db.prepare("INSERT INTO platform_works (id, organization_id, project_id, platform, platform_work_id, title, title_normalized, published_at, genre, review_status_raw, review_status, match_status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'douyin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(workId, organizationId, projectId, row.platformWorkId || null, row.title, titleNormalized, row.publishedAt, row.genre || null, row.reviewStatus || null, row.reviewStatus || null, matchStatus, user.id, user.id, now, now));
      statements.push(db.prepare("INSERT OR IGNORE INTO platform_metric_snapshots (id, organization_id, project_id, platform, work_id, import_batch_id, as_of_at, views, completion_rate_bps, five_second_completion_rate_bps, cover_ctr_bps, two_second_bounce_rate_bps, avg_watch_ms, likes, shares, comments, saves, homepage_visits, follower_delta, created_by, created_at) VALUES (?, ?, ?, 'douyin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, workId, batchId, asOfAt, row.views, row.completionRate === undefined ? null : Math.round(row.completionRate * 100), row.fiveSecondCompletionRate === undefined ? null : Math.round(row.fiveSecondCompletionRate * 100), row.coverCtr === undefined ? null : Math.round(row.coverCtr * 100), row.twoSecondBounceRate === undefined ? null : Math.round(row.twoSecondBounceRate * 100), row.avgWatchMs ?? null, row.likes, row.shares, row.comments, row.saves, row.homepageVisits, row.followerDelta, user.id, now));
      accepted += 1;
      if (statements.length >= 80) await flushStatements();
    }
    for (const warning of warnings) statements.push(db.prepare("INSERT INTO platform_metric_import_errors (id, organization_id, project_id, import_batch_id, row_number, error_code, message, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, batchId, warning.row, warning.code, warning.message, null, now));
    statements.push(db.prepare("UPDATE platform_metric_import_batches SET status = 'completed', accepted_count = ?, rejected_count = 0, errors_json = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'processing'").bind(accepted, warnings.length ? JSON.stringify(warnings) : null, new Date().toISOString(), batchId, organizationId, projectId));
    await flushStatements();
    return Response.json({ import: { id: batchId, format, platform: "douyin", asOfAt, rowCount: rows.length, acceptedCount: accepted, rejectedCount: 0, warningCount: warnings.length, errors: warnings } }, { status: 201 });
  } catch (error) {
    await db.prepare("UPDATE platform_metric_import_batches SET status = 'failed', accepted_count = ?, rejected_count = ?, errors_json = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'processing'").bind(accepted, rows.length - accepted, JSON.stringify([{ row: 0, code: "IMPORT_FAILED", message: error instanceof Error ? error.message.slice(0, 500) : "导入失败" }]), new Date().toISOString(), batchId, organizationId, projectId).run();
    throw error;
  }
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问运营数据。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的运营数据。", 403);
    const db = getD1();
    const [imports, platformImports, publications] = await Promise.all([
      db.prepare("SELECT id, source, original_filename, status, row_count, accepted_count, rejected_count, errors_json, created_at, completed_at FROM performance_import_batches WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, projectId).all(),
      db.prepare("SELECT id, 'douyin' AS source, platform, as_of_at, original_filename, status, row_count, accepted_count, rejected_count, errors_json, created_at, completed_at FROM platform_metric_import_batches WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, projectId).all(),
      db.prepare("SELECT p.id, p.content_item_id, c.title, p.platform, p.external_url, p.published_at FROM publication_records p INNER JOIN content_items c ON c.id = p.content_item_id AND c.organization_id = p.organization_id AND c.project_id = p.project_id WHERE p.organization_id = ? AND p.project_id = ? AND p.status = 'published' ORDER BY p.published_at DESC LIMIT 500").bind(organizationId, projectId).all(),
    ]);
    return Response.json({ imports: imports.results, platformImports: platformImports.results, publications: publications.results, canImport: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再导入运营数据。", 401);
  try {
    const body = await request.json();
    if (body && typeof body === "object" && "format" in body && body.format === "douyin_16") return await importDouyinSnapshot(identity, body);
    const parsed = performanceImportSchema.safeParse(body);
    if (!parsed.success) return apiError("INVALID_PERFORMANCE_IMPORT", parsed.error.issues[0]?.message || "导入数据格式无效。", 400);
    const { organizationId, projectId, source, filename, rows } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("IMPORT_ACCESS_DENIED", "当前角色不能导入运营数据。", 403);
    const db = getD1(); const sourceHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ source, rows })));
    const duplicate = await db.prepare("SELECT id, status FROM performance_import_batches WHERE project_id = ? AND source_hash = ?").bind(projectId, sourceHash).first<{ id: string; status: string }>();
    if (duplicate && duplicate.status !== "failed") return apiError("DUPLICATE_PERFORMANCE_IMPORT", "相同数据已经导入或正在处理，请勿重复提交。", 409, { importId: duplicate.id });
    const publications = await db.prepare("SELECT id, content_item_id, external_url FROM publication_records WHERE organization_id = ? AND project_id = ? AND status = 'published'").bind(organizationId, projectId).all<{ id: string; content_item_id: string; external_url: string | null }>();
    const byId = new Map(publications.results.map((item) => [item.id, item])); const byUrl = new Map(publications.results.filter((item) => item.external_url).map((item) => [normalizedUrl(item.external_url), item]));
    const user = await ensureUser(identity); const now = new Date().toISOString(); const batchId = duplicate?.id || crypto.randomUUID(); const rejected: Array<{ row: number; reason: string }> = [];
    const accepted = rows.flatMap((row, index) => { const publication = (row.publicationId && byId.get(row.publicationId)) || (row.externalUrl && byUrl.get(normalizedUrl(row.externalUrl))); if (!publication) { rejected.push({ row: index + 2, reason: "未找到当前项目中对应的已发布作品" }); return []; } return [{ row, publication }]; });
    if (duplicate) await db.batch([
      db.prepare("DELETE FROM publication_metric_snapshots WHERE import_batch_id = ? AND organization_id = ? AND project_id = ?").bind(batchId, organizationId, projectId),
      db.prepare("UPDATE performance_import_batches SET source = ?, original_filename = ?, status = 'processing', row_count = ?, accepted_count = 0, rejected_count = 0, errors_json = NULL, imported_by = ?, created_at = ?, completed_at = NULL WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'failed'").bind(source, filename || null, rows.length, user.id, now, batchId, organizationId, projectId),
    ]);
    else await db.prepare("INSERT INTO performance_import_batches (id, organization_id, project_id, source, source_hash, original_filename, status, row_count, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)").bind(batchId, organizationId, projectId, source, sourceHash, filename || null, rows.length, user.id, now).run();
    let inserted = 0;
    try {
      for (let offset = 0; offset < accepted.length; offset += 75) {
        const chunk = accepted.slice(offset, offset + 75);
        const results = await db.batch(chunk.map(({ row, publication }) => db.prepare("INSERT OR IGNORE INTO publication_metric_snapshots (id, organization_id, project_id, publication_id, content_item_id, import_batch_id, observed_at, views, likes, comments, shares, saves, followers_gained, leads, average_watch_seconds, completion_rate_bps, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, publication.id, publication.content_item_id, batchId, row.observedAt, row.views, row.likes, row.comments, row.shares, row.saves, row.followersGained, row.leads, row.averageWatchSeconds ?? null, row.completionRate === undefined ? null : Math.round(row.completionRate * 100), user.id, now)));
        inserted += results.reduce((sum, result) => sum + Number(result.meta.changes || 0), 0);
      }
      const duplicateRows = accepted.length - inserted; if (duplicateRows) rejected.push({ row: 0, reason: `${duplicateRows} 行与已有作品快照的时间重复，已跳过` }); const completedAt = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE performance_import_batches SET status = 'completed', accepted_count = ?, rejected_count = ?, errors_json = ?, completed_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'processing'").bind(inserted, rows.length - inserted, rejected.length ? JSON.stringify(rejected) : null, completedAt, batchId, organizationId, projectId),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'performance.import.completed', 'performance_import', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, batchId, JSON.stringify({ source, filename: filename || null, rowCount: rows.length, acceptedCount: inserted, rejectedCount: rows.length - inserted }), completedAt),
      ]);
      return Response.json({ import: { id: batchId, source, original_filename: filename || null, status: "completed", row_count: rows.length, accepted_count: inserted, rejected_count: rows.length - inserted, errors_json: rejected.length ? JSON.stringify(rejected) : null, created_at: now, completed_at: completedAt } }, { status: 201 });
    } catch (error) {
      await db.prepare("UPDATE performance_import_batches SET status = 'failed', accepted_count = ?, rejected_count = ?, errors_json = ?, completed_at = ? WHERE id = ? AND status = 'processing'").bind(inserted, rows.length - inserted, JSON.stringify([{ row: 0, reason: error instanceof Error ? error.message.slice(0, 500) : "导入失败" }]), new Date().toISOString(), batchId).run();
      throw error;
    }
  } catch (error) { return errorResponse(error); }
}
