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
  assert.match(adapter, /input\.nativeJson !== false/);
  assert.match(adapter, /max_tokens:/);
  assert.match(adapter, /MODEL_OUTPUT_TRUNCATED/);
  assert.match(adapter, /if \(finishReason === "length"\)/);
});

test("content generation recommends current enterprise-space benchmarks and preserves feedback-aware citations", async () => {
  const [route, saveRoute, workspace, schema, styles, recommendationRoute] = await Promise.all([
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/content-production.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/video-library/recommendations/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /benchmarkEntryIds/);
  assert.match(schema, /recommendedBenchmarkIds/);
  assert.match(schema, /"benchmark"/);
  assert.match(route, /video_library_entries/);
  assert.match(route, /project_video_references/);
  assert.match(route, /refs\.project_id = \? AND refs\.purpose = 'benchmark' AND refs\.status = 'active'/);
  assert.match(route, /materialFeedbackPrompt/);
  assert.match(route, /BENCHMARK_CITATION_REQUIRED/);
  assert.match(route, /nativeJson: attempt === 0/);
  assert.match(route, /normalizeGeneratedProductionPackTextBounds\(parseModelJson\(invocation\.content\)\)/);
  assert.match(route, /catch \(reason\)[\s\S]*new ModelRequestError\([\s\S]*"INVALID_MODEL_OUTPUT"\)/);
  assert.match(route, /benchmarkEntryIds/);
  assert.match(saveRoute, /benchmark:/);
  assert.match(workspace, /智能推荐参考素材/);
  assert.match(workspace, /selectedBenchmarkIds/);
  assert.match(workspace, /匹配度/);
  assert.match(workspace, /实际引用/);
  assert.match(styles, /benchmark-generation-context/);
  assert.match(recommendationRoute, /recommendMaterials/);
  assert.match(recommendationRoute, /content_reviews/);
  assert.match(recommendationRoute, /publication_metric_snapshots/);
});
