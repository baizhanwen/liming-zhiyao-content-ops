"use client";
import { runScopedAction } from "../lib/client-scope";
import { loadClientProjects } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError, formatClientDate as dateLabel } from "../lib/client-format";


import { FormEvent, useCallback, useMemo, useState } from "react";
import { Check, CircleX, Clock3, History, PencilLine, Power, RefreshCw, Save, Sparkles, X } from "lucide-react";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type MemoryEvidence = { id: string; sourceType: string; sourceId: string; quote: string | null; relevance: number | null };
type MemoryMetadata = {
  confidence?: number;
  operation?: string;
  reason?: string;
  conflictWithConfirmed?: boolean;
  model?: { provider?: string; name?: string; promptVersion?: string };
  evidenceCount?: number;
  validationState?: "needs_more_evidence" | "ready_for_review";
};
type MemoryItem = {
  id: string;
  canonical_key: string;
  status: string;
  title: string;
  content: string;
  source_type: string;
  source_id: string | null;
  revision: number;
  content_hash: string;
  updated_at: string;
  metadata?: MemoryMetadata;
  evidence?: MemoryEvidence[];
};
type MemoryHistoryResponse = { history: MemoryItem[]; canWrite: boolean };
type AssistantConfiguration = {
  configured: boolean;
  missing: string[];
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  isolation: "independent";
  implicitFallback: false;
};
type MemoryEventOperation = {
  operation: string;
  canonicalKey: string | null;
  outcome: "confirmed" | "candidate" | "deduplicated" | "retired" | "skipped" | "noop";
  memoryId?: string;
  revision?: number;
  confidence: number;
  reason: string;
};
type MemoryEvent = {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string | null;
  status: string;
  operations: MemoryEventOperation[];
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  processedAt: string | null;
};
type EventSummary = { counts: Record<string, number>; recent: MemoryEvent[] };
type MemoryRepairSummary = {
  count: number;
  operationCount: number;
  candidates: Array<{ id: string; eventType: string; sourceType: string; sourceId: string | null; operationCount: number; createdAt: string }>;
};
type MemoryResponse = {
  items: MemoryItem[];
  canWrite: boolean;
  configuration: AssistantConfiguration;
  events: EventSummary;
  repair: MemoryRepairSummary;
};
type MemorySyncResult = {
  status: string;
  processed: boolean;
  operations: MemoryEventOperation[];
  error?: { code?: string; message?: string };
};
type MemorySyncResponse = {
  results: MemorySyncResult[];
  events: EventSummary;
  configuration: AssistantConfiguration;
};

const statusLabels: Record<string, string> = {
  candidate: "待采纳",
  confirmed: "已采纳",
  rejected: "不采纳",
  superseded: "历史版本",
  expired: "已停用",
};
const sourceLabels: Record<string, string> = {
  manual: "早期人工录入",
  manual_correction: "人工纠错",
  manual_entry: "人工录入",
  manual_validation: "人工验证",
  analysis: "分析沉淀",
  video_analysis: "视频分析",
  project_assistant: "项目助理更新",
  project_assistant_message: "灵感对话",
  inspiration_card: "灵感卡片",
  performance_report: "数据报告",
  review_feedback: "审核退回意见",
  client_feedback: "客户反馈",
  document: "客户资料",
  url: "网页来源",
};
const eventLabels: Record<string, string> = {
  video_analysis_completed: "视频分析完成",
  inspiration_conversation: "灵感对话",
  inspiration_accepted: "采纳灵感",
  inspiration_rejected: "拒绝灵感",
  inspiration_edited: "编辑灵感",
};
const eventStatusLabels: Record<string, string> = {
  pending: "等待处理",
  processing: "处理中",
  completed: "处理完成",
  blocked: "等待配置",
  failed: "处理失败",
};
const eventOutcomeLabels: Record<MemoryEventOperation["outcome"], string> = {
  confirmed: "已写入",
  candidate: "待采纳",
  deduplicated: "已去重",
  retired: "已停用",
  skipped: "未写入",
  noop: "无需更新",
};

