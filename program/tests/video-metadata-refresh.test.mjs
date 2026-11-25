import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const workId = "7621970063271234571";
const firstTime = "2026-11-21T10:00:00.000Z";
const secondTime = "2026-11-22T10:00:00.000Z";
const detail = {
  platformWorkId: workId, title: "作品标题", description: "标签与说明", authorName: "作者", publishedAt: "2026-10-01T00:00:00.000Z",
  authorSecUid: "MS4wLjABAAAA_fixture_author", authorUid: "9007199254740993123",
  durationSec: 23, collectedAt: firstTime, metrics: { plays: 40, likes: 0, comments: 3, favorites: 1, shares: 0 },
  coverUrls: ["https://p3.douyinpic.com/test.jpg"],
};

async function fixture(t) {
  const f = runtimeFixture(t);
  const owner = await f.initialize();
  const scope = { ...owner, projectId: "metadata-project", videoId: "metadata-video" };
  const { videoId, projectId, userId, organizationId } = scope;
  const now = new Date().toISOString();
  f.identity.userId = userId;
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(projectId, organizationId, "Test", "Test", userId, userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,title,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,'用户自定义标题',?,?,?,?)")
    .run(videoId, organizationId, projectId, "https://www.douyin.com/video/" + workId, userId, userId, now, now);
  let lookups = 0, writes = 0;
  const provider = {
    observe: async () => detail,
    image: async () => ({ bytes: Uint8Array.of(1, 2, 3).buffer, contentType: "image/jpeg", extension: "jpg" }),
    comments: async () => ({ platformWorkId: workId, collectedAt: firstTime, comments: [] }),
  };
  const { TikHubError } = f.load("lib/tikhub-metadata.ts");
  f.mock("lib/tikhub-metadata.ts", {
    TikHubError,
    fetchTikHubMetadata: async input => { lookups++; return provider.observe(input); },
    fetchTikHubCover: async urls => provider.image(urls),
    fetchTikHubWebComments: input => provider.comments(input),
  });
  const objects = new Map();
  const env = { TIKHUB_API_KEY: "synthetic-ticket" };
  f.mockModule("cloudflare:workers", { env });
  f.runtime.getMediaBucket = () => ({
    put: async (key, bytes) => { writes++; objects.set(key, bytes); return { key }; },
    head: async key => objects.has(key) ? { key } : null,
    delete: async key => { objects.delete(key); },
  });
  f.runtime.getProjectAccess = async (_sub, org, project) =>
    org === organizationId && project === projectId ? { userId, canWrite: true } : null;
  f.runtime.canWriteProjectAccess = access => access.canWrite;
  const { POST } = f.load("app/api/videos/[videoId]/metadata/route.ts");
  async function post(changes = {}) {
    const body = { organizationId, projectId, ...changes };
    return POST(new Request("http://local.test/api/videos/" + videoId + "/metadata", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ videoId }) });
  }
  const snapshots = () => f.sqlite.prepare("SELECT source, plays, likes, comments, favorites, shares, collected_at FROM video_metric_snapshots ORDER BY collected_at").all()
    .map(row => ({ ...row }));
  const row = () => f.sqlite.prepare("SELECT * FROM videos WHERE id=?").get(videoId);
  const covers = () => f.sqlite.prepare("SELECT id, r2_key FROM media_assets WHERE video_id=? AND kind='platform_cover' AND status='active'").all(videoId);
  const jobs = () => f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n;
  return { ...f, scope, env, provider, TikHubError, post, row, snapshots, covers, jobs, objects, writes: () => writes, lookups: () => lookups };
}

test("refresh endpoint persists separate real observations, preserves unknown vs zero and deduplicates identical platform covers", async t => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "available");
  const coverKey = f.covers()[0].r2_key;
  f.provider.observe = async input => {
    assert.equal(input.platformWorkId, workId);
    return { ...detail, collectedAt: secondTime, publishedAt: null,
      metrics: { plays: null, likes: 7, comments: 0, favorites: null, shares: 0 } };
  };
  const second = await f.post();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, "partial");
  assert.deepEqual(f.snapshots(), [
    { source: "tikhub", ...detail.metrics, collected_at: firstTime },
    { source: "tikhub", plays: null, likes: 7, comments: 0, favorites: null, shares: 0, collected_at: secondTime },
  ]);
  assert.equal(f.row().title, "用户自定义标题");
  assert.equal(f.row().platform_title, detail.title);
  assert.equal(f.row().platform_description, detail.description);
  assert.equal(f.row().platform_author_sec_uid, detail.authorSecUid);
  assert.equal(f.row().platform_author_uid, detail.authorUid);
  assert.equal(f.row().published_at_source, "tikhub");
  assert.equal(f.row().published_at, detail.publishedAt);
  assert.equal(f.row().metadata_collected_at, secondTime);
  assert.equal(f.covers().length, 1);
  assert.equal(f.covers()[0].r2_key, coverKey);
  assert.equal(f.objects.size, 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.jobs(), 0);
});

