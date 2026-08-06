import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("video analysis accepts a full Douyin share message", async () => {
  const helper = await readFile(new URL("lib/douyin-url.ts", root), "utf8");
  const route = await readFile(new URL("app/api/videos/from-url/route.ts", root), "utf8");
  const workspace = await readFile(new URL("components/AnalysisWorkspace.tsx", root), "utf8");

  assert.match(helper, /value\.match\(\/https:/);
  assert.match(helper, /isDouyinHost\(url\.hostname\)/);
  assert.match(helper, /candidate\.replace/);
  assert.match(route, /extractDouyinUrl\(payload\.url/);
  assert.match(workspace, /<textarea name="url"/);
  assert.match(workspace, /抖音分享文案或链接/);
});
