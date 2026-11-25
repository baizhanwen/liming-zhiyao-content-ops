"use client";
import { SplitWorkspace } from "./SplitWorkspace";
import { StudioIdeaLibrary } from "./StudioIdeaLibrary";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError, formatClientDate as dateLabel } from "../lib/client-format";


import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isScopeCancellation } from "../lib/client-scope-request";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import "./creation-cleanup.css";
import type { CoreContentStrategy } from "../lib/content-strategy-policy";
import { Archive, BookmarkCheck, BookmarkPlus, Check, ChevronDown, ChevronRight, Clock3, History, MessageSquarePlus, PencilLine, RefreshCw, Save, Send, Sparkles, X } from "lucide-react";
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
  topic_id?: string | null;
  is_convertible?: boolean;
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
  { label: "推荐 5 个选题", prompt: "根据当前企业空间的对标内容库，推荐 5 个最值得做的选题，并说明借鉴了哪些方法。" },
  { label: "规划 6 期系列", prompt: "从对标内容中提炼可复用结构，延展成一个 6 期系列，每期给出角度和承接关系。" },
  { label: "想 10 个标题", prompt: "根据对标内容里的钩子和受众痛点，给我 10 个不套路的标题方向。" },
  { label: "发掘新角度", prompt: "从当前对标内容库里找出还没被充分利用的内容机会，并提出追问。" },
];

