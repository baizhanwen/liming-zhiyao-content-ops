import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const early = "2026-11-01T12:00:00Z";
const late = "2026-11-20T12:00:00Z";
const workId = "7621970063271234571";

async function fixture(t) {
  const f = runtimeFixture(t);
  const { organizationId, userId } = await f.initialize();
  const seed = (table, fields) => {
    const columns = f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    const values = {
      id: crypto.randomUUID(), organization_id: organizationId, created_by: userId, updated_by: userId,
      created_at: early, updated_at: early, ...fields,
    };
    const names = Object.keys(values).filter(name => columns.includes(name));
    f.sqlite.prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(n => values[n]));
    return values.id;
  };
  const projectId = seed("projects", { name: "分析空间", client_name: "test" });
  const other = seed("projects", { name: "其他空间", client_name: "test" });
  const projectData = { project_id: projectId };
  const video = (id, fields = {}) => seed("videos", { ...projectData, platform: "douyin", source_type: "url", source_url: "https://v.douyin.com/" + id + "/", id, ...fields });
  const report = (id, date = early, fields = {}) => seed("video_analyses", {
    ...projectData, video_id: id, schema_version: "analysis.v12", report_json: '{"summary":"已保存分析"}', created_at: date, ...fields,
  });
  const snapshot = (id, date, fields) => seed("video_metric_snapshots", { ...projectData, source: "tikhub", video_id: id, collected_at: date, ...fields });
  let canWrite = true;
  f.runtime.getProjectAccess = async (_subject, org, project) => org === organizationId && project === projectId ? { userId } : null;
  f.runtime.canWriteProjectAccess = () => canWrite;
  const { GET } = f.load("app/api/analytics/accounts/route.ts");
  const request = (params = { organizationId, projectId }) => GET(new Request("http://test.local/api/analytics/accounts?" + new URLSearchParams(params)));
  return { ...f, organizationId, projectId, other, seed, video, report, snapshot, request, readOnly() { canWrite = false; } };
}

test("saved reports group by stable identity after rename, deduplicate work copies, use the latest observation and original cover", async t => {
  const f = await fixture(t);
  const older = f.video("older", { platform_work_id: workId, platform_author_sec_uid: "sec-01", platform_author_uid: "62880088", author_name: "旧昵称", metadata_collected_at: early, duration_sec: 57 });
  f.report(older);
  f.snapshot(older, early, { plays: 100, likes: 5 });
  f.snapshot(older, late, { plays: null, likes: 0 });
  f.seed("media_assets", { id: "original-cover", project_id: f.projectId, video_id: older, kind: "platform_cover", r2_key: "original", filename: "cover.jpeg", content_type: "image/jpeg", size_bytes: 50, sha256: "a".repeat(64) });
  const newer = f.video("newer", { source_url: "https://www.douyin.com/video/" + workId, title: "同一作品" });
  f.report(newer);
  f.report(newer, late);
  f.snapshot(newer, early, { plays: 200, likes: 30, comments: 0 });
  const alias = f.video("alias", { platform_author_uid: "62880088", author_name: "新昵称", metadata_collected_at: late });
  f.report(alias);
  const sameName = f.video("samename", { platform_author_sec_uid: "another", author_name: "新昵称" });
  f.report(sameName);
  const response = await f.request();
  assert.equal(response.status, 200);
  const { accounts, canWrite } = await response.json();
  assert.equal(canWrite, true);
  assert.equal(accounts.length, 2);
  const main = accounts[0];
  assert.equal(main.accountKey, "sec:sec-01");
  assert.equal(main.name, "新昵称");
  assert.equal(main.lastAnalyzedAt, late);
  assert.equal(main.workCount, 2);
  assert.deepEqual(main.works.map(w => w.videoId), [newer, alias]);
  const first = main.works[0];
  assert.equal(first.platformWorkId, workId);
  assert.equal(first.durationSec, 57);
  assert.equal(first.collectedAt, late);
  assert.equal(first.plays, null);
  assert.equal(first.likes, 0);
  assert.equal(first.comments, null);
  assert.equal(first.title, "同一作品");
  assert.equal(first.coverSource, "platform");
  assert.ok(first.coverUrl.startsWith("/api/videos/older/assets/original-cover?"));
  assert.equal(new URL(first.coverUrl, "http://test.local").searchParams.get("projectId"), f.projectId);
  assert.equal(accounts[1].accountKey, "sec:another");
});

