import { initialTaskRefresh, type TaskRefreshState } from "./task-progress-view.ts";

/** A read owns its snapshot clock. Polling never changes a task's real progress. */
export function createTaskSnapshotReader<T>({ read, onData, onConnection, timeoutMs = 15_000, now = Date.now }: {
  read: (signal: AbortSignal) => Promise<T>;
  onData: (data: T, receivedAt: number) => void;
  onConnection: (connection: TaskRefreshState) => void;
  timeoutMs?: number;
  now?: () => number;
}) {
  let connection = { ...initialTaskRefresh };
  let disposed = false;
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let generation = 0;
  let cancelRead: (() => void) | null = null;

  function publish(next: TaskRefreshState) {
    connection = next;
    if (!disposed) onConnection({ ...connection });
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    controller = new AbortController();
    const current = controller;
    const readGeneration = generation;
    publish({ ...connection, pending: true, lastAttemptAt: now() });
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      cancelRead = () => reject(new Error("TASK_SNAPSHOT_INVALIDATED"));
      timer = setTimeout(() => {
        reject(new Error("任务状态读取超时，请检查服务连接"));
        current.abort();
      }, timeoutMs);
    });
    pending = (async () => {
      try {
        const data = await Promise.race([Promise.resolve().then(() => read(current.signal)), timedOut]);
        if (disposed || generation !== readGeneration) return;
        const receivedAt = now();
        onData(data, receivedAt);
        publish({ pending: false, lastSuccessAt: receivedAt, lastAttemptAt: connection.lastAttemptAt, error: null, failures: 0, failureStartedAt: null });
      } catch (reason) {
        if (disposed || generation !== readGeneration) return;
        publish({ ...connection, pending: false, error: reason instanceof Error ? reason.message : "任务状态读取失败", failures: connection.failures + 1, failureStartedAt: connection.failureStartedAt ?? now() });
        throw reason;
      } finally {
        clearTimeout(timer!);
        if (generation === readGeneration) { controller = null; pending = null; cancelRead = null; }
      }
    })();
    return pending;
  }

  return {
    refresh,
    // Mutations invalidate reads begun before their acknowledged state. A
    // cancellation/retry must never be replaced by a late pre-action snapshot.
    invalidate() { generation += 1; controller?.abort(); cancelRead?.(); controller = null; pending = null; cancelRead = null; },
    dispose() { disposed = true; generation += 1; controller?.abort(); cancelRead?.(); controller = null; pending = null; cancelRead = null; },
  };
}
