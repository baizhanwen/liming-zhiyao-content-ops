export type ClientScope = { organizationId: string; projectId: string };

export class ScopeChangedError extends Error {
  constructor() {
    super("CLIENT_SCOPE_CHANGED");
    this.name = "ScopeChangedError";
  }
}

export function isScopeCancellation(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && (error.name === "ScopeChangedError" || error.name === "AbortError"));
}

/** React does not await event handlers. Consume expected cancellation and display real failures. */
export async function runScopedAction(action: () => Promise<void>, onError: (message: string) => void) {
  try { await action(); }
  catch (error) {
    if (!isScopeCancellation(error)) onError(error instanceof Error ? error.message : "加载失败");
  }
}

let scopeEpoch = 0;
let currentScope: ClientScope = { organizationId: "", projectId: "" };
const activeControllers = new Set<AbortController>();

export function isCurrentClientScope(scope: ClientScope, epoch = scopeEpoch) {
  return epoch === scopeEpoch && scope.organizationId === currentScope.organizationId && scope.projectId === currentScope.projectId;
}

export function resetClientScope(scope: ClientScope) {
  if (scope.organizationId === currentScope.organizationId && scope.projectId === currentScope.projectId) return scopeEpoch;
  scopeEpoch += 1;
  currentScope = { ...scope };
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  return scopeEpoch;
}

export async function scopedFetch(input: RequestInfo | URL, init: RequestInit = {}, scope: ClientScope = currentScope) {
  const epoch = scopeEpoch;
  const controller = new AbortController();
  const signal = init.signal;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  activeControllers.add(controller);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!isCurrentClientScope(scope, epoch)) throw new ScopeChangedError();
    return response;
  } finally {
    activeControllers.delete(controller);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
