import assert from "node:assert/strict";
import test from "node:test";
import { canReadProject, canWriteProject } from "../lib/authorization.ts";
import { resetClientScope, scopedFetch, ScopeChangedError } from "../lib/client-scope-request.ts";
import { resolveProjectAccess } from "../lib/scope-access-state.ts";

function memberContext(projectId, organizationId = "org-1", role = "member") {
  return { userId: "user-1", organizationId, organizationRole: "member", projectMemberships: new Map([[projectId, role]]) };
}

test("central project resolver rejects cross-company and unassigned project rows", () => {
  assert.equal(resolveProjectAccess(null), null);
  assert.equal(resolveProjectAccess({ userId: "user-1", organizationId: "org-1", organizationRole: "member", projectId: "project-2", projectRole: null }), null);
  assert.equal(resolveProjectAccess({ userId: "user-1", organizationId: "org-1", organizationRole: "member", projectId: "project-1", projectRole: "member" }).projectId, "project-1");
  assert.equal(resolveProjectAccess({ userId: "user-1", organizationId: "org-2", organizationRole: "admin", projectId: "project-1", projectRole: "member" }).organizationId, "org-2");
});

test("authorization denies a member's other project and other company", () => {
  const context = memberContext("project-1");
  assert.equal(canReadProject(context, { organizationId: "org-1", projectId: "project-1" }), true);
  assert.equal(canWriteProject(context, { organizationId: "org-1", projectId: "project-1" }), true);
  assert.equal(canReadProject(context, { organizationId: "org-1", projectId: "project-2" }), false);
  assert.equal(canWriteProject(context, { organizationId: "org-1", projectId: "project-2" }), false);
  assert.equal(canReadProject(context, { organizationId: "org-2", projectId: "project-1" }), false);
  assert.equal(canWriteProject(context, { organizationId: "org-2", projectId: "project-1" }), false);
});

test("scope change aborts an in-flight old-project request before it can return", async () => {
  const originalFetch = globalThis.fetch;
  let resolveOld;
  let aborted = false;
  globalThis.fetch = (_input, init) => new Promise((resolve, reject) => {
    resolveOld = () => resolve(new Response(JSON.stringify({ project: "old" }), { status: 200 }));
    init.signal.addEventListener("abort", () => { aborted = true; const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true });
  });
  try {
    resetClientScope({ organizationId: "org-1", projectId: "project-1" });
    const oldRequest = scopedFetch("/api/slow-project");
    resetClientScope({ organizationId: "org-1", projectId: "project-2" });
    await assert.rejects(oldRequest, (error) => error?.name === "AbortError");
    assert.equal(aborted, true);
    resolveOld?.();
  } finally {
    globalThis.fetch = originalFetch;
    resetClientScope({ organizationId: "", projectId: "" });
  }
});

test("scope guard rejects a late response even when the transport ignores abort", async () => {
  const originalFetch = globalThis.fetch;
  let resolveOld;
  globalThis.fetch = () => new Promise((resolve) => { resolveOld = () => resolve(new Response(JSON.stringify({ project: "old" }), { status: 200 })); });
  try {
    resetClientScope({ organizationId: "org-1", projectId: "project-1" });
    const oldRequest = scopedFetch("/api/slow-project");
    resetClientScope({ organizationId: "org-1", projectId: "project-2" });
    resolveOld();
    await assert.rejects(oldRequest, (error) => error instanceof ScopeChangedError && error.message === "CLIENT_SCOPE_CHANGED");
  } finally {
    globalThis.fetch = originalFetch;
    resetClientScope({ organizationId: "", projectId: "" });
  }
});
test("ordinary members can generate when the freeze switch is unset or disabled", async () => {
  const { isGenerationFrozen } = await import("../lib/generation-freeze.mjs");
  assert.equal(isGenerationFrozen(undefined), false);
  assert.equal(isGenerationFrozen(""), false);
  assert.equal(isGenerationFrozen("0"), false);
  assert.equal(isGenerationFrozen("false"), false);
  assert.equal(isGenerationFrozen("off"), false);
  assert.equal(isGenerationFrozen("1"), true);
  assert.equal(isGenerationFrozen("true"), true);
});
test("project selection survives scope-only reset until the next list is validated", async () => {
  const { preferredProjectId, rememberCurrentScope } = await import("../lib/client-scope.ts");
  const values = new Map([["liming.currentProjectId", "project-2"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: storage,
    sessionStorage: { removeItem() {} },
    dispatchEvent() {},
  };
  try {
    rememberCurrentScope("org-1", "");
    assert.equal(preferredProjectId([{ id: "project-1" }, { id: "project-2" }]), "project-2");
  } finally {
    globalThis.window = previousWindow;
  }
});
