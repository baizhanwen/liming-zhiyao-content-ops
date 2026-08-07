import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("content model output parsing tolerates wrappers while DeepSeek structured calls disable thinking", async () => {
  const production = await import("../lib/content-production.ts");
  const adapter = await readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8");

  assert.deepEqual(production.parseModelJson("结果如下：\n```json\n{\"ok\":true,\"text\":\"带 } 字符\"}\n```\n请查收"), { ok: true, text: "带 } 字符" });
  assert.match(adapter, /extractModelResponseText/);
  assert.match(adapter, /Array\.isArray\(value\)/);
  assert.match(adapter, /requestBody\.thinking = \{ type: "disabled" \}/);
  assert.match(adapter, /max_tokens:/);
  assert.match(adapter, /MODEL_OUTPUT_TRUNCATED/);
});

test("content generation uses selected project benchmark analyses and preserves visible citations", async () => {
  const [route, saveRoute, workspace, schema, styles] = await Promise.all([
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/content-production.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /benchmarkEntryIds/);
  assert.match(schema, /"benchmark"/);
  assert.match(route, /project_video_references/);
  assert.match(route, /refs\.purpose = 'benchmark'/);
  assert.match(route, /analysisReportSourceText/);
  assert.match(route, /BENCHMARK_CITATION_REQUIRED/);
  assert.match(route, /benchmarkEntryIds/);
  assert.match(saveRoute, /benchmark:/);
  assert.match(workspace, /本次参考的对标内容/);
  assert.match(workspace, /selectedBenchmarkIds/);
  assert.match(workspace, /本版实际引用/);
  assert.match(styles, /benchmark-generation-context/);
});
