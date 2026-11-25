"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import { readApiError } from "../lib/client-format";
import type { ContentGenerationProgress } from "../lib/content-generation-progress";
import type { DraftProgressLocal } from "./DraftGenerationProgressCard";

type Target = { contentId: string; version: number };
type Run = {
  id: string | null; startedAt: number; target?: Target; attached: boolean; ended: boolean;
  outcome?: Terminal; timer?: ReturnType<typeof setTimeout>; request?: AbortController; hasRecord?: boolean;
};
type View = {
  local: DraftProgressLocal; snapshot: ContentGenerationProgress | null;
  checkedAt: number | null; refreshing: boolean; refreshError: string | null; trackable: boolean;
};
type Terminal = "failed" | "completed" | "needs_material";

function initialView(phase: DraftProgressLocal["phase"], startedAt: number): View {
  return { local: { phase, startedAt, phaseStartedAt: startedAt }, snapshot: null, refreshing: false, checkedAt: null, refreshError: null, trackable: phase !== "preparing" };
}

function cancelRead(run: Run | null) {
  if (!run) return;
  clearTimeout(run.timer);
  run.timer = undefined;
  run.request?.abort();
  run.request = undefined;
}

// Only identifiers and the browser start time are needed to reconnect after a reload.
function savedAttempt(key: string): { id: string; version: number; startedAt: number; outcome?: Terminal } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && /^[a-f0-9]{32}$/.test(value.id) && Number.isSafeInteger(value.version) && value.version > 0
      && Number.isFinite(value.startedAt) ? value : null;
  } catch { return null; }
}

