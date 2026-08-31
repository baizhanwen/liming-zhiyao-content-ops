import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("topic completion receives a deterministic methodology plan separated from project facts", async () => {
  const [route, prompt] = await Promise.all([
    readFile(new URL("../app/api/topics/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/topic-generation.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /selectAuthorizedMethodologyPlan/);
  assert.match(route, /task:\s*"topic"/);
  assert.match(route, /methodologyPlan:\s*methodologyPlan\.snapshot/);
  assert.match(route, /supportingMethodReferences/);
  assert.match(route, /filter\(\(source\) => !source\.systemMethodology\)/);
  assert.match(prompt, /topic-fields\.v4-methodology-plan/);
  assert.match(prompt, /methodologyPlan 是系统在调用前确定的方法步骤/);
  assert.match(prompt, /不能作为客户事实/);
});
