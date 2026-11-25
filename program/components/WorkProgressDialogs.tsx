"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, Check, X } from "lucide-react";
import { readApiError } from "../lib/client-format";
import { scopedFetch } from "../lib/client-scope";
import { deliveryPlan } from "../lib/delivery-entitlements";
import { workProgressActions, workProgressPriorities, workProgressStatuses, workProgressTypes } from "../lib/work-progress-labels";
import type { WorkTask, WorkTaskBoard, WorkTaskHistory, WorkTaskStatus } from "../lib/work-tasks";
import "./work-progress-dialogs.css";

export type WorkProgressDialogTarget = { kind: "create" } | { kind: "detail" | "update"; taskId: string } | null;

type Props = {
  target: WorkProgressDialogTarget;
  organizationId: string;
  currentUserId: string;
  isAdmin: boolean;
  employees: WorkTaskBoard["employees"];
  projects: WorkTaskBoard["projects"];
  onClose: () => void;
  onSaved: () => void;
};

type TaskDetail = { workTask: WorkTask; history: WorkTaskHistory[] };
type ReportStatus = Exclude<WorkTaskStatus, "cancelled">;

const workTaskPaths = {
  video_analysis: "/analysis", topic: "/studio?view=inspiration", content: "/studio?view=drafts",
  review: "/workflow?view=review", publish: "/workflow?view=publish",
};
const timestamp = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timestamp.format(date) : "—";
}

function taskHref(task: WorkTask) {
  if (task.task_type === "custom" || (task.task_type === "video_analysis" && !deliveryPlan.features.videoAnalysis)) return null;
  const [path, query] = workTaskPaths[task.task_type].split("?");
  const params = new URLSearchParams(query);
  params.set("organizationId", task.organization_id);
  if (task.project_id) params.set("projectId", task.project_id);
  return path + "?" + params.toString();
}

function DialogFrame({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current;
    const opener = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={element} className="wpd-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="wpd-dialog-layout">
      <header className="wpd-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="wpd-icon" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X aria-hidden="true" /></button></header>
      {children}
    </div>
  </dialog>;
}

function useSaveTask(onSaved: () => void, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const lastRequest = useRef({ fingerprint: "", id: "" });
  useEffect(() => () => pending.current?.abort(), []);
  function clearError() { setError(""); setConflict(false); }
  async function save(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    clearError();
    try {
      const fingerprint = JSON.stringify(body);
      if (lastRequest.current.fingerprint !== fingerprint) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
        lastRequest.current = { fingerprint, id };
      }
      const response = await scopedFetch(path, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, requestId: lastRequest.current.id }), signal: controller.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        if (controller.signal.aborted) return;
        setConflict(result?.error?.code === "TASK_REVISION_CONFLICT");
        throw new Error(result?.error?.message || "保存失败，请重试。");
      }
      if (!controller.signal.aborted) { onSaved(); onClose(); }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "连接失败，请重试。");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, conflict, clearError, save };
}

export function WorkProgressDialogs(props: Props) {
  const { target, organizationId } = props;
  if (!organizationId || !target) return null;
  if (target.kind === "create") return props.isAdmin ? <CreateTask key={organizationId} {...props} /> : null;
  return <TaskDialog key={[organizationId, target.taskId, target.kind].join("/")} {...props} taskId={target.taskId} initialUpdate={target.kind === "update"} />;
}

