import { readBoundedJson, RequestBodyError } from "../../../lib/bounded-request-body";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError } from "../../../lib/project-write-access";
import { commitPerformanceImport } from "../../../lib/performance-import-transaction";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { douyinPerformanceImportSchema, performanceImportSchema } from "../../../lib/performance-analytics";
import { readRequestIdentity, type RequestIdentity } from "../../../lib/request-auth";
export const dynamic = "force-dynamic";
function normalizedUrl(value: string | null | undefined) { return (value || "").trim().replace(/\/$/, ""); }
function normalizedWorkTitle(value: string) { return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN"); }
type Work = {
    id: string;
    platform_work_id: string | null;
    title_normalized: string;
    published_at: string;
    genre: string | null;
    updated_at: string;
    match_status: string;
};
const workKey = (title: string, published: string, genre: string | null | undefined) => JSON.stringify([title, published, genre || ""]);
async function importDouyinSnapshot(request: Request, identity: RequestIdentity, body: unknown) {
    const parsed = douyinPerformanceImportSchema.safeParse(body);
    if (!parsed.success)
        return apiError("INVALID_DOUYIN_METRIC_IMPORT", parsed.error.issues[0]?.message || "抖音 16 字段导入格式无效。", 400);
    const { organizationId, projectId, format, asOfAt, filename, rows } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access))
        return apiError("IMPORT_ACCESS_DENIED", "当前角色不能导入抖音数据。", 403);
    const db = getD1(), user = await ensureUser(identity), now = new Date().toISOString();
    const scope = { organizationId, projectId, userId: user.id };
    const assertAccess = createProjectWriteAssertion(db, scope, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    const sourceHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ format, asOfAt, rows })));
    const findDuplicate = () => db.prepare("SELECT id,status FROM platform_metric_import_batches WHERE organization_id=? AND project_id=? AND source_hash=? AND as_of_at=?").bind(organizationId, projectId, sourceHash, asOfAt).first<{
        id: string;
        status: string;
    }>();
    const duplicate = await findDuplicate();
    if (duplicate && duplicate.status !== "failed")
        return apiError("DUPLICATE_PLATFORM_METRIC_IMPORT", "相同文件和数据截至时间已经导入，请勿重复提交。", 409, { importId: duplicate.id });
    const batchId = duplicate?.id || crypto.randomUUID();
    const works = (await db.prepare("SELECT id,platform_work_id,title_normalized,published_at,genre,updated_at,match_status FROM platform_works WHERE organization_id=? AND project_id=? AND platform='douyin'").bind(organizationId, projectId).all<Work>()).results;
    const owned = duplicate ? (await db.prepare("SELECT s.*,w.platform_work_id,w.title_normalized,w.published_at,w.genre FROM platform_metric_snapshots s JOIN platform_works w ON w.id=s.work_id AND w.organization_id=s.organization_id AND w.project_id=s.project_id WHERE s.import_batch_id=? AND s.organization_id=? AND s.project_id=?").bind(batchId, organizationId, projectId).all<Record<string, unknown>>()).results : [];
    const warnings: Array<{
        row: number;
        code: string;
        message: string;
    }> = [], plans: Array<{
        row: typeof rows[number];
        work: Work;
        create: boolean;
    }> = [], used = new Set<string>();
    const fileCounts = new Map<string, number>();
    for (const row of rows) {
        const key = workKey(normalizedWorkTitle(row.title), row.publishedAt, row.genre);
        fileCounts.set(key, (fileCounts.get(key) || 0) + 1);
    }
    const stagedIds = new Map<string, Work>();
    const bps = (value: number | undefined) => value === undefined ? null : Math.round(value * 100);
    for (const [index, row] of rows.entries()) {
        const titleNormalized = normalizedWorkTitle(row.title), key = workKey(titleNormalized, row.publishedAt, row.genre);
        const previous = owned.find(item => !used.has(String(item.id)) && (row.platformWorkId ? item.platform_work_id === row.platformWorkId : workKey(String(item.title_normalized), String(item.published_at), item.genre as string | null) === key)
            && item.as_of_at === asOfAt && item.views === row.views && item.likes === row.likes && item.shares === row.shares && item.comments === row.comments && item.saves === row.saves && item.homepage_visits === row.homepageVisits && item.follower_delta === row.followerDelta
            && item.completion_rate_bps === bps(row.completionRate) && item.five_second_completion_rate_bps === bps(row.fiveSecondCompletionRate) && item.cover_ctr_bps === bps(row.coverCtr) && item.two_second_bounce_rate_bps === bps(row.twoSecondBounceRate) && item.avg_watch_ms === (row.avgWatchMs ?? null));
        if (previous) {
            used.add(String(previous.id));
            continue;
        }
        const matches = row.platformWorkId ? works.filter(item => item.platform_work_id === row.platformWorkId) : works.filter(item => workKey(item.title_normalized, item.published_at, item.genre) === key);
        const ambiguous = matches.length > 1 || !row.platformWorkId && (fileCounts.get(key) || 0) > 1;
        const matched = ambiguous ? undefined : matches[0] || (row.platformWorkId ? stagedIds.get(row.platformWorkId) : undefined);
        if (ambiguous)
            warnings.push({ row: index + 2, code: "AMBIGUOUS_WORK_MATCH", message: `作品“${row.title}”存在多个候选，已保留为待人工映射。` });
        const work: Work = matched || { id: crypto.randomUUID(), platform_work_id: row.platformWorkId || null, title_normalized: titleNormalized, published_at: row.publishedAt, genre: row.genre || null, updated_at: now, match_status: ambiguous ? "ambiguous" : "unmatched" };
        if (row.platformWorkId && !matched)
            stagedIds.set(row.platformWorkId, work);
        plans.push({ row, work, create: !matched });
    }
    if (used.size !== owned.length)
        return apiError("PERFORMANCE_IMPORT_RECOVERY_REQUIRED", "旧失败批次的已保存记录与当前作品资料不一致，已保留原数据。请先核对历史与映射，勿直接重导。", 409);
    const guard = `${duplicate ? "EXISTS(SELECT 1 FROM platform_metric_import_batches WHERE id=? AND organization_id=? AND project_id=? AND status='failed')" : "NOT EXISTS(SELECT 1 FROM platform_metric_import_batches WHERE organization_id=? AND project_id=? AND source_hash=? AND as_of_at=?)"}
    AND (SELECT COUNT(*) FROM platform_works WHERE organization_id=? AND project_id=? AND platform='douyin')=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN platform_works w ON w.id=json_extract(expected.value,'$.id') AND w.organization_id=? AND w.project_id=? WHERE w.id IS NULL OR w.updated_at IS NOT json_extract(expected.value,'$.updatedAt'))
    AND (SELECT COUNT(*) FROM platform_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN platform_metric_snapshots s ON s.id=json_extract(expected.value,'$.id') AND s.import_batch_id=? AND s.organization_id=? AND s.project_id=?
      WHERE s.id IS NULL OR s.work_id IS NOT json_extract(expected.value,'$.work_id') OR s.as_of_at IS NOT json_extract(expected.value,'$.as_of_at') OR s.views IS NOT json_extract(expected.value,'$.views') OR s.completion_rate_bps IS NOT json_extract(expected.value,'$.completion_rate_bps') OR s.five_second_completion_rate_bps IS NOT json_extract(expected.value,'$.five_second_completion_rate_bps') OR s.cover_ctr_bps IS NOT json_extract(expected.value,'$.cover_ctr_bps') OR s.two_second_bounce_rate_bps IS NOT json_extract(expected.value,'$.two_second_bounce_rate_bps') OR s.avg_watch_ms IS NOT json_extract(expected.value,'$.avg_watch_ms') OR s.likes IS NOT json_extract(expected.value,'$.likes') OR s.shares IS NOT json_extract(expected.value,'$.shares') OR s.comments IS NOT json_extract(expected.value,'$.comments') OR s.saves IS NOT json_extract(expected.value,'$.saves') OR s.homepage_visits IS NOT json_extract(expected.value,'$.homepage_visits') OR s.follower_delta IS NOT json_extract(expected.value,'$.follower_delta'))`;
    const bindings = [...(duplicate ? [batchId, organizationId, projectId] : [organizationId, projectId, sourceHash, asOfAt]), organizationId, projectId, works.length, JSON.stringify(works.map(w => ({ id: w.id, updatedAt: w.updated_at }))), organizationId, projectId, batchId, organizationId, projectId, owned.length, JSON.stringify(owned), batchId, organizationId, projectId];
    return commitPerformanceImport(db, {
        scope, batchId, rowCount: rows.length, platform: true, guard, bindings, assertAccess, duplicate: findDuplicate,
        statements: (exists, marker) => {
            const statements: D1PreparedStatement[] = [];
            if (duplicate)
                statements.push(db.prepare(`UPDATE platform_metric_import_batches SET status='processing',row_count=?,completed_at=NULL,imported_by=?,original_filename=? WHERE id=? AND ${exists}`).bind(rows.length, user.id, filename || null, batchId, marker), db.prepare(`DELETE FROM platform_metric_import_errors WHERE import_batch_id=? AND organization_id=? AND project_id=? AND ${exists}`).bind(batchId, organizationId, projectId, marker));
            else
                statements.push(db.prepare(`INSERT INTO platform_metric_import_batches(id,organization_id,project_id,platform,as_of_at,source_hash,original_filename,status,row_count,imported_by,created_at) SELECT ?,?,?,'douyin',?,?,?,'processing',?,?,? WHERE ${exists}`).bind(batchId, organizationId, projectId, asOfAt, sourceHash, filename || null, rows.length, user.id, now, marker));
            for (const { row, work, create } of plans) {
                if (create)
                    statements.push(db.prepare(`INSERT INTO platform_works(id,organization_id,project_id,platform,platform_work_id,title,title_normalized,published_at,genre,review_status_raw,review_status,match_status,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,'douyin',?,?,?,?,?,?,?,?,?,?,?,? WHERE ${exists}`).bind(work.id, organizationId, projectId, row.platformWorkId || null, row.title, work.title_normalized, row.publishedAt, row.genre || null, row.reviewStatus || null, row.reviewStatus || null, work.match_status, user.id, user.id, now, now, marker));
                statements.push(db.prepare(`INSERT OR IGNORE INTO platform_metric_snapshots(id,organization_id,project_id,platform,work_id,import_batch_id,as_of_at,views,completion_rate_bps,five_second_completion_rate_bps,cover_ctr_bps,two_second_bounce_rate_bps,avg_watch_ms,likes,shares,comments,saves,homepage_visits,follower_delta,created_by,created_at) SELECT ?,?,?,'douyin',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${exists}`).bind(crypto.randomUUID(), organizationId, projectId, work.id, batchId, asOfAt, row.views, bps(row.completionRate), bps(row.fiveSecondCompletionRate), bps(row.coverCtr), bps(row.twoSecondBounceRate), row.avgWatchMs ?? null, row.likes, row.shares, row.comments, row.saves, row.homepageVisits, row.followerDelta, user.id, now, marker));
            }
            for (const warning of warnings)
                statements.push(db.prepare(`INSERT INTO platform_metric_import_errors(id,organization_id,project_id,import_batch_id,row_number,error_code,message,raw_json,created_at) SELECT ?,?,?,?,?,?,?,NULL,? WHERE ${exists}`).bind(crypto.randomUUID(), organizationId, projectId, batchId, warning.row, warning.code, warning.message, now, marker));
            statements.push(db.prepare(`UPDATE platform_metric_import_batches SET status='completed',accepted_count=(SELECT COUNT(*) FROM platform_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?),rejected_count=row_count-(SELECT COUNT(*) FROM platform_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?),errors_json=?,completed_at=? WHERE id=? AND ${exists}`).bind(batchId, organizationId, projectId, batchId, organizationId, projectId, warnings.length ? JSON.stringify(warnings) : null, now, batchId, marker));
            statements.push(db.prepare(`UPDATE platform_metric_import_batches SET errors_json=json_insert(COALESCE(errors_json,'[]'),'$[#]',json_object('row',0,'code','DUPLICATE_SNAPSHOT','message',printf('%d 行已有同一作品和时间的快照，已跳过',rejected_count))) WHERE id=? AND rejected_count>0 AND ${exists}`).bind(batchId, marker));
            return statements;
        },
        receipt: marker => db.prepare(`UPDATE audit_logs SET metadata_json=(SELECT json_object('import',json_object('id',id,'format','douyin_16','platform','douyin','asOfAt',as_of_at,'rowCount',row_count,'acceptedCount',accepted_count,'rejectedCount',rejected_count,'warningCount',json_array_length(COALESCE(errors_json,'[]')),'errors',json(COALESCE(errors_json,'[]')))) FROM platform_metric_import_batches WHERE id=?) WHERE id=?`).bind(batchId, marker),
    });
}
export async function GET(request: Request) {
    const identity = await readRequestIdentity(request);
    if (!identity)
        return apiError("AUTH_REQUIRED", "请先登录后再访问运营数据。", 401);
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId")?.trim() || "";
    const projectId = url.searchParams.get("projectId")?.trim() || "";
    if (!organizationId || !projectId)
        return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    try {
        const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
        if (!access)
            return apiError("ACCESS_DENIED", "无权访问该项目的运营数据。", 403);
        const db = getD1();
        const [imports, platformImports, publications] = await Promise.all([
            db.prepare("SELECT id, source, original_filename, status, row_count, accepted_count, rejected_count, errors_json, created_at, completed_at FROM performance_import_batches WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, projectId).all(),
            db.prepare("SELECT id, 'douyin' AS source, platform, as_of_at, original_filename, status, row_count, accepted_count, rejected_count, errors_json, created_at, completed_at FROM platform_metric_import_batches WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, projectId).all(),
            db.prepare("SELECT p.id, p.content_item_id, c.title, p.platform, p.external_url, p.published_at FROM publication_records p INNER JOIN content_items c ON c.id = p.content_item_id AND c.organization_id = p.organization_id AND c.project_id = p.project_id WHERE p.organization_id = ? AND p.project_id = ? AND p.status = 'published' ORDER BY p.published_at DESC LIMIT 500").bind(organizationId, projectId).all(),
        ]);
        return Response.json({ imports: imports.results, platformImports: platformImports.results, publications: publications.results, canImport: canWriteProjectAccess(access) });
    }
    catch (error) {
        return errorResponse(error);
    }
}
export async function POST(request: Request) {
    const identity = await readRequestIdentity(request);
    if (!identity)
        return apiError("AUTH_REQUIRED", "请先登录后再导入运营数据。", 401);
    try {
        const body = await readBoundedJson(request, 8 * 1024 * 1024, "复盘导入请求最多 8 MiB，请按 500 行上限分批整理。");
        if (body && typeof body === 'object' && 'format' in body && body.format === 'douyin_16')
            return await importDouyinSnapshot(request, identity, body);
        const parsed = performanceImportSchema.safeParse(body);
        if (!parsed.success)
            return apiError("INVALID_PERFORMANCE_IMPORT", parsed.error.issues[0]?.message || "导入数据格式无效。", 400);
        const { organizationId, projectId, source, filename, rows } = parsed.data;
        const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
        if (!access || !canWriteProjectAccess(access))
            return apiError("IMPORT_ACCESS_DENIED", "当前角色不能导入运营数据。", 403);
        const db = getD1(), user = await ensureUser(identity), now = new Date().toISOString(), scope = { organizationId, projectId, userId: user.id };
        const assertAccess = createProjectWriteAssertion(db, scope, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
        const sourceHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ source, rows })));
        const findDuplicate = () => db.prepare("SELECT id,status FROM performance_import_batches WHERE organization_id=? AND project_id=? AND source_hash=?").bind(organizationId, projectId, sourceHash).first<{
            id: string;
            status: string;
        }>();
        const duplicate = await findDuplicate();
        if (duplicate && duplicate.status !== "failed")
            return apiError("DUPLICATE_PERFORMANCE_IMPORT", "相同数据已经导入或正在处理，请勿重复提交。", 409, { importId: duplicate.id });
        const batchId = duplicate?.id || crypto.randomUUID();
        const publications = (await db.prepare(`SELECT p.id,p.content_item_id,p.external_url FROM publication_records p JOIN content_items c ON c.id=p.content_item_id AND c.organization_id=p.organization_id AND c.project_id=p.project_id WHERE p.organization_id=? AND p.project_id=? AND p.status='published'`).bind(organizationId, projectId).all<{
            id: string;
            content_item_id: string;
            external_url: string | null;
        }>()).results;
        const byId = new Map(publications.map(p => [p.id, p])), byUrl = new Map(publications.filter(p => p.external_url).map(p => [normalizedUrl(p.external_url), p]));
        const rejected: Array<{
            row: number;
            reason: string;
        }> = [];
        const accepted = rows.flatMap((row, index) => { const publication = (row.publicationId && byId.get(row.publicationId)) || (row.externalUrl && byUrl.get(normalizedUrl(row.externalUrl))); if (!publication) {
            rejected.push({ row: index + 2, reason: "未找到当前项目中对应的已发布作品，已保存的历史行会保留" });
            return [];
        } return [{ row, publication }]; });
        const previousSnapshots = duplicate ? (await db.prepare("SELECT id,publication_id,observed_at,content_item_id FROM publication_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?").bind(batchId, organizationId, projectId).all<{ id: string; publication_id: string; observed_at: string }>()).results : [];
        const availableRows = [...rows];
        for (const saved of previousSnapshots) {
            const index = availableRows.findIndex(row => (row.publicationId || byUrl.get(normalizedUrl(row.externalUrl))?.id) === saved.publication_id && row.observedAt === saved.observed_at);
            if (index < 0) return apiError("PERFORMANCE_IMPORT_RECOVERY_REQUIRED", "旧失败批次的已保存时间或关联与原文件不一致，已保留原数据。请先核对历史，勿直接重导。", 409);
            availableRows.splice(index, 1);
        }
        const guard = `${duplicate ? "EXISTS(SELECT 1 FROM performance_import_batches WHERE id=? AND organization_id=? AND project_id=? AND status='failed')" : "NOT EXISTS(SELECT 1 FROM performance_import_batches WHERE organization_id=? AND project_id=? AND source_hash=?)"}
      AND (SELECT COUNT(*) FROM publication_records p JOIN content_items c ON c.id=p.content_item_id AND c.organization_id=p.organization_id AND c.project_id=p.project_id WHERE p.organization_id=? AND p.project_id=? AND p.status='published')=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN publication_records p ON p.id=json_extract(expected.value,'$.id') AND p.organization_id=? AND p.project_id=? AND p.status='published' LEFT JOIN content_items c ON c.id=p.content_item_id AND c.organization_id=p.organization_id AND c.project_id=p.project_id WHERE p.id IS NULL OR c.id IS NULL OR p.content_item_id IS NOT json_extract(expected.value,'$.content_item_id') OR p.external_url IS NOT json_extract(expected.value,'$.external_url')) AND (SELECT COUNT(*) FROM publication_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN publication_metric_snapshots s ON s.id=json_extract(expected.value,'$.id') AND s.import_batch_id=? AND s.organization_id=? AND s.project_id=? WHERE s.id IS NULL OR s.publication_id IS NOT json_extract(expected.value,'$.publication_id') OR s.observed_at IS NOT json_extract(expected.value,'$.observed_at') OR s.content_item_id IS NOT json_extract(expected.value,'$.content_item_id'))`;
        const bindings = [...(duplicate ? [batchId, organizationId, projectId] : [organizationId, projectId, sourceHash]), organizationId, projectId, publications.length, JSON.stringify(publications), organizationId, projectId, batchId, organizationId, projectId, previousSnapshots.length, JSON.stringify(previousSnapshots), batchId, organizationId, projectId];
        return await commitPerformanceImport(db, {
            scope, batchId, rowCount: rows.length, platform: false, guard, bindings, assertAccess, duplicate: findDuplicate,
            statements: (exists, marker) => {
                const statements: D1PreparedStatement[] = [];
                if (duplicate)
                    statements.push(db.prepare(`UPDATE performance_import_batches SET status='processing',row_count=?,completed_at=NULL,imported_by=?,original_filename=? WHERE id=? AND ${exists}`).bind(rows.length, user.id, filename || null, batchId, marker));
                else
                    statements.push(db.prepare(`INSERT INTO performance_import_batches(id,organization_id,project_id,source,source_hash,original_filename,status,row_count,imported_by,created_at) SELECT ?,?,?,?,?,?,'processing',?,?,? WHERE ${exists}`).bind(batchId, organizationId, projectId, source, sourceHash, filename || null, rows.length, user.id, now, marker));
                for (const { row, publication } of accepted)
                    statements.push(db.prepare(`INSERT OR IGNORE INTO publication_metric_snapshots(id,organization_id,project_id,publication_id,content_item_id,import_batch_id,observed_at,views,likes,comments,shares,saves,followers_gained,leads,average_watch_seconds,completion_rate_bps,created_by,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${exists}`).bind(crypto.randomUUID(), organizationId, projectId, publication.id, publication.content_item_id, batchId, row.observedAt, row.views, row.likes, row.comments, row.shares, row.saves, row.followersGained, row.leads, row.averageWatchSeconds ?? null, row.completionRate === undefined ? null : Math.round(row.completionRate * 100), user.id, now, marker));
                statements.push(db.prepare(`UPDATE performance_import_batches SET status='completed',accepted_count=(SELECT COUNT(*) FROM publication_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?),rejected_count=row_count-(SELECT COUNT(*) FROM publication_metric_snapshots WHERE import_batch_id=? AND organization_id=? AND project_id=?),errors_json=?,completed_at=? WHERE id=? AND ${exists}`).bind(batchId, organizationId, projectId, batchId, organizationId, projectId, rejected.length ? JSON.stringify(rejected) : null, now, batchId, marker));
                statements.push(db.prepare(`UPDATE performance_import_batches SET errors_json=json_insert(COALESCE(errors_json,'[]'),'$[#]',json_object('row',0,'reason',printf('%d 行未新增快照；相同作品和时间的数据保留',rejected_count))) WHERE id=? AND rejected_count>? AND ${exists}`).bind(batchId, rejected.length, marker));
                return statements;
            },
            receipt: marker => db.prepare(`UPDATE audit_logs SET metadata_json=(SELECT json_object('import',json_object('id',id,'source',source,'original_filename',original_filename,'status',status,'row_count',row_count,'accepted_count',accepted_count,'rejected_count',rejected_count,'errors_json',errors_json,'created_at',created_at,'completed_at',completed_at)) FROM performance_import_batches WHERE id=?) WHERE id=?`).bind(batchId, marker),
        });
    }
    catch (error) {
        if (error instanceof RequestBodyError)
            return apiError(error.code, error.message, error.status);
        if (error instanceof ProjectWriteAccessChangedError)
            return apiError(error.code, "登录状态或项目权限已改变，本次复盘导入未保存。请刷新确认权限后再操作。", 403);
        return errorResponse(error);
    }
}
