import type { ReferenceMaterialQuestion } from "./reference-material-questions";

export type ContentGenerationProgress = {
  generationRequestId: string;
  expectedVersion: number;
  status: "running" | "completed" | "needs_material" | "failed";
  stage: "writing" | "validating" | "citation_repair" | "reviewing" | "saving";
  startedAt: string;
  stepStartedAt: string;
  finishedAt: string | null;
  requestCount: number;
  errorCode: string | null;
  materialQuestions: ReferenceMaterialQuestion[];
};

type Scope = {
  organizationId: string; projectId: string; contentId: string;
  expectedVersion: number; generationRequestId?: string;
};
type ProgressRow = Pick<ContentGenerationProgress, "generationRequestId" | "startedAt" | "finishedAt" | "requestCount" | "errorCode"> & {
  status: string; savedStage: ContentGenerationProgress["stage"] | null; stageAt: string | null;
  stageRequest: number | null; latestStep: string | null; latestStartedAt: string | null;
  questions: string | null;
};

/** The root call owns the attempt. Its child rows are actual provider requests, including repairs. */
export async function readContentGenerationProgress(db: D1Database, scope: Scope): Promise<ContentGenerationProgress | null> {
  const { organizationId, projectId, contentId, expectedVersion, generationRequestId } = scope;
  const row = await db.prepare(`WITH root AS (
    SELECT m.id, m.topic_id, m.status, m.created_at AS startedAt, m.completed_at AS finishedAt,
      m.error_code AS errorCode, json_extract(m.input_json,'$.progress.generationRequestId') AS generationRequestId,
      json_extract(m.input_json,'$.progress.stage') AS savedStage,
      json_extract(m.input_json,'$.progress.at') AS stageAt, json_extract(m.input_json,'$.progress.request') AS stageRequest,
      CASE WHEN m.status='completed' AND json_extract(m.output_json,'$.outcome')='material_questions'
        THEN json_extract(m.output_json,'$.materialQuestions') END AS questions
    FROM content_items c JOIN topic_ideas t ON t.id=c.topic_id AND t.organization_id=c.organization_id AND t.project_id=c.project_id
    JOIN model_calls m ON m.topic_id=c.topic_id AND m.organization_id=c.organization_id AND m.project_id=c.project_id
    WHERE c.organization_id=? AND c.project_id=? AND c.id=? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
      AND m.task_type='content_draft' AND json_valid(m.input_json) AND json_extract(m.input_json,'$.progress.contentId')=c.id
      AND json_extract(m.input_json,'$.progress.expectedVersion')=?
      ${generationRequestId ? "AND json_extract(m.input_json,'$.progress.generationRequestId')=?" : "AND c.current_version=? AND m.status='started'"}
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
  ), children AS (
    SELECT child.created_at, child.rowid AS sequence, json_extract(child.input_json,'$.step') AS step
      FROM root JOIN model_calls child ON child.topic_id=root.topic_id AND child.created_at >= root.startedAt
      WHERE child.organization_id=? AND child.project_id=? AND child.task_type='content_draft.request'
        AND json_valid(child.input_json) AND json_extract(child.input_json,'$.parentModelCallId')=root.id
  )
  SELECT root.*, 1+(SELECT count(*) FROM children) AS requestCount, latest.step AS latestStep, latest.created_at AS latestStartedAt
    FROM root LEFT JOIN (SELECT * FROM children ORDER BY created_at DESC, sequence DESC LIMIT 1) latest ON 1=1`)
    .bind(organizationId, projectId, contentId, expectedVersion, generationRequestId ?? expectedVersion, organizationId, projectId).first<ProgressRow>();
  if (!row) return null;
  const currentMarker = row.savedStage && row.stageRequest === row.requestCount;
  const stage = currentMarker ? row.savedStage! : row.latestStep === "reference_draft_review" ? "reviewing"
    : row.latestStep === "citation_repair" ? "citation_repair" : "writing";
  const status = row.status === "failed" ? "failed" : row.status === "completed" ? (row.questions ? "needs_material" : "completed") : "running";
  return {
    generationRequestId: row.generationRequestId, expectedVersion, status, stage,
    startedAt: row.startedAt, stepStartedAt: (currentMarker ? row.stageAt : row.latestStartedAt) || row.startedAt,
    finishedAt: row.finishedAt, requestCount: row.requestCount, errorCode: row.errorCode,
    materialQuestions: row.questions ? JSON.parse(row.questions) as ReferenceMaterialQuestion[] : [],
  };
}