function CreateTask({ organizationId, employees, projects, onClose, onSaved }: Props) {
  const formId = useId();
  const [assignee, setAssignee] = useState("");
  const [project, setProject] = useState("");
  const [type, setType] = useState<WorkTask["task_type"]>("custom");
  const { busy, error, save } = useSaveTask(onSaved, onClose);
  const eligibleProjects = projects.filter(item => item.memberIds.includes(assignee));
  const hasCounter = type !== "custom" && !!project;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      organizationId, assigneeUserId: assignee, projectId: project, taskType: type,
      title: String(form.get("title")).trim(), description: String(form.get("description") || "").trim(),
      deliveryRequirements: String(form.get("deliveryRequirements") || "").trim(), priority: String(form.get("priority")),
      dueAt: new Date(String(form.get("dueAt")) + "+08:00").toISOString(), targetCount: Number(form.get("targetCount") || 1),
    };
    void save("/api/work-tasks", "POST", body);
  }

  return <DialogFrame title="新建任务" busy={busy} onClose={onClose}>
    <div className="wpd-dialog-body">
      <form id={formId} onSubmit={submit}>
        <fieldset className="wpd-fields" disabled={busy}>
          <label className="wpd-wide">任务标题<input name="title" required pattern=".*\S.*" maxLength={160} placeholder="例如：整理本周客户访谈纪要" /></label>
          <label>负责人<select name="assigneeUserId" required value={assignee} onChange={event => {
            const id = event.target.value;
            setAssignee(id);
            if (!projects.find(item => item.id === project)?.memberIds.includes(id)) setProject("");
          }}><option value="" disabled>选择员工</option>{employees.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>截止时间（北京时间）<input type="datetime-local" name="dueAt" max="9999-12-31T23:59" required /></label>
          <label>优先级<select name="priority" defaultValue="normal">{Object.entries(workProgressPriorities).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
          <label>企业空间<select name="projectId" value={project} onChange={event => setProject(event.target.value)}><option value="">公司内部工作</option>{eligibleProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className={hasCounter ? "" : "wpd-wide"}>任务类型<select name="taskType" value={type} onChange={event => setType(event.target.value as WorkTask["task_type"])}>{Object.entries(workProgressTypes).filter(([key]) => key !== "video_analysis" || deliveryPlan.features.videoAnalysis).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
          {hasCounter && <label>业务目标数量<input type="number" name="targetCount" min="1" max="100" defaultValue="1" required /></label>}
          {type !== "custom" && !project && <p className="wpd-wide wpd-hint">选择企业空间后，可同步统计该空间的业务完成数量。</p>}
          <label className="wpd-wide">任务说明<textarea name="description" rows={2} maxLength={1000} placeholder="写下要做的具体工作" /></label>
          <label className="wpd-wide">交付要求<textarea name="deliveryRequirements" rows={2} maxLength={1000} placeholder="需要交付什么，达到什么标准？" /></label>
        </fieldset>
      </form>
    </div>
    <footer className="wpd-dialog-foot">
      {!employees.length && <p className="wpd-hint">当前公司暂无可选员工。请先在成员管理中添加员工。</p>}
      {error && <p role="alert" className="wpd-error">{error}</p>}
      <div className="wpd-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="wpd-primary" form={formId} disabled={busy || !employees.length} aria-busy={busy}>{busy ? "正在派发…" : "派发任务"}</button></div>
    </footer>
  </DialogFrame>;
}

function DeliveryLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return <span>{url}</span>;
  return <a className="wpd-link" href={url} rel="noopener noreferrer" target="_blank">{url}<ArrowUpRight aria-hidden="true" /></a>;
}

function TaskSummary({ task }: { task: WorkTask }) {
  return <section className="wpd-task-summary">
    <h3>{task.title}</h3>
    <div className="wpd-task-tags"><span>{workProgressStatuses[task.workflow_status]}</span>{task.is_overdue && <span className="wpd-overdue">已逾期</span>}<span>{workProgressPriorities[task.priority]}优先级</span></div>
    <dl className="wpd-meta">
      <div><dt>负责人</dt><dd>{task.assignee_name}</dd></div><div><dt>截止时间</dt><dd>{formatTime(task.due_at)}</dd></div>
      <div><dt>企业空间</dt><dd>{task.project_name || "公司内部工作"}</dd></div><div><dt>任务类型</dt><dd>{workProgressTypes[task.task_type]}</dd></div>
    </dl>
    <div className="wpd-progress">
      <div><span>任务进度</span><strong>{task.progress_percent === null ? "待更新" : task.progress_percent + "%"}</strong></div>
      {task.progress_percent !== null && <progress max={100} value={task.progress_percent} aria-label="任务进度" />}
    </div>
    {task.task_type !== "custom" && task.project_id && <p className="wpd-counter">系统业务计数 <strong>{task.completed_count} / {task.target_count}</strong></p>}
  </section>;
}

function TaskHistory({ history }: { history: WorkTaskHistory[] }) {
  return <section className="wpd-section"><h4>更新记录</h4>
    {history.length ? <ol className="wpd-history">{history.map(item => <li key={item.id}>
      <div className="wpd-history-head"><strong>{item.actor_name}</strong><span>{workProgressActions[item.action]}</span><time dateTime={item.created_at}>{formatTime(item.created_at)}</time></div>
      <div className="wpd-history-change">{workProgressStatuses[item.status]}{item.action !== "created" && <span> · {item.previous_percent === null ? "待更新" : item.previous_percent + "%"} → {item.progress_percent === null ? "待更新" : item.progress_percent + "%"}</span>}</div>
      {item.note && <p>{item.note}</p>}{item.next_step && <p>下一步 · {item.next_step}</p>}{item.blocker && <p>阻塞 · {item.blocker}</p>}
      {item.delivery_url && <DeliveryLink url={item.delivery_url} />}
    </li>)}</ol> : <p className="wpd-hint">暂无更新记录</p>}
  </section>;
}

function TaskDescription({ detail }: { detail: TaskDetail }) {
  const { workTask: task, history } = detail;
  return <>
    <section className="wpd-section"><h4>任务说明</h4><p>{task.description || "未填写"}</p><h4>交付要求</h4><p>{task.delivery_requirements || "未填写"}</p></section>
    {(task.progress_note || task.next_step || task.blocker || task.delivery_url) && <section className="wpd-section"><h4>最近进展</h4>
      {task.progress_note && <p>{task.progress_note}</p>}
      {task.next_step && <p>下一步 · {task.next_step}</p>}{task.blocker && <p>阻塞 · {task.blocker}</p>}
      {task.delivery_url && <div>成果链接 · <DeliveryLink url={task.delivery_url} /></div>}
    </section>}
    <TaskHistory history={history} />
  </>;
}

function ReportForm({ id, task, initialStatus, busy, submit }: {
  id: string; task: WorkTask; initialStatus: ReportStatus; busy: boolean; submit: (body: Record<string, unknown>) => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [percent, setPercent] = useState(initialStatus === "completed" ? "100" : String(task.progress_percent ?? ""));
  const progressInput = useRef<HTMLInputElement>(null);
  useEffect(() => { progressInput.current?.focus({ preventScroll: true }); }, []);
  function changeStatus(value: ReportStatus) {
    setStatus(value);
    if (value === "completed") setPercent("100");
    else if (value === "pending") setPercent("0");
    else if (percent === "100") setPercent("");
  }
  function changePercent(value: string) {
    setPercent(value);
    if (value === "100") setStatus("completed");
    else if (status === "completed" || (status === "pending" && Number(value) > 0)) setStatus("in_progress");
  }
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    submit({ action: "report", status, progressPercent: Number(percent), note: form.get("note"), nextStep: form.get("nextStep"), blocker: form.get("blocker"), deliveryUrl: form.get("deliveryUrl") });
  }
  return <form id={id} onSubmit={send} className="wpd-report-form"><fieldset className="wpd-fields" disabled={busy}>
    <label>本次进度（%）<input ref={progressInput} name="progressPercent" type="number" inputMode="numeric" min="0" max="100" step="1" required value={percent} placeholder="0–100" onChange={event => changePercent(event.target.value)} /></label>
    <label>任务状态<select name="status" value={status} onChange={event => changeStatus(event.target.value as ReportStatus)}>{Object.entries(workProgressStatuses).filter(([key]) => key !== "cancelled").map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
    <label className="wpd-wide">本次进展<textarea name="note" required maxLength={1000} rows={3} placeholder={task.progress_percent !== null && Number(percent) < task.progress_percent ? "请说明下调进度的原因" : "写下本次完成的工作"} /></label>
    <label className="wpd-wide">下一步<textarea name="nextStep" maxLength={1000} rows={2} defaultValue={task.next_step || ""} /></label>
    {status === "waiting" && <label className="wpd-wide">等待谁协作，或遇到了什么阻塞？<textarea name="blocker" maxLength={1000} rows={2} required defaultValue={task.blocker || ""} /></label>}
    <label className="wpd-wide">成果链接（选填）<input name="deliveryUrl" type="url" pattern="https?://.+" maxLength={2048} placeholder="https://" defaultValue={task.delivery_url || ""} /></label>
  </fieldset></form>;
}

function TaskDialog({ organizationId, currentUserId, isAdmin, initialUpdate, taskId, onClose, onSaved }: Props & { initialUpdate: boolean; taskId: string }) {
  const path = "/api/work-tasks/" + encodeURIComponent(taskId);
  const formId = useId();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [readError, setReadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(initialUpdate);
  const [markComplete, setMarkComplete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { busy, error, conflict, clearError, save } = useSaveTask(onSaved, onClose);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await scopedFetch(path + "?organizationId=" + encodeURIComponent(organizationId), { signal: controller.signal });
        if (!response.ok) throw new Error(await readApiError(response));
        const data = await response.json() as TaskDetail;
        if (!controller.signal.aborted) setDetail(data);
      } catch (reason) {
        if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "任务读取失败。");
      }
    })();
    return () => controller.abort();
  }, [attempt, path, organizationId]);
  const task = detail?.workTask;
  const owner = !!task && task.assignee_user_id === currentUserId;
  const open = !!task && task.workflow_status !== "completed" && task.workflow_status !== "cancelled";
  const showForm = !!task && open && owner && editing;
  const href = task && open && owner ? taskHref(task) : null;
  function refresh() { clearError(); setReadError(""); setDetail(null); setConfirmCancel(false); setMarkComplete(false); setAttempt(value => value + 1); }
  function update(body: Record<string, unknown>) { if (task) void save(path, "PATCH", { ...body, organizationId, expectedRevision: task.revision }); }
  function edit(complete: boolean) { setMarkComplete(complete); setEditing(true); clearError(); bodyRef.current?.scrollTo({ top: 0 }); }

  return <DialogFrame title={showForm ? "更新进度" : "任务详情"} busy={busy} onClose={onClose}>
    <div className="wpd-dialog-body" ref={bodyRef}>
      {readError ? <p className="wpd-error" role="alert">{readError}</p> : !detail || !task ? <p className="wpd-hint" role="status">正在读取任务…</p> : <>
        <TaskSummary task={task} />
        {showForm ? <ReportForm id={formId} task={task} busy={busy} initialStatus={markComplete ? "completed" : task.workflow_status as ReportStatus} submit={update} /> : <TaskDescription detail={detail} />}
      </>}
    </div>
    <footer className="wpd-dialog-foot">
      {error && <p className="wpd-error" role="alert">{error}</p>}
      {confirmCancel && <p className="wpd-hint">取消后将停止填报并保留已有记录。确认取消这项任务？</p>}
      <div className="wpd-actions">
        {readError && <button type="button" onClick={refresh}>重新读取</button>}
        {conflict ? <button type="button" onClick={refresh}>{showForm ? "放弃本次填写并读取最新进度" : "读取最新进度"}</button> : task && (confirmCancel ? <>
          <button type="button" disabled={busy} onClick={() => { clearError(); setConfirmCancel(false); }}>保留任务</button>
          <button type="button" className="wpd-danger" aria-busy={busy} disabled={busy} onClick={() => update({ action: "cancel" })}>确认取消任务</button>
        </> : showForm ? <>
          <button type="button" disabled={busy} onClick={() => { setEditing(false); clearError(); }}>返回详情</button><button className="wpd-primary" form={formId} disabled={busy} aria-busy={busy}>{busy ? "保存中…" : "保存进度"}</button>
        </> : <>
          {isAdmin && open && <button type="button" className="wpd-cancel" onClick={() => setConfirmCancel(true)}>取消任务</button>}
          {href && <Link href={href} className="wpd-route">去处理<ArrowUpRight aria-hidden="true" /></Link>}
          {task.workflow_status === "completed" && (owner || isAdmin) && <button type="button" disabled={busy} aria-busy={busy} onClick={() => update({ action: "reopen" })}>重新打开</button>}
          {open && owner && <><button type="button" onClick={() => edit(true)}><Check aria-hidden="true" />完成任务</button><button type="button" className="wpd-primary" onClick={() => edit(false)}>更新进度</button></>}
          {((!owner && open) || task.workflow_status === "cancelled") && <button type="button" onClick={onClose}>关闭</button>}
        </>)}
      </div>
    </footer>
  </DialogFrame>;
}
