import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("video analysis is one click after the local launcher starts", async () => {
  const [workspace, videos, model, migration] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_analyzer_worker_presence.sql", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /一键开始分析/);
  assert.match(workspace, /window\.setInterval/);
  assert.match(workspace, /4_000/);
  assert.match(workspace, /页面会自动更新进度/);
  assert.match(videos, /analyzerOnline/);
  assert.match(videos, /analyzer_workers/);
  assert.match(model, /CONTENT_MODEL_API_KEY \|\| runtime\.ANALYZER_LLM_API_KEY/);
  assert.match(migration, /CREATE TABLE `analyzer_workers`/);
});
