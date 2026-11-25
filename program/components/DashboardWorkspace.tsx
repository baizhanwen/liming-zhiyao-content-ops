"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, CalendarClock, CheckCheck, ChevronDown, ClipboardList, Handshake, ListFilter, NotebookPen, PencilLine, Plus } from "lucide-react";
import { loadClientOrganizations, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { readApiError } from "../lib/client-format";
import type { WorkTask, WorkTaskBoard } from "../lib/work-tasks";
import { deadlineState, summarizeWorkTasks } from "../lib/work-progress-view";
import { workProgressActions, workProgressStatuses, workProgressTypes } from "../lib/work-progress-labels";
import { ModuleHeader } from "./ModuleHeader";
import { AppShell } from "./AppShell";
import { PersonalMemoDialog } from "./PersonalMemoDialog";
import { WorkProgressDialogs, type WorkProgressDialogTarget } from "./WorkProgressDialogs";
import "./dashboard-workspace.css";

type Organization = { id: string; name: string };
type Filters = { assignee: string; project: string; status: string; type: string; deadline: string };
const allFilters: Filters = { assignee: "", project: "", status: "", type: "", deadline: "" };
const pageSize = 15;
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const timeText = (date: string) => timeFormat.format(new Date(date));
const dateTitle = (date: string) => new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function matchesFilters(task: WorkTask, filters: Filters, now: number) {
  if (filters.assignee && task.assignee_user_id !== filters.assignee) return false;
  if (filters.project && (task.project_id ?? "internal") !== filters.project) return false;
  if (filters.status && task.workflow_status !== filters.status) return false;
  if (filters.type && task.task_type !== filters.type) return false;
  if (filters.deadline === "week") {
    const due = Date.parse(task.due_at);
    return due >= now && due < now + 7 * 86400000;
  }
  return !filters.deadline || deadlineState(task, now) === filters.deadline;
}

function Filter({ label, value, any, choices, onChange }: {
  label: string; value: string; any: string; choices: [string, string][]; onChange: (value: string) => void;
}) {
  return <label className="wp-filter"><span>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{any}</option>{choices.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
  </select></label>;
}

function TaskBoard({ organizationId, requestedProject, organizationSelector }: {
  organizationId: string; requestedProject: string; organizationSelector: React.ReactNode;
}) {
  const [board, setBoard] = useState<WorkTaskBoard | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState<Filters>({ ...allFilters, project: requestedProject });
  const [limit, setLimit] = useState(pageSize);
  const [dialog, setDialog] = useState<WorkProgressDialogTarget>(null);
  const [showMemos, setShowMemos] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!organizationId) return;
    const controller = new AbortController();
    (async () => {
      const response = await scopedFetch("/api/work-tasks?organizationId=" + encodeURIComponent(organizationId), { signal: controller.signal });
      if (!response.ok) {
        if (!controller.signal.aborted && [401, 403, 404].includes(response.status)) {
          setBoard(null); setDialog(null); setShowMemos(false);
        }
        throw new Error(await readApiError(response, "工作进度加载失败。"));
      }
      const body = await response.json() as WorkTaskBoard;
      if (!controller.signal.aborted) { setBoard(body); setNow(Date.now()); setError(""); }
    })().catch(reason => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "工作进度加载失败。");
      }
    });
    return () => controller.abort();
  }, [organizationId, refresh]);
  useEffect(() => {
    function sync() {
      if (document.visibilityState === "visible") setRefresh(value => value + 1);
    }
    const timer = window.setInterval(sync, 60_000);
    document.addEventListener("visibilitychange", sync);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, []);
  function changeFilter(key: keyof Filters, value: string) {
    setFilters(current => ({ ...current, [key]: value }));
    setLimit(pageSize);
  }
  function clearFilters() { setFilters(allFilters); setLimit(pageSize); }

  const tasks = useMemo(() => (board?.workTasks ?? []).filter(task => matchesFilters(task, filters, now)), [board, filters, now]);
  const summary = summarizeWorkTasks(tasks, now);
  const visibleIds = new Set(tasks.map(task => task.id));
  const updates = board?.recentUpdates.filter(update => visibleIds.has(update.task_id)) ?? [];
  const filtered = Object.values(filters).some(Boolean);
  const isAdmin = board?.canAssign === true;
  const employees = new Map(board?.employees.map(item => [item.id, item.name]));
  for (const task of board?.workTasks ?? []) {
    if (!employees.has(task.assignee_user_id)) employees.set(task.assignee_user_id, task.assignee_name);
  }
  const reload = () => { setError(""); setRefresh(value => value + 1); };
  return <>
    <ModuleHeader title="工作进度台" actions={
      <div className="wp-actions">{organizationSelector}{board && <>
        <button type="button" className="wp-button" aria-haspopup="dialog" onClick={() => setShowMemos(true)}><NotebookPen />我的备忘</button>
        {isAdmin && <button type="button" className="wp-button primary" aria-haspopup="dialog" onClick={() => setDialog({ kind: "create" })}><Plus />新建任务</button>}
      </>}</div>
    } />
    {error && <div className="wp-message" role="alert">{error}<button type="button" onClick={reload}>重新加载</button></div>}
    {!board && !error && <p className="wp-message" role="status">正在加载工作进度…</p>}
    {board && <>
      <section aria-label="任务摘要" className="wp-metrics">
        <div className="wp-metric"><span><ClipboardList />未完成任务</span><strong>{summary.open}<small>项</small></strong></div>
        <div className="wp-metric"><span><CalendarClock />今日待到期 / 已逾期</span><strong>{summary.today}<i>/</i><b className={summary.overdue ? "wp-late" : ""}>{summary.overdue}</b><small>项</small></strong></div>
        <div className="wp-metric"><span><Handshake />等待协作</span><strong>{summary.waiting}<small>项</small></strong></div>
        <div className="wp-metric wp-average"><span><Activity />{summary.unknown ? "已填任务平均进度" : "整体进度"}</span><strong>{summary.average === null ? "—" : summary.average + "%"}<small>已填 {summary.known} 项 · 待填 {summary.unknown} 项</small></strong></div>
      </section>
      <section className="wp-task-panel" id="work-tasks" aria-labelledby="wp-list-title">
        <header className="wp-panel-head"><h2 id="wp-list-title">{isAdmin ? "团队任务" : "我的任务"}</h2><span aria-live="polite">{filtered ? "筛选结果" : "全部任务"} · {tasks.length} 项</span></header>
        <div className="wp-filters">
          {isAdmin && <Filter label="员工" any="全部员工" choices={[...employees.entries()]} value={filters.assignee} onChange={value => changeFilter("assignee", value)} />}
          <Filter label="企业空间" any="全部空间" choices={[["internal", "公司内部"], ...board.projects.map(({ id, name }): [string, string] => [id, name])]} value={filters.project} onChange={value => changeFilter("project", value)} />
          <Filter label="状态" any="全部状态" choices={Object.entries(workProgressStatuses)} value={filters.status} onChange={value => changeFilter("status", value)} />
          <Filter label="任务类型" any="全部类型" choices={Object.entries(workProgressTypes)} value={filters.type} onChange={value => changeFilter("type", value)} />
          <Filter label="截止时间" any="全部日期" choices={[["today", "今日待到期"], ["overdue", "已逾期"], ["week", "未来 7 天"]]} value={filters.deadline} onChange={value => changeFilter("deadline", value)} />
          {filtered && <button type="button" className="wp-text-button" onClick={clearFilters}>清除筛选</button>}
        </div>
        {tasks.length ? <div className="wp-task-table"><div className="wp-columns wp-table-head" aria-hidden="true"><span>任务 / 空间</span><span>负责人</span><span>截止时间</span><span>状态</span><span>工作进度</span><span>最近更新</span></div>
          <ul>{tasks.slice(0, limit).map(task => {
            const due = deadlineState(task, now);
            const canReport = task.assignee_user_id === board.currentUserId && task.workflow_status !== "completed" && task.workflow_status !== "cancelled";
            return <li key={task.id} className="wp-columns wp-task-row">
              <div className="wp-task-name"><button type="button" title={task.title} onClick={() => setDialog({ kind: "detail", taskId: task.id })}>{task.title}</button>
                <small>{task.project_name || "公司内部"} · {workProgressTypes[task.task_type]}</small></div>
              <span className="wp-owner"><span className="wp-mobile-label">负责人</span>{task.assignee_name}</span>
              <div className="wp-date"><span className="wp-mobile-label">截止时间</span><time dateTime={task.due_at} title={dateTitle(task.due_at)}>{timeText(task.due_at)}</time>{due && <small className={due === "overdue" ? "wp-late" : "wp-soon"}>{due === "overdue" ? "已逾期" : "今日到期"}</small>}</div>
              <div className="wp-state-cell"><span className={"wp-state " + task.workflow_status}>{workProgressStatuses[task.workflow_status]}</span></div>
              <div className="wp-progress"><span className="wp-mobile-label">工作进度</span>{task.workflow_status === "cancelled" ? <span>—</span> : task.progress_percent == null ? <span className="wp-unreported">待更新</span> : <>
                <strong>{task.progress_percent}%</strong><progress aria-label="工作进度" value={task.progress_percent} max={100} /></>}</div>
              <div className="wp-updated"><span className="wp-mobile-label">最近更新</span><time dateTime={task.updated_at} title={dateTitle(task.updated_at)}>{timeText(task.updated_at)}</time>
                {canReport && <button type="button" className="wp-text-button" onClick={() => setDialog({ kind: "update", taskId: task.id })}><PencilLine size={12} />更新进度</button>}</div>
            </li>;
          })}</ul>{tasks.length > limit && <button type="button" className="wp-load-more" onClick={() => setLimit(count => count + pageSize)}>显示更多任务（已显示 {limit} / {tasks.length}）</button>}
        </div> : <div className="wp-empty">{filtered ? <ListFilter /> : <ClipboardList />}<strong>{filtered ? "没有符合筛选条件的任务" : isAdmin ? "还没有团队任务" : "还没有分配给你的任务"}</strong>
          {filtered ? <button className="wp-text-button" type="button" onClick={clearFilters}>查看全部任务</button> : isAdmin && <span>点击“新建任务”，为员工安排第一项工作。</span>}</div>}
      </section>
      <details className="wp-recent"><summary><CheckCheck /><strong>最近动态</strong><ChevronDown className="wp-chevron" /></summary>
        {updates.length ? <ul>{updates.map(update => <li key={update.id}><div><button type="button" className="wp-text-button" onClick={() => setDialog({ kind: "detail", taskId: update.task_id })}>{update.title}</button>
          <small>{update.actor_name} · {workProgressActions[update.action]} · {workProgressStatuses[update.status]}{update.progress_percent != null && " · " + (update.previous_percent == null ? "" : update.previous_percent + "% → ") + update.progress_percent + "%"}</small></div>
          <time dateTime={update.created_at}>{timeText(update.created_at)}</time></li>)}</ul> : <p>{filtered ? "最近动态中没有符合当前筛选的记录。" : "暂无任务更新记录。"}</p>}
      </details>
      <WorkProgressDialogs target={dialog} organizationId={organizationId} currentUserId={board.currentUserId} isAdmin={isAdmin} employees={board.employees} projects={board.projects} onClose={() => setDialog(null)} onSaved={reload} />
      {showMemos && <PersonalMemoDialog organizationId={organizationId} onClose={() => setShowMemos(false)} />}
    </>}
  </>;
}

