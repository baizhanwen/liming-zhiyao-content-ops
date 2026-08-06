import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("topic field generation validates requested fields and returns only selected values", async () => {
  const generation = await import("../lib/topic-generation.ts");
  const selected = generation.parseTopicGeneration(JSON.stringify({
    angle: "从经营成本而不是技术参数切入",
    audience: "希望用 AI 提效的中小企业负责人",
    hook: "老板不需要会写代码，但一定要懂这五个概念。",
    priority: 82,
  }), ["angle", "audience", "priority"]);
  assert.deepEqual(selected, { angle: "从经营成本而不是技术参数切入", audience: "希望用 AI 提效的中小企业负责人", priority: 82 });
  assert.throws(() => generation.parseTopicGeneration('{"angle":"有效角度"}', ["hook"]));
});

test("topic workspace can fill blank fields and regenerate one field without overwriting the rest", async () => {
  const [workspace, route] = await Promise.all([
    readFile(new URL("../components/TopicWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/topics/generate/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /一键补全空白内容/);
  assert.match(workspace, /generatedFields\.filter\(\(field\) => !formValue\(field\)\)/);
  assert.match(workspace, /generateTopicFields\(\[field\]\)/);
  assert.match(workspace, /原有内容保持不变/);
  assert.match(route, /canWriteProjectAccess/);
  assert.match(route, /checkOrganizationQuota/);
  assert.match(route, /topic\.fields_generated/);
  assert.match(route, /model_calls/);
  assert.match(route, /sourceVideoAnalysis/);
  assert.match(route, /selectedKnowledge/);
});
