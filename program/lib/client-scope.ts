import { resetClientScope } from "./client-scope-request.ts";
import { scopedFetch } from "./client-scope-request.ts";
import { readApiError } from "./client-format.ts";
export { scopedFetch, ScopeChangedError, runScopedAction } from "./client-scope-request.ts";

export const scopeChangeEvent = "liming:scope-change";

const organizationKey = "liming.currentOrganizationId";
const projectKey = "liming.currentProjectId";

function stored(key: string) {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}

export function preferredOrganizationId(items: Array<{ id: string }>, requested = "") {
  const remembered = stored(organizationKey);
  return items.some((item) => item.id === requested) ? requested : items.some((item) => item.id === remembered) ? remembered : items[0]?.id ?? "";
}

export function preferredProjectId(items: Array<{ id: string }>, requested = "") {
  const remembered = stored(projectKey);
  return items.some((item) => item.id === requested) ? requested : items.some((item) => item.id === remembered) ? remembered : items[0]?.id ?? "";
}

export async function loadClientOrganizations<T extends { id: string }>(requested = "") {
  const response = await fetch("/api/organizations");
  if (!response.ok) throw new Error(await readApiError(response));
  const body = await response.json() as { organizations: T[] };
  return { ...body, selected: preferredOrganizationId(body.organizations, requested) };
}

export async function loadClientProjects<T extends { id: string }>(organizationId: string, requested = "") {
  rememberCurrentScope(organizationId, "");
  const response = await scopedFetch("/api/projects?organizationId=" + encodeURIComponent(organizationId));
  if (!response.ok) throw new Error(await readApiError(response));
  const body = await response.json() as { projects: T[] };
  return { ...body, selected: preferredProjectId(body.projects, requested) };
}

export function rememberCurrentScope(organizationId: string, projectId = "") {
  if (typeof window === "undefined") return;
  const previousOrganizationId = stored(organizationKey);
  resetClientScope({ organizationId, projectId });
  try {
    if (organizationId) window.localStorage.setItem(organizationKey, organizationId);
    if (projectId) window.localStorage.setItem(projectKey, projectId);
  } catch { /* Keep current-page behavior when browser storage is unavailable. */ }
  if (previousOrganizationId && previousOrganizationId !== organizationId) {
    try { window.sessionStorage.removeItem(`liming.scope.cache.${previousOrganizationId}`); } catch { /* Storage is optional. */ }
  }
  window.dispatchEvent(new CustomEvent(scopeChangeEvent, { detail: { organizationId, projectId } }));
}