test("work duration uses saved seconds or a measured report and distinguishes missing values from zero", async t => {
  const f = await fixture(t);
  for (const [id, stored, status, measured] of [
    ["stored", 0, "measured", 0.42],
    ["measured", null, "measured", 9.751],
    ["unknown", null, "unknown", 0],
    ["malformed", null, "measured", "20"],
    ["negative", null, "measured", -1],
  ]) {
    f.video(id, { platform_author_uid: "123", duration_sec: stored });
    f.report(id, late, { report_json: JSON.stringify({ content_analysis: { metrics: { media: { status, duration_seconds: measured } } } }) });
  }
  const { accounts } = await (await f.request()).json();
  assert.deepEqual(Object.fromEntries(accounts[0].works.map(work => [work.videoId, work.durationSec])), {
    stored: 0, measured: 9.751, unknown: null, malformed: null, negative: null,
  });
});

test("transcript characters and detected cuts come from the displayed report and require valid measurement status", async t => {
  const f = await fixture(t);
  const metrics = (chars, cuts, transcriptStatus = "estimated", shotStatus = "measured") => ({
    report_json: JSON.stringify({ content_analysis: { metrics: {
      transcript_statistics: { status: transcriptStatus, character_count: chars },
      shot_detection: { status: shotStatus, detected_cut_count: cuts },
    } } }),
  });
  f.report(f.video("old", { platform_work_id: workId }), early, metrics(360, 35));
  f.report(f.video("latest", { platform_work_id: workId }), late, metrics(0, null, "estimated", "unknown"));
  for (const [id, report] of [
    ["normal", metrics(125, 0)],
    ["unknown", metrics(0, 0, "unavailable", "not_applicable")],
    ["invalid", metrics(2.4, -1)],
    ["invalid-types", metrics("10", true)],
  ]) f.report(f.video(id), late, report);

  const { accounts } = await (await f.request()).json();
  assert.deepEqual(Object.fromEntries(accounts[0].works.map(w => [w.videoId, [w.transcriptChars, w.cutCount]])), {
    latest: [0, null], normal: [125, 0], unknown: [null, null], invalid: [null, null], "invalid-types": [null, null],
  });
});

test("only saved Douyin analyses belonging to this space appear; missing identity, not nickname, controls identification", async t => {
  const f = await fixture(t);
  const one = f.video("local", { author_name: "同名" });
  f.report(one);
  const two = f.video("linked", { author_name: "同名", platform_author_uid: "62881212" });
  f.report(two);
  f.video("queued");
  f.report(f.video("deleted", { deleted_at: late }));
  f.report(f.video("otherproject", { project_id: f.other }), early, { project_id: f.other });
  f.report(f.video("tiktok", { platform: "tiktok" }));
  f.report(f.video("wrongscope"), early, { project_id: f.other });
  f.report(f.video("empty"), late, { report_json: "{}" });
  f.report(f.video("malformed"), late, { report_json: "broken" });
  const { accounts } = await (await f.request()).json();
  assert.deepEqual(accounts.map(a => a.accountKey), ["uid:62881212", "unidentified"]);
  assert.deepEqual(accounts[1].works.map(w => w.videoId), [one]);
  assert.equal(accounts[1].works[0].canIdentify, true);
  assert.equal(accounts[0].works[0].canIdentify, false);
  f.readOnly();
  const readonly = await (await f.request()).json();
  assert.equal(readonly.canWrite, false);
  assert.equal(readonly.accounts[1].works[0].canIdentify, false);
  assert.equal((await f.request({ projectId: f.other, organizationId: f.organizationId })).status, 403);
  assert.equal((await f.request({ projectId: f.projectId, organizationId: "foreign-org" })).status, 403);
  assert.equal((await f.request({})).status, 400);
});

test("conflicting sec_uid evidence does not merge distinct accounts or assign an ambiguous uid-only work", async t => {
  const f = await fixture(t);
  for (const [id, sec] of [["a", "sec-a"], ["b", "sec-b"], ["c", null]]) {
    f.report(f.video(id, { platform_author_sec_uid: sec, platform_author_uid: "62880088", author_name: "同名" }));
  }
  const { accounts } = await (await f.request()).json();
  assert.deepEqual(accounts.map(a => a.accountKey), ["sec:sec-a", "sec:sec-b", "unidentified"]);
  assert.equal(accounts[2].works[0].videoId, "c");
});
