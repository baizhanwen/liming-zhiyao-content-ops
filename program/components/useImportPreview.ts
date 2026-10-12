"use client";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "reading" | "ready" | "importing" | "error" | "done";
type Preview<T> = { scope: string; revision: number; filename: string; data: T | null; message: string; phase: Phase };
const empty = <T,>(scope: string): Preview<T> => ({ scope, revision: 0, filename: "", data: null, message: "", phase: "idle" });

export function useImportPreview<T>(scope: string) {
  const [state, setState] = useState<Preview<T>>(() => empty(scope));
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  // Reset during the scope render, so the previous preview can never be
  // submitted to a newly selected space, even before effects run.
  if (state.scope !== scope) setState(empty(scope));
  const preview = state.scope === scope ? state : empty<T>(scope);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; generation.current++; }, [scope]);

  function operation(revision: number, abort: AbortController) {
    const isCurrent = () => generation.current === revision && !abort.signal.aborted;
    return {
      signal: abort.signal, isCurrent,
      update(patch: Partial<Omit<Preview<T>, "scope" | "revision">>) {
        if (!isCurrent()) return;
        setState(current => current.scope === scope && current.revision === revision ? { ...current, ...patch } : current);
      },
    };
  }
  function begin(filename: string) {
    controller.current?.abort();
    const abort = new AbortController(), revision = ++generation.current;
    controller.current = abort;
    setState({ ...empty<T>(scope), revision, filename, phase: "reading", message: "正在解析…" });
    return operation(revision, abort);
  }
  function current() {
    if (state.scope !== scope || state.revision !== generation.current || !controller.current) return null;
    return operation(state.revision, controller.current);
  }
  function clear() {
    controller.current?.abort(); controller.current = null; generation.current++;
    setState(empty<T>(scope));
  }
  return { preview, begin, current, clear };
}