export function useDraftGenerationProgress(organizationId: string, projectId: string,
  onTerminal: (snapshot: ContentGenerationProgress, contentId: string) => void) {
  const current = useRef<Run | null>(null);
  const pageHidden = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const keyFor = useCallback((contentId: string) => JSON.stringify(["draft-generation", organizationId, projectId, contentId]), [organizationId, projectId]);

  const remember = useCallback((run: Run) => {
    if (!run.target || !run.id) return;
    const key = keyFor(run.target.contentId);
    try {
      if (!run.ended || (run.hasRecord && run.outcome !== "completed")) {
        sessionStorage.setItem(key, JSON.stringify({ id: run.id, version: run.target.version, startedAt: run.startedAt, outcome: run.outcome }));
      }
      else if (savedAttempt(key)?.id === run.id) sessionStorage.removeItem(key);
    } catch { /* The live request also works with browser storage disabled. */ }
  }, [keyFor]);

  const read = useCallback(async function poll(run: Run) {
    if (current.current !== run || !run.target || run.request || pageHidden.current) return;
    clearTimeout(run.timer);
    run.timer = undefined;
    const operation = new AbortController();
    run.request = operation;
    const timeout = setTimeout(() => operation.abort(), 12000);
    const params = new URLSearchParams({ organizationId, projectId, expectedVersion: String(run.target.version) });
    if (run.id) params.set("generationRequestId", run.id);
    setView(previous => previous && { ...previous, refreshing: true });
    let again = false;
    let unavailable = false;
    try {
      const response = await scopedFetch(`/api/content-items/${encodeURIComponent(run.target.contentId)}/generation-progress?${params}`,
        { signal: operation.signal, cache: "no-store" });
      if (!response.ok) {
        unavailable = [401, 403, 404].includes(response.status);
        throw new Error(await readApiError(response));
      }
      const { progress } = await response.json() as { progress: ContentGenerationProgress | null };
      if (current.current !== run || run.request !== operation) return;
      if (progress && (progress.expectedVersion !== run.target.version || run.id && progress.generationRequestId !== run.id)) {
        throw new Error("返回的进度与本次生成不一致。");
      }
      const checkedAt = Date.now();
      if (!progress) {
        if (!run.id) { current.current = null; return; }
        // A newly submitted request can still be validating materials before its first model call.
        again = !run.ended && (run.attached || checkedAt - run.startedAt < 15000);
        setView(previous => previous && { ...previous, checkedAt, refreshing: false, refreshError: null,
          local: again || run.ended ? previous.local : { ...previous.local, phase: "unconfirmed", detail: "尚未查到本次生成记录，可以刷新状态核对。" } });
        return;
      }
      if (!run.id) { run.id = progress.generationRequestId; run.startedAt = Date.parse(progress.startedAt); }
      run.hasRecord = true;
      const terminal = progress.status !== "running";
      const newlyTerminal = terminal && !run.ended;
      if (progress.status !== "running") run.outcome = progress.status;
      run.ended ||= terminal;
      again = !run.ended;
      remember(run);
      setView(previous => ({
        local: run.ended && !newlyTerminal && previous ? previous.local : {
          phase: progress.status === "running" ? "submitted" : progress.status,
          startedAt: run.startedAt, endedAt: terminal ? Date.parse(progress.finishedAt ?? "") || checkedAt : undefined,
        },
        checkedAt, refreshing: false, refreshError: null, snapshot: progress, trackable: true,
      }));
      if (newlyTerminal) onTerminal(progress, run.target.contentId);
    } catch (reason) {
      if (current.current !== run || run.request !== operation || (isScopeCancellation(reason) && !operation.signal.aborted)) return;
      again = Boolean(run.id && !run.ended && !unavailable);
      setView(previous => previous && { ...previous, refreshing: false,
        ...(unavailable && { snapshot: null }),
        ...(unavailable && !run.attached && !run.ended && { local: { ...previous.local, phase: "unconfirmed" } }),
        refreshError: operation.signal.aborted
        ? "状态查询超时，将重新连接。" : reason instanceof Error ? reason.message : "暂时无法连接进度服务。" });
    } finally {
      clearTimeout(timeout);
      if (run.request === operation) {
        run.request = undefined;
        if (again && current.current === run && !pageHidden.current) run.timer = setTimeout(() => void poll(run), document.hidden ? 8000 : 2500);
      }
    }
  }, [organizationId, projectId, onTerminal, remember]);

  useEffect(() => {
    const hide = () => { pageHidden.current = true; cancelRead(current.current); };
    const show = () => {
      pageHidden.current = false;
      if (current.current && !current.current.ended) void read(current.current);
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      cancelRead(current.current);
      current.current = null;
    };
  }, [read]);

  const resume = useCallback((contentId: string, version: number) => {
    cancelRead(current.current);
    const prior = savedAttempt(keyFor(contentId));
    const saved = prior && (!prior.outcome || prior.version === version) ? prior : null;
    const run: Run = { id: saved?.id ?? null, startedAt: saved?.startedAt ?? Date.now(),
      target: { contentId, version: saved?.version ?? version }, attached: false, ended: false };
    current.current = run;
    setView(saved ? initialView("submitted", run.startedAt) : null);
    void read(run);
  }, [keyFor, read]);

  function begin() {
    cancelRead(current.current);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const startedAt = Date.now();
    current.current = { id, startedAt, ended: false, attached: true };
    setView(initialView("preparing", startedAt));
    return id;
  }

  function track(target: Target) {
    const run = current.current;
    if (!run) return;
    run.target = target;
    remember(run);
    setView(previous => previous && { ...previous, trackable: true, local: { ...previous.local, phase: "submitted", phaseStartedAt: Date.now() } });
    void read(run);
  }

  function finish(phase: Terminal, detail?: string) {
    const run = current.current;
    if (!run) return;
    cancelRead(run);
    run.ended = true;
    run.outcome = phase;
    remember(run);
    setView(previous => previous && { ...previous, refreshing: false, refreshError: null, local: { ...previous.local, phase, endedAt: Date.now(), detail } });
    if (phase !== "completed" && run.target) void read(run);
  }

  function disconnect() {
    const run = current.current;
    if (!run || run.ended) return;
    run.attached = false;
    setView(previous => previous && { ...previous, local: { ...previous.local,
      phase: run.hasRecord ? "submitted" : "unconfirmed", detail: "提交连接中断，正在查询这次生成的记录。" } });
    if (!pageHidden.current && !run.request && !run.timer) run.timer = setTimeout(() => void read(run), 600);
  }

  return { view, begin, track, resume, finish, disconnect,
    refresh: view?.trackable ? () => { if (current.current) void read(current.current); } : undefined,
    locked: view?.local.phase === "submitted" || view?.local.phase === "preparing",
  };
}
