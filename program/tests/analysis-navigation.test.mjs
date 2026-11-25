import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("material center groups three scoped views under one sidebar entry", async () => {
  const [shell, page, workspace] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/analysis/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.equal((shell.match(/href: "\/analysis[^"]*"/g) ?? []).length, 1);
  assert.match(shell, /label: "素材中心"[^\n]+href: "\/analysis"/);
  assert.match(page, /<AppShell activePath="\/analysis">/);
  assert.match(page, /<ModuleHeader title="素材中心"/);
  const tabs = [...page.matchAll(/href: "\/analysis\?view=([^"]+)", label: "([^"]+)", active: view === "\1"/g)];
  assert.deepEqual(tabs.map(([, view, label]) => [view, label]), [
    ["videos", "视频分析"],
    ["benchmark", "空间对标"],
    ["assets", "公司素材"],
  ]);
  assert.match(page, /requestedView === "assets" \? requestedView : "videos"/);
  assert.match(page, /initialOrganizationId=\{organizationId\} initialProjectId=\{projectId\}/);
  assert.match(workspace, /useWorkspaceInitialization\(\{ initialOrganizationId, initialProjectId,/);
});
