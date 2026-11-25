import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const workId = "7621970063271234571";
const identity = { platformWorkId: workId, authorName: "测试作者", authorSecUid: "MS4w-test", authorUid: "12345678" };

async function fixture(t) {
  const f = runtimeFixture(t);
  const { userId, organizationId } = await f.initialize();
  const projectId = "author-project", videoId = "author-video", now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'测试','测试',?,?,?,?)")
    .run(projectId, organizationId, userId, userId, now, now);
  f.sqlite.prepare(`INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,platform_work_id,author_name,created_by,updated_by,created_at,updated_at,
    metadata_status,metadata_message,metadata_collected_at,metadata_attempted_at,platform_comments_json)
    VALUES(?,?,?,'douyin','url',?,?,'旧昵称',?,?,?,?,'partial','上次缺少收藏数','2026-01-01','2026-01-02','[]')`)
    .run(videoId, organizationId, projectId, "https://www.douyin.com/video/" + workId, workId, userId, userId, now, now);
  f.sqlite.prepare(`INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at)
    VALUES ('analysis',?,?,?,'analysis.v12','{"summary":"测试"}',?,?,?)`).run(organizationId, projectId, videoId, userId, now, now);
  let authorCalls = 0, detailCalls = 0;
  const gate = { writable: true, key: "synthetic-author-key", observe: async () => identity };
  f.runtime.getProjectAccess = async (_subject, org, project) => org === organizationId && project === projectId ? { userId } : null;
  f.runtime.canWriteProjectAccess = () => gate.writable;
  const tik = f.load("lib/tikhub-metadata.ts");
  f.mock("lib/tikhub-metadata.ts", {
    ...tik, fetchTikHubWorkAuthor: async input => { authorCalls++; return gate.observe(input); },
    fetchTikHubMetadata: async () => { detailCalls++; throw new tik.TikHubError("workUnavailable"); },
  });
  f.mock("lib/tikhub-settings.ts", { readEffectiveTikHubKey: async () => gate.key });
  const { POST } = f.load("app/api/videos/[videoId]/author/route.ts");
  const { refreshVideoMetadata } = f.load("lib/video-metadata-refresh.ts");
  const post = (patch = {}) => POST(new Request("http://test.local/author", {
    method: "POST", body: JSON.stringify({ organizationId, projectId, ...patch }),
  }), { params: Promise.resolve({ videoId }) });
  const row = () => f.sqlite.prepare("SELECT * FROM videos WHERE id=?").get(videoId);
  const fullRefresh = () => refreshVideoMetadata({ db: f.db, apiKey: gate.key, bucket: {} }, { organizationId, projectId, videoId, userId });
  return { ...f, gate, post, row, fullRefresh, authorCalls: () => authorCalls, detailCalls: () => detailCalls };
}

test("identify once without touching metrics, collection status, comments or covers; repeat uses the saved identity even without key", async t => {
  const f = await fixture(t);
  const before = f.row();
  const first = await f.post();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { accountKey: "sec:MS4w-test", authorName: "测试作者" });
  const after = f.row();
  for (const key of Object.keys(before)) {
    if (["updated_at", "platform_author_sec_uid", "platform_author_uid", "author_name"].includes(key)) continue;
    assert.equal(after[key], before[key], key);
  }
  for (const table of ["video_metric_snapshots","media_assets"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  f.gate.key = "";
  assert.equal((await f.post()).status, 200);
  assert.equal(f.authorCalls(), 1);
  assert.equal(f.detailCalls(), 0);
});

test("author lookup and full refresh share the work lease even when the last metadata attempt is old; failed transport can be retried", async t => {
  const f = await fixture(t);
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const blocker = new Promise(resolve => { finish = resolve; });
  f.gate.observe = async () => { started(); await blocker; throw new Error("synthetic-private-error"); };
  const pending = f.post();
  await entered;
  try {
    assert.equal((await f.post()).status, 409);
    assert.equal((await f.fullRefresh()).httpStatus, 409);
    assert.equal(f.authorCalls(), 1);
    assert.equal(f.detailCalls(), 0);
  } finally { finish(); }
  const failed = await pending;
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /synthetic-private-error/);
  assert.equal(f.row().metadata_request_id, null);
  assert.equal(f.row().metadata_status, "partial");
  assert.equal(f.row().metadata_attempted_at, "2026-01-02");
  f.gate.observe = async () => ({ ...identity, authorUid: null, authorSecUid: null });
  assert.equal((await f.post()).status, 422);
  assert.equal(f.row().author_name, "旧昵称");
  f.gate.observe = async () => identity;
  const clock = new Date().toISOString();
  f.sqlite.prepare("UPDATE videos SET metadata_request_id='legacy-refresh',metadata_attempted_at=?").run(clock);
  assert.equal((await f.post()).status, 409);
  assert.equal(f.authorCalls(), 2);
  f.sqlite.exec("UPDATE videos SET metadata_attempted_at='2026-01-02'");
  assert.equal((await f.post()).status, 200);
});

test("read-only, foreign, missing report or key cannot spend a request; changed permission or mismatched identity cannot write", async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ projectId: "another" })).status, 403);
  f.gate.writable = false;
  assert.equal((await f.post()).status, 403);
  f.gate.writable = true;
  f.gate.key = "";
  assert.equal((await f.post()).status, 503);
  f.gate.key = "synthetic-author-key";
  f.sqlite.exec("UPDATE videos SET deleted_at='2026-01-01'");
  assert.equal((await f.post()).status, 404);
  f.sqlite.exec("UPDATE videos SET deleted_at=NULL,source_type='upload'");
  assert.equal((await f.post()).status, 404);
  f.sqlite.exec("UPDATE videos SET source_type='url'; SAVEPOINT no_report; DELETE FROM video_analyses");
  assert.equal((await f.post()).status, 404);
  assert.equal(f.authorCalls(), 0);
  f.sqlite.exec("ROLLBACK TO no_report; RELEASE no_report");
  f.gate.observe = async () => ({ ...identity, platformWorkId: "7621970063271234572" });
  assert.equal((await f.post()).status, 502);
  assert.equal(f.row().platform_author_sec_uid, null);
  f.gate.observe = async () => { f.sqlite.exec("UPDATE projects SET status='archived'"); return identity; };
  assert.equal((await f.post()).status, 409);
  assert.equal(f.row().platform_author_sec_uid, null);
  assert.equal(f.row().metadata_request_id, null);
});
