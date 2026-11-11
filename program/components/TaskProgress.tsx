"use client";

// Adapted from baizhanwen/liming-zhiyao-skill-collect frontend/src/TaskProgress.tsx (MIT).
import { useEffect, useState, type ReactNode } from "react";
import { formatElapsedSeconds, taskProgressPhases, taskProgressView, type TaskProgressTask, type TaskRefreshState } from "../lib/task-progress-view";
import styles from "./TaskProgress.module.css";

export { initialTaskRefresh, type TaskRefreshState, type TaskProgressTask, type TaskProgressSnapshot } from "../lib/task-progress-view";

export default function TaskProgress({task, connection, snapshotAt, onRefresh, onOpen, compact = false, children, className = ""}: {
  task: TaskProgressTask;
  connection: TaskRefreshState;
  snapshotAt: number | null;
  onRefresh?: () => void;
  onOpen?: () => void;
  compact?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer);}, [task.id]);
  const view = taskProgressView(task, connection, snapshotAt, now);
  const refreshLabel = snapshotAt == null ? "尚未成功读取本任务状态"
    : `最近成功刷新：${new Date(snapshotAt).toLocaleTimeString("zh-CN", {hour12: false})}（${formatElapsedSeconds(view.snapshotAge)}前）`;
  const detail = <p className={styles.detail}>{taskProgressPhases[view.phase] && <strong>{taskProgressPhases[view.phase]} · </strong>}{view.detail}</p>;
  const metrics = view.metricItems.length > 0 && <ul className={styles.metrics}>{view.metricItems.slice(0, compact ? 3 : 10).map(item => <li key={item}>{item}</li>)}</ul>;
  const connectionWarning = connection.error ? <p role="alert"><strong>任务状态刷新失败</strong>（连续 {connection.failures} 次）：{connection.error}。保留上次结果，正在自动重连。</p>
    : connection.pending && snapshotAt == null ? <p>正在读取状态，尚未确认当前进展。</p>
    : connection.pending && view.readAge != null && view.readAge >= 8 ? <p>状态读取仍在等待响应，暂不能确认最新进展。</p>
    : view.stale ? <p>较久未成功刷新，当前显示上次状态。</p> : null;
  const information = <>
    {!view.active && <p className={styles.worker}>所在步骤：{view.stage}</p>}
    {compact && view.terminal && detail}
    {view.workerLabel && <p className={styles.worker}>{view.workerLabel}</p>}
    {view.waitingLabel && <p className={styles.wait}>等待{view.waitingLabel}返回下一步结果，当前调用没有可测量的生成百分比。</p>}
    {compact && view.terminal && metrics}
    {!connectionWarning && <p className={styles.worker}>{snapshotAt != null ? "状态连接正常，定时刷新中。" : "实时状态尚未读取。"}</p>}
    <div className={styles.freshness}><small>{refreshLabel}</small>{view.activityAge != null && <small>最近真实进展：{formatElapsedSeconds(view.activityAge)}前</small>}</div>
  </>;
  return <section className={`${styles.card}${compact ? ` ${styles.compact}` : ""} ${className}`} aria-label="当前任务进度" data-status={task.status}>
    <div className={styles.heading}>
      <div className={styles.headingCopy}>{!compact && <span className={styles.eyebrow}>任务进度</span>}<h2 aria-live="polite"><span aria-hidden="true" className={`${styles.dot}${view.active ? ` ${styles.active}` : ""}`}/>{view.heading}</h2></div>
      <div className={styles.buttons}>
        {onOpen && <button className="button" type="button" onClick={onOpen}>查看任务详情</button>}
        {onRefresh && <button className="button" type="button" aria-busy={connection.pending} onClick={onRefresh} disabled={connection.pending}>{connection.pending ? "刷新中…" : "刷新状态"}</button>}
      </div>
    </div>
    <div className={styles.clock} aria-live="off">
      <span>{view.queued ? "排队等候" : "任务历时"} <strong>{formatElapsedSeconds(view.elapsed)}</strong></span>
      {!view.queued && <span>本步骤已用时 <strong>{formatElapsedSeconds(view.stageElapsed)}</strong></span>}
      {view.executionCount != null && view.executionCount > 0 && <span>已执行 <strong>{view.executionCount}</strong> 次</span>}
    </div>
    {(!compact || !view.terminal) && <>{detail}{metrics}</>}
    {connectionWarning && <div className={styles.connection} aria-live="polite">{connectionWarning}</div>}
    {view.noActivity && <p className={styles.slow}>当前步骤已等待较久，已有 {formatElapsedSeconds(view.activityAge)}未收到新进展；{view.fresh ? "状态连接正常。" : "请先核对状态连接。"}外部请求或本地处理可能仍在等待，不能据此判断已卡死。</p>}
    {(connection.error || view.stale) && <p className={styles.snapshot}>用时根据最近快照短暂估算后已停止增加，刷新恢复后再更新；刷新失败不等于任务处理失败。</p>}
    {children && <div className={styles.children}>{children}</div>}
    {compact ? <details className={styles.more}><summary>连接与进度详情</summary><div className={styles.moreContent}>{information}</div></details> : <div className={styles.information}>{information}</div>}
  </section>;
}
