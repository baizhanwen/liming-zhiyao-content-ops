import {
  PROJECT_ASSISTANT_PROMPT_VERSION,
  parseProjectAssistantChatResponse,
} from "./project-assistant-contract.ts";
import type { ProjectAssistantInvocation } from "./project-assistant-model.ts";
import { readProjectAssistantBenchmarksWithDb } from "./project-assistant-benchmarks.ts";
import type { ProjectAssistantDatabase } from "./project-memory-events.ts";

type InvocationFunction = (input: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<ProjectAssistantInvocation>;

function parseArray(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoredSuggestions(value: unknown) {
  return parseArray(value).map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    return {
      ...row,
      benchmarkIds: Array.isArray(row.benchmarkIds)
        ? row.benchmarkIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
        : [],
    };
  });
}

function parseStoredCitations(value: unknown) {
  return parseArray(value).flatMap((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const benchmarkId = typeof row.benchmarkId === "string" ? row.benchmarkId.trim() : "";
    if (!benchmarkId) return [];
    return [{
      benchmarkId,
      quote: typeof row.quote === "string" && row.quote.trim() ? row.quote.trim() : null,
    }];
  });
}

function clip(value: string, maximum: number) {
  return value.trim().slice(0, maximum);
}

export function questionRequestsProjectAssistantRecommendations(question: string) {
  return /(选题|标题|角度|系列|推荐|建议|策划|创意|方向|灵感|topic|title|angle|series|recommend)/i.test(question);
}

function chatSystemPrompt() {
  return [
    "你是当前企业空间专属的独立内容项目助理。",
    "唯一可调用的知识来源是输入中的 benchmarkLibrary：它只包含当前企业空间已启用且完成分析的对标内容。禁止读取、推断或引用项目记忆、其他企业空间数据或来源外客户事实。",
    "对标内容只用于提炼选题机会、表达方法、结构、钩子和受众反应，不得把对标作者的经历、成绩、数据或身份写成当前企业空间自身事实。",
    "如果 benchmarkLibrary 为空，必须明确说明当前企业空间暂无可用对标内容，再根据用户问题给出通用但可执行的初始建议，禁止虚构客户事实。",
    "你可以做选题推荐、标题延展、角度发散、系列规划，以及基于当前对标内容和本对话历史的连续追问。",
    "回答需具体说明借鉴了哪些对标方法，并在 citations 中引用确实使用过的 benchmarkId；没有使用对标内容时 citations 返回空数组。",
    "当输入中的 requiresRecommendations 为 true 时，必须输出 1 到 6 张可保存的灵感建议；否则可以输出 0 到 6 张。灵感是启发，不是客户事实。",
    "recommendations 中的 confidence 必须返回 0 到 100 的整数，例如 82；禁止返回 0 到 1 的小数比例。每张建议只关联确实采用过的 benchmarkIds。",
    "只返回 JSON：{reply,citations:[{benchmarkId,quote}],recommendations:[{title,coreInsight,applicableScenarios,excludedScenarios,tags,confidence,benchmarkIds}]}。",
  ].join("\n");
}

export async function createProjectAssistantConversationWithDb(
  db: ProjectAssistantDatabase,
  input: {
    organizationId: string;
    projectId: string;
    userId: string;
    title?: string;
  },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = clip(input.title || "新的灵感对话", 160) || "新的灵感对话";
  await db.prepare(
    "INSERT INTO project_assistant_conversations (id, organization_id, project_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
  ).bind(id, input.organizationId, input.projectId, title, input.userId, now, now).run();
  return { id, title, status: "active" as const, createdAt: now, updatedAt: now };
}

export async function listProjectAssistantConversationsWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string },
) {
  const rows = await db.prepare(
    "SELECT c.id, c.title, c.status, c.created_at, c.updated_at, (SELECT content FROM project_assistant_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message, (SELECT COUNT(*) FROM project_assistant_messages m WHERE m.conversation_id = c.id) AS message_count FROM project_assistant_conversations c WHERE c.organization_id = ? AND c.project_id = ? AND c.status = 'active' ORDER BY c.updated_at DESC LIMIT 100",
  ).bind(input.organizationId, input.projectId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    lastMessage: row.last_message ? String(row.last_message).slice(0, 180) : null,
    messageCount: Number(row.message_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function readProjectAssistantMessagesWithDb(
  db: ProjectAssistantDatabase,
  input: { organizationId: string; projectId: string; conversationId: string },
) {
  const conversation = await db.prepare(
    "SELECT id, title, status, created_at, updated_at FROM project_assistant_conversations WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1",
  ).bind(input.conversationId, input.organizationId, input.projectId).first<Record<string, unknown>>();
  if (!conversation) return null;
  const rows = await db.prepare(
    "SELECT id, role, status, content, suggestions_json, citations_json, model_provider, model_name, prompt_version, error_code, created_at FROM project_assistant_messages WHERE conversation_id = ? AND organization_id = ? AND project_id = ? ORDER BY created_at ASC LIMIT 300",
  ).bind(input.conversationId, input.organizationId, input.projectId).all<Record<string, unknown>>();
  return {
    conversation: {
      id: String(conversation.id),
      title: String(conversation.title),
      status: String(conversation.status),
      createdAt: String(conversation.created_at),
      updatedAt: String(conversation.updated_at),
    },
    messages: rows.results.map((row) => ({
      id: String(row.id),
      role: String(row.role),
      status: String(row.status),
      content: String(row.content),
      suggestions: parseStoredSuggestions(row.suggestions_json),
      citations: parseStoredCitations(row.citations_json),
      provider: row.model_provider ? String(row.model_provider) : null,
      model: row.model_name ? String(row.model_name) : null,
      promptVersion: row.prompt_version ? String(row.prompt_version) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
      createdAt: String(row.created_at),
    })),
  };
}

export async function runProjectAssistantConversationWithDb(
  db: ProjectAssistantDatabase,
  input: {
    organizationId: string;
    projectId: string;
    conversationId: string;
    userId: string;
    question: string;
    invoke: InvocationFunction;
  },
) {
  const question = clip(input.question, 12_000);
  if (question.length < 2) throw new Error("请输入至少 2 个字符的问题。");
  const conversation = await db.prepare(
    "SELECT id, title FROM project_assistant_conversations WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active' LIMIT 1",
  ).bind(input.conversationId, input.organizationId, input.projectId).first<{ id: string; title: string }>();
  if (!conversation) throw new Error("项目助理会话不存在或不属于当前项目。");

  const now = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO project_assistant_messages (id, organization_id, project_id, conversation_id, role, status, content, suggestions_json, citations_json, memory_operations_json, created_by, created_at) VALUES (?, ?, ?, ?, 'user', 'completed', ?, '[]', '[]', '[]', ?, ?)",
  ).bind(userMessageId, input.organizationId, input.projectId, input.conversationId, question, input.userId, now).run();

  const [benchmarks, history] = await Promise.all([
    readProjectAssistantBenchmarksWithDb(db, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      query: question,
      limit: 10,
      maxCharacters: 40_000,
    }),
    db.prepare(
      "SELECT role, content FROM project_assistant_messages WHERE conversation_id = ? AND organization_id = ? AND project_id = ? AND id != ? ORDER BY created_at DESC LIMIT 24",
    ).bind(input.conversationId, input.organizationId, input.projectId, userMessageId).all<{ role: string; content: string }>(),
  ]);

  const requiresRecommendations = questionRequestsProjectAssistantRecommendations(question);
  const modelContext = {
    project: { organizationId: input.organizationId, projectId: input.projectId },
    benchmarkLibrary: benchmarks,
    benchmarkContext: { available: benchmarks.length > 0, readyCount: benchmarks.length },
    recentConversation: history.results.reverse(),
    question,
    requiresRecommendations,
  };
  let invocation: ProjectAssistantInvocation;
  try {
    invocation = await input.invoke({
      system: chatSystemPrompt(),
      user: JSON.stringify(modelContext),
      temperature: 0.55,
      maxTokens: 10_000,
      timeoutMs: 90_000,
    });
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "PROJECT_ASSISTANT_CHAT_FAILED";
    const message = error instanceof Error ? error.message : "独立项目助理模型调用失败。";
    await db.prepare(
      "INSERT INTO project_assistant_messages (id, organization_id, project_id, conversation_id, role, status, content, suggestions_json, citations_json, memory_operations_json, error_code, created_by, created_at) VALUES (?, ?, ?, ?, 'assistant', 'failed', ?, '[]', '[]', '[]', ?, ?, ?)",
    ).bind(crypto.randomUUID(), input.organizationId, input.projectId, input.conversationId, message.slice(0, 2000), errorCode.slice(0, 100), input.userId, new Date().toISOString()).run();
    await db.prepare(
      "UPDATE project_assistant_conversations SET updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?",
    ).bind(new Date().toISOString(), input.conversationId, input.organizationId, input.projectId).run();
    throw error;
  }

  let parsed = parseProjectAssistantChatResponse(invocation.content);
  if (requiresRecommendations && parsed.recommendations.length === 0) {
    try {
      const repairedInvocation = await input.invoke({
        system: chatSystemPrompt() + "\n这是一次受控输出修复：上一版没有 recommendations。保留有用内容，但必须补出 1 到 6 张结构完整、可保存的灵感建议。",
        user: JSON.stringify({
          ...modelContext,
          repair: {
            reason: "recommendations_empty",
            previousReply: parsed.reply,
            requiredRecommendationCount: "1-6",
          },
        }),
        temperature: 0.35,
        maxTokens: 10_000,
        timeoutMs: 90_000,
      });
      const repaired = parseProjectAssistantChatResponse(repairedInvocation.content);
      if (repaired.recommendations.length > 0) {
        invocation = repairedInvocation;
        parsed = repaired;
      }
    } catch {
      // The first reply remains usable and can still be saved as one fallback card.
    }
  }
  const benchmarkById = new Map(benchmarks.map((benchmark) => [benchmark.id, benchmark]));
  const citations = parsed.citations.filter((citation) => benchmarkById.has(citation.benchmarkId)).map((citation) => ({
    ...citation,
    quote: citation.quote || benchmarkById.get(citation.benchmarkId)?.summary.slice(0, 500) || null,
  }));
  const recommendations = parsed.recommendations.map((recommendation) => ({
    ...recommendation,
    benchmarkIds: recommendation.benchmarkIds.filter((benchmarkId) => benchmarkById.has(benchmarkId)),
  }));
  const assistantMessageId = crypto.randomUUID();
  const completedAt = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT INTO project_assistant_messages (id, organization_id, project_id, conversation_id, role, status, content, suggestions_json, citations_json, memory_operations_json, model_provider, model_name, prompt_version, created_by, created_at) VALUES (?, ?, ?, ?, 'assistant', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      assistantMessageId,
      input.organizationId,
      input.projectId,
      input.conversationId,
      parsed.reply,
      JSON.stringify(recommendations),
      JSON.stringify(citations),
      "[]",
      invocation.provider,
      invocation.model,
      PROJECT_ASSISTANT_PROMPT_VERSION,
      input.userId,
      completedAt,
    ),
    db.prepare(
      "UPDATE project_assistant_conversations SET title = CASE WHEN title = '新的灵感对话' THEN ? ELSE title END, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?",
    ).bind(question.slice(0, 36), completedAt, input.conversationId, input.organizationId, input.projectId),
  ]);

  return {
    userMessageId,
    assistantMessage: {
      id: assistantMessageId,
      role: "assistant" as const,
      status: "completed" as const,
      content: parsed.reply,
      suggestions: recommendations,
      citations,
      provider: invocation.provider,
      model: invocation.model,
      promptVersion: PROJECT_ASSISTANT_PROMPT_VERSION,
      errorCode: null,
      createdAt: completedAt,
    },
    knowledgeSource: "benchmark_library" as const,
  };
}
