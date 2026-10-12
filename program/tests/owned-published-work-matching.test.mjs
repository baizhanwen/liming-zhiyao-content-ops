import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("owned published work matching prioritizes stable platform ids", async () => {
  const matching = await import("../lib/published-work-matching.ts");
  const result = matching.scorePublishedWorkCandidate(
    { platformWorkId: "73001", title: "标题已经修改", publishedAt: "2026-08-20T08:00:00.000Z" },
    { id: "video-1", platformWorkId: "73001", title: "原始标题", publishedAt: "2026-08-19T08:00:00.000Z" },
  );
  assert.deepEqual(result, { score: 100, method: "platform_id", reason: "抖音作品ID完全一致" });
});

test("title and publish date produce a confirmable suggestion without auto-binding", async () => {
  const matching = await import("../lib/published-work-matching.ts");
  const result = matching.scorePublishedWorkCandidate(
    { title: "大二程序员，实习中午干饭实录！", publishedAt: "2026-08-20T08:00:00.000Z" },
    { id: "video-1", title: "大二程序员实习中午干饭实录", publishedAt: "2026-08-20T09:00:00.000Z" },
  );
  assert.equal(result.method, "exact_title_date");
  assert.ok(result.score >= 90);
});

test("private and self-only works are excluded from owned published review", async () => {
  const matching = await import("../lib/published-work-matching.ts");
  assert.equal(matching.isPublicOwnedWork("公开"), true);
  assert.equal(matching.isPublicOwnedWork("自见"), false);
  assert.equal(matching.isPublicOwnedWork("仅自己可见"), false);
});

test("matching API requires project scope, completed analysis, human confirmation, and published material classification", async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL("../app/api/performance/work-matches/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0037_mark_matched_videos_published.sql", import.meta.url), "utf8"),
  ]);
  assert.match(source, /getProjectAccess/);
  assert.match(source, /video_analyses/);
  assert.match(source, /match_status = 'confirmed'/);
  assert.match(source, /INSERT OR IGNORE INTO video_library_entries/);
  assert.match(source, /video_library_entries SET category = 'published'/);
  assert.match(source, /VIDEO_ALREADY_MATCHED/);
  assert.match(source, /performance\.work_video_matched/);
  assert.match(migration, /match_status` = 'confirmed'/);
  assert.match(migration, /category` = 'published'/);
});

test("Douyin import accepts native XLSX and normalizes decimal ratio cells", async () => {
  const [workspace, xlsx, parser] = await Promise.all([
    readFile(new URL("../components/InsightsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/xlsx-table.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-import.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /\.xlsx/);
  assert.match(parser, /result \* 100/);
  assert.match(xlsx, /openBoundedZip/);
  assert.match(xlsx, /sharedStrings\.xml/);
});

test("owned works can start URL analysis inline using the local browser session", async () => {
  const [workspace, readiness, bootstrap] = await Promise.all([
    readFile(new URL("../components/OwnedWorkMatchingView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/analyzer-readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/bootstrap.py", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /\/api\/videos\/from-url/);
  assert.match(workspace, /粘贴这条作品的抖音链接/);
  assert.match(workspace, /开始分析/);
  assert.match(workspace, /分析已启动/);
  assert.match(readiness, /publicLinkAuthenticationMode/);
  assert.match(bootstrap, /ANALYZER_YTDLP_COOKIES_FROM_BROWSER", "edge"/);
});
