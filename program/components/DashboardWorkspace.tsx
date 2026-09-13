"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
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
import { scopedFetch, rememberCurrentScope } from "../lib/client-scope";
import { deliveryPlan } from "../lib/delivery-entitlements";
import { AppShell } from "./AppShell";

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
  };
  reviews: Array<{ id: string; content_id: string; review_stage: string; title: string; project_name: string; due_at: string | null }>;
  tasks: Array<{ id: string; title: string; status: string; due_at: string | null; updated_at: string; project_id: string; project_name: string }>;
  jobs: Array<{ id: string; status: string; progress: number; current_stage: string | null; title: string | null; project_name: string; updated_at: string }>;
  projects: Array<{ id: string; name: string; content_target: number; status: string; published_month: number; open_items: number }>;
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

function dateText(value: string | null) {
  if (!value) return "未设置";
  return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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

export function DashboardWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [memos, setMemos] = useState<PersonalMemo[]>([]);
  const [memoBusy, setMemoBusy] = useState("");
  const [workTasks, setWorkTasks] = useState<WorkTask[]>([]);
  const [taskBusy, setTaskBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadDashboard(id: string) {
    rememberCurrentScope(id, "");
    setLoading(true);
    setError("");
    const [response, memoResponse, taskResponse] = await Promise.all([
      scopedFetch(`/api/dashboard?organizationId=${encodeURIComponent(id)}`),
      scopedFetch(`/api/personal-memos?organizationId=${encodeURIComponent(id)}`),
      scopedFetch(`/api/work-tasks?organizationId=${encodeURIComponent(id)}`),
    ]);
    if (!response.ok) throw new Error(await errorMessage(response));
    if (!memoResponse.ok) throw new Error(await errorMessage(memoResponse));
    if (!taskResponse.ok) throw new Error(await errorMessage(taskResponse));
    setDashboard(await response.json() as Dashboard);
    setMemos((await memoResponse.json() as { memos: PersonalMemo[] }).memos);
    setWorkTasks((await taskResponse.json() as { workTasks: WorkTask[] }).workTasks);
    setLoading(false);
  }

  async function addMemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const content = String(form.get("content") || "").trim();
    if (!content || !organizationId) return;
    setMemoBusy("create");
    setError("");
    const response = await scopedFetch("/api/personal-memos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, content }),
    });
    if (!response.ok) setError(await errorMessage(response));
    else {
      const body = await response.json() as { memo: PersonalMemo };
      setMemos((current) => [body.memo, ...current]);
      formElement.reset();
    }
    setMemoBusy("");
  }

  async function updateMemo(memo: PersonalMemo, action: "complete" | "reopen") {
    setMemoBusy(action + ":" + memo.id);
    setError("");
    const response = await scopedFetch(`/api/personal-memos/${encodeURIComponent(memo.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, action }),
    });
    if (!response.ok) setError(await errorMessage(response));
    else setMemos((current) => current.map((item) => item.id === memo.id ? { ...item, status: action === "complete" ? "completed" : "active" } : item));
    setMemoBusy("");
  }

  async function removeMemo(memo: PersonalMemo) {
    setMemoBusy("remove:" + memo.id);
    setError("");
    const response = await scopedFetch(`/api/personal-memos/${encodeURIComponent(memo.id)}?organizationId=${encodeURIComponent(organizationId)}`, { method: "DELETE" });
    if (!response.ok) setError(await errorMessage(response));
    else setMemos((current) => current.filter((item) => item.id !== memo.id));
    setMemoBusy("");
  }

  async function assignWorkTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawDueAt = String(form.get("dueAt") || "");
    setTaskBusy("create");
    setError("");
    const response = await scopedFetch("/api/work-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    if (!response.ok) setError(await errorMessage(response));
    else {
      const body = await response.json() as { workTask: WorkTask };
      if (body.workTask) setWorkTasks((current) => [body.workTask, ...current]);
      formElement.reset();
    }
    setTaskBusy("");
  }

  async function updateWorkTask(task: WorkTask, action: "complete" | "reopen" | "cancel") {
    setTaskBusy(action + ":" + task.id);
    setError("");
    const response = await scopedFetch(`/api/work-tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, action }),
    });
    if (!response.ok) setError(await errorMessage(response));
    else {
      const body = await response.json() as { workTask: WorkTask };
      if (body.workTask) setWorkTasks((current) => current.map((item) => item.id === task.id ? body.workTask : item));
    }
    setTaskBusy("");
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/organizations");
        if (!response.ok) throw new Error(await errorMessage(response));
        const body = await response.json() as { organizations: Organization[] };
        if (!active) return;
        setOrganizations(body.organizations);
        const first = body.organizations[0]?.id ?? "";
        setOrganizationId(first);
        if (first) await loadDashboard(first);
        else setLoading(false);
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : "工作台加载失败。");
          setLoading(false);
        }
      }
    })();
    return () => { active = false; };
  }, []);

  const activeMemos = useMemo(() => memos.filter((memo) => memo.status === "active"), [memos]);
  const activeWorkTasks = useMemo(() => workTasks.filter((task) => !["completed", "cancelled"].includes(task.status)), [workTasks]);
  const assignableEmployees = useMemo(() => dashboard?.team.filter((member) => member.role === "member") ?? [], [dashboard]);
  const publishedProgress = dashboard?.summary.monthlyContentTarget
    ? Math.min(100, Math.round(dashboard.summary.publishedMonth / dashboard.summary.monthlyContentTarget * 100))
    : 0;
  const assignedTaskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    activeWorkTasks.forEach((task) => counts.set(task.assignee_user_id, (counts.get(task.assignee_user_id) ?? 0) + 1));
    return counts;
  }, [activeWorkTasks]);
  const maxTeamLoad = Math.max(1, ...(dashboard?.team.map((member) => Number(member.open_tasks) + Number(member.active_jobs) + (assignedTaskCounts.get(member.id) ?? 0)) ?? [1]));

  const renderWorkTaskRows = (adminView: boolean) => workTasks.length ? <div className="dashboard-work-task-list">{workTasks.slice(0, 10).map((task) => {
    const progress = Math.min(100, Math.round(task.completed_count / Math.max(1, task.target_count) * 100));
    return <article className={`dashboard-work-task ${task.status} priority-${task.priority}`} key={task.id}>
      <header>
        <span className="dashboard-avatar">{task.assignee_name.slice(0, 1)}</span>
        <div><strong>{task.title}</strong><small>{task.assignee_name} · {task.project_name || "不限企业空间"} · {workTaskTypeLabels[task.task_type]}</small></div>
        <em>{workTaskStatusLabels[task.status]}</em>
      </header>
      <div className="dashboard-work-task-progress"><i style={{ width: `${progress}%` }} /></div>
      <footer>
        <span><b>{task.completed_count}</b> / {task.target_count} · 截止 {new Date(task.due_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        {adminView && !["completed", "cancelled"].includes(task.status) ? <button type="button" disabled={Boolean(taskBusy)} onClick={() => void updateWorkTask(task, "cancel")}><X aria-hidden="true" />取消</button> : null}
        {!adminView && task.task_type === "custom" && task.status !== "cancelled" ? <button type="button" disabled={Boolean(taskBusy)} onClick={() => void updateWorkTask(task, task.status === "completed" ? "reopen" : "complete")}>{task.status === "completed" ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}{task.status === "completed" ? "重新打开" : "完成任务"}</button> : null}
        {!adminView && task.task_type !== "custom" && !["completed", "cancelled"].includes(task.status) ? <Link href={workTaskHrefs[task.task_type]}>去完成 <ArrowRight aria-hidden="true" /></Link> : null}
      </footer>
    </article>;
  })}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><div><strong>{adminView ? "还没有布置任务" : "当前没有管理员任务"}</strong><span>{adminView ? "使用上方表单给员工安排今天的工作。" : "管理员下达任务后会出现在这里。"}</span></div></div>;

  const memoPanel = <article className="panel personal-memo-panel dashboard-memo-panel">
    <div className="panel-heading">
      <div><p className="section-kicker">仅自己可见</p><h2>我的备忘</h2></div>
      <span>{activeMemos.length} 条待处理</span>
    </div>
    <form className="personal-memo-create" onSubmit={addMemo}>
      <textarea name="content" rows={2} minLength={1} maxLength={2000} placeholder="记下一件需要跟进的事…" required />
      <button disabled={memoBusy === "create"}><NotebookPen aria-hidden="true" />{memoBusy === "create" ? "记录中" : "记下"}</button>
    </form>
    {memos.length ? <div className="personal-memo-list">{memos.slice(0, 6).map((memo) => <article className={memo.status === "completed" ? "completed" : ""} key={memo.id}>
      <button className="memo-check" type="button" aria-label={memo.status === "completed" ? "重新打开" : "标记完成"} disabled={Boolean(memoBusy)} onClick={() => void updateMemo(memo, memo.status === "completed" ? "reopen" : "complete")}>
        {memo.status === "completed" ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
      </button>
      <div><p>{memo.content}</p><small>{memo.project_name || "个人记录"}{memo.source_type === "performance_report" ? " · 来自报告建议" : ""}</small></div>
      <button className="memo-remove" type="button" aria-label="删除备忘" disabled={Boolean(memoBusy)} onClick={() => void removeMemo(memo)}><Trash2 aria-hidden="true" /></button>
    </article>)}</div> : <div className="personal-memo-empty">报告建议和手动记录会出现在这里。</div>}
  </article>;

  return <AppShell activePath="/">
    <main className="role-dashboard" aria-label="运营工作台">
      <section className="page-heading dashboard-role-heading">
        <div>
          <div className="dashboard-heading-meta">
            <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</span>
            {dashboard && <em>{dashboard.mode === "admin" ? "公司管理员" : "公司员工"}</em>}
          </div>
          <h1>{dashboard?.mode === "admin" ? "运营总览" : "我的工作台"}</h1>
          <p>{dashboard?.mode === "admin"
            ? "掌握全公司进度、任务积压和需要处理的异常。所有数字均来自当前公司真实业务记录。"
            : `${dashboard?.currentUser.displayName || "你好"}，这里仅展示分配给你的任务、分析与个人记录。`}</p>
        </div>
      </section>

      {organizations.length > 1 && <div className="management-toolbar dashboard-scope">
        <label>公司<select value={organizationId} onChange={async (event) => { setOrganizationId(event.target.value); await loadDashboard(event.target.value); }}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      </div>}
      {loading && <div className="management-state" role="status">正在汇总真实运营数据…</div>}
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {!loading && !organizationId && <section className="setup-card"><span className="setup-step">开始使用</span><h2>先创建公司和企业空间</h2><p>完成初始化后，工作台会自动汇总审核、发布、分析和内容进度。</p><Link className="primary-button link-button" href="/projects">创建公司空间</Link></section>}

      {dashboard && <>
        <section className="dashboard-command-center" aria-label={dashboard.mode === "admin" ? "公司今日状态" : "我的今日状态"}>
          <header>
            <div><span>今天先看这里</span><h2>{dashboard.mode === "admin" ? "公司推进状态" : "我的推进清单"}</h2></div>
            <small>{dashboard.mode === "admin" ? "先处理异常，再看进度" : "按截止时间优先处理"}</small>
          </header>
          <div className="dashboard-command-strip">
            <Link className={dashboard.summary.pendingReviews ? "dashboard-command-item urgent" : "dashboard-command-item"} href="/workflow?view=review">
              <ClipboardCheck aria-hidden="true" /><div><span>{dashboard.mode === "admin" ? "待审核" : "待我审核"}</span><strong>{dashboard.summary.pendingReviews}</strong><small>{dashboard.summary.pendingReviews ? "需要尽快决定" : "当前已清空"}</small></div><ArrowRight aria-hidden="true" />
            </Link>
            <Link className="dashboard-command-item" href="#work-tasks">
              <ListTodo aria-hidden="true" /><div><span>{dashboard.mode === "admin" ? "团队任务" : "管理员任务"}</span><strong>{activeWorkTasks.length}</strong><small>{dashboard.mode === "admin" ? "尚未完成的安排" : "今天需要完成"}</small></div><ArrowRight aria-hidden="true" />
            </Link>
            {deliveryPlan.features.videoAnalysis && <Link className={dashboard.summary.failedJobs ? "dashboard-command-item warning" : "dashboard-command-item"} href="/analysis">
              <PlayCircle aria-hidden="true" /><div><span>{dashboard.mode === "admin" ? "分析运行" : "我的分析"}</span><strong>{dashboard.summary.activeJobs}</strong><small>{dashboard.summary.failedJobs ? `${dashboard.summary.failedJobs} 个失败任务` : "运行状态正常"}</small></div><ArrowRight aria-hidden="true" />
            </Link>}
          </div>
        </section>

        {dashboard.mode === "admin" ? <section className="dashboard-layout dashboard-admin-layout">
          <div className="dashboard-primary-column">
            <article className="panel dashboard-assignment-panel" id="work-tasks">
              <div className="panel-heading"><div><p className="section-kicker">工作安排</p><h2>给员工布置任务</h2></div><span>{activeWorkTasks.length} 项未完成</span></div>
              <form className="dashboard-assignment-form" onSubmit={assignWorkTask}>
                <label>员工<select name="assigneeUserId" required defaultValue=""><option value="" disabled>选择员工</option>{assignableEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label>
                <label>企业空间<select name="projectId" defaultValue={dashboard.projects[0]?.id ?? ""}><option value="">仅自定义任务可不限</option>{dashboard.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
                <label>任务类型<select name="taskType" required defaultValue="video_analysis"><option value="video_analysis">视频分析</option><option value="topic">选题生产</option><option value="content">内容生产</option><option value="review">内容审核</option><option value="publish">作品发布</option><option value="custom">自定义任务</option></select></label>
                <label>数量<input name="targetCount" type="number" min="1" max="100" defaultValue="1" required /></label>
                <label>截止时间<input name="dueAt" type="datetime-local" required /></label>
                <label>优先级<select name="priority" defaultValue="normal"><option value="normal">普通</option><option value="high">重要</option><option value="urgent">紧急</option><option value="low">低</option></select></label>
                <label className="dashboard-assignment-note">任务说明<input name="description" maxLength={1000} placeholder="补充要求，可不填" /></label>
                <button type="submit" disabled={taskBusy === "create" || !assignableEmployees.length}><Target aria-hidden="true" />{taskBusy === "create" ? "下达中…" : "下达任务"}</button>
              </form>
              <p className="dashboard-assignment-help">视频分析、选题、内容、审核和发布按真实业务记录自动统计；自定义任务由员工手动完成。</p>
              {renderWorkTaskRows(true)}
            </article>

            <article className="panel dashboard-list-panel">
              <div className="panel-heading"><div><p className="section-kicker">需要决定</p><h2>待审核内容</h2></div><Link href="/workflow?view=review">查看全部</Link></div>
              {dashboard.reviews.length ? <div className="dashboard-review-list">{dashboard.reviews.map((item) => <Link href={`/workflow?view=review&organizationId=${encodeURIComponent(organizationId)}&contentId=${encodeURIComponent(item.content_id)}`} key={item.id}>
                <span className={dueTone(item.due_at)}><ClipboardCheck aria-hidden="true" /></span>
                <div><strong>{item.title}</strong><small>{item.project_name} · 内部审核</small></div>
                <time className={dueTone(item.due_at)}>{dateText(item.due_at)}</time>
              </Link>)}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><div><strong>审核队列已清空</strong><span>暂时没有需要管理员决定的内容。</span></div></div>}
            </article>

            {deliveryPlan.features.videoAnalysis && <article className="panel jobs-panel dashboard-jobs-panel">
              <div className="panel-heading"><div><p className="section-kicker">异常与运行</p><h2>最近分析任务</h2></div><Link href="/analysis">全部</Link></div>
              {dashboard.jobs.length ? dashboard.jobs.map((job) => <div className="job" key={job.id}>
                <span className={`job-icon ${job.status === "completed" ? "complete" : job.status === "failed" ? "error" : ""}`}>{job.status === "failed" ? "!" : "影"}</span>
                <div><strong>{job.title || "未命名分析任务"}</strong><small>{job.project_name} · {job.current_stage || job.status}</small>{!["completed", "partial", "failed", "cancelled"].includes(job.status) && <div className="progress-track small"><i style={{ width: `${job.progress}%` }} /></div>}</div>
                <em>{job.status === "failed" ? "失败" : jobLabel(job.status)}</em>
              </div>) : <div className="dashboard-empty">还没有分析任务。</div>}
            </article>}
          </div>

          <aside className="dashboard-secondary-column">
            <article className="panel dashboard-team-panel">
              <div className="panel-heading"><div><p className="section-kicker">团队负载</p><h2>谁需要协调</h2></div><Link href="/members">成员管理</Link></div>
              {dashboard.team.length ? <div className="dashboard-team-list">{dashboard.team.map((member) => {
                const assignedTasks = assignedTaskCounts.get(member.id) ?? 0;
                const load = Number(member.open_tasks) + Number(member.active_jobs) + assignedTasks;
                return <article key={member.id}>
                  <span className="dashboard-avatar">{member.name.slice(0, 1)}</span>
                  <div><strong>{member.name}</strong><span><i style={{ width: `${Math.max(4, Math.round(load / maxTeamLoad * 100))}%` }} /></span></div>
                  <p><b>{Number(member.open_tasks) + assignedTasks}</b> 待办{Number(member.due_soon) ? <em>{Number(member.due_soon)} 临期</em> : null}</p>
                </article>;
              })}</div> : <div className="dashboard-empty">暂时没有团队负载数据。</div>}
            </article>

            {memoPanel}

            <article className="panel dashboard-project-panel">
              <div className="panel-heading"><div><p className="section-kicker">企业空间</p><h2>本月目标与积压</h2></div><Link href="/projects">管理空间</Link></div>
              {dashboard.projects.length ? <div className="dashboard-project-list">{dashboard.projects.map((project) => {
                const target = Number(project.content_target);
                const completed = Number(project.published_month);
                const progress = target ? Math.min(100, Math.round(completed / target * 100)) : 0;
                return <article key={project.id}>
                  <div><strong>{project.name}</strong><span>{Number(project.open_items)} 条进行中</span></div>
                  <div className="dashboard-project-progress"><i style={{ width: `${progress}%` }} /></div>
                  <small><b>{completed}</b> / {target || "未设目标"}</small>
                </article>;
              })}</div> : <div className="dashboard-empty">还没有可用的企业空间。</div>}
            </article>

          </aside>
        </section> : <section className="dashboard-layout dashboard-employee-layout">
          <div className="dashboard-primary-column">
            <article className="panel dashboard-assigned-panel" id="work-tasks">
              <div className="panel-heading"><div><p className="section-kicker">管理员下达</p><h2>我的工作任务</h2></div><span>{activeWorkTasks.length} 项未完成</span></div>
              {renderWorkTaskRows(false)}
            </article>

            <article className="panel dashboard-list-panel">
              <div className="panel-heading"><div><p className="section-kicker">内容流转</p><h2>我的内容任务</h2></div><Link href="/content">进入内容生产</Link></div>
              {dashboard.tasks.length ? <div className="dashboard-task-list">{dashboard.tasks.map((task) => <Link href={`/content?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(task.project_id)}`} key={task.id}>
                <span className={dueTone(task.due_at)}><FilePenLine aria-hidden="true" /></span>
                <div><strong>{task.title}</strong><small>{task.project_name} · {taskStatusLabels[task.status] || task.status}</small></div>
                <time className={dueTone(task.due_at)}>{task.due_at ? `截止 ${dateText(task.due_at)}` : "未设截止"}</time>
                <ArrowRight aria-hidden="true" />
              </Link>)}</div> : <div className="dashboard-empty dashboard-clear-state"><CheckCircle2 aria-hidden="true" /><div><strong>当前没有待办内容</strong><span>新任务分配给你后会出现在这里。</span></div></div>}
            </article>

            {deliveryPlan.features.videoAnalysis && <article className="panel jobs-panel dashboard-jobs-panel">
              <div className="panel-heading"><div><p className="section-kicker">我的产出</p><h2>最近分析任务</h2></div><Link href="/analysis">查看全部</Link></div>
              {dashboard.jobs.length ? dashboard.jobs.map((job) => <div className="job" key={job.id}>
                <span className={`job-icon ${job.status === "completed" ? "complete" : job.status === "failed" ? "error" : ""}`}>{job.status === "failed" ? "!" : "影"}</span>
                <div><strong>{job.title || "未命名分析任务"}</strong><small>{job.project_name} · {job.current_stage || job.status}</small>{!["completed", "partial", "failed", "cancelled"].includes(job.status) && <div className="progress-track small"><i style={{ width: `${job.progress}%` }} /></div>}</div>
                <em>{job.status === "failed" ? "失败" : job.status === "completed" ? "完成" : `${job.progress}%`}</em>
              </div>) : <div className="dashboard-empty">你还没有分析任务。</div>}
            </article>}
          </div>

          <aside className="dashboard-secondary-column">
            {memoPanel}
            {dashboard.reviews.length > 0 && <article className="panel dashboard-list-panel dashboard-my-review-panel">
              <div className="panel-heading"><div><p className="section-kicker">需要我决定</p><h2>待我审核</h2></div><Link href="/workflow?view=review">审核中心</Link></div>
              <div className="dashboard-review-list">{dashboard.reviews.slice(0, 4).map((item) => <Link href="/workflow?view=review" key={item.id}><span><ClipboardCheck aria-hidden="true" /></span><div><strong>{item.title}</strong><small>{item.project_name}</small></div><time>{dateText(item.due_at)}</time></Link>)}</div>
            </article>}
            <article className="panel dashboard-personal-progress">
              <div className="panel-heading"><div><p className="section-kicker">本月产出</p><h2>我的发布进度</h2></div><BarChart3 aria-hidden="true" /></div>
              <strong>{dashboard.summary.publishedMonth}<small> 条已发布</small></strong>
              <div className="progress-track"><i style={{ width: `${publishedProgress}%` }} /></div>
              <p>{dashboard.summary.monthlyContentTarget ? `所在企业空间目标合计 ${dashboard.summary.monthlyContentTarget} 条` : "企业空间暂未设置月目标"}</p>
            </article>
          </aside>
        </section>}
      </>}
    </main>
  </AppShell>;
}
