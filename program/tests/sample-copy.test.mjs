import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("user-facing forms do not expose the retired sample customer name", async () => {
  const files = ["ProjectManager.tsx", "SearchWorkspace.tsx", "AppShell.tsx"];
  const sources = await Promise.all(files.map((name) => readFile(new URL(`../components/${name}`, import.meta.url), "utf8")));
  for (const source of sources) assert.doesNotMatch(source, /澄川/);
});
