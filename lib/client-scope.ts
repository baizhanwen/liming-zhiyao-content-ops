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

export function rememberCurrentScope(organizationId: string, projectId = "") {
  if (typeof window === "undefined") return;
  try {
    if (organizationId) window.localStorage.setItem(organizationKey, organizationId);
    if (projectId) window.localStorage.setItem(projectKey, projectId); else window.localStorage.removeItem(projectKey);
  } catch { /* Keep current-page behavior when browser storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(scopeChangeEvent, { detail: { organizationId, projectId } }));
}