test("legacy works acquire missing author IDs and keep them across renames or incomplete responses", async t => {
  const f = await fixture(t);
  f.provider.observe = async () => ({ ...detail, authorSecUid: null, authorUid: null });
  assert.equal((await (await f.post()).json()).status, "partial");
  assert.equal(f.row().platform_author_uid, null);
  f.provider.observe = async () => ({ ...detail, authorSecUid: null });
  assert.equal((await (await f.post()).json()).status, "available");
  f.provider.observe = async () => ({ ...detail, authorName: "新名称" });
  assert.equal((await f.post()).status, 200);
  f.provider.observe = async () => ({ ...detail, authorSecUid: null, authorUid: null, authorName: null });
  assert.equal((await f.post()).status, 200);
  assert.equal(f.row().author_name, "新名称");
  assert.equal(f.row().platform_author_sec_uid, detail.authorSecUid);
  assert.equal(f.row().platform_author_uid, detail.authorUid);
});

test("a conflicting publisher never replaces the saved account, cover or metrics", async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  const saved = f.snapshots();
  for (const conflicting of [{ authorSecUid: "MS4wLjABAAAA_another" }, { authorUid: "42" }]) {
    f.provider.observe = async () => ({ ...detail, ...conflicting, collectedAt: secondTime, authorName: "其他作者" });
    const response = await f.post();
    assert.equal(response.status, 502);
    assert.match(await response.text(), /作者标识/);
    assert.equal(f.row().author_name, detail.authorName);
    assert.equal(f.row().platform_author_sec_uid, detail.authorSecUid);
    assert.equal(f.row().platform_author_uid, detail.authorUid);
    assert.equal(f.row().metadata_request_id, null);
    assert.deepEqual(f.snapshots(), saved);
  }
  assert.equal(f.writes(), 1);
});

test("the metadata and comment providers use the company's saved key on the next refresh", async t => {
  const f = await fixture(t);
  f.env.MODEL_SETTINGS_ENCRYPTION_KEY = "ca".repeat(32);
  f.env.TIKHUB_API_KEY = "";
  f.runtime.getOrganizationAccess = async (_sub, org) =>
    org === f.scope.organizationId ? { organizationRole: "admin", userId: f.scope.userId } : null;
  const route = f.load("app/api/tikhub-settings/route.ts");
  const update = patch => route.PUT(new Request("http://local.test/api/tikhub-settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: f.scope.organizationId, ...patch }),
  }));
  const detailsKeys = [], commentsKeys = [];
  f.provider.observe = async ({ apiKey }) => { detailsKeys.push(apiKey); return detail; };
  f.provider.comments = async ({ apiKey }) => {
    commentsKeys.push(apiKey);
    return { platformWorkId: workId, collectedAt: firstTime, comments: [] };
  };
  assert.equal((await update({ version: 0, apiKey: "fixture-organization-only" })).status, 200);
  assert.equal((await f.post()).status, 200);
  f.env.TIKHUB_API_KEY = "fixture-fallback";
  assert.equal((await update({ version: 1, clearApiKey: true })).status, 200);
  assert.equal((await f.post()).status, 200);
  assert.deepEqual(detailsKeys, ["fixture-organization-only", "fixture-fallback"]);
  assert.deepEqual(commentsKeys, detailsKeys);
  assert.equal(f.covers().length, 1);
});

test("overlapping refresh requests share one in-flight observation and release the lock on failure", async t => {
  const f = await fixture(t);
  let entered, unblock;
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = new Promise(resolve => { unblock = resolve; });
  f.provider.observe = async () => { entered(); await blocker; throw new Error("upstream transport failed"); };
  const first = f.post();
  await started;
  try {
    const concurrent = await f.post();
    assert.equal(concurrent.status, 409);
    assert.equal(f.lookups(), 1);
  } finally {
    unblock();
  }
  assert.equal((await first).status, 502);
  assert.equal(f.row().metadata_request_id, null);
  assert.equal(f.snapshots().length, 0);
  f.provider.observe = async () => detail;
  assert.equal((await f.post()).status, 200);
  assert.equal(f.snapshots().length, 1);
});

test("failed lookups and mismatched work identities preserve the previous snapshot and cover", async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  const saved = f.snapshots();
  const cover = f.covers()[0].r2_key;
  for (const observe of [async () => { throw new Error("private upstream response"); },
    async () => ({ ...detail, platformWorkId: "7621970063271234572", collectedAt: secondTime })]) {
    f.provider.observe = observe;
    const result = await f.post();
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /private upstream response/);
    assert.deepEqual(f.snapshots(), saved);
    assert.equal(f.row().metadata_collected_at, firstTime);
    assert.equal(f.row().metadata_request_id, null);
    assert.equal(f.row().platform_work_id, workId);
    assert.equal(f.covers()[0].r2_key, cover);
  }
  assert.equal(f.writes(), 1);
  assert.equal(f.jobs(), 0);
});

