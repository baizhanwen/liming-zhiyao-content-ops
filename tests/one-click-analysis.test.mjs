import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("video analysis is one click after the local launcher starts", async () => {
  const [workspace, videos, readiness, model, migration] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/analyzer-readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_analyzer_worker_presence.sql", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /一键开始分析/);
  assert.match(workspace, /请先配置分析模型/);
  assert.match(workspace, /分析服务未连接/);
  assert.doesNotMatch(workspace, /分析服务启动中/);
  assert.match(workspace, /window\.setInterval/);
  assert.match(workspace, /4_000/);
  assert.match(workspace, /页面会自动更新进度/);
  assert.match(videos, /analyzerOnline/);
  assert.match(readiness, /analyzer_workers/);
  assert.match(model, /CONTENT_MODEL_API_KEY \|\| runtime\.ANALYZER_LLM_API_KEY/);
  assert.match(migration, /CREATE TABLE `analyzer_workers`/);
});
