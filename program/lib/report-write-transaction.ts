import { sha256Hex } from "../db/runtime";
import { readSessionToken } from "./local-auth";
import { readRequestIdentity } from "./request-auth";
import { assertProjectWriteAccess, ProjectWriteAccessChangedError, projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access";

export class ReportWriteStatusUnknownError extends Error {
  readonly code = "REPORT_WRITE_STATUS_UNKNOWN";
  constructor() { super("暂时无法确认报告操作是否已保存。请恢复服务并刷新报告列表核对，请勿连续生成或定稿。"); }
}

// updated_at doubles as the existing report revision. Even if the clock moves
// backwards or two requests share a millisecond, a successful refresh advances it.
export function nextReportVersion(previous?: string | null) {
  const prior = Date.parse(previous || "");
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
}

export async function commitReportWrite(db: D1Database, options: {
  request: Request; authSubject: string; scope: ProjectWriteScope;
  reportId: string; version: string;
  action: "performance.report.generated" | "performance.report.finalized" | "employee.report.generated";
  targetType: "performance_report" | "employee_work_report";
  metadata: Record<string, unknown>; guard: string; bindings: unknown[];
  mutate: (markerCondition: string, markerId: string) => D1PreparedStatement;
}) {
  const { scope } = options, markerId = crypto.randomUUID();
  // Local logout/expiry is checked at transaction entry as well as before it.
  // Proxy/development identities have no local token and keep their normal check.
  const token = readSessionToken(options.request);
  const sessionCondition = token ? "EXISTS(SELECT 1 FROM local_sessions s WHERE s.token_hash=? AND s.user_id=? AND julianday(s.expires_at)>julianday('now'))" : "1";
  const sessionBindings = token ? [await sha256Hex(new TextEncoder().encode(token)),scope.userId] : [];
  const accessChanged = () => {
    const error = new ProjectWriteAccessChangedError();
    error.message = "登录状态或企业空间权限已改变，本次报告操作未保存。请刷新确认后再操作。";
    return error;
  };
  const assertAccess = async () => {
    if ((await readRequestIdentity(options.request))?.authSubject !== options.authSubject) throw accessChanged();
    try { await assertProjectWriteAccess(db,scope); }
    catch(error) { if(error instanceof ProjectWriteAccessChangedError)throw accessChanged();throw error; }
    if (token && !await db.prepare(`SELECT 1 WHERE ${sessionCondition}`).bind(...sessionBindings).first()) throw accessChanged();
  };
  const receipt = () => db.prepare(`SELECT id FROM audit_logs WHERE id=? AND organization_id=? AND project_id=? AND actor_user_id=?
    AND action=? AND target_type=? AND target_id=? AND json_extract(metadata_json,'$.receiptVersion')=?`)
    .bind(markerId,scope.organizationId,scope.projectId,scope.userId,options.action,options.targetType,options.reportId,options.version);
  const statements = [
    db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${projectWriteAccessCondition} AND (${sessionCondition}) AND (${options.guard})`)
      .bind(markerId,scope.organizationId,scope.projectId,scope.userId,options.action,options.targetType,options.reportId,
        JSON.stringify({...options.metadata,receiptVersion:options.version}),new Date().toISOString(),...projectWriteAccessBindings(scope),...sessionBindings,...options.bindings),
    options.mutate("EXISTS(SELECT 1 FROM audit_logs WHERE id=?)",markerId),
  ];
  await assertAccess();
  let results;
  try { results = await db.batch(statements); }
  catch(error) {
    // Reconcile this operation's receipt; never replay a possibly committed write
    // or treat another writer's report as proof that this request succeeded.
    let stored;
    try { stored = await receipt().first(); } catch { throw new ReportWriteStatusUnknownError(); }
    if (stored) return true;
    await assertAccess();
    if (!await db.prepare(`SELECT 1 WHERE (${options.guard})`).bind(...options.bindings).first()) return false;
    throw error;
  }
  if (!results[0].meta.changes) { await assertAccess(); return false; }
  if (results[1].meta.changes !== 1) throw new ReportWriteStatusUnknownError();
  return true;
}
