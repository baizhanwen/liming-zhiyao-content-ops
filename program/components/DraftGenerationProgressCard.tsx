"use client";

import { useEffect, useState } from "react";
import type { ContentGenerationProgress } from "../lib/content-generation-progress";
import { formatElapsedSeconds } from "../lib/task-progress-view";
import styles from "./TaskProgress.module.css";

export type DraftProgressLocal = {
  phase: "preparing" | "submitted" | "needs_material" | "failed" | "completed" | "unconfirmed";
  startedAt: number;
  phaseStartedAt?: number;
  endedAt?: number;
  detail?: string;
};

const stages = {
  writing: "按参考结构写稿",
  validating: "校验稿件内容",
  citation_repair: "校正材料引用",
  reviewing: "核对逐段内容",
  saving: "保存稿件版本",
} satisfies Record<ContentGenerationProgress["stage"], string>;

const headings = {
  preparing: "正在准备稿件",
  submitted: "已提交，等待读取生成进度",
  needs_material: "等待补充材料",
  failed: "文案生成失败",
  completed: "稿件已生成",
  unconfirmed: "生成结果待确认",
};

type Props = {
  local: DraftProgressLocal;
  snapshot: ContentGenerationProgress | null;
  checkedAt: number | null;
  refreshing: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
};

export function DraftGenerationProgressCard({ local, snapshot, checkedAt, refreshing, refreshError, onRefresh }: Props) {
  const localTerminal = local.phase === "failed" || local.phase === "completed" || local.phase === "needs_material";
  const status = localTerminal ? local.phase : (snapshot?.status ?? local.phase);
  const phase = snapshot && stages[snapshot.stage];
  const active = status === "preparing" || status === "submitted" || status === "running";
  const clockRunning = active && !(snapshot && refreshError);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!clockRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [clockRunning]);

  const remoteStart = snapshot && Date.parse(snapshot.startedAt);
  const started = remoteStart != null ? Math.min(local.startedAt, remoteStart) : local.startedAt;
  const stepStarted = snapshot ? Date.parse(snapshot.stepStartedAt) : local.phaseStartedAt;
  const finished = snapshot?.finishedAt ? Date.parse(snapshot.finishedAt) : local.endedAt;
  // Match the analysis card: advance a live reading briefly between successful polls.
  const liveEnd = snapshot && checkedAt != null ? Math.min(now, checkedAt + 12_000) : now;
  const end = active ? liveEnd : (finished ?? checkedAt);
  const elapsed = (from: number) => formatElapsedSeconds(end == null ? null : Math.max(0, (end - from) / 1000));
  const heading = status === "running" ? `正在${phase}` : headings[status];
  const missingCount = status === "needs_material" ? snapshot?.materialQuestions.length : 0;

  return <section className={`${styles.card} ${styles.compact} ${styles.draft}`} aria-label="文案生成进度" data-status={status}>
    <div className={styles.heading}>
      <h2 aria-live="polite" aria-atomic="true">
        <span aria-hidden="true" className={`${styles.dot}${active ? " " + styles.active : ""}`} />{heading}
      </h2>
      {onRefresh && <div className={styles.buttons}>
        <button type="button" disabled={refreshing} aria-busy={refreshing} data-no-feedback onClick={onRefresh}>{refreshing ? "刷新中…" : "刷新状态"}</button>
      </div>}
    </div>
    <div className={styles.clock} aria-live="off">
      <span>生成历时 <strong>{elapsed(started)}</strong></span>
      {stepStarted != null && <span>本步骤已用时 <strong>{elapsed(stepStarted)}</strong></span>}
      {snapshot && <span>模型调用 <strong>{snapshot.requestCount}</strong> 次</span>}
    </div>
    {local.detail && (localTerminal || !snapshot) ? <p className={styles.worker}>{local.detail}</p>
      : Boolean(missingCount) && <p className={styles.worker}>有 {missingCount} 段需要补充材料。</p>}
    {refreshError && <div className={styles.connection} role="status"><p>进度读取失败。{refreshError}</p></div>}
    <details className={styles.more}>
      <summary>连接与进度详情</summary>
      <div className={styles.moreContent}>
        {snapshot && <p className={styles.worker}>最近记录的步骤 · {phase}</p>}
        {snapshot && active && checkedAt != null && (refreshError || now - checkedAt > 12_000) &&
          <p className={styles.worker}>正在等待新的状态记录，计时暂时停留在上次读数。</p>}
        {checkedAt != null
          ? <p className={styles.worker}>上次成功刷新 <time dateTime={new Date(checkedAt).toISOString()}>{new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time></p>
          : <p className={styles.worker}>{local.phase === "preparing" ? "正在确认本次选题和材料。" : "尚未读取到本次生成的进度记录。"}</p>}
        {snapshot?.errorCode && status === "failed" && <p className={styles.worker}>错误代码 {snapshot.errorCode}</p>}
      </div>
    </details>
  </section>;
}
