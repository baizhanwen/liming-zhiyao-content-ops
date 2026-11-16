"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ClipboardCheck,
  FilePenLine,
  ListTodo,
  NotebookPen,
  PlayCircle,
  RotateCcw,
  Trash2,
  Target,
  X,
} from "lucide-react";
import { scopedFetch, rememberCurrentScope, preferredOrganizationId, preferredProjectId } from "../lib/client-scope";
import { deliveryPlan } from "../lib/delivery-entitlements";
import { AppShell } from "./AppShell";
import "./dashboard-workspace.css";

type Organization = { id: string; name: string; role: string };
type Dashboard = {
  mode: "admin" | "employee";
  organizationRole: "admin" | "member";
  canCreateContent: boolean;
  currentUser: { id: string; displayName: string };
  summary: {
    pendingReviews: number;
    publishedMonth: number;
    activeJobs: number;
    failedJobs: number;
    upcomingSchedules: number;
    openTasks: number;
    monthlyContentTarget: number;
    openWorkTasks: number;
    overdueWorkTasks: number;
    currentFailedJobs: number;
    partialJobs: number;
    historicalFailedJobs: number;
  };
  reviews: Array<{ id: string; content_id: string; review_stage: string; project_id: string; title: string; project_name: string; due_at: string | null }>;
  tasks: Array<{ id: string; title: string; status: string; due_at: string | null; updated_at: string; project_id: string; project_name: string }>;
  jobs: Array<{ id: string; video_id: string; project_id: string; status: string; progress: number; current_stage: string | null; title: string | null; project_name: string; updated_at: string }>;
  projects: Array<{ id: string; name: string; content_target: number; status: string; published_month: number; open_items: number }>;
  assignableEmployees: Array<{ id: string; name: string }>;
  team: Array<{ id: string; name: string; role: string; open_tasks: number; due_soon: number; active_jobs: number }>;
};
type PersonalMemo = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  content: string;
  source_type: "manual" | "performance_report";
  source_id: string | null;
  source_locator: string | null;
  status: "active" | "completed";
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};
type WorkTask = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  assignee_user_id: string;
  assignee_name: string;
  task_type: "video_analysis" | "topic" | "content" | "review" | "publish" | "custom";
  title: string;
  description: string | null;
  target_count: number;
  completed_count: number;
  priority: "low" | "normal" | "high" | "urgent";
  status: "pending" | "in_progress" | "completed" | "overdue" | "cancelled";
  due_at: string;
};

const workTaskTypeLabels: Record<WorkTask["task_type"], string> = {
  video_analysis: "视频分析",
  topic: "选题生产",
  content: "内容生产",
  review: "内容审核",
  publish: "作品发布",
  custom: "自定义",
};
const workTaskStatusLabels: Record<WorkTask["status"], string> = {
  pending: "待开始",
  in_progress: "进行中",
  completed: "已完成",
  overdue: "已逾期",
  cancelled: "已取消",
};
const workTaskHrefs: Record<WorkTask["task_type"], string> = {
  video_analysis: "/analysis",
  topic: "/topics",
  content: "/content",
  review: "/workflow?view=review",
  publish: "/workflow?view=publish",
  custom: "#",
};

const taskStatusLabels: Record<string, string> = {
  draft: "草稿",
  internal_revision: "退回修改",
  internal_review: "内部审核",
  client_review: "客户审核",
  publish_ready: "待发布",
};

const subscribeToClient = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function dateText(value: string | null) {
  if (!value) return "未设置";
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" });
}

function dueTone(value: string | null) {
  if (!value) return "";
  const difference = new Date(value).getTime() - Date.now();
  if (difference < 0) return "overdue";
  if (difference < 3 * 86400000) return "near";
  return "";
}

function jobLabel(status: string) {
  if (status === "failed") return "失败";
  if (status === "partial") return "部分完成";
  if (status === "completed") return "完成";
  if (status === "cancelled") return "已取消";
  return "处理中";
}

async function errorMessage(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "工作台加载失败。";
}

function dashboardHref(path: string, organizationId: string, projectId = "", extra: Record<string, string> = {}) {
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  if (organizationId) params.set("organizationId", organizationId);
  if (projectId) params.set("projectId", projectId);
  Object.entries(extra).forEach(([key, value]) => params.set(key, value));
  return `${pathname}?${params.toString()}`;
}