function OrganizationBoard({ requestedOrg, requestedProject }: { requestedOrg: string; requestedProject: string }) {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    loadClientOrganizations<Organization>(requestedOrg).then(result => {
      if (!active) return;
      setOrganizations(result.organizations);
      if (result.selected) rememberCurrentScope(result.selected);
      setOrganizationId(result.selected); setReady(true);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "公司信息加载失败。"); });
    return () => { active = false; };
  }, [requestedOrg, retry]);
  const selector = organizations.length > 1 && <select className="wp-company" aria-label="公司" value={organizationId} onChange={e => {
    const selected = e.target.value;
    router.replace("/?organizationId=" + encodeURIComponent(selected));
  }}>{organizations.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</select>;
  return <section className="work-progress-home" aria-label="工作进度台">
    {ready && organizationId ? <TaskBoard key={organizationId + "/" + requestedProject} organizationId={organizationId} requestedProject={requestedOrg && requestedOrg !== organizationId ? "" : requestedProject} organizationSelector={selector} /> :
      <><ModuleHeader title="工作进度台" />{error ? <div className="wp-message" role="alert">{error}<button type="button" onClick={() => { setError(""); setRetry(v => v + 1); }}>重新加载</button></div> :
        <p className="wp-message" role="status">{ready ? "当前账号尚未加入公司。" : "正在加载工作进度…"}</p>}</>}
  </section>;
}

export function DashboardWorkspace() {
  const query = useSearchParams();
  const requestedOrg = query?.get("organizationId") ?? "";
  const requestedProject = query?.get("projectId") ?? "";
  return <AppShell activePath="/"><OrganizationBoard key={requestedOrg} requestedOrg={requestedOrg} requestedProject={requestedProject} /></AppShell>;
}
