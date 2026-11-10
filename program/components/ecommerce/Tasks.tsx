"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrief } from "../../lib/ecommerce/contracts";
import { isScopeCancellation } from "../../lib/client-scope-request";
import { displayTime, ecommerceApi, EcommerceApiError, kinds, Notices, TextField, useDirtySections, useEcommerceAction, type ComponentRow, type Scope } from "./shared";
import { TaskForm } from "./TaskForm";
import { Assembly } from "./Assembly";
import { PublicationPanel } from "./Results";
import { taskStates, type Recommendation, type TaskDetail, type TaskOptions, type TaskRow } from "./task-types";

export function Tasks({ scope, enabled, canManage, dirty, discard, guided = false, initialProductVersionId = "", initialTaskId = "", onTaskSaved, onProgressChange }: { scope: Scope; enabled: boolean; canManage: boolean; dirty: (value: boolean) => void; discard: () => boolean; guided?: boolean; initialProductVersionId?: string; initialTaskId?: string; onTaskSaved?: (id: string) => void; onProgressChange?: () => void }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]), [editor, setEditor] = useState({ id: "" }), [options, setOptions] = useState<TaskOptions | null>(null);
  const selectedId = editor.id;
  const [methods, setMethods] = useState<ComponentRow[]>([]), [cases, setCases] = useState<{ id: string; title: string }[]>([]), action = useEcommerceAction();
  const localEdits = useRef(false), pendingInitialTask = useRef(initialTaskId), appliedInitialTask = useRef<string | null>(null);
  const mounted = useRef(true), editorRef = useRef(editor);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectTask = useCallback((id: string) => { const next = { id }; editorRef.current = next; setEditor(next); }, []);
  // Each selection owns its callbacks, including A → B → A and new-task drafts.
  const isCurrentEditor = () => mounted.current && editorRef.current === editor;
  const markDirty = (value: boolean) => { if (isCurrentEditor()) { localEdits.current = value; dirty(value); } };
  const { setError } = action;
  const refreshList = useCallback(async () => {
    const editorAtStart = editorRef.current;
    const data = await ecommerceApi<{ tasks: TaskRow[] }>(scope, "tasks");
    if (!mounted.current) return;
    setTasks(data.tasks);
    const requested = pendingInitialTask.current;
    if (editorAtStart !== editorRef.current || localEdits.current || appliedInitialTask.current === requested) return;
    appliedInitialTask.current = requested;
    // The list was scoped by the server; never read a foreign ID supplied by guide state.
    if (!requested) return;
    if (data.tasks.some(task => task.id === requested)) selectTask(requested);
    else setError("向导中的任务已不可用，可从当前空间重新选择或新建任务。");
  }, [scope, setError, selectTask]);
  const taskSaved = async (id: string) => {
    if (!isCurrentEditor()) return;
    // Enter the acknowledged task immediately. A later list response must not
    // redirect an editor the user selected while that read was in flight.
    selectTask(id); onTaskSaved?.(id); onProgressChange?.();
    await action.act(refreshList);
  };
  const taskChanged = async () => { if (!isCurrentEditor()) return; await refreshList(); if (isCurrentEditor()) onProgressChange?.(); };
  const load = useCallback(async () => {
    const [o, m, c] = await Promise.all([ecommerceApi<TaskOptions>(scope, "options"), ecommerceApi<{ components: ComponentRow[] }>(scope, "components"), ecommerceApi<{ cases: { id: string; status: string; body_json: string }[] }>(scope, "cases")]);
    if (!mounted.current) return;
    setOptions(o); setMethods(m.components); setCases(c.cases.filter(c => c.status === "confirmed").map(c => ({ id: c.id, title: JSON.parse(c.body_json).title }))); await refreshList();
  }, [scope, refreshList]);
  const { act } = action; useEffect(() => { void act(load); }, [act, load]);
  useEffect(() => {
    if (pendingInitialTask.current === initialTaskId) return;
    pendingInitialTask.current = initialTaskId;
    if (initialTaskId) void act(refreshList);
  }, [initialTaskId, act, refreshList]);
  return <><Notices error={action.error} /><div className={guided ? "ec-task-guided" : "ec-split"}>{!guided && <aside className="ec-panel ec-list"><div className="ec-panel-head"><h2>电商任务</h2><button type="button" disabled={!enabled} onClick={() => { if (discard()) { appliedInitialTask.current = pendingInitialTask.current; markDirty(false); selectTask(""); } }}>新建任务</button></div>{tasks.map(task => <button type="button" className={`ec-list-item ${selectedId === task.id ? "selected" : ""}`} key={task.id} onClick={() => { if (task.id !== selectedId && discard()) { appliedInitialTask.current = pendingInitialTask.current; markDirty(false); selectTask(task.id); } }}><strong>{task.title}</strong><small>v{task.current_version} · {taskStates[task.status]}</small></button>)}{!tasks.length && <p className="ec-muted">保存右侧的选择后，进入生成、修改和拍摄清单。</p>}</aside>}
    {!options ? <section className="ec-panel" role="status">正在读取可用商品与资料…</section> : selectedId ? <TaskSession key={selectedId} scope={scope} taskId={selectedId} options={options} methods={methods} cases={cases} enabled={enabled} canManage={canManage} guided={guided} dirty={markDirty} discard={discard} listChanged={taskChanged} /> : <TaskForm scope={scope} options={options} methods={methods} cases={cases} enabled={enabled} guided={guided} initialProductVersionId={initialProductVersionId} dirty={markDirty} saved={taskSaved} />}
  </div></>;
}

