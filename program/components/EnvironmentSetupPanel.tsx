"use client";

import { useCallback, useEffect, useState } from "react";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import { readApiError } from "../lib/client-format";
import styles from "./EnvironmentSetupPanel.module.css";

type EnvironmentAction = "setup" | "start" | "stop" | "check";
type EnvironmentSnapshot = {
  available: boolean;
  workerRunning: boolean;
  processRunning?: boolean;
  restartRequired?: boolean;
  ready: boolean;
  checks: Array<{ id: string; label: string; status: "ready" | "missing" | "error" | "checking"; message?: string }>;
  job?: {
    id: string;
    action: string;
    status: "running" | "succeeded" | "failed";
    logTail: string[];
    startedAt: string;
    error?: string;
  };
  message?: string;
};

const checkLabels = { ready: "就绪", missing: "未安装", error: "异常", checking: "检查中" };
const jobLabels = { running: "正在执行", succeeded: "执行完成", failed: "执行失败" };

function readableLog(line: string) {
  try {
    const event = JSON.parse(line) as { phase?: string; ready?: boolean; workerRunning?: boolean; message?: string };
    const phases: Record<string, string> = {
      preparing_project_installer: "正在准备本项目安装工具…",
      installing_media_dependencies: "正在安装视频分析依赖…",
      installing_collector_dependencies: "正在安装采集器依赖…",
      installing_browser: "正在准备独立 Chromium 浏览器…",
      preparing_local_models: "正在下载并验证本地转写和文字识别模型…",
      checking_windows_native_runtime: "正在检查 Windows 本地推理所需的 Microsoft Visual C++ 运行库…",
      preparing_windows_qwen: "正在准备 Qwen3-ASR-1.7B 本地模型…",
      verifying_windows_qwen: "正在用 Qwen3-ASR-1.7B 转写中文测试录音…",
      asr_inference_passed: "本地语音模型已通过转写验证。",
    };
    if (event.phase) return phases[event.phase] || "正在准备分析环境…";
    if (event.message) return event.message;
    if (typeof event.ready === "boolean") return event.ready
      ? `环境已就绪，${event.workerRunning ? "服务运行中" : "服务未启动"}。`
      : event.message || "环境仍有未完成项目，请查看上方检查结果。";
    return event.message || "环境状态已更新。";
  } catch { return line.startsWith("{") ? "环境状态已更新，请查看上方检查结果。" : line; }
}

export function EnvironmentSetupPanel({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<EnvironmentAction | null>(null);
  const readSnapshot = useCallback(async (signal?: AbortSignal) => {
    const response = await scopedFetch(`/api/analyzer-environment?organizationId=${encodeURIComponent(organizationId)}`, { signal });
    if (!response.ok) throw new Error(await readApiError(response));
    return await response.json() as EnvironmentSnapshot;
  }, [organizationId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await readSnapshot(signal);
      if (!signal?.aborted) { setSnapshot(body); setError(""); }
    } catch (reason) {
      if (!isScopeCancellation(reason) && !signal?.aborted) setError(reason instanceof Error ? reason.message : "环境状态暂时无法读取。");
    }
  }, [readSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void readSnapshot(controller.signal).then(body => {
      if (!controller.signal.aborted) { setSnapshot(body); setError(""); }
    }).catch(reason => {
      if (!isScopeCancellation(reason) && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "环境状态暂时无法读取。");
    });
    return () => controller.abort();
  }, [readSnapshot]);

  const jobRunning = snapshot?.job?.status === "running";
  const serviceConnecting = snapshot?.processRunning && !snapshot.workerRunning && !snapshot.restartRequired;
  useEffect(() => {
    if (!jobRunning && !serviceConnecting) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobRunning, serviceConnecting, refresh]);

  async function execute(action: EnvironmentAction) {
    if (submitting || jobRunning) return;
    setSubmitting(action); setError("");
    try {
      const response = await scopedFetch("/api/analyzer-environment", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, action }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setSnapshot(await response.json() as EnvironmentSnapshot);
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "环境操作没有完成。");
    } finally { setSubmitting(null); }
  }

  const disabled = !canManage || !snapshot?.available || Boolean(submitting) || jobRunning;
  return <article id="analyzer-environment" className="panel operations-panel">
    <div className="panel-heading"><div><p className="section-kicker">本项目独立运行环境</p><h2>视频分析服务</h2></div><span>{snapshot?.restartRequired ? "服务需要重新启动" : snapshot?.workerRunning ? "服务运行中" : snapshot?.processRunning ? "服务已启动，等待连接" : "服务未启动"}</span></div>
    <p className={styles.intro}>在这里安装缺少的依赖、准备模型并启动服务。首次配置会联网下载模型。验证通过后，下次启动时可直接复用。</p>
    <div className={styles.body}>
      <div className={styles.status}><strong>{error && !submitting ? "环境状态需重新检查" : !snapshot ? "正在检查环境…" : snapshot.ready ? "分析环境已就绪" : snapshot.available ? "分析环境需要准备" : "环境管理暂不可用"}</strong>{snapshot?.job?.status === "running" && <span role="status">正在执行，页面会自动更新进度</span>}</div>
      {snapshot?.message && <p className={styles.message}>{snapshot.message}</p>}
      {snapshot && snapshot.checks.length > 0 && <ul className={styles.checks}>{snapshot.checks.map(check => <li className={`${styles.check} ${styles[check.status] ?? ""}`} key={check.id}><span className={styles.indicator} aria-hidden="true">{check.status === "ready" ? "✓" : check.status === "checking" ? "…" : "!"}</span><div><strong>{check.label} · {checkLabels[check.status]}</strong>{check.message && <small>{check.message}</small>}</div></li>)}</ul>}
      <div className={styles.actions}>
        <button type="button" className="primary-button" disabled={disabled} onClick={() => void execute("setup")}>{submitting === "setup" || jobRunning && snapshot?.job?.action === "setup" ? "正在配置环境…" : "一键配置环境并启动"}</button>
        <button type="button" className="secondary-button" disabled={disabled || Boolean(snapshot?.processRunning || snapshot?.workerRunning)} onClick={() => void execute("start")}>{submitting === "start" ? "正在启动…" : "启动服务"}</button>
        <button type="button" className="secondary-button" disabled={disabled || !(snapshot?.processRunning || snapshot?.workerRunning)} onClick={() => void execute("stop")}>{submitting === "stop" ? "正在停止…" : "停止服务"}</button>
        <button type="button" className="secondary-button" disabled={!canManage || Boolean(submitting) || jobRunning} onClick={() => snapshot?.available ? void execute("check") : void refresh()}>{submitting === "check" ? "正在检查…" : "重新检查"}</button>
      </div>
      {!canManage && <p className={styles.message}>只有公司管理员可以配置环境或管理服务。</p>}
      {snapshot?.workerRunning && <p className={styles.message}>环境完整时直接复用；修复需要重启服务时，请先等待当前分析任务完成。</p>}
      {error && <p className={`${styles.message} ${styles.failure}`} role="alert">{error}</p>}
      {snapshot?.job && <div className={styles.job}>
        <h3>最近任务 · {jobLabels[snapshot.job.status]}</h3>
        {snapshot.job.error && <p className={`${styles.message} ${styles.failure}`} role="alert">{snapshot.job.error}</p>}
        {snapshot.job.logTail.length > 0 && <pre className={styles.log} aria-label="环境配置运行日志" aria-live={jobRunning ? "polite" : "off"}>{snapshot.job.logTail.map(readableLog).join("\n")}</pre>}
      </div>}
    </div>
  </article>;
}