function memoryEventResult(event: MemoryEvent) {
  if (event.status !== "completed") {
    return {
      label: eventStatusLabels[event.status] || event.status,
      tone: event.status === "failed" ? "danger" : event.status === "blocked" ? "warning" : "neutral",
      details: "",
      reason: event.errorMessage || "",
    };
  }
  const counts = Object.fromEntries(
    Object.keys(eventOutcomeLabels).map((outcome) => [
      outcome,
      event.operations.filter((operation) => operation.outcome === outcome).length,
    ]),
  ) as Record<MemoryEventOperation["outcome"], number>;
  const wrote = counts.confirmed + counts.candidate + counts.retired;
  const label = counts.confirmed
    ? "已写入 " + counts.confirmed + " 条记忆"
    : counts.candidate
      ? "产生 " + counts.candidate + " 条待采纳候选"
      : counts.retired
        ? "已停用 " + counts.retired + " 条旧记忆"
        : counts.deduplicated
          ? "已完成去重"
          : counts.skipped
            ? "处理完成但未写入"
            : counts.noop
              ? "无需更新"
              : "处理完成";
  return {
    label,
    tone: wrote > 0 ? "success" : "neutral",
    details: (Object.entries(counts) as Array<[MemoryEventOperation["outcome"], number]>)
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => eventOutcomeLabels[outcome] + " " + count)
      .join(" · "),
    reason: event.operations.find((operation) => operation.reason)?.reason || "",
  };
}





