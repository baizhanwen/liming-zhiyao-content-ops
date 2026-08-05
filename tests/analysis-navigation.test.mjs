import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("analysis navigation uses one distinct active target per research view", async () => {
  const [shell, page, workspace] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/analysis/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(shell, /label: "视频分析"[^\n]+href: "\/analysis"/);
  assert.match(shell, /label: "对标内容库"[^\n]+href: "\/analysis\?view=benchmark"/);
  assert.match(shell, /label: "素材中心"[^\n]+href: "\/analysis\?view=assets"/);
  assert.match(page, /activePath = view === "videos" \? "\/analysis" : `\/analysis\?view=\$\{view\}`/);
  assert.match(workspace, /initialView\?: "videos" \| "benchmark" \| "assets"/);
});
