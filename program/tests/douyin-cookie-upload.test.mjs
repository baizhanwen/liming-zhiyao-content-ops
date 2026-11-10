import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("legacy Douyin cookie endpoints remain compatible without configuring anonymous collection", async () => {
  const { sanitizeDouyinCookieSnapshot } = await import("../lib/douyin-cookie-snapshot.ts");
  const input = [
    "# Netscape HTTP Cookie File",
    ".douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tsecret",
    ".example.com\tTRUE\t/\tTRUE\t0\tunrelated\tsecret",
  ].join("\n");
  const imported = sanitizeDouyinCookieSnapshot(input);
  assert.equal(imported.count, 1);
  assert.match(imported.contents, /sessionid/);
  assert.doesNotMatch(imported.contents, /unrelated/);

  const [uploadRoute, workerRoute, workspace, workerClient] = await Promise.all([
    readFile(new URL("../app/api/analyzer/cookies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/cookies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/api_client.py", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(uploadRoute, /organizationRole !== "admin"/);
  assert.match(uploadRoute, /if \(!access\).*ACCESS_DENIED/);
  assert.match(uploadRoute, /getMediaBucket\(\)\.put/);
  assert.match(uploadRoute, /export async function DELETE/);
  assert.match(uploadRoute, /getMediaBucket\(\)\.delete/);
  assert.match(uploadRoute, /analyzer\.cookies_deleted/);
  assert.doesNotMatch(uploadRoute, /contents.*Response\.json/);
  assert.match(workerRoute, /lease_owner = \?/);
  assert.match(workerRoute, /lease_expires_at > \?/);
  assert.match(workspace, /更新 Cookie/);
  assert.match(workspace, /清除 Cookie/);
  assert.match(workspace, /accept="\.txt,text\/plain"/);
  const videosRoute = await readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8");
  const readiness = await readFile(new URL("../lib/analyzer-readiness.ts", import.meta.url), "utf8");
  assert.match(videosRoute, /canManageCookies: canWriteProjectAccess\(access\)/);
  assert.match(readiness, /publicLinkAuthenticationMode = "anonymous"/);
  assert.doesNotMatch(readiness, /getMediaBucket|ANALYZER_YTDLP_COOKIE_FILE/);
  assert.match(workspace, /service\.canManageCookies && !anonymousCollection/);
  assert.match(workerClient, /download_cookie_snapshot/);
});