test("read-only access, a foreign space, uploads, and absent keys never call TikHub", async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ projectId: "foreign-space" })).status, 403);
  f.runtime.canWriteProjectAccess = () => false;
  assert.equal((await f.post()).status, 403);
  f.runtime.canWriteProjectAccess = () => true;
  f.env.TIKHUB_API_KEY = "";
  assert.equal((await f.post()).status, 503);
  f.env.TIKHUB_API_KEY = "synthetic-ticket";
  f.sqlite.prepare("UPDATE videos SET source_type='upload', source_url=NULL WHERE id=?").run(f.scope.videoId);
  assert.equal((await f.post()).status, 422);
  assert.equal(f.lookups(), 0);
  assert.equal(f.jobs(), 0);
  assert.equal(f.snapshots().length, 0);
});

test("original cover storage quota failure keeps observed metrics, removes the orphan and allows a later retry", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE organization_settings SET storage_quota_bytes=0 WHERE organization_id=?").run(f.scope.organizationId);
  const first = await f.post();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "partial");
  assert.equal(f.snapshots().length, 1);
  assert.equal(f.row().metadata_collected_at, firstTime);
  assert.deepEqual(f.covers(), []);
  assert.equal(f.objects.size, 0);
  f.sqlite.prepare("UPDATE organization_settings SET storage_quota_bytes=10000 WHERE organization_id=?").run(f.scope.organizationId);
  f.provider.observe = async () => ({ ...detail, collectedAt: secondTime });
  const second = await f.post();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, "available");
  assert.equal(f.objects.size, 1);
  assert.equal(f.covers().length, 1);
  assert.equal(f.snapshots().length, 2);
  assert.equal(f.jobs(), 0);
});

test("detail returns comments in observed order; a failed Web refresh keeps that sample while metrics and cover still update", async t => {
  const f = await fixture(t);
  const { videoId, projectId, organizationId } = f.scope;
  const { GET } = f.load("app/api/videos/[videoId]/route.ts");
  const read = async () => {
    const response = await GET(new Request(`http://local.test/api/videos/${videoId}?organizationId=${organizationId}&projectId=${projectId}`),
      { params: Promise.resolve({ videoId }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await read()).platform_comments.status, "not_collected");
  const comments = [
    { comment_id: "7512762229444985651", text: "先返回的评论", like_count: 0, reply_count: null, published_at: null, has_image: false },
    { comment_id: "7513159958159622970", text: "后返回的评论", like_count: 23, reply_count: 2, published_at: firstTime, has_image: true },
  ];
  let calls = 0;
  f.provider.comments = async input => {
    calls++;
    assert.equal(input.platformWorkId, workId);
    return { platformWorkId: workId, collectedAt: firstTime, comments };
  };
  assert.equal((await (await f.post()).json()).status, "available");
  const first = await read();
  assert.equal(calls, 1);
  assert.equal(first.video.cover_source, "platform");
  assert.deepEqual(first.platform_comments, { status: "available", collected_at: firstTime, comments, error: null });

  f.provider.observe = async () => ({ ...detail, collectedAt: secondTime });
  f.provider.comments = async () => { throw Error("upstream response with private tokens"); };
  assert.equal((await (await f.post()).json()).status, "partial");
  const second = await read();
  assert.equal(second.metrics.length, 2);
  assert.equal(second.video.cover_source, "platform");
  assert.deepEqual(second.platform_comments.comments, comments);
  assert.equal(second.platform_comments.collected_at, firstTime);
  assert.equal(second.platform_comments.status, "failed");
  assert.doesNotMatch(second.platform_comments.error, /private tokens/);

  f.provider.comments = async () => ({ platformWorkId: workId, collectedAt: secondTime, comments: [] });
  assert.equal((await (await f.post()).json()).status, "available");
  assert.deepEqual((await read()).platform_comments, { status: "available", collected_at: secondTime, error: null, comments: [] });
  assert.equal(f.jobs(), 0);
});

test("an observation without any available counters creates no data point", async t => {
  const f = await fixture(t);
  f.provider.observe = async () => ({ ...detail, metrics: { plays: null, likes: null, comments: null, favorites: null, shares: null } });
  const result = await f.post();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "partial");
  assert.equal(f.row().author_name, detail.authorName);
  assert.equal(f.covers().length, 1);
  assert.deepEqual(f.snapshots(), []);
});

test("archiving the space during a lookup prevents new observations and orphaned covers", async t => {
  const f = await fixture(t);
  f.provider.observe = async () => {
    f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.scope.projectId);
    return detail;
  };
  const result = await f.post();
  assert.ok(result.status >= 400);
  assert.deepEqual(f.snapshots(), []);
  assert.equal(f.covers().length, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(f.row().metadata_request_id, null);
});

test("only trusted TikHub failures expose the actionable message to the API and saved status", async t => {
  const f = await fixture(t);
  for (const [error, expected] of [
    [new f.TikHubError("auth"), "TikHub 鉴权失败，请检查 API Key 和接口权限。"],
    [new Error("secret HTTP response"), "TikHub 作品资料暂未获取，请稍后重试。"],
  ]) {
    f.provider.observe = async () => { throw error; };
    const result = await f.post();
    assert.equal(result.status, 502);
    const body = await result.text();
    assert.ok(body.includes(expected));
    assert.ok(!body.includes("secret HTTP response"));
    assert.equal(f.row().metadata_message, expected);
  }
});
