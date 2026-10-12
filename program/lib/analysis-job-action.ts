import { projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access";

export class AnalysisJobActionStatusUnknownError extends Error {
  readonly code = "ANALYSIS_ACTION_STATUS_UNKNOWN";
  constructor() { super("暂时无法确认任务操作是否已保存。请等待服务恢复后刷新任务状态，再决定下一步；请勿连续点击重试或取消。"); }
}

type ActionJob = { id: string; video_id: string; status: string; version: number };
type ActionState = { id: string; status: string; progress: number; current_stage: string | null; retry_count: number; checkpoint_stage: string | null; resume_count: number; version: number; updated_at: string };

// The audit marker, state transition and event commit together. A lost batch
// acknowledgement is reconciled by this request's marker, never by replaying it.
export async function executeAnalysisJobAction(db: D1Database, options: {
  scope: ProjectWriteScope; job: ActionJob; action: "retried" | "cancelled";
  guard: string; guardBindings: unknown[]; metadata: Record<string, unknown>;
  now: string; toStatus: string; progress: number;
  mutate: (markerCondition: string, markerId: string) => D1PreparedStatement;
}) {
  const { scope, job, action, now } = options;
  const markerId = crypto.randomUUID();
  const markerCondition = "EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)";
  const select = () => db.prepare(`SELECT id, status, progress, current_stage, retry_count, checkpoint_stage, resume_count, version, updated_at
    FROM analysis_jobs WHERE id = ? AND organization_id = ? AND project_id = ?`).bind(job.id, scope.organizationId, scope.projectId);
  const statements = [
    db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?, ?, ?, ?, ?, 'analysis_job', ?, ?, ? WHERE ${projectWriteAccessCondition}
        AND EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND organization_id = ? AND project_id = ? AND version = ? AND (${options.guard}))`)
      .bind(markerId, scope.organizationId, scope.projectId, scope.userId, `analysis_job.${action}`, job.id, JSON.stringify(options.metadata), now,
        ...projectWriteAccessBindings(scope), job.id, scope.organizationId, scope.projectId, job.version, ...options.guardBindings),
    options.mutate(markerCondition, markerId),
    db.prepare(`INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, details_json, created_at)
      SELECT ?, ?, ?, ?, ?, 'stage_changed', ?, ?, ?, ?, ? WHERE ${markerCondition}`)
      .bind(crypto.randomUUID(), scope.organizationId, scope.projectId, job.id, job.video_id, job.status, options.toStatus, options.progress, JSON.stringify(options.metadata), now, markerId),
    select(),
  ];
  try {
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return null;
    const state = results[3].results[0] as ActionState | undefined;
    if (!state) throw new AnalysisJobActionStatusUnknownError();
    return state;
  } catch (error) {
    let committed: unknown;
    let state: ActionState | null = null;
    try {
      committed = await db.prepare("SELECT id FROM audit_logs WHERE id = ? AND organization_id = ? AND project_id = ? AND actor_user_id = ? AND action = ? AND target_id = ?")
        .bind(markerId, scope.organizationId, scope.projectId, scope.userId, `analysis_job.${action}`, job.id).first();
      if (committed) state = await select().first<ActionState>();
    } catch { throw new AnalysisJobActionStatusUnknownError(); }
    if (!committed) throw error;
    if (!state) throw new AnalysisJobActionStatusUnknownError();
    return state;
  }
}