export function ProjectMemoryWorkspace({ initialOrganizationId = "", initialProjectId = "" }: { initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [configuration, setConfiguration] = useState<AssistantConfiguration | null>(null);
  const [events, setEvents] = useState<EventSummary>({ counts: {}, recent: [] });
  const [repair, setRepair] = useState<MemoryRepairSummary>({ count: 0, operationCount: 0, candidates: [] });
  const [canWrite, setCanWrite] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [selectedView, setSelectedView] = useState<"all" | "candidate" | "confirmed">("all");
  const [history, setHistory] = useState<MemoryItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairNotice, setRepairNotice] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState("");
  const [actionKey, setActionKey] = useState("");
  const [error, setError] = useState("");

  const applyResponse = useCallback((body: MemoryResponse) => {
    setItems(body.items);
    setCanWrite(body.canWrite);
    setConfiguration(body.configuration);
    setEvents(body.events);
    setRepair(body.repair ?? { count: 0, operationCount: 0, candidates: [] });
    setHistory(null);
    setEditing(null);
  }, []);

  const loadItems = useCallback(async (orgId: string, projId: string, autoSync = true) => {
    if (!orgId || !projId) {
      setItems([]);
      setRepair({ count: 0, operationCount: 0, candidates: [] });
      setCanWrite(false);
      return;
    }
    const query = "organizationId=" + encodeURIComponent(orgId) + "&projectId=" + encodeURIComponent(projId);
    const response = await scopedFetch("/api/project-memory?" + query);
    if (!response.ok) throw new Error(await readError(response));
    let body = await response.json() as MemoryResponse;
    if (autoSync && body.canWrite && body.configuration.configured && Number(body.events.counts.pending || 0) > 0) {
      setSyncing(true);
      const syncResponse = await scopedFetch("/api/project-memory/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, projectId: projId, limit: 3 }),
      });
      if (syncResponse.ok) {
        const refreshed = await scopedFetch("/api/project-memory?" + query);
        if (refreshed.ok) body = await refreshed.json() as MemoryResponse;
      } else {
        setError(await readError(syncResponse));
      }
      setSyncing(false);
    }
    applyResponse(body);
  }, [applyResponse]);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred);
    setProjects(body.projects);
    const selected = body.selected;
    setProjectId(selected);
    rememberCurrentScope(orgId, selected);
    await loadItems(orgId, selected);
  }, [loadItems]);

  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading });

  const currentItems = useMemo(
    () => items.filter((item) => item.status === "confirmed" || item.status === "candidate"),
    [items],
  );
  const visibleItems = useMemo(
    () => selectedView === "all" ? currentItems : currentItems.filter((item) => item.status === selectedView),
    [currentItems, selectedView],
  );

  async function syncMemory() {
    setError("");
    setSyncNotice("");
    if (!configuration?.configured) {
      setError("候选提取助手尚未配置，暂时不能处理新来源。待处理信息会保留，不会丢失。");
      return;
    }
    const queuedCount = Number(events.counts.pending || 0) + Number(events.counts.failed || 0) + Number(events.counts.blocked || 0);
    if (queuedCount === 0) {
      setSyncNotice("当前没有待提取的新信息。审核退回意见会直接生成待采纳候选，不需要再次点击提取。");
      return;
    }
    setSyncing(true);
    try {
      const response = await scopedFetch("/api/project-memory/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, limit: 5 }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as MemorySyncResponse;
      const operations = body.results.flatMap((result) => result.operations ?? []);
      const candidateCount = operations.filter((operation) => operation.outcome === "candidate").length;
      const failedCount = body.results.filter((result) => result.status === "failed" || result.status === "blocked").length;
      await loadItems(organizationId, projectId, false);
      if (candidateCount > 0) {
        setSyncNotice(`已处理 ${body.results.length} 条新来源，提取出 ${candidateCount} 条待采纳候选。`);
      } else if (failedCount > 0) {
        setSyncNotice(`已处理 ${body.results.length} 条来源，其中 ${failedCount} 条未完成，请查看右侧处理记录。`);
      } else if (body.results.length > 0) {
        setSyncNotice(`已处理 ${body.results.length} 条新来源，没有发现符合长期项目记忆标准的新候选。`);
      } else {
        setSyncNotice("当前没有待提取的新信息。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "候选提取没有完成，请稍后重试。");
    } finally {
      setSyncing(false);
    }
  }

  async function repairLegacyConfidenceEvents() {
    if (!repair.count) return;
    setRepairing(true);
    setRepairNotice("");
    setError("");
    try {
      const response = await scopedFetch("/api/project-memory/confidence-repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { repair: MemoryRepairSummary };
      let pending = body.repair.count;
      for (let round = 0; round < 3 && pending > 0; round += 1) {
        const syncResponse = await scopedFetch("/api/project-memory/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, projectId, limit: 5 }),
        });
        if (!syncResponse.ok) throw new Error(await readError(syncResponse));
        const syncBody = await syncResponse.json() as { events: EventSummary };
        pending = Number(syncBody.events.counts.pending || 0);
      }
      await loadItems(organizationId, projectId, false);
      setRepairNotice("已安全重排并重新处理 " + body.repair.count + " 个旧事件，共 " + body.repair.operationCount + " 条记忆操作。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "旧记忆事件修复失败。");
    } finally {
      setRepairing(false);
    }
  }

  async function checkConnection() {
    setActionKey("connection:check");
    setHealth("正在检查独立连接…");
    const response = await scopedFetch("/api/project-assistant/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, projectId }),
    });
    if (!response.ok) {
      setHealth(await readError(response));
      setActionKey("");
      return;
    }
    const body = await response.json() as { health: { provider: string; model: string; latencyMs: number } };
    setHealth("连接正常：" + body.health.provider + " / " + body.health.model + " · " + body.health.latencyMs + "ms");
    setActionKey("");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setActionKey("edit:" + editing.id);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await scopedFetch(
      "/api/project-memory/" + encodeURIComponent(editing.id) + "?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          content: form.get("content"),
          sourceType: "manual_correction",
          sourceId: editing.id,
          quote: form.get("quote"),
          value: { correctionReason: form.get("correctionReason") },
        }),
      },
    );
    if (!response.ok) {
      setError(await readError(response));
      setSaving(false);
      setActionKey("");
      return;
    }
    setSaving(false);
    setEditing(null);
    await loadItems(organizationId, projectId, false);
    setActionKey("");
  }

  async function transition(id: string, action: "confirm" | "reject") {
    setActionKey(action + ":" + id);
    setError("");
    const response = await scopedFetch("/api/project-memory/" + encodeURIComponent(id) + "/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, projectId, action }),
    });
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    await loadItems(organizationId, projectId, false);
    setActionKey("");
  }

  async function disable(id: string) {
    if (!window.confirm("确认停用这条项目记忆？历史版本保留，后续灵感对话不会再读取它。")) return;
    setActionKey("disable:" + id);
    setError("");
    const response = await scopedFetch(
      "/api/project-memory/" + encodeURIComponent(id) + "?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId),
      { method: "DELETE" },
    );
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    await loadItems(organizationId, projectId, false);
    setActionKey("");
  }

  async function showHistory(id: string) {
    setActionKey("history:" + id);
    setError("");
    const response = await scopedFetch(
      "/api/project-memory/" + encodeURIComponent(id) + "?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId),
    );
    if (!response.ok) {
      setError(await readError(response));
      setActionKey("");
      return;
    }
    const body = await response.json() as MemoryHistoryResponse;
    setEditing(null);
    setHistory(body.history);
    setActionKey("");
  }

  if (loading) return <div className="management-state" role="status">正在载入项目长期档案…</div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>每个项目拥有完全隔离的记忆与事件。</p></div>;

  return <div className="knowledge-workspace project-memory-workspace automatic-memory-workspace">
    <div className="management-toolbar knowledge-toolbar">
      <label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadItems(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="memory-toolbar-actions">
        <button type="button" className="memory-button secondary" disabled={syncing || Boolean(actionKey)} onClick={async () => { setActionKey("workspace:refresh"); await loadItems(organizationId, projectId, false); setActionKey(""); }}><RefreshCw aria-hidden="true" className={actionKey === "workspace:refresh" ? "is-spinning" : ""} />{actionKey === "workspace:refresh" ? "刷新中" : "刷新"}</button>
        <button type="button" className="memory-button secondary" disabled={!canWrite || syncing} title={!canWrite ? "当前角色没有项目记忆写入权限" : !configuration?.configured ? "候选提取助手尚未配置，点击查看说明" : "提取内容启发与表达方法，也会按新规则补查旧素材"} onClick={() => void syncMemory()}><Sparkles aria-hidden="true" />{syncing ? "处理中" : "提取候选"}</button>
      </div>
    </div>

    {error && <div className="inline-alert" role="alert">{error}</div>}
    {syncNotice && <div className="memory-repair-notice" role="status">{syncNotice}</div>}
    {configuration && !configuration.configured && <div className="inline-alert warning-alert" role="status"><strong>独立项目助理 API 尚未配置</strong><span>缺少 {configuration.missing.join("、")}。待处理事件会保留，系统不会借用视频分析或内容生成模型。</span></div>}
    {repair.count > 0 && <div className="memory-repair-alert" role="status">
      <div><strong>发现 {repair.count} 个旧版置信度事件需要修复</strong><span>共 {repair.operationCount} 条操作此前被错误当成 1 分而跳过；真正的“无需更新”事件不会重排。</span></div>
      <button type="button" className="memory-button primary" disabled={!canWrite || repairing || !configuration?.configured} onClick={() => void repairLegacyConfidenceEvents()}><RefreshCw aria-hidden="true" className={repairing ? "is-spinning" : ""} />{repairing ? "修复处理中" : "安全重排并处理"}</button>
    </div>}
    {repairNotice && <div className="memory-repair-notice" role="status">{repairNotice}</div>}

    <section className="memory-category-index" aria-label="项目记忆状态">
      <button type="button" className={selectedView === "all" ? "active" : ""} onClick={() => setSelectedView("all")}><span>全部</span><strong>{currentItems.length}</strong></button>
      <button type="button" className={selectedView === "candidate" ? "active" : ""} onClick={() => setSelectedView("candidate")}><span>待采纳</span><strong>{currentItems.filter((item) => item.status === "candidate").length}</strong></button>
      <button type="button" className={selectedView === "confirmed" ? "active" : ""} onClick={() => setSelectedView("confirmed")}><span>已采纳</span><strong>{currentItems.filter((item) => item.status === "confirmed").length}</strong></button>
    </section>
    <div className="automatic-memory-layout">
      <section className="panel knowledge-list-panel">
        <div className="panel-heading"><div><p className="section-kicker">候选由系统提取 · 人工决定</p><h2>{selectedView === "candidate" ? "待采纳候选" : selectedView === "confirmed" ? "已采纳记忆" : "项目记忆"}</h2></div><span>已采纳记忆仅用于灵感对话，不直接进入选题补全和正文生成</span></div>
        {visibleItems.length ? <div className="knowledge-list memory-auto-list">{visibleItems.map((item) => {
          const evidenceCount = new Set((item.evidence ?? []).map((evidence) => `${evidence.sourceType}:${evidence.sourceId}`)).size;
          return <article key={item.id} className={"memory-card status-" + item.status}>
          <div className="knowledge-card-head"><span>{item.status === "candidate" ? "等待决定" : "项目记忆"}</span><em className={"status " + (item.status === "confirmed" ? "success" : "neutral")}>{statusLabels[item.status] || item.status}</em></div>
          <h3>{item.title}</h3>
          <p>{item.content}</p>
          <div className="memory-meta-row">
            <span>来源：{sourceLabels[item.source_type] || item.source_type}</span>
            <span>版本 v{item.revision}</span>
            {evidenceCount > 0 && <span>依据 {evidenceCount} 条</span>}
            {typeof item.metadata?.confidence === "number" && <span>置信度 {item.metadata.confidence}</span>}
            <span>{dateLabel(item.updated_at)}</span>
          </div>
          {(item.metadata?.reason || item.evidence?.length) ? <details className="memory-card-details"><summary>查看依据与记录</summary><div>
            {item.metadata?.reason && <small className="memory-reason">更新依据：{item.metadata.reason}</small>}
            {item.evidence?.length ? <div className="memory-evidence-list">{item.evidence.slice(0, 2).map((evidence) => <small key={evidence.id}><b>{sourceLabels[evidence.sourceType] || evidence.sourceType}</b>{evidence.quote ? "：" + evidence.quote : " · " + evidence.sourceId}</small>)}</div> : null}
          </div></details> : null}
          <footer className="memory-card-footer"><div className="memory-card-actions">
            {item.status === "candidate" && canWrite && <div className="memory-decision-actions"><button type="button" className="memory-button confirm" disabled={Boolean(actionKey)} onClick={() => void transition(item.id, "confirm")}><Check aria-hidden="true" />{actionKey === "confirm:" + item.id ? "采纳中" : "采纳"}</button><button type="button" className="memory-button reject" disabled={Boolean(actionKey)} onClick={() => void transition(item.id, "reject")}><CircleX aria-hidden="true" />{actionKey === "reject:" + item.id ? "处理中" : "不采纳"}</button></div>}
            <div className="memory-management-actions">
              {canWrite && <button type="button" className="memory-button ghost" onClick={() => { setHistory(null); setEditing(item); }}><PencilLine aria-hidden="true" />编辑</button>}
              <button type="button" className="memory-button ghost" disabled={Boolean(actionKey)} onClick={() => void showHistory(item.id)}><History aria-hidden="true" />{actionKey === "history:" + item.id ? "读取中" : "版本历史"}</button>
              {canWrite && item.status === "confirmed" && <button type="button" className="memory-button danger-ghost" disabled={Boolean(actionKey)} onClick={() => void disable(item.id)}><Power aria-hidden="true" />{actionKey === "disable:" + item.id ? "停用中" : "停用"}</button>}
            </div>
          </div></footer>
        </article>;
        })}</div> : <div className="list-empty"><strong>{selectedView === "candidate" ? "没有待采纳候选" : selectedView === "confirmed" ? "还没有已采纳记忆" : "当前没有项目记忆"}</strong><p>系统提取候选后，由管理员决定采纳或不采纳。</p></div>}
      </section>

      <aside className="memory-automation-aside">
        <section className="panel assistant-config-card memory-config-card">
          <p className="section-kicker">候选提取助手</p><h2>{configuration?.configured ? "辅助识别已开启" : "辅助识别未配置"}</h2>
          <dl><div><dt>隔离状态</dt><dd>独立 API · 无隐式回退</dd></div><div><dt>提供方</dt><dd>{configuration?.provider || "未配置"}</dd></div><div><dt>模型</dt><dd>{configuration?.model || "未配置"}</dd></div></dl>
          <button type="button" className="memory-button secondary" disabled={!configuration?.configured || actionKey === "connection:check"} onClick={() => void checkConnection()}><RefreshCw aria-hidden="true" className={actionKey === "connection:check" ? "is-spinning" : ""} />{actionKey === "connection:check" ? "检查中" : "检查连接"}</button>
          {health && <small>{health}</small>}
        </section>

        <section className="panel memory-event-panel">
          <div className="panel-heading"><div><p className="section-kicker">最近处理记录</p><h3>候选提取事件</h3></div></div>
          {events.recent.length ? <div className="memory-event-list">{events.recent.slice(0, 12).map((event) => {
            const result = memoryEventResult(event);
            return <article key={event.id}>
              <div><strong>{eventLabels[event.eventType] || event.eventType}</strong><em className={"status " + result.tone}>{result.label}</em></div>
              <small>{sourceLabels[event.sourceType] || event.sourceType} · {dateLabel(event.createdAt)}</small>
              {result.details && <small className="memory-event-outcomes">{result.details}</small>}
              {result.reason && <p className={event.errorMessage ? "" : "memory-event-reason"}>{result.reason}</p>}
            </article>;
          })}</div> : <div className="list-empty">还没有自动更新事件。</div>}
        </section>
      </aside>
    </div>

    {editing && <div className="inspiration-modal-backdrop memory-modal-backdrop" role="presentation">
      <form className="stack-form inspiration-modal memory-modal" onSubmit={saveEdit} role="dialog" aria-modal="true" aria-labelledby="memory-edit-title">
        <div className="inspiration-modal-heading memory-modal-heading"><div><p className="section-kicker">管理员修订保存后立即生效</p><h2 id="memory-edit-title">编辑项目记忆</h2><span>{editing.canonical_key}</span></div><button type="button" className="inspiration-icon-button memory-icon-button" aria-label="关闭编辑" onClick={() => setEditing(null)}><X aria-hidden="true" /></button></div>
        <label>标题<input name="title" defaultValue={editing.title} required minLength={2} maxLength={160} /></label>
        <label>正确内容<textarea name="content" defaultValue={editing.content} required minLength={2} maxLength={20000} rows={7} /></label>
        <label>纠错原因<textarea name="correctionReason" required rows={3} maxLength={1000} placeholder="说明哪里记错了，便于后续审计" /></label>
        <label>逐字依据（可选）<textarea name="quote" rows={3} maxLength={4000} /></label>
        <div className="inspiration-modal-actions memory-modal-actions"><button type="button" className="memory-button secondary" onClick={() => setEditing(null)}>取消</button><button className="memory-button primary" disabled={saving}><Save aria-hidden="true" />{saving ? "保存中" : "保存并更新"}</button></div>
      </form>
    </div>}

    {history && <div className="inspiration-modal-backdrop memory-modal-backdrop" role="presentation">
      <section className="inspiration-modal inspiration-history-modal memory-modal memory-history-modal" role="dialog" aria-modal="true" aria-labelledby="memory-history-title">
        <div className="inspiration-modal-heading memory-modal-heading"><div><p className="section-kicker">同一记忆键的完整演变</p><h2 id="memory-history-title">版本历史</h2></div><button type="button" className="inspiration-icon-button memory-icon-button" aria-label="关闭版本历史" onClick={() => setHistory(null)}><X aria-hidden="true" /></button></div>
        <div className="inspiration-history-list memory-history-list">{history.map((item) => <article key={item.id}><div><strong>v{item.revision}</strong><span>{statusLabels[item.status] || item.status}</span></div><h3>{item.title}</h3><p>{item.content}</p><small><Clock3 aria-hidden="true" />{sourceLabels[item.source_type] || item.source_type} · {dateLabel(item.updated_at)}</small></article>)}</div>
      </section>
    </div>}
  </div>;
}
