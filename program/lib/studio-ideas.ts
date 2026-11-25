export type StudioIdeaKind = "card" | "topic";
export type StudioIdeaScope = { organizationId: string; projectId: string };
export type StudioIdea = {
  id: string; kind: StudioIdeaKind; title: string; updatedAt: string; cardId: string | null; topicId: string | null;
  sourceType: string; status: string; active: number;
};
export type LibraryIdea = StudioIdea & {
  insight: string | null; originalTitle: string | null; angle: string | null; rationale: string | null; conversationId: string | null;
  drafts: { id: string; title: string }[];
};

// Reference drafts have an internal backing topic, even when the user never saved an idea.
export function studioIdeasSql(projectScopeSql: string) {
  return `WITH scope AS (${projectScopeSql}),
  cards AS (SELECT c.* FROM project_inspiration_cards c JOIN scope ON c.organization_id=scope.org AND c.project_id=scope.project),
  topics AS (
    SELECT t.* FROM topic_ideas t JOIN scope ON t.organization_id=scope.org AND t.project_id=scope.project
    WHERE t.deleted_at IS NULL AND t.source_type <> 'script_rewrite' AND NOT EXISTS (
      SELECT 1 FROM content_items d JOIN content_versions v ON v.content_item_id=d.id AND v.version=1
        AND v.project_id=t.project_id AND v.organization_id=t.organization_id
      WHERE d.topic_id=t.id AND d.organization_id=t.organization_id AND d.project_id=t.project_id
        AND json_extract(CASE WHEN json_valid(v.pack_json) THEN v.pack_json END,'$.structureRequestDigest') IS NOT NULL
    )
  ), ideas AS (
    SELECT c.id, 'card' AS kind, CASE WHEN t.status='archived' THEN c.title ELSE COALESCE(t.title,c.title) END AS title, MAX(c.updated_at,COALESCE(t.updated_at,c.updated_at)) AS updatedAt,
      c.id AS cardId,t.id AS topicId,c.source_type AS sourceType,c.status,
      (c.status IN ('confirmed','candidate') AND (c.expires_at IS NULL OR COALESCE(julianday(c.expires_at)>julianday('now'),0))) AS active,
      c.core_insight AS insight,c.title AS originalTitle,t.angle,t.rationale,c.organization_id,c.project_id
    FROM cards c LEFT JOIN topics t ON t.source_type='inspiration_card' AND t.source_ref=c.id AND t.organization_id=c.organization_id AND t.project_id=c.project_id
    UNION ALL
    SELECT t.id, 'topic', t.title,t.updated_at,NULL,t.id,t.source_type,t.status,t.status<>'archived',NULL,NULL,t.angle,t.rationale,t.organization_id,t.project_id
    FROM topics t WHERE t.source_type<>'inspiration_card' OR NOT EXISTS(SELECT 1 FROM cards c WHERE c.id=t.source_ref AND c.organization_id=t.organization_id AND c.project_id=t.project_id)
  )`;
}
const scopedIdeas = studioIdeasSql("SELECT ? AS org, ? AS project");
const briefColumns = "id, kind, title, updatedAt, cardId, topicId, sourceType, status, active";
const sameIdea = "kind=? AND id=?";

export function studioIdeaGuard(scope: StudioIdeaScope, kind: StudioIdeaKind, id: string, title: string) {
  return {
    guard: `EXISTS(${scopedIdeas} SELECT 1 FROM ideas WHERE active=1 AND ${sameIdea} AND title=?)`,
    bindings: [scope.organizationId, scope.projectId, kind, id, title],
  };
}

export async function readStudioIdea(db: D1Database, scope: StudioIdeaScope, kind: StudioIdeaKind, id: string) {
  return db.prepare(`${scopedIdeas} SELECT ${briefColumns} FROM ideas WHERE active=1 AND ${sameIdea}`)
    .bind(scope.organizationId, scope.projectId, kind, id).first<StudioIdea>();
}

type IdeaQuery = {
  detailed?: boolean; history?: boolean; query?: string; id?: string; kind?: StudioIdeaKind;
  focusId?: string; offset?: number;
};

export async function listStudioIdeas(db: D1Database, scope: StudioIdeaScope, opts: IdeaQuery = {}) {
  const where = ["i.active=?"];
  const bindings: (string | number)[] = [scope.organizationId, scope.projectId, opts.history ? 0 : 1];
  if (opts.id && opts.kind) { where.push("i.kind=? AND i.id=?"); bindings.push(opts.kind, opts.id); }
  if (opts.query) {
    where.push("(instr(lower(i.title), lower(?))>0 OR instr(lower(i.originalTitle), lower(?))>0)");
    bindings.push(opts.query, opts.query);
  }
  const limit = opts.detailed ? 36 : 200;
  const select = opts.detailed ? `${briefColumns}, insight, originalTitle, angle, rationale,
    (SELECT conversation_id FROM project_inspiration_card_sources WHERE card_id=i.cardId AND organization_id=i.organization_id AND project_id=i.project_id AND conversation_id IS NOT NULL LIMIT 1) AS conversationId,
    (SELECT json_group_array(json_object('id',linked.id,'title',linked.title)) FROM (
      SELECT d.id,d.title FROM content_items d
      LEFT JOIN content_versions v ON v.content_item_id=d.id AND v.organization_id=d.organization_id AND v.project_id=d.project_id AND v.version=1
      WHERE d.organization_id=(SELECT org FROM scope) AND d.project_id=(SELECT project FROM scope) AND d.deleted_at IS NULL
        AND (d.topic_id=i.topicId OR
          (json_extract(CASE WHEN json_valid(v.pack_json) THEN v.pack_json END,'$.referenceCreation.idea.id')=i.id AND
           json_extract(CASE WHEN json_valid(v.pack_json) THEN v.pack_json END,'$.referenceCreation.idea.kind')=i.kind))
      ORDER BY d.updated_at DESC
    ) linked) AS draftsJson` : briefColumns;
  // Old deep links may name the converted topic rather than its original inspiration card.
  const ordering = opts.focusId ? "(i.id=? OR i.topicId=?) DESC," : "";
  if (opts.focusId) bindings.push(opts.focusId, opts.focusId);
  const { results } = await db.prepare(`${scopedIdeas} SELECT ${select} FROM ideas i WHERE ${where.join(" AND ")}
    ORDER BY ${ordering} i.updatedAt DESC, i.kind, i.id LIMIT ? OFFSET ?`)
    .bind(...bindings, limit+1, opts.offset ?? 0).all<StudioIdea & { draftsJson?: string }>();
  return { ideas: results.slice(0,limit).map(({draftsJson,...row}) => draftsJson ? {...row,drafts:JSON.parse(draftsJson)} : row),
    hasMore: results.length > limit };
}