function isOpenWorkTask(task: WorkTask) {
  return !["completed", "cancelled"].includes(task.status);
}

function isOverdueWorkTask(task: WorkTask) {
  return isOpenWorkTask(task) && (task.status === "overdue" || new Date(task.due_at).getTime() < Date.now());
}

function sortWorkTasks(tasks: WorkTask[]) {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...tasks].sort((a, b) => Number(isOverdueWorkTask(b)) - Number(isOverdueWorkTask(a))
    || (new Date(a.due_at).getTime() || Infinity) - (new Date(b.due_at).getTime() || Infinity)
    || priority[a.priority] - priority[b.priority]
    || a.id.localeCompare(b.id));
}

export function DashboardWorkspace() {
  const hydrated = useSyncExternalStore(subscribeToClient, clientSnapshot, serverSnapshot);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [memos, setMemos] = useState<PersonalMemo[]>([]);
  const [memoBusy, setMemoBusy] = useState("");
  const [workTasks, setWorkTasks] = useState<WorkTask[]>([]);
  const [taskBusy, setTaskBusy] = useState("");
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentType, setAssignmentType] = useState<WorkTask["task_type"]>(deliveryPlan.features.videoAnalysis ? "video_analysis" : "topic");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const activeOrganization = useRef("");
  const assignmentRef = useRef<HTMLDetailsElement>(null);

  const loadDashboard = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current;
    activeOrganization.current = id;
    const isCurrent = () => mounted.current && loadSequence.current === sequence && activeOrganization.current === id;
    setOrganizationId(id);
    setDashboard(null);
    setMemos([]);
    setWorkTasks([]);
    setMemoBusy("");
    setTaskBusy("");
    setAssignmentOpen(false);
    setAssignmentType(deliveryPlan.features.videoAnalysis ? "video_analysis" : "topic");
    setLoading(true);
    setError("");
    rememberCurrentScope(id, "");
    try {
      const responses = await Promise.all([
        scopedFetch(`/api/dashboard?organizationId=${encodeURIComponent(id)}`),
        scopedFetch(`/api/personal-memos?organizationId=${encodeURIComponent(id)}`),
        scopedFetch(`/api/work-tasks?organizationId=${encodeURIComponent(id)}`),
      ]);
      for (const response of responses) if (!response.ok) throw new Error(await errorMessage(response));
      const [nextDashboard, nextMemos, nextTasks] = await Promise.all([
        responses[0].json() as Promise<Dashboard>,
        responses[1].json() as Promise<{ memos: PersonalMemo[] }>,
        responses[2].json() as Promise<{ workTasks: WorkTask[] }>,
      ]);
      if (!isCurrent()) return;
      setDashboard(nextDashboard);
      setMemos(nextMemos.memos);
      setWorkTasks(nextTasks.workTasks);
      rememberCurrentScope(id, preferredProjectId(nextDashboard.projects));
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "工作台加载失败。");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    (async () => {
      try {
        const response = await fetch("/api/organizations");
        if (!response.ok) throw new Error(await errorMessage(response));
        const body = await response.json() as { organizations: Organization[] };
        if (!active) return;
        setOrganizations(body.organizations);
        const first = preferredOrganizationId(body.organizations);
        if (first) await loadDashboard(first);
        else setLoading(false);
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : "工作台加载失败。");
          setLoading(false);
        }
      }
    })();
    return () => { active = false; mounted.current = false; loadSequence.current += 1; };
  }, [loadDashboard]);

  function currentMutation() {
    const sequence = loadSequence.current;
    const id = organizationId;
    return () => mounted.current && loadSequence.current === sequence && activeOrganization.current === id;
  }

  function updateTaskCounts(previous: WorkTask | null, next: WorkTask) {
    setDashboard((current) => current ? { ...current, summary: {
      ...current.summary,
      openWorkTasks: Math.max(0, current.summary.openWorkTasks + Number(isOpenWorkTask(next)) - Number(previous ? isOpenWorkTask(previous) : false)),
      overdueWorkTasks: Math.max(0, current.summary.overdueWorkTasks + Number(isOverdueWorkTask(next)) - Number(previous ? isOverdueWorkTask(previous) : false)),
    } } : current);
  }

  async function addMemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const content = String(new FormData(formElement).get("content") || "").trim();
    if (!content || !organizationId || memoBusy) return;
    const isCurrent = currentMutation();
    setMemoBusy("create");
    setError("");
    try {
      const response = await scopedFetch("/api/personal-memos", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, content }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { memo: PersonalMemo };
      if (!isCurrent()) return;
      setMemos((current) => [body.memo, ...current]);
      formElement.reset();
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "备忘保存失败，请重试。");
    } finally { if (isCurrent()) setMemoBusy(""); }
  }

  async function updateMemo(memo: PersonalMemo, action: "complete" | "reopen") {
    if (memoBusy) return;
    const isCurrent = currentMutation();
    setMemoBusy(action + ":" + memo.id);
    setError("");
    try {
      const response = await scopedFetch(`/api/personal-memos/${encodeURIComponent(memo.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, action }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      if (isCurrent()) setMemos((current) => current.map((item) => item.id === memo.id ? { ...item, status: action === "complete" ? "completed" : "active" } : item));
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "备忘更新失败，请重试。");
    } finally { if (isCurrent()) setMemoBusy(""); }
  }

  async function removeMemo(memo: PersonalMemo) {
    if (memoBusy) return;
    const isCurrent = currentMutation();
    setMemoBusy("remove:" + memo.id);
    setError("");
    try {
      const response = await scopedFetch(`/api/personal-memos/${encodeURIComponent(memo.id)}?organizationId=${encodeURIComponent(organizationId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorMessage(response));
      if (isCurrent()) setMemos((current) => current.filter((item) => item.id !== memo.id));
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "备忘删除失败，请重试。");
    } finally { if (isCurrent()) setMemoBusy(""); }
  }

  async function assignWorkTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (taskBusy || !organizationId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawDueAt = String(form.get("dueAt") || "");
    const isCurrent = currentMutation();
    setTaskBusy("create");
    setError("");
    try {
      const response = await scopedFetch("/api/work-tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          assigneeUserId: String(form.get("assigneeUserId") || ""),
          projectId: String(form.get("projectId") || ""),
          taskType: String(form.get("taskType") || ""),
          targetCount: Number(form.get("targetCount") || 1),
          priority: String(form.get("priority") || "normal"),
          dueAt: rawDueAt ? new Date(rawDueAt).toISOString() : "",
          description: String(form.get("description") || ""),
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { workTask: WorkTask };
      if (!isCurrent()) return;
      if (body.workTask) {
        setWorkTasks((current) => [body.workTask, ...current]);
        updateTaskCounts(null, body.workTask);
      }
      formElement.reset();
      setAssignmentType(deliveryPlan.features.videoAnalysis ? "video_analysis" : "topic");
      setAssignmentOpen(false);
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "任务下达失败，请重试。");
    } finally { if (isCurrent()) setTaskBusy(""); }
  }

  async function updateWorkTask(task: WorkTask, action: "complete" | "reopen" | "cancel") {
    if (taskBusy) return;
    const isCurrent = currentMutation();
    setTaskBusy(action + ":" + task.id);
    setError("");
    try {
      const response = await scopedFetch(`/api/work-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, action }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { workTask: WorkTask };
      if (!isCurrent()) return;
      if (body.workTask) {
        setWorkTasks((current) => current.map((item) => item.id === task.id ? body.workTask : item));
        updateTaskCounts(task, body.workTask);
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "任务更新失败，请重试。");
    } finally { if (isCurrent()) setTaskBusy(""); }
  }

  const activeMemos = useMemo(() => memos.filter((memo) => memo.status === "active"), [memos]);
  const activeWorkTasks = useMemo(() => sortWorkTasks(workTasks.filter(isOpenWorkTask)), [workTasks]);
  const finishedWorkTasks = useMemo(() => workTasks.filter((task) => !isOpenWorkTask(task)), [workTasks]);
  const assignableEmployees = dashboard?.assignableEmployees ?? [];
  const organizationName = organizations.find((item) => item.id === organizationId)?.name ?? "";
  const defaultProjectId = dashboard ? preferredProjectId(dashboard.projects) : "";
  const href = (path: string, projectId = defaultProjectId, extra: Record<string, string> = {}) => dashboardHref(path, organizationId, projectId, extra);
  const today = hydrated ? new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }) : "";

  const renderWorkTaskRows = (adminView: boolean, items = activeWorkTasks) => items.length ? <div className="dashboard-work-task-list">{items.map((task) => {
    const progress = Math.min(100, Math.round(task.completed_count / Math.max(1, task.target_count) * 100));
    return <article className={`dashboard-work-task ${task.status} priority-${task.priority}`} key={task.id}>
      <header>
        <span className="dashboard-avatar">{task.assignee_name.slice(0, 1)}</span>
        <div><strong>{task.title}</strong><small>{task.assignee_name} · {task.project_name || "不限企业空间"} · {workTaskTypeLabels[task.task_type]}</small></div>
        <em>{workTaskStatusLabels[task.status]}</em>
      </header>
      {task.description && <p className="home-task-description" title={task.description}>{task.description}</p>}
      <div className="dashboard-work-task-progress"><i style={{ width: `${progress}%` }} /></div>
      <footer>
        <span><b>{task.completed_count}</b> / {task.target_count} · 截止 {new Date(task.due_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        {adminView && isOpenWorkTask(task) ? <button type="button" disabled={Boolean(taskBusy)} onClick={() => void updateWorkTask(task, "cancel")}><X aria-hidden="true" />取消</button> : null}
        {!adminView && task.task_type === "custom" && task.status !== "cancelled" ? <button type="button" disabled={Boolean(taskBusy)} onClick={() => void updateWorkTask(task, task.status === "completed" ? "reopen" : "complete")}>{task.status === "completed" ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}{task.status === "completed" ? "重新打开" : "完成任务"}</button> : null}
        {!adminView && task.task_type !== "custom" && isOpenWorkTask(task) && (task.task_type !== "video_analysis" || deliveryPlan.features.videoAnalysis) ? <Link href={href(workTaskHrefs[task.task_type], task.project_id ?? "")}>去完成 <ArrowRight aria-hidden="true" /></Link> : null}
      </footer>
    </article>;
  })}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><span>{adminView ? "当前工作安排已处理完毕。" : "当前没有未完成的管理员任务。"}</span></div>;

  const memoPanel = <article className="panel personal-memo-panel dashboard-memo-panel">
    <div className="panel-heading"><div><p className="section-kicker">仅自己可见</p><h2>我的备忘</h2></div><span>{activeMemos.length} 条待处理</span></div>
    <form className="personal-memo-create" onSubmit={addMemo}>
      <textarea name="content" aria-label="新的个人备忘" rows={2} minLength={1} maxLength={2000} placeholder="记下稍后要处理的事…" required />
      <button type="submit" disabled={Boolean(memoBusy)}><NotebookPen aria-hidden="true" />{memoBusy === "create" ? "记录中" : "记下"}</button>
    </form>
    {memos.length ? <div className="personal-memo-list">{[...activeMemos, ...memos.filter((memo) => memo.status === "completed")].slice(0, 12).map((memo) => <article className={memo.status === "completed" ? "completed" : ""} key={memo.id}>
      <button type="button" className="memo-check" aria-label={memo.status === "completed" ? "重新打开" : "标记完成"} disabled={Boolean(memoBusy)} onClick={() => void updateMemo(memo, memo.status === "completed" ? "reopen" : "complete")}>{memo.status === "completed" ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}</button>
      <div><p>{memo.content}</p><small>{memo.source_type === "performance_report" ? "来自复盘报告" : "个人记录"}{memo.project_name ? ` · ${memo.project_name}` : ""}</small></div>
      <button type="button" className="memo-remove" aria-label="删除备忘" disabled={Boolean(memoBusy)} onClick={() => void removeMemo(memo)}><Trash2 aria-hidden="true" /></button>
    </article>)}</div> : <p className="personal-memo-empty"><NotebookPen aria-hidden="true" />还没有备忘，随手记一条。</p>}
  </article>;

  return <AppShell activePath="/">
    <section className="role-dashboard home-dashboard" aria-label="运营工作台">
      <header className="page-heading management-heading home-heading">
        <div><p>运营工作</p><h1>{dashboard?.mode === "employee" ? "我的工作台" : "工作台"}</h1><span>处理待办、查看运营进度，从这里开始今天的工作。</span></div>
        <Link className="secondary-link" href={organizationId ? href("/projects") : "/projects"}>企业空间 →</Link>
      </header>
      <div className="management-toolbar home-context">
        {organizations.length > 0 && <label>公司<select aria-label="公司" value={organizationId} onChange={(event) => void loadDashboard(event.target.value)}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
        <span><time>{today}</time>{dashboard && ` · ${dashboard.mode === "admin" ? "管理员" : dashboard.currentUser.displayName}`}</span>
      </div>
      {loading && <div className="management-state" role="status">正在汇总真实运营数据…</div>}
      {error && <div className="inline-alert" role="alert">{error}{organizationId && <button type="button" disabled={loading} onClick={() => void loadDashboard(organizationId)}>重新加载</button>}</div>}
      {!loading && !organizationId && !error && <section className="setup-card"><span className="setup-step">开始使用</span><h2>先创建公司和企业空间</h2><p>完成初始化后，工作台会自动汇总审核、发布、分析和内容进度。</p><Link className="primary-button link-button" href="/projects">创建公司空间</Link></section>}
      {dashboard && <>
        <section className="home-stats" aria-label="今日工作概览">
          <Link className={`home-stat${dashboard.summary.pendingReviews ? " urgent" : ""}`} href="#home-reviews"><ClipboardCheck aria-hidden="true" /><span className="home-stat-label">{dashboard.mode === "admin" ? "待审核" : "项目待审核"}</span><strong className="home-stat-value">{dashboard.summary.pendingReviews}</strong><small className="home-stat-hint">{dashboard.summary.pendingReviews ? "查看待审核内容" : "当前审核已清空"}</small></Link>
          <a className={`home-stat${dashboard.summary.overdueWorkTasks ? " urgent" : ""}`} href="#work-tasks"><ListTodo aria-hidden="true" /><span className="home-stat-label">未完成任务</span><strong className="home-stat-value">{dashboard.summary.openWorkTasks}</strong><small className="home-stat-hint">{dashboard.summary.overdueWorkTasks ? `${dashboard.summary.overdueWorkTasks} 项已逾期` : "优先处理有截止时间的安排"}</small></a>
          {deliveryPlan.features.videoAnalysis && <Link className={`home-stat${dashboard.summary.currentFailedJobs || dashboard.summary.partialJobs ? " warning" : ""}`} href="#home-analysis"><PlayCircle aria-hidden="true" /><span className="home-stat-label">进行中分析</span><strong className="home-stat-value">{dashboard.summary.activeJobs}</strong><small className="home-stat-hint">{dashboard.summary.currentFailedJobs || dashboard.summary.partialJobs ? `${dashboard.summary.currentFailedJobs} 项当前失败 · ${dashboard.summary.partialJobs} 项部分完成` : dashboard.summary.activeJobs ? "查看分析队列与进度" : "暂无进行中的分析"}</small></Link>}
          <a className="home-stat" href="#home-monthly"><BarChart3 aria-hidden="true" /><span className="home-stat-label">本月发布</span><strong className="home-stat-value">{dashboard.summary.publishedMonth}</strong><small className="home-stat-hint">{dashboard.mode === "admin" ? "查看空间发布进度" : "我的发布数量 · 查看空间发布进度"}</small></a>
        </section>
        <section className="home-actions" aria-label="常用操作">
          <div className="home-actions-copy"><p className="section-kicker">常用操作</p><h2>开始今天的创作</h2><p>创建选题、分析参考视频，或继续下方待办。</p></div>
          <div className="home-action-buttons">
            {dashboard.canCreateContent && <Link className="primary-button link-button" href={href("/topics")}><FilePenLine aria-hidden="true" />创建选题</Link>}
            {deliveryPlan.features.videoAnalysis && <Link className="secondary-button" href={href("/analysis")}><PlayCircle aria-hidden="true" />分析视频</Link>}
            {dashboard.mode === "admin" && <button className="secondary-button" type="button" aria-expanded={assignmentOpen} aria-controls="dashboard-assignment" onClick={() => { setAssignmentOpen(!assignmentOpen); if (!assignmentOpen) requestAnimationFrame(() => assignmentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }}><Target aria-hidden="true" />布置任务</button>}
          </div>
        </section>
        {dashboard.mode === "admin" && <details className="home-assignment-disclosure" id="dashboard-assignment" ref={assignmentRef} open={assignmentOpen} onToggle={(event) => setAssignmentOpen(event.currentTarget.open)}>
          <summary><span><Target aria-hidden="true" />给员工布置任务</span><button type="button" onClick={(event) => { event.preventDefault(); setAssignmentOpen(false); }}>收起表单</button></summary>
          <form className="dashboard-assignment-form" onSubmit={assignWorkTask}>
            <label>员工<select name="assigneeUserId" required defaultValue=""><option value="" disabled>选择员工</option>{assignableEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label>
            <label>企业空间<select name="projectId" required={assignmentType !== "custom"} defaultValue={defaultProjectId}><option value="">仅自定义任务可不限</option>{dashboard.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
            <label>任务类型<select name="taskType" required value={assignmentType} onChange={(event) => setAssignmentType(event.target.value as WorkTask["task_type"])}>{deliveryPlan.features.videoAnalysis && <option value="video_analysis">视频分析</option>}<option value="topic">选题生产</option><option value="content">内容生产</option><option value="review">内容审核</option><option value="publish">作品发布</option><option value="custom">自定义任务</option></select></label>
            <label>数量<input name="targetCount" type="number" min="1" max="100" defaultValue="1" required /></label>
            <label>截止时间<input name="dueAt" type="datetime-local" required /></label>
            <label>优先级<select name="priority" defaultValue="normal"><option value="normal">普通</option><option value="high">重要</option><option value="urgent">紧急</option><option value="low">低</option></select></label>
            <label className="dashboard-assignment-note">任务说明<input name="description" maxLength={1000} placeholder="补充要求，可不填" /></label>
            <button type="submit" disabled={Boolean(taskBusy) || !assignableEmployees.length}><Target aria-hidden="true" />{taskBusy === "create" ? "下达中…" : "下达任务"}</button>
          </form>
          <p className="dashboard-assignment-help">常规任务按真实业务记录自动统计；自定义任务由员工手动完成。{!assignableEmployees.length && " 请先在成员管理中添加员工。"}</p>
        </details>}
        <section className={`dashboard-layout dashboard-${dashboard.mode}-layout`}>
          <div className="dashboard-primary-column">
            <article className="panel dashboard-list-panel home-review-panel" id="home-reviews">
              <div className="panel-heading"><div><p className="section-kicker">需要决定</p><h2>{dashboard.mode === "admin" ? "待审核内容" : "项目待审核"}</h2></div><Link href={href("/workflow?view=review")}>进入审核中心</Link></div>
              {dashboard.reviews.length ? <div className="dashboard-review-list">{dashboard.reviews.map((item) => <Link href={href("/workflow?view=review", item.project_id, { contentId: item.content_id })} key={item.id}><span className={dueTone(item.due_at)}><ClipboardCheck aria-hidden="true" /></span><div><strong>{item.title}</strong><small>{item.project_name} · {item.review_stage === "client" ? "客户审核" : "内部审核"}</small></div><time className={dueTone(item.due_at)}>{dateText(item.due_at)}</time></Link>)}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><span>当前审核已清空。</span></div>}
            </article>
            <article className="panel dashboard-assigned-panel" id="work-tasks">
              <div className="panel-heading"><div><p className="section-kicker">{dashboard.mode === "admin" ? "工作安排" : "管理员下达"}</p><h2>{dashboard.mode === "admin" ? "团队工作任务" : "我的工作任务"}</h2></div><span>{dashboard.summary.openWorkTasks} 项未完成</span></div>
              {dashboard.mode === "admin" ? renderWorkTaskRows(true) : renderWorkTaskRows(false)}
              {finishedWorkTasks.length > 0 && <details className="home-completed-tasks"><summary>已完成与已取消 · {finishedWorkTasks.length} 项</summary>{renderWorkTaskRows(dashboard.mode === "admin", finishedWorkTasks)}</details>}
            </article>
            {dashboard.mode === "employee" && <article className="panel dashboard-list-panel">
              <div className="panel-heading"><div><p className="section-kicker">内容流转</p><h2>我的内容任务</h2></div><Link href={href("/content")}>进入内容生产</Link></div>
              {dashboard.tasks.length ? <div className="dashboard-task-list">{dashboard.tasks.map((task) => <Link href={href("/content", task.project_id, { contentId: task.id })} key={task.id}><span className={dueTone(task.due_at)}><FilePenLine aria-hidden="true" /></span><div><strong>{task.title}</strong><small>{task.project_name} · {taskStatusLabels[task.status] || task.status}</small></div><time className={dueTone(task.due_at)}>{task.due_at ? `截止 ${dateText(task.due_at)}` : "未设截止"}</time><ArrowRight aria-hidden="true" /></Link>)}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><span>当前没有待办内容。</span></div>}
            </article>}
            {deliveryPlan.features.videoAnalysis && <article className="panel jobs-panel dashboard-jobs-panel" id="home-analysis">
              <div className="panel-heading"><div><p className="section-kicker">异常与运行</p><h2>{dashboard.mode === "admin" ? "分析任务" : "我的分析任务"}</h2></div><Link href={href("/analysis")}>进入视频分析</Link></div>
              {dashboard.jobs.length ? dashboard.jobs.map((job) => <Link className="job" href={href(`/analysis/${encodeURIComponent(job.video_id)}`, job.project_id)} key={job.id}><span className={`job-icon ${job.status === "completed" ? "complete" : job.status === "failed" ? "error" : ""}`}>{job.status === "failed" ? "!" : "影"}</span><div><strong>{job.title || "未命名分析任务"}</strong><small>{job.project_name} · {job.current_stage || jobLabel(job.status)}</small>{!["completed", "partial", "failed", "cancelled"].includes(job.status) && <div className="progress-track small"><i style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>}</div><em>{jobLabel(job.status)}</em></Link>) : <div className="dashboard-empty">当前没有分析任务。</div>}
              {dashboard.summary.historicalFailedJobs > dashboard.summary.currentFailedJobs && <p className="home-job-history"><span>历史失败 {dashboard.summary.historicalFailedJobs} 条记录，仅当前 {dashboard.summary.currentFailedJobs} 项仍列为失败。</span><Link href={href("/analysis")}>进入视频分析</Link></p>}
            </article>}
          </div>
          <aside className="dashboard-secondary-column">
            <article className="panel dashboard-project-panel" id="home-monthly">
              <div className="panel-heading"><div><p className="section-kicker">企业空间</p><h2>{dashboard.mode === "admin" ? "本月目标" : "项目月目标"}</h2></div><Link href={href("/projects", "")}>{dashboard.mode === "admin" ? "管理空间" : "查看空间"}</Link></div>
              {dashboard.projects.length ? <div className="dashboard-project-list">{dashboard.projects.map((project) => {
                const target = Number(project.content_target);
                const published = Number(project.published_month);
                return <article key={project.id}><div><Link href={href("/workflow?view=publish", project.id)}><strong>{project.name}</strong></Link><span>{Number(project.open_items)} 条进行中</span></div>{target > 0 && <div className="dashboard-project-progress"><i style={{ width: `${Math.min(100, Math.round(published / target * 100))}%` }} /></div>}<small><b>{published}</b> 条已发布{target > 0 ? ` / 目标 ${target} 条` : " · 未设置月目标"}</small></article>;
              })}</div> : <div className="dashboard-empty">还没有可用的企业空间。</div>}
              {dashboard.mode === "employee" && <p className="home-history-note">项目整体目标，非个人发布指标；我本月已发布 {dashboard.summary.publishedMonth} 条。</p>}
            </article>
            {dashboard.mode === "admin" && <article className="panel dashboard-team-panel">
              <div className="panel-heading"><div><p className="section-kicker">团队待办</p><h2>谁需要协调</h2></div><Link href={href("/members", "")}>成员管理</Link></div>
              {dashboard.team.length ? <div className="dashboard-team-list">{dashboard.team.map((member) => <article key={member.id}><span className="dashboard-avatar">{member.name.slice(0, 1)}</span><div><strong>{member.name}</strong></div><p><b>{Number(member.open_tasks)}</b> 条内容 · <b>{Number(member.active_jobs)}</b> 条分析{Number(member.due_soon) > 0 && <em>{Number(member.due_soon)} 条内容临期</em>}</p></article>)}</div> : <div className="dashboard-empty">暂时没有团队待办。</div>}
              <p className="home-history-note">按内容待办展示前 8 位成员。</p>
            </article>}
            {memoPanel}
          </aside>
        </section>
        <p className="dashboard-data-note">{organizationName} · 所有进度来自真实业务记录。</p>
      </>}
    </section>
  </AppShell>;
}
