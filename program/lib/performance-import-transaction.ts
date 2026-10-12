import { apiError } from "./api-response";
import { projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access";
export async function commitPerformanceImport(db: D1Database, options: {
    scope: ProjectWriteScope;
    batchId: string;
    rowCount: number;
    platform: boolean;
    guard: string;
    bindings: unknown[];
    assertAccess: () => Promise<void>;
    duplicate: () => Promise<{
        id: string;
        status: string;
    } | null>;
    statements: (exists: string, marker: string) => D1PreparedStatement[];
    receipt: (marker: string) => D1PreparedStatement;
}) {
    const { scope, batchId } = options, marker = crypto.randomUUID(), now = new Date().toISOString();
    const action = options.platform ? "platform_metrics.import.completed" : "performance.import.completed";
    const readReceipt = () => db.prepare("SELECT metadata_json FROM audit_logs WHERE id=? AND organization_id=? AND project_id=? AND actor_user_id=? AND action=? AND target_id=?")
        .bind(marker, scope.organizationId, scope.projectId, scope.userId, action, batchId);
    const unknown = () => apiError("PERFORMANCE_IMPORT_STATUS_UNKNOWN", "暂时无法确认复盘导入是否已保存，请恢复服务并刷新历史核对，勿立即重复提交。", 503);
    const respond = (text: string) => {
        try {
            const value = JSON.parse(text) as {
                import: Record<string, unknown>;
            };
            const item = value.import, accepted = item?.[options.platform ? "acceptedCount" : "accepted_count"], rejected = item?.[options.platform ? "rejectedCount" : "rejected_count"];
            if (item?.id !== batchId || !Number.isSafeInteger(accepted) || !Number.isSafeInteger(rejected) || Number(accepted) < 0 || Number(rejected) < 0 || Number(accepted) + Number(rejected) !== options.rowCount)
                return unknown();
            return Response.json(value, { status: 201 });
        }
        catch {
            return unknown();
        }
    };
    const conflict = async () => {
        await options.assertAccess();
        const existing = await options.duplicate();
        if (existing && existing.status !== "failed")
            return apiError(options.platform ? "DUPLICATE_PLATFORM_METRIC_IMPORT" : "DUPLICATE_PERFORMANCE_IMPORT", "相同数据已导入或已有历史批次，请刷新历史核对，勿重复提交。", 409, { importId: existing.id });
        return apiError("PERFORMANCE_IMPORT_CHANGED", "导入前作品、快照或发布记录已改变，本次未保存。请刷新核对后重新选择文件。", 409);
    };
    const statements = [
        db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?,?,?,?,?, '{}',? WHERE ${projectWriteAccessCondition} AND (${options.guard})`)
            .bind(marker, scope.organizationId, scope.projectId, scope.userId, action, options.platform ? "platform_metric_import" : "performance_import", batchId, now, ...projectWriteAccessBindings(scope), ...options.bindings),
        ...options.statements("EXISTS(SELECT 1 FROM audit_logs WHERE id=?)", marker),
        options.receipt(marker),
        readReceipt(),
    ];
    await options.assertAccess();
    let results;
    try {
        results = await db.batch(statements);
    }
    catch (error) {
        let stored: {
            metadata_json: string;
        } | null;
        try {
            stored = await readReceipt().first<{
                metadata_json: string;
            }>();
        }
        catch {
            return unknown();
        }
        if (stored)
            return respond(stored.metadata_json);
        const existing = await options.duplicate();
        if (existing && existing.status !== "failed")
            return conflict();
        throw error;
    }
    if (!results[0].meta.changes)
        return conflict();
    const stored = results[results.length - 1].results[0] as {
        metadata_json: string;
    } | undefined;
    return stored ? respond(stored.metadata_json) : unknown();
}
