import {
  createInspirationCardWithDb,
  type InspirationCardDatabase,
} from "./project-inspiration-card.ts";
import type { ProjectAssistantRecommendation } from "./project-assistant-contract.ts";
import type { ProjectAssistantDatabase, ProjectAssistantBoundStatement } from "./project-memory-events.ts";

function parseSuggestions(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const suggestion = item && typeof item === "object" && !Array.isArray(item)
        ? item as Partial<ProjectAssistantRecommendation>
        : {};
      return {
        ...suggestion,
        benchmarkIds: Array.isArray(suggestion.benchmarkIds)
          ? suggestion.benchmarkIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
          : [],
      } as ProjectAssistantRecommendation;
    });
  } catch {
    return [];
  }
}

function fallbackReplyTitle(content: string) {
  const firstLine = content.split(/\r?\n/)
    .map((line) => line.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*·\d.)、\s]+/, ""))
    .find((line) => line.length >= 2);
  return ("对话灵感：" + (firstLine || "项目助理回复")).slice(0, 160);
}

export async function saveProjectAssistantRecommendationsWithDb(
  db: ProjectAssistantDatabase,
  input: {
    organizationId: string;
    projectId: string;
    messageId: string;
    userId: string;
    recommendationIndexes: number[];
    saveReply?: boolean;
  },
) {
  const message = await db.prepare(
    "SELECT id, conversation_id, content, suggestions_json FROM project_assistant_messages WHERE id = ? AND organization_id = ? AND project_id = ? AND role = 'assistant' AND status = 'completed' LIMIT 1",
  ).bind(input.messageId, input.organizationId, input.projectId).first<{
    id: string;
    conversation_id: string;
    content: string;
    suggestions_json: string;
  }>();
  if (!message) throw new Error("项目助理回复不存在或不属于当前项目。");
  const suggestions = parseSuggestions(message.suggestions_json);
  const indexes = Array.from(new Set(input.recommendationIndexes))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < suggestions.length)
    .slice(0, 12);
  const selections: Array<{ index: number; suggestion: ProjectAssistantRecommendation }> = indexes.map((index) => ({
    index,
    suggestion: suggestions[index],
  }));
  if (!selections.length && input.saveReply && message.content.trim().length >= 10) {
    selections.push({
      index: -1,
      suggestion: {
        title: fallbackReplyTitle(message.content),
        coreInsight: message.content.trim().slice(0, 20_000),
        applicableScenarios: ["项目内容策划"],
        excludedScenarios: [],
        tags: ["对话灵感"],
        confidence: 60,
        benchmarkIds: [],
      },
    });
  }
  if (!selections.length) throw new Error("没有可保存的灵感建议。");

  const created = [];
  for (const selection of selections) {
    const { index, suggestion } = selection;
    const suffix = index >= 0 ? String(index) : "reply";
    const canonicalKey = ("assistant_" + input.messageId.replaceAll("-", "") + "_" + suffix).slice(0, 160);
    const existing = await db.prepare(
      "SELECT id, version, status FROM project_inspiration_cards WHERE organization_id = ? AND project_id = ? AND canonical_key = ? AND source_type = 'project_assistant' AND source_id = ? ORDER BY version DESC LIMIT 1",
    ).bind(input.organizationId, input.projectId, canonicalKey, input.messageId).first<{ id: string; version: number; status: string }>();
    if (existing) {
      created.push({ ...existing, index, existing: true });
      continue;
    }

    const benchmarkIds = Array.from(new Set(suggestion.benchmarkIds)).slice(0, 30);
    const benchmarkRows = benchmarkIds.length ? await db.prepare(`
      SELECT library.id, COALESCE(v.title, v.source_url, '未命名对标内容') AS title,
        json_extract(analysis.report_json, '$.summary') AS summary
      FROM project_video_references refs
      INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
      INNER JOIN video_analyses analysis ON analysis.id = (
        SELECT latest.id FROM video_analyses latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1
      )
      WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
        AND library.id IN (${benchmarkIds.map(() => "?").join(", ")})
    `).bind(input.organizationId, input.projectId, ...benchmarkIds).all<{ id: string; title: string; summary: string | null }>() : { results: [] };
    const card = await createInspirationCardWithDb(db as unknown as InspirationCardDatabase, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      canonicalKey,
      title: suggestion.title,
      coreInsight: suggestion.coreInsight,
      applicableScenarios: suggestion.applicableScenarios,
      excludedScenarios: suggestion.excludedScenarios,
      evidence: benchmarkRows.results.map((benchmark) => ({
        sourceType: "benchmark",
        sourceId: benchmark.id,
        quote: String(benchmark.summary || benchmark.title).slice(0, 2000),
      })),
      sourceType: "project_assistant",
      sourceId: input.messageId,
      tags: suggestion.tags,
      confidence: suggestion.confidence,
    });
    const now = new Date().toISOString();
    const links: ProjectAssistantBoundStatement[] = [db.prepare(
      "INSERT INTO project_inspiration_card_sources (id, organization_id, project_id, card_id, conversation_id, message_id, memory_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    ).bind(crypto.randomUUID(), input.organizationId, input.projectId, card.id, message.conversation_id, input.messageId, now)];
    await db.batch(links);
    created.push({ id: card.id, version: card.version, status: card.status, index, existing: false });
  }
  return created;
}
