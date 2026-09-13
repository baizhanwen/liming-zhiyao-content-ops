export type InspirationCardDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null | undefined>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>): Promise<unknown>;
};

export type InspirationEvidence = { sourceType: string; sourceId: string; quote?: string | null };

export type InspirationCardInput = {
  organizationId: string;
  projectId: string;
  userId: string;
  canonicalKey: string;
  title: string;
  coreInsight: string;
  applicableScenarios?: string[];
  excludedScenarios?: string[];
  evidence?: InspirationEvidence[];
  sourceType: string;
  sourceId?: string | null;
  tags?: string[];
  confidence?: number | null;
};

function list(value: unknown, limit: number, itemLimit: number) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().slice(0, itemLimit)).filter(Boolean).slice(0, limit);
}

function evidence(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { sourceType: String(row.sourceType ?? "").trim().slice(0, 60), sourceId: String(row.sourceId ?? "").trim().slice(0, 160), quote: row.quote ? String(row.quote).trim().slice(0, 4000) : null };
  }).filter((item) => item.sourceType && item.sourceId).slice(0, 20);
}

function parseArray(value: unknown) {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

async function sha256HexText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createInspirationCardWithDb(db: InspirationCardDatabase, input: InspirationCardInput) {
  const now = new Date().toISOString();
  const applicableScenarios = list(input.applicableScenarios, 20, 500);
  const excludedScenarios = list(input.excludedScenarios, 20, 500);
  const tags = list(input.tags, 30, 80);
  const cardEvidence = evidence(input.evidence);
  const contentHash = await sha256HexText(JSON.stringify({ title: input.title, coreInsight: input.coreInsight, applicableScenarios, excludedScenarios, evidence: cardEvidence, sourceType: input.sourceType, sourceId: input.sourceId ?? null, tags }));
  const existing = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM project_inspiration_cards WHERE organization_id = ? AND project_id = ? AND canonical_key = ?").bind(input.organizationId, input.projectId, input.canonicalKey).first<{ version: number }>();
  const version = Number(existing?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.batch([db.prepare("INSERT INTO project_inspiration_cards (id, organization_id, project_id, canonical_key, version, status, title, core_insight, applicable_scenarios_json, excluded_scenarios_json, evidence_json, source_type, source_id, tags_json, confidence, content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, input.organizationId, input.projectId, input.canonicalKey, version, input.title, input.coreInsight, JSON.stringify(applicableScenarios), JSON.stringify(excludedScenarios), JSON.stringify(cardEvidence), input.sourceType, input.sourceId ?? null, JSON.stringify(tags), input.confidence ?? null, contentHash, input.userId, now, now)]);
  return { id, version, status: "candidate" as const, contentHash };
}

export function serializeInspirationCard(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    project_id: String(row.project_id),
    canonical_key: String(row.canonical_key),
    version: Number(row.version),
    status: String(row.status),
    title: String(row.title),
    core_insight: String(row.core_insight),
    applicable_scenarios: parseArray(row.applicable_scenarios_json),
    excluded_scenarios: parseArray(row.excluded_scenarios_json),
    evidence: parseArray(row.evidence_json),
    source_type: String(row.source_type),
    source_id: row.source_id ? String(row.source_id) : null,
    source_trace: parseArray(row.source_trace_json),
    tags: parseArray(row.tags_json),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    content_hash: String(row.content_hash),
    confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
    superseded_by: row.superseded_by ? String(row.superseded_by) : null,
    expires_at: row.expires_at ? String(row.expires_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}