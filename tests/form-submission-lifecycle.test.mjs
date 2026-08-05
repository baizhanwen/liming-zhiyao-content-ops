import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("async form handlers retain the form element before awaiting requests", async () => {
  const componentDirectory = new URL("../components/", import.meta.url);
  const componentFiles = (await readdir(componentDirectory)).filter((name) => name.endsWith(".tsx"));
  const sources = await Promise.all(componentFiles.map(async (name) => [name, await readFile(new URL(name, componentDirectory), "utf8")]));

  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /event\.currentTarget\.reset\(\)/, `${name} resets a React event target after an await`);
  }

  const projectManager = sources.find(([name]) => name === "ProjectManager.tsx")?.[1] ?? "";
  assert.match(projectManager, /const formElement = event\.currentTarget/);
  assert.match(projectManager, /formElement\.reset\(\)/);
});
