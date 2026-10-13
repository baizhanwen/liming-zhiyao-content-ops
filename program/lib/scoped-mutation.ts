import { sha256Hex } from "../db/runtime";
import { readSessionToken } from "./local-auth";
import { readRequestIdentity } from "./request-auth";
import { assertProjectWriteAccess, ProjectWriteAccessChangedError, projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access";

export class ScopedMutationStatusUnknownError extends Error {
  constructor(readonly code: string,message: string) { super(message); }
}

// updated_at doubles as the row revision. Even if the clock moves
// backwards or two requests share a millisecond, a successful write advances it.
export function nextWriteTimestamp(previous?: string | null) {
  const prior = Date.parse(previous || "");
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
}

export type ScopedMutationOptions = {
  request: Request; authSubject: string; scope: ProjectWriteScope;
  targetId: string; version: string;
  action: string; targetType: string;
  metadata: Record<string, unknown>; guard: string; bindings: unknown[];
  mutate: (markerCondition: string, markerId: string) => D1PreparedStatement | D1PreparedStatement[];
  accessMessage: string; unknownError: () => Error;
};

export async function commitScopedMutation(db: D1Database, options: ScopedMutationOptions) {
  const { scope } = options, markerId = crypto.randomUUID();
  // Local logout/expiry is checked at transaction entry as well as before it.
  // Proxy/development identities have no local token and keep their normal check.
  const token = readSessionToken(options.request);
  const sessionCondition = token ? "EXISTS(SELECT 1 FROM local_sessions s WHERE s.token_hash=? AND s.user_id=? AND julianday(s.expires_at)>julianday('now'))" : "1";
  const sessionBindings = token ? [await sha256Hex(new TextEncoder().encode(token)),scope.userId] : [];
  const accessChanged = () => {
    const error = new ProjectWriteAccessChangedError();
    error.message = options.accessMessage;
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
    .bind(markerId,scope.organizationId,scope.projectId,scope.userId,options.action,options.targetType,options.targetId,options.version);
  const statements = [
    db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${projectWriteAccessCondition} AND (${sessionCondition}) AND (${options.guard})`)
      .bind(markerId,scope.organizationId,scope.projectId,scope.userId,options.action,options.targetType,options.targetId,
        JSON.stringify({...options.metadata,receiptVersion:options.version}),new Date().toISOString(),...projectWriteAccessBindings(scope),...sessionBindings,...options.bindings),
    ...[options.mutate("EXISTS(SELECT 1 FROM audit_logs WHERE id=?)",markerId)].flat(),
  ];
  await assertAccess();
  let results;
  try { results = await db.batch(statements); }
  catch(error) {
    // Reconcile this operation's receipt; never replay a possibly committed write
    // or treat another writer's report as proof that this request succeeded.
    let stored;
    try { stored = await receipt().first(); } catch { throw options.unknownError(); }
    if (stored) return true;
    await assertAccess();
    if (!await db.prepare(`SELECT 1 WHERE (${options.guard})`).bind(...options.bindings).first()) return false;
    throw error;
  }
  if (!results[0].meta.changes) { await assertAccess(); return false; }
  if (results.slice(1).some(result=>result.meta.changes !== 1)) throw options.unknownError();
  return true;
}
