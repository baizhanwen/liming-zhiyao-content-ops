export type RewriteWriteScope = { organizationId: string; projectId: string; workspaceId: string; userId: string };

// Evaluate membership and the live workspace in the same statement that writes
// the version. A preflight access snapshot cannot authorize a late model reply.
const writableWorkspaceSql = `FROM script_rewrite_workspaces w
  INNER JOIN projects p ON p.id = w.project_id AND p.organization_id = w.organization_id
  INNER JOIN organizations o ON o.id = w.organization_id
  INNER JOIN users u ON u.id = ?
  INNER JOIN organization_members om ON om.user_id = u.id AND om.organization_id = w.organization_id
  WHERE w.id = ? AND w.organization_id = ? AND w.project_id = ? AND w.status = 'active'
    AND p.deleted_at IS NULL AND p.status <> 'archived' AND o.status = 'active'
    AND u.status = 'active' AND om.status = 'active'
    AND (om.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm
      WHERE pm.organization_id = w.organization_id AND pm.project_id = w.project_id
        AND pm.user_id = u.id AND pm.status = 'active' AND pm.role IS NOT NULL))`;
const bindings = (scope: RewriteWriteScope) => [scope.userId, scope.workspaceId, scope.organizationId, scope.projectId];
export const rewriteWriteAccessCondition = `EXISTS (SELECT w.id ${writableWorkspaceSql})`;
export const rewriteWriteAccessBindings = bindings;

export async function canContinueRewriteWrite(db: D1Database, scope: RewriteWriteScope) {
  return Boolean(await db.prepare(`SELECT w.id ${writableWorkspaceSql}`).bind(...bindings(scope)).first());
}

export function rewriteVersionInsert(db: D1Database, input: RewriteWriteScope & {
  id: string; variant: string; parentVersionId: string | null; runId?: string | null;
  text: string; paragraphs: string[]; sourceMapping: string[]; outline?: unknown; validation?: unknown;
  modelProvider?: string | null; modelName?: string | null; promptVersion?: string | null; modelCallId?: string | null;
  changeSummary: string; now: string;
}) {
  return db.prepare(`INSERT INTO script_rewrite_versions
    (id, organization_id, project_id, workspace_id, version, variant, parent_version_id, run_id, text,
     paragraphs_json, source_mapping_json, outline_json, validation_json, model_provider, model_name,
     prompt_version, model_call_id, change_summary, created_by, created_at)
    SELECT ?, w.organization_id, w.project_id, w.id,
      (SELECT COALESCE(MAX(v.version), 0) + 1 FROM script_rewrite_versions v WHERE v.workspace_id = w.id),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${writableWorkspaceSql}
      ${input.runId ? "AND EXISTS (SELECT 1 FROM script_rewrite_runs r WHERE r.id = ? AND r.workspace_id = w.id AND r.status = 'started')" : ""}`)
    .bind(input.id, input.variant, input.parentVersionId, input.runId ?? null, input.text,
      JSON.stringify(input.paragraphs), JSON.stringify(input.sourceMapping), JSON.stringify(input.outline ?? []), JSON.stringify(input.validation ?? {}),
      input.modelProvider ?? null, input.modelName ?? null, input.promptVersion ?? null, input.modelCallId ?? null,
      input.changeSummary, input.userId, input.now, ...bindings(input), ...(input.runId ? [input.runId] : []));
}

export function rewriteVersionAudit(db: D1Database, input: RewriteWriteScope & {
  id: string; versionId: string; action: "script_rewrite.generated" | "script_rewrite.manual_version_saved";
  metadata: Record<string, unknown>; now: string;
}) {
  return db.prepare(`INSERT INTO audit_logs
    (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
    SELECT ?, organization_id, project_id, ?, ?, 'script_rewrite_version', id,
      json_set(?, '$.version', version), ? FROM script_rewrite_versions
    WHERE id = ? AND organization_id = ? AND project_id = ? AND workspace_id = ?`)
    .bind(input.id, input.userId, input.action, JSON.stringify(input.metadata), input.now,
      input.versionId, input.organizationId, input.projectId, input.workspaceId);
}
