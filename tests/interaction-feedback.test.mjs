import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the whole app acknowledges clicks, navigation, form submits, and pending workflow actions", async () => {
  const [layout, feedback, styles, workflow] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/InteractionFeedback.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../components/WorkflowWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /<InteractionFeedback/);
  assert.match(feedback, /document\.addEventListener\("click"/);
  assert.match(feedback, /document\.addEventListener\("submit"/);
  assert.match(feedback, /aria-live="polite"/);
  assert.match(styles, /button:not\(:disabled\):active/);
  assert.match(styles, /\.interaction-feedback/);
  assert.match(styles, /button\[aria-busy="true"\]::before/);
  assert.match(workflow, /aria-busy=\{pending\}/);
});
