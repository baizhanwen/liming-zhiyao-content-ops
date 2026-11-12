"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError, formatClientDate as dateLabel } from "../lib/client-format";


import { FormEvent, useCallback, useMemo, useState } from "react";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import "./creation-cleanup.css";
import type { CoreContentStrategy } from "../lib/content-strategy-policy";
import { Archive, BookmarkCheck, BookmarkPlus, Check, ChevronRight, Clock3, History, MessageSquarePlus, PencilLine, RefreshCw, Save, Send, Sparkles, X } from "lucide-react";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type AssistantConfiguration = {
  configured: boolean;
  missing: string[];
  provider: string | null;
  model: string | null;
  isolation: "independent";
  implicitFallback: false;
};
type BenchmarkStatus = { available: boolean; activeCount: number; readyCount: number };
type Conversation = {
  id: string;
  title: string;
  status: string;
  lastMessage: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};
type Citation = { benchmarkId: string; quote: string | null };
type Suggestion = {
  memoryIds?: string[];
  title: string;
  coreInsight: string;
  applicableScenarios: string[];
  excludedScenarios: string[];
  tags: string[];
  confidence: number;
  benchmarkIds: string[];
};
type Message = {
  id: string;
  role: "user" | "assistant";
  status: string;
  content: string;
  suggestions: Suggestion[];
  citations: Citation[];
  memoryCitations?: Array<{ memoryId: string; title: string; quote: string }>;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  errorCode: string | null;
  createdAt: string;
};
type InspirationCard = {
  id: string;
  canonical_key: string;
  version: number;
  status: string;
  title: string;
  core_insight: string;
  applicable_scenarios: string[];
  excluded_scenarios: string[];
  evidence: Array<{ sourceType: string; sourceId: string; quote?: string | null }>;
  source_type: string;
  source_id: string | null;
  source_trace: Array<{ conversationId: string | null; messageId: string | null; memoryItemId: string | null }>;
  tags: string[];
  confidence: number | null;
  updated_at: string;
  created_at: string;
};

const statusLabels: Record<string, string> = { candidate: "待确认", confirmed: "已确认", rejected: "已拒绝", superseded: "历史版本", archived: "已归档" };
const sourceLabels: Record<string, string> = {
  manual: "人工整理",
  project_assistant: "项目助理对话",
  video_atom: "视频知识原子",
  analysis: "视频分析",
  knowledge: "品牌知识",
  project_memory: "项目记忆",
  benchmark: "对标内容",
  client_feedback: "客户反馈",
};
const quickPrompts = [
  "根据当前企业空间的对标内容库，推荐 5 个最值得做的选题，并说明借鉴了哪些方法。",
  "从对标内容中提炼可复用结构，延展成一个 6 期系列，每期给出角度和承接关系。",
  "根据对标内容里的钩子和受众痛点，给我 10 个不套路的标题方向。",
  "从当前对标内容库里找出还没被充分利用的内容机会，并提出追问。",
];





