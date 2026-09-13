import { analysisReportSourceText } from "./content-production.ts";
import type { ProjectAssistantDatabase } from "./project-memory-events.ts";

type BenchmarkRow = {
  benchmark_id: string;
  analysis_id: string;
  report_json: string;
  title: string;
  author_name: string | null;
  summary: string | null;
  hook: string | null;
  audience: string | null;
  structure_json: string | null;
  highlights_json: string | null;
  recommendations_json: string | null;
  spoken_script_json: string | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  collected_at: string | null;
  referenced_at: string;
};

export type ProjectAssistantBenchmark = {
  id: string;
  analysisId: string;
  title: string;
  authorName: string | null;
  summary: string;
  hook: string;
  audience: string;
  structure: string[];
  highlights: string[];
  recommendations: string[];
  spokenScript: string[];
  content: string;
  performance: {
    plays: number | null;
    likes: number | null;
    comments: number | null;
    favorites: number | null;
    shares: number | null;
    collectedAt: string | null;
  };
};

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stringList(value: unknown, limit: number, itemLimit: number) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => text(item, itemLimit)).filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

function searchTokens(value: string) {
  const normalized = value.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
  const tokens = new Set<string>();
  for (const word of value.toLocaleLowerCase("zh-CN").match(/[a-z][a-z0-9+.#-]{1,}|\d+(?:\.\d+)?/gu) ?? []) tokens.add(word);
  for (let index = 0; index < normalized.length - 1; index += 1) tokens.add(normalized.slice(index, index + 2));
  return tokens;
}

function relevanceScore(item: ProjectAssistantBenchmark, queryTokens: Set<string>) {
  if (!queryTokens.size) return 0;
  const searchable = searchTokens([item.title, item.summary, item.hook, item.audience, ...item.highlights, ...item.recommendations].join("\n"));
  let score = 0;
  for (const token of queryTokens) if (searchable.has(token)) score += token.length > 2 ? 3 : 1;
  return score;
}

function serializeBenchmark(row: BenchmarkRow): ProjectAssistantBenchmark {
  return {
    id: String(row.benchmark_id),
    analysisId: String(row.analysis_id),
    title: text(row.title, 500) || "未命名对标内容",
    authorName: text(row.author_name, 200) || null,
    summary: text(row.summary, 2_400),
    hook: text(row.hook, 1_200),
    audience: text(row.audience, 1_200),
    structure: stringList(row.structure_json, 16, 500),
    highlights: stringList(row.highlights_json, 12, 700),
    recommendations: stringList(row.recommendations_json, 12, 700),
    spokenScript: stringList(row.spoken_script_json, 8, 1_500),
    content: analysisReportSourceText(row.report_json).slice(0, 12_000),
    performance: {
      plays: row.plays === null ? null : Number(row.plays),
      likes: row.likes === null ? null : Number(row.likes),
      comments: row.comments === null ? null : Number(row.comments),
      favorites: row.favorites === null ? null : Number(row.favorites),
      shares: row.shares === null ? null : Number(row.shares),
      collectedAt: text(row.collected_at, 80) || null,
    },
  };
}

export async function readProjectAssistantBenchmarkStatusWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS active_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM video_library_entries ready_library
        INNER JOIN videos ready_video ON ready_video.id = ready_library.source_video_id AND ready_video.organization_id = ready_library.organization_id AND ready_video.deleted_at IS NULL
        INNER JOIN video_analyses analysis ON analysis.video_id = ready_video.id AND analysis.organization_id = ready_video.organization_id
        WHERE ready_library.id = refs.library_entry_id AND ready_library.organization_id = refs.organization_id
      ) THEN 1 ELSE 0 END) AS ready_count
    FROM project_video_references refs
    WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
  `).bind(input.organizationId, input.projectId).first<{ active_count: number; ready_count: number }>();
  const activeCount = Number(row?.active_count ?? 0);
  const readyCount = Number(row?.ready_count ?? 0);
  return { available: readyCount > 0, activeCount, readyCount };
}

export async function readProjectAssistantBenchmarksWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string; query?: string; limit?: number; maxCharacters?: number },
) {
  const rows = await db.prepare(`
    SELECT library.id AS benchmark_id, analysis.id AS analysis_id, analysis.report_json,
      COALESCE(v.title, v.source_url, '未命名对标内容') AS title, v.author_name,
      json_extract(analysis.report_json, '$.summary') AS summary,
      json_extract(analysis.report_json, '$.hook') AS hook,
      json_extract(analysis.report_json, '$.audience') AS audience,
      json_extract(analysis.report_json, '$.structure') AS structure_json,
      json_extract(analysis.report_json, '$.highlights') AS highlights_json,
      json_extract(analysis.report_json, '$.recommendations') AS recommendations_json,
      json_extract(analysis.report_json, '$.spoken_script') AS spoken_script_json,
      metrics.plays, metrics.likes, metrics.comments, metrics.favorites, metrics.shares, metrics.collected_at,
      refs.created_at AS referenced_at
    FROM project_video_references refs
    INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
    INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
    INNER JOIN video_analyses analysis ON analysis.id = (
      SELECT latest.id FROM video_analyses latest
      WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id
      ORDER BY latest.created_at DESC LIMIT 1
    )
    LEFT JOIN video_metric_snapshots metrics ON metrics.id = (
      SELECT latest_metric.id FROM video_metric_snapshots latest_metric
      WHERE latest_metric.organization_id = v.organization_id AND latest_metric.video_id = v.id
      ORDER BY latest_metric.collected_at DESC, latest_metric.created_at DESC LIMIT 1
    )
    WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
    ORDER BY refs.created_at DESC LIMIT 80
  `).bind(input.organizationId, input.projectId).all<BenchmarkRow>();

  const queryTokens = searchTokens(input.query ?? "");
  const ranked = rows.results.map((row, index) => ({ item: serializeBenchmark(row), index }))
    .sort((left, right) => relevanceScore(right.item, queryTokens) - relevanceScore(left.item, queryTokens) || left.index - right.index);
  const limit = Math.max(1, Math.min(20, input.limit ?? 10));
  const maximum = Math.max(4_000, Math.min(80_000, input.maxCharacters ?? 40_000));
  const selected: ProjectAssistantBenchmark[] = [];
  let characters = 0;
  for (const row of ranked) {
    const size = JSON.stringify(row.item).length;
    if (selected.length && characters + size > maximum) continue;
    selected.push(row.item);
    characters += size;
    if (selected.length >= limit) break;
  }
  return selected;
}