export function InspirationWorkspace({ initialOrganizationId = "", initialProjectId = "", initialConversationId = "", initialCardId = "", initialTopicId = "" }: { initialOrganizationId?: string; initialProjectId?: string; initialConversationId?: string; initialCardId?: string; initialTopicId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [configuration, setConfiguration] = useState<AssistantConfiguration | null>(null);
  const [coreStrategy, setCoreStrategy] = useState<CoreContentStrategy | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);
  const [benchmarkStatus, setBenchmarkStatus] = useState<BenchmarkStatus>({ available: false, activeCount: 0, readyCount: 0 });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const thread = useRef<HTMLDivElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const activeThread = useRef("");
  const questionDrafts = useRef(new Map<string, string>());
  const readNumber = useRef(0);
  const spaceEpoch = useRef(0);
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (lastMessageId && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [conversationId, lastMessageId]);
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
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [error, setError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  const scopeQuery = useCallback((orgId: string, projId: string) => (
    "organizationId=" + encodeURIComponent(orgId) + "&projectId=" + encodeURIComponent(projId)
  ), []);

  const loadConversation = useCallback(async (orgId: string, projId: string, id: string) => {
    const currentRead = ++readNumber.current;
    if (activeThread.current !== id) setMessages([]);
    activeThread.current = id;
    setConversationId(id);
    if (!id) return;
    try {
      const response = await scopedFetch(
        "/api/project-assistant/conversations/" + encodeURIComponent(id) + "?" + scopeQuery(orgId, projId),
      );
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { messages: Message[] };
      if (currentRead === readNumber.current) setMessages(body.messages);
    } catch (reason) {
      if (currentRead === readNumber.current && !isScopeCancellation(reason)) throw reason;
    }
  }, [scopeQuery]);

  const loadWorkspace = useCallback(async (orgId: string, projId: string, preferredConversation = "") => {
    if (!orgId || !projId) {
      setCards([]);
      setConversations([]);
      setMessages([]);
      setBenchmarkStatus({ available: false, activeCount: 0, readyCount: 0 });
      return;
    }
    const epoch = spaceEpoch.current;
    const previousRead = readNumber.current;
    const query = scopeQuery(orgId, projId);
    const [cardsResponse, conversationsResponse, statusResponse] = await Promise.all([
      scopedFetch("/api/inspiration-cards?" + query + (initialCardId ? "&cardId=" + encodeURIComponent(initialCardId) : "")),
      scopedFetch("/api/project-assistant/conversations?" + query),
      scopedFetch("/api/project-assistant/status?" + query),
    ]);
    if (!cardsResponse.ok) throw new Error(await readError(cardsResponse));
    if (!conversationsResponse.ok) throw new Error(await readError(conversationsResponse));
    if (!statusResponse.ok) throw new Error(await readError(statusResponse));
    const cardsBody = await cardsResponse.json() as { cards: InspirationCard[]; canWrite: boolean; canManage: boolean };
    const conversationsBody = await conversationsResponse.json() as { conversations: Conversation[]; benchmarks: BenchmarkStatus; canWrite: boolean };
    const statusBody = await statusResponse.json() as { configuration: AssistantConfiguration; coreStrategy: CoreContentStrategy | null; memoryStatus?: { confirmedCount: number } };
    if (epoch !== spaceEpoch.current) return;
    setCards(cardsBody.cards);
    setLibraryRevision(n => n + 1);
    setCanWrite(cardsBody.canWrite && conversationsBody.canWrite);
    setCanManage(cardsBody.canManage);
    setConfiguration(statusBody.configuration);
    setCoreStrategy(statusBody.coreStrategy ?? null);
    setMemoryCount(statusBody.memoryStatus?.confirmedCount ?? 0);
    setBenchmarkStatus(conversationsBody.benchmarks ?? { available: false, activeCount: 0, readyCount: 0 });
    setConversations(conversationsBody.conversations);
    setHistory(null);
    setEditing(null);
    if (previousRead !== readNumber.current) return;
    const requested = activeThread.current || preferredConversation;
    const selected = conversationsBody.conversations.some((item) => item.id === requested)
      ? requested
      : conversationsBody.conversations[0]?.id || "";
    await loadConversation(orgId, projId, selected);
  }, [loadConversation, scopeQuery, initialCardId, setHistory, setEditing]);

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
  function selectPrompt(prompt: string) {
    setQuestion(prompt);
    questionInput.current?.focus();
  }

  function openConversation(id: string) {
    setHistoryExpanded(false);
    if (id !== activeThread.current) {
      questionDrafts.current.set(activeThread.current, question);
      setQuestion(questionDrafts.current.get(id) || "");
    }
    setError("");
    void runScopedAction(() => loadConversation(organizationId, projectId, id), setError);
  }

  async function switchWorkspace(change: () => Promise<void>) {
    const epoch = ++spaceEpoch.current;
    ++readNumber.current;
    activeThread.current = "";
    questionDrafts.current.clear();
    setConversationId(""); setSending(false); setActionKey("");
    setLoading(true);
    setMessages([]); setCards([]); setConversations([]);
    setCanWrite(false); setCanManage(false);
    setSaveNotice(""); setError(""); setQuestion("");
    setSavedSuggestions(new Set());
    setHistoryExpanded(false);
    setEditing(null); setHistory(null);
    try { await change(); } finally { if (spaceEpoch.current === epoch) setLoading(false); }
  }

  async function createConversation(keepQuestion = false) {
    const epoch = spaceEpoch.current;
    const previousRead = readNumber.current;
    setError("");
    setActionKey("conversation:create");
    try {
      const response = await scopedFetch("/api/project-assistant/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, title: "新的灵感对话" }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const { conversation } = await response.json() as { conversation: Conversation };
      if (epoch !== spaceEpoch.current) return "";
      setConversations(items => [{ ...conversation, lastMessage: null, messageCount: 0 }, ...items]);
      if (previousRead !== readNumber.current) return "";
      ++readNumber.current;
      if (!keepQuestion) {
        questionDrafts.current.set(activeThread.current, question);
        setQuestion("");
      }
      activeThread.current = conversation.id;
      setConversationId(conversation.id);
      setMessages([]);
      return conversation.id;
    } catch (reason) {
      if (epoch === spaceEpoch.current && previousRead === readNumber.current && !isScopeCancellation(reason))
        setError(reason instanceof Error ? reason.message : "暂时无法新建对话。");
      return "";
    } finally {
      if (epoch === spaceEpoch.current) setActionKey(key => key === "conversation:create" ? "" : key);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = question.trim();
    if (clean.length < 2 || sending || actionKey === "conversation:create" || !canWrite || !configuration?.configured) return;
    const epoch = spaceEpoch.current;
    let targetId = activeThread.current;
    const stillReading = () => epoch === spaceEpoch.current && targetId === activeThread.current;
    setSending(true);
    setError("");
    try {
      if (!targetId) targetId = await createConversation(true);
      if (!targetId || !stillReading()) return;
      const response = await scopedFetch(
        "/api/project-assistant/conversations/" + encodeURIComponent(targetId) + "/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, projectId, question: clean }),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      if (epoch === spaceEpoch.current && questionDrafts.current.get(targetId)?.trim() === clean) {
        questionDrafts.current.delete(targetId);
      }
      if (!stillReading()) return;
      setQuestion(current => current.trim() === clean ? "" : current);
      await loadWorkspace(organizationId, projectId, targetId);
    } catch (reason) {
      if (stillReading() && !isScopeCancellation(reason)) {
        setError(reason instanceof Error ? reason.message : "发送失败，请重试。");
        // After a lost response the server may already have stored the turn.
        await runScopedAction(() => loadConversation(organizationId, projectId, targetId), () => {});
      }
    } finally {
      if (epoch === spaceEpoch.current) setSending(false);
    }
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

  async function readCardHistory(id: string) {
    const response = await scopedFetch("/api/inspiration-cards/" + encodeURIComponent(id) + "?" + scopeQuery(organizationId, projectId));
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as {history: InspirationCard[]};
    return body.history;
  }
  async function showHistory(id: string) {
    setActionKey("history:" + id);
    try {
      const versions = await readCardHistory(id);
      setEditing(null);
      setHistory(versions);
    } finally { setActionKey(""); }
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

  const companyName = organizations.find(item => item.id === organizationId)?.name;
  const projectName = projects.find(item => item.id === projectId)?.name;
  const scopeLabel = [companyName !== projectName && companyName, projectName].filter(Boolean).join(" · ") || "选择空间";

  return <div className="knowledge-workspace inspiration-workspace assistant-inspiration-workspace creation-cleanup">
    <div className="management-toolbar knowledge-toolbar" data-scope-expanded={scopeExpanded}>
      <button type="button" className="inspiration-scope-toggle" data-no-feedback title={scopeLabel} aria-label={"切换空间，当前为" + scopeLabel} aria-controls="studio-company-field studio-project-field" aria-expanded={scopeExpanded} onClick={() => setScopeExpanded(!scopeExpanded)}>
        <span>{scopeLabel}</span><ChevronDown aria-hidden="true" />
      </button>
      <label id="studio-company-field">公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await switchWorkspace(()=>loadProjects(id)); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label id="studio-project-field">企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await switchWorkspace(()=>loadWorkspace(organizationId, id)); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="inspiration-toolbar-actions">
        <button type="button" className="inspiration-button secondary" disabled={Boolean(actionKey)} onClick={async () => { setActionKey("workspace:refresh"); await loadWorkspace(organizationId, projectId, conversationId); setActionKey(""); }}>
          <RefreshCw aria-hidden="true" className={actionKey === "workspace:refresh" ? "is-spinning" : ""} />{actionKey === "workspace:refresh" ? "刷新中" : "刷新"}
        </button>
        <a className="inspiration-button secondary" href="#studio-saved-ideas">已存灵感</a>
      </div>
    </div>

    {error && <div className="inline-alert" role="alert">{error}</div>}
    {saveNotice && <div className="analysis-submit-notice" role="status">{saveNotice}</div>}
    <section className="studio-inspiration-chat" id="studio-idea-chat" aria-label="灵感对话">
    {configuration && !configuration.configured && <div className="inline-alert warning-alert"><strong>独立项目助理 API 尚未配置</strong><span>缺少 {configuration.missing.join("、")}。对话按钮会保持不可用，系统不会调用其他模型代替。</span></div>}
    <details className="creation-context-summary">
      <summary><strong>可用参考</strong><span>策略{coreStrategy ? "已启用" : "未启用"} · {memoryCount} 条记忆 · {benchmarkStatus.readyCount} 条对标</span></summary>
      <div className="creation-context-body">
        <CoreStrategyPreview strategy={coreStrategy} />
        <section><h3>项目记忆</h3><p>从 {memoryCount} 条已采纳记忆中按问题选取；候选、停用和过期记忆不参与，仅用于灵感对话。</p></section>
        <section><h3>对标内容</h3><p>{benchmarkStatus.available ? "从已启用且完成分析的对标内容中寻找选题与方法，并结合核心策略检查适配度。" : benchmarkStatus.activeCount ? "对标内容尚未完成分析，完成后即可参与灵感生成。" : "当前企业空间暂无可用对标内容，可在视频分析页加入素材。"}</p></section>
        <p className="creation-hint">以上为可用资料，实际引用见每次回复。</p>
      </div>
    </details>

    <SplitWorkspace className="assistant-chat-layout">
      <aside className="conversation-sidebar" aria-label="对话历史">
        <div className="conversation-history-heading">
          <h2><History aria-hidden="true" />对话历史</h2>
          <button type="button" className="history-toggle" data-no-feedback aria-expanded={historyExpanded} aria-controls="studio-conversation-history" onClick={() => setHistoryExpanded(!historyExpanded)}>
            <History aria-hidden="true" />对话历史<ChevronDown aria-hidden="true" />
          </button>
        </div>
        <div id="studio-conversation-history" className="conversation-history-body" data-expanded={historyExpanded}>
          {conversations.length ? <div className="conversation-list">{conversations.map((conversation) => <button type="button" key={conversation.id} className={conversation.id === conversationId ? "active" : ""} aria-current={conversation.id === conversationId ? "true" : undefined} onClick={() => openConversation(conversation.id)}>
            <strong>{conversation.title}</strong>
            <span>{conversation.lastMessage || "还没有消息"}</span>
            <small>{conversation.messageCount} 条 · {dateLabel(conversation.updatedAt)}</small>
          </button>)}</div> : <p className="conversation-history-empty">这个空间的对话会保存在这里。</p>}
          <div className="conversation-model"><span>项目助理模型</span><strong>{configuration?.model || "未配置"}</strong></div>
        </div>
      </aside>

      <section className="assistant-thread-panel" aria-labelledby="studio-conversation-title">
        <div className="panel-heading">
          <h2 id="studio-conversation-title" title={activeConversation?.title}>{activeConversation?.title || "灵感对话"}</h2>
          <button type="button" className="inspiration-button secondary" disabled={!canWrite || Boolean(actionKey) || sending} onClick={() => void createConversation()}>
            <MessageSquarePlus aria-hidden="true" />{actionKey === "conversation:create" ? "创建中…" : "新建对话"}
          </button>
        </div>
        <div className="assistant-thread" ref={thread}>
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
          </article>) : <div className="assistant-thread-empty">
            <Sparkles className="assistant-empty-icon" aria-hidden="true" />
            <strong>想聊什么选题？</strong>
            <p>写下你的想法，或从下面的问题开始。</p>
            <div>{quickPrompts.map(({ label, prompt }) => <button type="button" key={label} data-no-feedback title={prompt} onClick={() => selectPrompt(prompt)}>{label}<ChevronRight aria-hidden="true" /></button>)}</div>
          </div>}
        </div>
        <form className="assistant-composer" onSubmit={sendMessage}>
          {messages.length > 0 && <div className="assistant-quick-prompts">{quickPrompts.slice(0, 3).map(({ label, prompt }) => <button type="button" key={label} data-no-feedback onClick={() => selectPrompt(prompt)}>{label}</button>)}</div>}
          <div className="assistant-input-row">
            <textarea ref={questionInput} aria-label="灵感对话内容" value={question} onChange={(event) => setQuestion(event.target.value)} rows={2} maxLength={12000} placeholder="写下想法，或继续追问…" />
            <button className="inspiration-button primary send-button" disabled={!canWrite || !configuration?.configured || sending || actionKey === "conversation:create" || question.trim().length < 2}><Send aria-hidden="true" />{sending ? "生成建议中" : "发送问题"}</button>
          </div>
        </form>
      </section>
    </SplitWorkspace>

    </section>

    <StudioIdeaLibrary key={organizationId+":"+projectId} organizationId={organizationId} projectId={projectId}
      focusId={initialConversationId ? "" : initialCardId || initialTopicId} showHistoryInitially={Boolean(initialCardId && cards.find(card=>card.id===initialCardId && !card.is_convertible))}
      refresh={libraryRevision} onConversation={id => {
        openConversation(id);
        document.getElementById("studio-idea-chat")?.scrollIntoView({block:"start"});
      }}
      cardActions={idea=>{
        const card=cards.find(item=>item.id===idea.id);
        return <div className="inspiration-card-actions">
          {idea.status==="candidate" && canWrite && <>
            <button type="button" className="inspiration-button confirm" disabled={Boolean(actionKey)} onClick={()=>void transition(idea.id,"confirm")}><Check aria-hidden="true"/>采纳</button>
            <button type="button" className="inspiration-button reject" disabled={Boolean(actionKey)} onClick={()=>void transition(idea.id,"reject")}><X aria-hidden="true"/>拒绝</button>
          </>}
          {canManage && Boolean(idea.active) && <button type="button" className="inspiration-button ghost" onClick={()=>void runScopedAction(async()=>{
            const item=card || (await readCardHistory(idea.id)).find(entry=>entry.id===idea.id);
            if(item) { setHistory(null); setEditing(item); }
          },setError)}><PencilLine aria-hidden="true"/>编辑</button>}
          <button type="button" className="inspiration-button ghost" disabled={Boolean(actionKey)} onClick={()=>void runScopedAction(()=>showHistory(idea.id),setError)}><History aria-hidden="true"/>历史</button>
          {canManage && Boolean(idea.active) && <button type="button" className="inspiration-button danger-ghost" disabled={Boolean(actionKey)} onClick={()=>void archive(idea.id)}><Archive aria-hidden="true"/>归档</button>}
        </div>;
      }}/>

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