export function InspirationWorkspace({ initialOrganizationId = "", initialProjectId = "", initialConversationId = "" }: { initialOrganizationId?: string; initialProjectId?: string; initialConversationId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [configuration, setConfiguration] = useState<AssistantConfiguration | null>(null);
  const [coreStrategy, setCoreStrategy] = useState<CoreContentStrategy | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);
  const [benchmarkStatus, setBenchmarkStatus] = useState<BenchmarkStatus>({ available: false, activeCount: 0, readyCount: 0 });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<InspirationCard[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [question, setQuestion] = useState("");
  const [editing, setEditing] = useState<InspirationCard | null>(null);
  const [history, setHistory] = useState<InspirationCard[] | null>(null);
  const [savedSuggestions, setSavedSuggestions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionKey, setActionKey] = useState("");
  const [cardView, setCardView] = useState<"active" | "history">("active");
  const [error, setError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  const scopeQuery = useCallback((orgId: string, projId: string) => (
    "organizationId=" + encodeURIComponent(orgId) + "&projectId=" + encodeURIComponent(projId)
  ), []);

  const loadConversation = useCallback(async (orgId: string, projId: string, id: string) => {
    if (!id) {
      setMessages([]);
      return;
    }
    const response = await scopedFetch(
      "/api/project-assistant/conversations/" + encodeURIComponent(id) + "?" + scopeQuery(orgId, projId),
    );
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { messages: Message[] };
    setMessages(body.messages);
  }, [scopeQuery]);

  const loadWorkspace = useCallback(async (orgId: string, projId: string, preferredConversation = "") => {
    if (!orgId || !projId) {
      setCards([]);
      setConversations([]);
      setMessages([]);
      setBenchmarkStatus({ available: false, activeCount: 0, readyCount: 0 });
      return;
    }
    const query = scopeQuery(orgId, projId);
    const [cardsResponse, conversationsResponse, statusResponse] = await Promise.all([
      scopedFetch("/api/inspiration-cards?" + query),
      scopedFetch("/api/project-assistant/conversations?" + query),
      scopedFetch("/api/project-assistant/status?" + query),
    ]);
    if (!cardsResponse.ok) throw new Error(await readError(cardsResponse));
    if (!conversationsResponse.ok) throw new Error(await readError(conversationsResponse));
    if (!statusResponse.ok) throw new Error(await readError(statusResponse));
    const cardsBody = await cardsResponse.json() as { cards: InspirationCard[]; canWrite: boolean; canManage: boolean };
    const conversationsBody = await conversationsResponse.json() as { conversations: Conversation[]; benchmarks: BenchmarkStatus; canWrite: boolean };
    const statusBody = await statusResponse.json() as { configuration: AssistantConfiguration; coreStrategy: CoreContentStrategy | null; memoryStatus?: { confirmedCount: number } };
    setCards(cardsBody.cards);
    setCanWrite(cardsBody.canWrite && conversationsBody.canWrite);
    setCanManage(cardsBody.canManage);
    setConfiguration(statusBody.configuration);
    setCoreStrategy(statusBody.coreStrategy ?? null);
    setMemoryCount(statusBody.memoryStatus?.confirmedCount ?? 0);
    setBenchmarkStatus(conversationsBody.benchmarks ?? { available: false, activeCount: 0, readyCount: 0 });
    setConversations(conversationsBody.conversations);
    setHistory(null);
    setEditing(null);
    const selected = conversationsBody.conversations.some((item) => item.id === preferredConversation)
      ? preferredConversation
      : conversationsBody.conversations[0]?.id || "";
    setConversationId(selected);
    await loadConversation(orgId, projId, selected);
  }, [loadConversation, scopeQuery]);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred);
    setProjects(body.projects);
    const selected = body.selected;
    setProjectId(selected);
    rememberCurrentScope(orgId, selected);
    await loadWorkspace(orgId, selected, initialConversationId);
  }, [loadWorkspace, initialConversationId]);

  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading });

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId) || null,
    [conversationId, conversations],
  );
  const activeCards = useMemo(() => cards.filter((card) => card.status === "candidate" || card.status === "confirmed"), [cards]);
  const historicalCards = useMemo(() => cards.filter((card) => card.status !== "candidate" && card.status !== "confirmed"), [cards]);
  const displayedCards = cardView === "active" ? activeCards : historicalCards;

  async function createConversation() {
    setError("");
    setActionKey("conversation:create");
    const response = await scopedFetch("/api/project-assistant/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, projectId, title: "新的灵感对话" }),
    });
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return "";
    }
    const body = await response.json() as { conversation: Conversation };
    const id = body.conversation.id;
    await loadWorkspace(organizationId, projectId, id);
    setActionKey("");
    return id;
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = question.trim();
    if (clean.length < 2 || sending) return;
    setSending(true);
    setError("");
    let targetId = conversationId;
    if (!targetId) targetId = await createConversation();
    if (!targetId) {
      setSending(false);
      return;
    }
    const response = await scopedFetch(
      "/api/project-assistant/conversations/" + encodeURIComponent(targetId) + "/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, question: clean }),
      },
    );
    if (!response.ok) {
      setError(await readError(response));
      await loadConversation(organizationId, projectId, targetId);
      setSending(false);
      return;
    }
    setQuestion("");
    await loadWorkspace(organizationId, projectId, targetId);
    setSending(false);
  }

  async function saveSuggestion(messageId: string, index: number) {
    const key = messageId + ":" + index;
    setSaving(true);
    setActionKey("suggestion:" + key);
    setError("");
    setSaveNotice("");
    const response = await scopedFetch(
      "/api/project-assistant/messages/" + encodeURIComponent(messageId) + "/cards",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, recommendationIndexes: [index] }),
      },
    );
    if (!response.ok) {
      setError(await readError(response));
      setSaving(false);
      setActionKey("");
      return;
    }
    setSavedSuggestions((current) => new Set([...current, key]));
    setSaveNotice("已保存为灵感卡，对标引用已随卡片保留。");
    await loadWorkspace(organizationId, projectId, conversationId);
    setSaving(false);
    setActionKey("");
  }

  async function saveReply(messageId: string) {
    const key = messageId + ":reply";
    setSaving(true);
    setActionKey("reply:" + messageId);
    setError("");
    setSaveNotice("");
    const response = await scopedFetch(
      "/api/project-assistant/messages/" + encodeURIComponent(messageId) + "/cards",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, recommendationIndexes: [], saveReply: true }),
      },
    );
    if (!response.ok) {
      setError(await readError(response));
      setSaving(false);
      setActionKey("");
      return;
    }
    setSavedSuggestions((current) => new Set([...current, key]));
    setSaveNotice("已保存为灵感卡，对标引用已随卡片保留。");
    await loadWorkspace(organizationId, projectId, conversationId);
    setSaving(false);
    setActionKey("");
  }

  async function transition(id: string, action: "confirm" | "reject") {
    setActionKey(action + ":" + id);
    setError("");
    const response = await scopedFetch("/api/inspiration-cards/" + encodeURIComponent(id) + "/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, projectId, action }),
    });
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    await loadWorkspace(organizationId, projectId, conversationId);
    setActionKey("");
  }

  async function archive(id: string) {
    if (!window.confirm("确认归档这张灵感卡片？来源对话和版本历史仍会保留。")) return;
    setActionKey("archive:" + id);
    setError("");
    const response = await scopedFetch(
      "/api/inspiration-cards/" + encodeURIComponent(id) + "?" + scopeQuery(organizationId, projectId),
      { method: "DELETE" },
    );
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    await loadWorkspace(organizationId, projectId, conversationId);
    setActionKey("");
  }

  async function showHistory(id: string) {
    setActionKey("history:" + id);
    setError("");
    const response = await scopedFetch(
      "/api/inspiration-cards/" + encodeURIComponent(id) + "?" + scopeQuery(organizationId, projectId),
    );
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    const body = await response.json() as { history: InspirationCard[] };
    setEditing(null);
    setHistory(body.history);
    setActionKey("");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setActionKey("edit:" + editing.id);
    const form = new FormData(event.currentTarget);
    const response = await scopedFetch(
      "/api/inspiration-cards/" + encodeURIComponent(editing.id) + "?" + scopeQuery(organizationId, projectId),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: String(form.get("title") || ""),
          coreInsight: String(form.get("coreInsight") || ""),
          applicableScenarios: String(form.get("applicableScenarios") || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
          excludedScenarios: String(form.get("excludedScenarios") || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
          sourceType: editing.source_type,
          sourceId: editing.source_id,
          evidence: editing.evidence,
          tags: String(form.get("tags") || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
          confidence: form.get("confidence") ? Number(form.get("confidence")) : null,
        }),
      },
    );
    if (!response.ok) {
      setError(await readError(response));
      setSaving(false);
      setActionKey("");
      return;
    }
    setEditing(null);
    await loadWorkspace(organizationId, projectId, conversationId);
    setSaving(false);
    setActionKey("");
  }

  if (loading) return <div className="management-state" role="status">正在载入项目灵感对话…</div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>每个企业空间拥有独立对标内容库、独立对话和独立灵感卡片。</p></div>;

  return <div className="knowledge-workspace inspiration-workspace assistant-inspiration-workspace creation-cleanup">
    <div className="management-toolbar knowledge-toolbar">
      <label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="inspiration-toolbar-actions">
        <button type="button" className="inspiration-button secondary" disabled={Boolean(actionKey)} onClick={async () => { setActionKey("workspace:refresh"); await loadWorkspace(organizationId, projectId, conversationId); setActionKey(""); }}>
          <RefreshCw aria-hidden="true" className={actionKey === "workspace:refresh" ? "is-spinning" : ""} />{actionKey === "workspace:refresh" ? "刷新中" : "刷新"}
        </button>
        <button type="button" className="inspiration-button primary" disabled={!canWrite || Boolean(actionKey)} onClick={() => void createConversation()}>
          <MessageSquarePlus aria-hidden="true" />{actionKey === "conversation:create" ? "创建中" : "新建对话"}
        </button>
      </div>
    </div>

    {error && <div className="inline-alert" role="alert">{error}</div>}
    {saveNotice && <div className="analysis-submit-notice" role="status">{saveNotice}</div>}
    {configuration && !configuration.configured && <div className="inline-alert warning-alert"><strong>独立项目助理 API 尚未配置</strong><span>缺少 {configuration.missing.join("、")}。对话按钮会保持不可用，系统不会调用其他模型代替。</span></div>}
    <details className="creation-context-summary">
      <summary><strong>可用参考</strong><span>策略{coreStrategy ? "已启用" : "未启用"} · 项目记忆 {memoryCount} 条 · 对标内容 {benchmarkStatus.readyCount} 条</span></summary>
      <div className="creation-context-body">
        <CoreStrategyPreview strategy={coreStrategy} />
        <section><h3>项目记忆</h3><p>从 {memoryCount} 条已采纳记忆中按问题选取；候选、停用和过期记忆不参与，仅用于灵感对话。</p></section>
        <section><h3>对标内容</h3><p>{benchmarkStatus.available ? "从已启用且完成分析的对标内容中寻找选题与方法，并结合核心策略检查适配度。" : benchmarkStatus.activeCount ? "对标内容尚未完成分析，完成后即可参与灵感生成。" : "当前企业空间暂无可用对标内容，可在视频分析页加入素材。"}</p></section>
        <p className="creation-hint">以上为可用资料，实际引用见每次回复。</p>
      </div>
    </details>

    <div className="assistant-chat-layout">
      <aside className="panel conversation-sidebar">
        <div className="panel-heading"><div><p className="section-kicker">按项目永久保存</p><h2>对话历史</h2></div></div>
        {conversations.length ? <div className="conversation-list">{conversations.map((conversation) => <button type="button" key={conversation.id} className={conversation.id === conversationId ? "active" : ""} onClick={async () => { setConversationId(conversation.id); await loadConversation(organizationId, projectId, conversation.id); }}>
          <strong>{conversation.title}</strong>
          <span>{conversation.lastMessage || "还没有消息"}</span>
          <small>{conversation.messageCount} 条 · {dateLabel(conversation.updatedAt)}</small>
        </button>)}</div> : <div className="list-empty"><strong>还没有对话</strong><p>从右侧直接提出你的第一个问题。</p></div>}
        <div className="assistant-model-badge"><span>独立模型</span><strong>{configuration?.model || "未配置"}</strong><small>无内容模型/分析模型回退</small></div>
      </aside>

      <section className="panel assistant-thread-panel">
        <div className="panel-heading"><div><p className="section-kicker">生成的建议可手动保存为灵感卡片</p><h2>{activeConversation?.title || "和项目助理聊选题与创意"}</h2></div><span>可连续追问 · 刷新后保留</span></div>
        <div className="assistant-thread">
          {messages.length ? messages.map((message) => <article key={message.id} className={"assistant-message " + message.role + (message.status === "failed" ? " failed" : "")}>
            <header><strong>{message.role === "user" ? "你" : "项目助理"}</strong><small>{dateLabel(message.createdAt)}{message.model ? " · " + message.model : ""}</small></header>
            <p>{message.content}</p>
            {message.citations.length ? <div className="assistant-citations"><span>引用对标内容</span>{message.citations.map((citation) => <small key={citation.benchmarkId} title={citation.quote || ""}>{citation.benchmarkId.slice(0, 8)}{citation.quote ? " · " + citation.quote.slice(0, 40) : ""}</small>)}</div> : null}
            {(message.memoryCitations || []).length > 0 && <details className="assistant-citations"><summary>引用项目记忆（{message.memoryCitations!.length} 条）</summary>{message.memoryCitations!.map(citation => <p key={citation.memoryId}><strong>{citation.title}</strong><br />{citation.quote}</p>)}</details>}
            {message.suggestions.length ? <div className="assistant-suggestion-grid">{message.suggestions.map((suggestion, index) => {
              const key = message.id + ":" + index;
              const saved = savedSuggestions.has(key) || cards.some((card) => card.source_id === message.id && card.title === suggestion.title);
              return <section key={key} className="assistant-suggestion-card">
                <div><span>灵感建议 {index + 1}</span><em>可信度 {suggestion.confidence}</em></div>
                <h3>{suggestion.title}</h3>
                <p>{suggestion.coreInsight}</p>
                <div className="plain-chips">{suggestion.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                <small>关联 {suggestion.benchmarkIds.length} 条对标内容 · {suggestion.memoryIds?.length || 0} 条项目记忆</small>
                <button type="button" className={"inspiration-button suggestion-save" + (saved ? " completed" : "")} disabled={!canWrite || saving || saved} onClick={() => void saveSuggestion(message.id, index)}>
                  {saved ? <BookmarkCheck aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}
                  {saved ? "已保存" : actionKey === "suggestion:" + key ? "保存中" : "保存为灵感卡"}
                </button>
              </section>;
            })}</div> : message.role === "assistant" && message.status === "completed" ? <div className="assistant-reply-fallback">
              <span>本次回复没有拆成独立建议卡，但正文仍可保留为一张灵感卡片。</span>
              <button type="button" className="inspiration-button secondary" disabled={!canWrite || saving || savedSuggestions.has(message.id + ":reply") || cards.some((card) => card.source_id === message.id && card.canonical_key.endsWith("_reply"))} onClick={() => void saveReply(message.id)}>
                <BookmarkPlus aria-hidden="true" />
                {savedSuggestions.has(message.id + ":reply") || cards.some((card) => card.source_id === message.id && card.canonical_key.endsWith("_reply")) ? "整段回复已保存" : actionKey === "reply:" + message.id ? "保存中" : "保存整段回复"}
              </button>
            </div> : null}
            {message.status === "failed" && <small className="message-error-code">{message.errorCode || "PROJECT_ASSISTANT_FAILED"}</small>}
          </article>) : <div className="assistant-thread-empty"><Sparkles className="assistant-empty-icon" aria-hidden="true" /><strong>我会结合对标内容与已采纳记忆，再给你建议</strong><p>可以问选题、标题、角度、系列规划，也可以基于对标视频的方法继续追问。</p><div>{quickPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}><span>{prompt}</span><ChevronRight aria-hidden="true" /></button>)}</div></div>}
        </div>
        <form className="assistant-composer" onSubmit={sendMessage}>
          {messages.length > 0 && <div className="assistant-quick-prompts">{quickPrompts.slice(0, 3).map((prompt, index) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{["推荐选题", "规划系列", "延展标题"][index]}</button>)}</div>}
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={4} maxLength={12000} placeholder="例如：根据当前企业空间的对标内容，接下来最值得做哪些选题？" />
          <div><small>{configuration?.configured ? "将调用独立项目助理模型，并保存本次对话与对标引用。" : "配置独立项目助理 API 后才能发送。"}</small><button className="inspiration-button primary send-button" disabled={!canWrite || !configuration?.configured || sending || question.trim().length < 2}><Send aria-hidden="true" />{sending ? "生成建议中" : "发送问题"}</button></div>
        </form>
      </section>
    </div>

    <section className="panel inspiration-library-panel">
      <div className="panel-heading inspiration-library-heading"><div><p className="section-kicker">对话沉淀 · 来源可追溯</p><h2>{cardView === "active" ? activeCards.filter((card) => card.status === "confirmed").length + " 张已确认 · " + activeCards.filter((card) => card.status === "candidate").length + " 张待确认" : historicalCards.length + " 张历史卡片"}</h2></div><div className="inspiration-library-tabs" role="group" aria-label="灵感卡片状态筛选"><button type="button" className={cardView === "active" ? "active" : ""} onClick={() => setCardView("active")}>有效卡片 <span>{activeCards.length}</span></button><button type="button" className={cardView === "history" ? "active" : ""} onClick={() => setCardView("history")}>历史卡片 <span>{historicalCards.length}</span></button></div></div>
      {displayedCards.length ? <div className={"inspiration-card-grid " + (cardView === "history" ? "history-view" : "active-view")}>{displayedCards.map((card) => {
        const linkedBenchmarks = new Set(card.evidence.filter((item) => item.sourceType === "benchmark").map((item) => item.sourceId)).size;
        const tracedConversation = card.source_trace.some((trace) => trace.conversationId);
        return <article key={card.id} className={"inspiration-library-card status-" + card.status}>
          <div className="knowledge-card-head"><span>灵感卡片 · v{card.version}</span><em className={"status " + (card.status === "confirmed" ? "success" : card.status === "archived" || card.status === "rejected" ? "danger" : "neutral")}>{statusLabels[card.status] || card.status}</em></div>
          <h3>{card.title}</h3><p>{card.core_insight}</p>
          <div className="plain-chips">{card.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          <small>来源：{sourceLabels[card.source_type] || card.source_type}{tracedConversation ? " · 可回到原对话" : ""}{linkedBenchmarks ? " · 关联 " + linkedBenchmarks + " 条对标内容" : ""} · {dateLabel(card.updated_at)}</small>
          <footer>
            {card.applicable_scenarios.length ? <div className="inspiration-card-scope"><span>适用场景</span><p>{card.applicable_scenarios.join("、")}</p></div> : null}
            <div className="inspiration-card-actions">
              {card.status === "candidate" && canWrite && <div className="inspiration-decision-actions">
                <button type="button" className="inspiration-button confirm" disabled={Boolean(actionKey)} onClick={() => void transition(card.id, "confirm")}><Check aria-hidden="true" />{actionKey === "confirm:" + card.id ? "采纳中" : "采纳"}</button>
                <button type="button" className="inspiration-button reject" disabled={Boolean(actionKey)} onClick={() => void transition(card.id, "reject")}><X aria-hidden="true" />{actionKey === "reject:" + card.id ? "处理中" : "拒绝"}</button>
              </div>}
              <div className="inspiration-management-actions">
                {canManage && (card.status === "candidate" || card.status === "confirmed") && <button type="button" className="inspiration-button ghost" onClick={() => { setHistory(null); setEditing(card); }}><PencilLine aria-hidden="true" />编辑</button>}
                <button type="button" className="inspiration-button ghost" disabled={Boolean(actionKey)} onClick={() => void showHistory(card.id)}><History aria-hidden="true" />{actionKey === "history:" + card.id ? "读取中" : "历史"}</button>
                {canManage && (card.status === "candidate" || card.status === "confirmed") && <button type="button" className="inspiration-button danger-ghost" disabled={Boolean(actionKey)} onClick={() => void archive(card.id)}><Archive aria-hidden="true" />{actionKey === "archive:" + card.id ? "归档中" : "归档"}</button>}
              </div>
            </div>
          </footer>
        </article>;
      })}</div> : <div className="list-empty"><strong>{cardView === "active" ? "还没有有效灵感卡片" : "还没有历史卡片"}</strong><p>{cardView === "active" ? "让项目助理给出建议后，可一键把建议保存到这里。" : "被拒绝或归档的灵感卡片会集中显示在这里。"}</p></div>}
    </section>

    {editing && <div className="inspiration-modal-backdrop" role="presentation">
      <form className="stack-form inspiration-modal" onSubmit={saveEdit} role="dialog" aria-modal="true" aria-labelledby="inspiration-edit-title">
        <div className="inspiration-modal-heading"><div><p className="section-kicker">保存后生成新版本</p><h2 id="inspiration-edit-title">编辑灵感卡片</h2><span>{editing.title}</span></div><button type="button" className="inspiration-icon-button" aria-label="关闭编辑" onClick={() => setEditing(null)}><X aria-hidden="true" /></button></div>
        <label>标题<input name="title" defaultValue={editing.title} required minLength={2} maxLength={160} /></label>
        <label>核心启发<textarea name="coreInsight" defaultValue={editing.core_insight} required minLength={10} maxLength={20000} rows={5} /></label>
        <div className="form-row"><label>适用场景<textarea name="applicableScenarios" defaultValue={editing.applicable_scenarios.join("，")} rows={3} /></label><label>不适用场景<textarea name="excludedScenarios" defaultValue={editing.excluded_scenarios.join("，")} rows={3} /></label></div>
        <div className="form-row"><label>标签<input name="tags" defaultValue={editing.tags.join("，")} /></label><label>可信度<input name="confidence" type="number" min="0" max="100" defaultValue={editing.confidence ?? ""} /></label></div>
        <div className="inspiration-modal-actions"><button type="button" className="inspiration-button secondary" onClick={() => setEditing(null)}>取消</button><button className="inspiration-button primary" disabled={saving}><Save aria-hidden="true" />{saving ? "保存中" : "保存新版本"}</button></div>
      </form>
    </div>}

    {history && <div className="inspiration-modal-backdrop" role="presentation">
      <section className="inspiration-modal inspiration-history-modal" role="dialog" aria-modal="true" aria-labelledby="inspiration-history-title">
        <div className="inspiration-modal-heading"><div><p className="section-kicker">来源和改动完整保留</p><h2 id="inspiration-history-title">灵感版本历史</h2></div><button type="button" className="inspiration-icon-button" aria-label="关闭历史记录" onClick={() => setHistory(null)}><X aria-hidden="true" /></button></div>
        <div className="inspiration-history-list">{history.map((card) => <article key={card.id}><div><strong>v{card.version}</strong><span>{statusLabels[card.status] || card.status}</span></div><h3>{card.title}</h3><p>{card.core_insight}</p><small><Clock3 aria-hidden="true" />{sourceLabels[card.source_type] || card.source_type} · {dateLabel(card.updated_at)}</small></article>)}</div>
      </section>
    </div>}
  </div>;
}