function TaskSession({ scope, taskId, options, methods, cases, enabled, canManage, guided = false, dirty, discard, listChanged }: { scope: Scope; taskId: string; options: TaskOptions; methods: ComponentRow[]; cases: { id: string; title: string }[]; enabled: boolean; canManage: boolean; guided?: boolean; dirty: (value: boolean) => void; discard: () => boolean; listChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null), [editRow, setEditRow] = useState<TaskRow | null>(null), [recommendation, setRecommendation] = useState<Recommendation | null>(null), [recommendationError, setRecommendationError] = useState("");
  const [instructions, setInstructions] = useState(""), [requesting, setRequesting] = useState(false), [uncertain, setUncertain] = useState(false), [pollError, setPollError] = useState("");
  const action = useEcommerceAction(), stopAction = useEcommerceAction(), [clock, setClock] = useState(Date.now);
  const forms = useDirtySections(dirty);
  // Refreshes update permissions and run status, while the editor owns its
  // original revision until its save is acknowledged or the user leaves it.
  const edit = editRow !== null;
  const requestRef = useRef<Record<string, unknown> | null>(null), key = `ec.run.${scope.organizationId}.${scope.projectId}.${taskId}`;
  const refresh = useCallback(async () => {
    const data = await ecommerceApi<TaskDetail>(scope, `tasks?taskId=${encodeURIComponent(taskId)}`); setDetail(data); setPollError("");
    const matching = requestRef.current && data.runs.find(r => r.idempotency_key === requestRef.current?.idempotencyKey);
    if (matching && matching.status !== "running" && !matching.active_calls) { requestRef.current = null; setUncertain(false); try { sessionStorage.removeItem(key); } catch { /* Optional browser storage. */ } }
    return data;
  }, [scope, taskId, key]);
  const { act } = action;
  useEffect(() => { try { const raw = sessionStorage.getItem(key); if (raw) requestRef.current = JSON.parse(raw); } catch { /* Invalid or disabled optional storage. */ } void act(async () => { await refresh(); if (requestRef.current) setUncertain(true); }); }, [act, key, refresh]);
  const live = Boolean(detail?.runs.some(r => r.status === "running" || r.active_calls));
  useEffect(() => {
    if (!live && !requesting && !uncertain) return;
    let active = true, inFlight = false;
    const timer = window.setInterval(async () => { if (inFlight) return; inFlight = true; setClock(Date.now()); try { await refresh(); } catch (e) { if (active && !isScopeCancellation(e)) setPollError("运行记录刷新失败；未自动重试生成，可手动刷新。"); } finally { inFlight = false; } }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [live, requesting, uncertain, refresh]);
  const revision = detail?.task.revision, currentVersion = detail?.task.current_version;
  useEffect(() => { if (revision === undefined || edit) return; let active = true; ecommerceApi<Recommendation>(scope, `tasks/${taskId}/recommendations`).then(r => { if (active) { setRecommendation(r); setRecommendationError(""); } }).catch(e => { if (active && !isScopeCancellation(e)) { setRecommendation(null); setRecommendationError(e.message); } }); return () => { active = false; }; }, [scope, taskId, revision, currentVersion, edit]);

  async function generate(replace?: "hook" | "evidence" | "cta", replay = false) {
    if (!detail) return;
    if (!replay && !discard()) return;
    const body = replay ? requestRef.current : { revision: detail.task.revision, baseVersion: detail.task.current_version, idempotencyKey: crypto.randomUUID(), instructions, ...(replace ? { replace } : {}) };
    if (!body) throw new Error("没有待核对的请求。");
    requestRef.current = body; try { sessionStorage.setItem(key, JSON.stringify(body)); } catch { /* Server idempotency still protects this session. */ }
    setRequesting(true); setUncertain(false);
    try { await ecommerceApi(scope, `tasks/${taskId}/generate`, body); dirty(false); }
    catch (e) {
      // A structured rejection is authoritative. Network/proxy failures may
      // have lost a successful response, so retain that request's identity.
      if (e instanceof EcommerceApiError && e.code && (e.status < 500 || e.code === "MODEL_NOT_CONFIGURED")) {
        requestRef.current = null;
        try { sessionStorage.removeItem(key); } catch { /* Optional storage. */ }
      } else setUncertain(true);
      throw e;
    } finally {
      setRequesting(false);
      try { await refresh(); await listChanged(); }
      catch (e) { if (!isScopeCancellation(e)) setPollError("运行记录刷新失败；请刷新核对，未自动重新生成。"); }
    }
  }
  async function changed() { await refresh(); await listChanged(); }
  if (!detail) return <section className="ec-panel"><Notices error={action.error} /><p role="status">正在加载任务…</p></section>;
  const task = detail.task, brief = JSON.parse(task.brief_json) as TaskBrief, blocked = !enabled || live || requesting || task.status === "archived";
  return <div className="ec-stack"><section className="ec-panel"><header className="ec-panel-head"><div><h2>{task.title}</h2><p className="ec-muted">{taskStates[task.status]} · 稿件 v{task.current_version} · 条件修订 {task.revision}</p></div><div className="ec-actions"><button type="button" disabled={!edit && (live || requesting || task.status === "archived")} onClick={() => { if (discard()) { forms.mark("task", false); forms.mark("pack", false); forms.mark("publication", false); setEditRow(edit ? null : { ...task }); } }}>{edit ? "返回装配台" : "修改任务条件"}</button><button type="button" disabled={stopAction.busy} onClick={() => void stopAction.act(changed)}>刷新记录</button></div></header><Notices error={action.error || stopAction.error || pollError} message={stopAction.message} />
    {!edit && <><TextField label="本次生成或局部替换要求" value={instructions} onChange={setInstructions} /><div className="ec-actions"><button type="button" className="ec-primary" disabled={blocked || !recommendation?.ready || action.busy || uncertain} aria-busy={requesting} onClick={() => void action.act(() => generate())}>{task.current_version ? "生成新版本" : "生成电商素材"}</button>{requesting && <span role="status">正在选择方法、生成与校对，可在运行记录中取消。</span>}</div>{uncertain && <p className="ec-notice">请求结果尚需核对。<button type="button" disabled={requesting || action.busy} onClick={() => void action.act(() => generate(undefined, true))}>核对原请求</button><small>复用原运行标识，不新建重复任务。</small></p>}</>}
    {(live || detail.runs.length > 0) && <details open={live}><summary>运行记录</summary>{detail.runs.slice(0, 8).map(run => <div className="ec-run" key={run.id}><div><strong>{run.operation === "generate" ? "完整生成" : `替换${run.operation === "hook" ? "开头" : run.operation === "evidence" ? "证据" : "CTA"}`}</strong> · {run.status === "running" ? "进行中" : run.status === "completed" ? "已完成" : "未完成"}<small>{displayTime(run.created_at)} · {run.call_count} 次模型调用{run.active_calls ? " · 请求尚在结束中" : ""}</small>{run.error_message && <Notices error={run.error_message} />}</div><div className="ec-actions">{run.status === "running" && <button type="button" disabled={stopAction.busy} onClick={() => void stopAction.act(async () => { await ecommerceApi(scope, `tasks/${taskId}/runs`, { runId: run.id, action: "cancel" }); await changed(); }, "已请求取消，已有稿件保留。")}>取消生成</button>}{canManage && (run.status === "running" || run.active_calls > 0) && <button type="button" disabled={stopAction.busy || clock - Date.parse(run.last_activity_at) < 300000} onClick={() => void stopAction.act(async () => { await ecommerceApi(scope, `tasks/${taskId}/runs`, { runId: run.id, action: "recover" }); await changed(); }, "已结束中断运行，没有自动重新生成。")}>恢复中断运行</button>}</div></div>)}</details>}
  </section>
  {editRow ? <>
    {editRow.revision !== task.revision && <p className="ec-notice" role="status">任务条件已在别处更新，正在编辑的内容和原版本已保留。保存时会重新核对版本；发生冲突时请先复制内容，再退出编辑查看最新条件。</p>}
    <TaskForm key={`${editRow.id}:${editRow.revision}`} scope={scope} row={editRow} options={options} methods={methods} cases={cases} enabled={!blocked} guided={guided} dirty={value => forms.mark("task", value)} saved={async () => { forms.mark("task", false); setEditRow(null); await changed(); }} />
  </> : <>
    <section className="ec-panel"><h3>本次调用方案</h3><Notices error={recommendationError} />{recommendation && <><p className="ec-muted">{recommendation.caseNotice}</p>{!recommendation.ready && <p className="ec-notice ec-error">请补齐：{recommendation.missing.join("、")}</p>}<details><summary>推荐方法及适配理由</summary>{Object.entries(kinds).map(([kind, name]) => <div key={kind} className="ec-inset"><strong>{name}</strong>{recommendation.candidates.filter(c => c.card.kind === kind).map(c => <p key={c.id}>{c.card.name}：{c.reasons.join("；")}</p>)}</div>)}{!!recommendation.rejected.length && <details><summary>未匹配的方法</summary>{recommendation.rejected.map(r => <p key={r.id}>{r.name}：{r.reasons.join("；")}</p>)}</details>}</details>{recommendation.strategy && <details><summary>本次核心策略</summary><p>{recommendation.strategy.positioning}</p><p>{recommendation.strategy.targetAudience}</p><p>{recommendation.strategy.styleNotes}</p></details>}</>}</section>
    <Assembly key={task.current_version} scope={scope} detail={detail} enabled={!blocked} dirty={value => forms.mark("pack", value)} changed={changed} replace={role => action.act(() => generate(role))} />
    <PublicationPanel scope={scope} detail={detail} brief={brief} enabled={!blocked} accounts={options.accounts} changed={changed} dirty={value => forms.mark("publication", value)} />
  </>}
  </div>;
}
