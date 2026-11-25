import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const workId = "7621970063271234571";
const otherId = "7621970063271234572";
const input = { platformWorkId: workId, sourceUrl: "https://www.douyin.com/video/" + workId, apiKey: "test-key" };
const cover = "https://p3-sign.douyinpic.com/abc.jpeg";
const detail = {
  aweme_id: workId, item_title: "标题", desc: "完整描述与标签",
  author: { nickname: "作者", sec_uid: "MS4wLjABAAAA_fixture_author", uid: "9007199254740993123" }, create_time: 1700000000,
  video: { duration: 12500, origin_cover: { url_list: [cover] } },
  statistics: { digg_count: 0, comment_count: "32", collect_count: -1, share_count: null, play_count: 0 },
};

function provider(t) {
  const fixture = runtimeFixture(t);
  return fixture.load("lib/tikhub-metadata.ts");
}

function envelope(data) {
  // Douyin sometimes sends a 19-digit ID as an unquoted JSON number.
  const raw = JSON.stringify({ code: 200, data }).replaceAll('"aweme_id":"' + workId + '"', '"aweme_id":' + workId);
  return new Response(raw);
}

test("direct and short URLs bind metadata, official zero plays and original cover to an exact 64-bit work ID", async t => {
  const { fetchTikHubMetadata } = provider(t);
  const calls = [];
  const mock = async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.tikhub.io");
    calls.push(parsed);
    if (parsed.pathname.endsWith("/fetch_video_play_count")) {
      return envelope({ aweme_id: workId, is_available: true, play_count: 0 });
    }
    return envelope({ aweme_detail: detail });
  };
  for (const target of [input, { ...input, platformWorkId: null, sourceUrl: "分享 https://v.douyin.com/abc/?tracking=private" }]) {
    const value = await fetchTikHubMetadata(target, mock);
    assert.equal(value.platformWorkId, workId);
    assert.equal(value.title, "标题");
    assert.equal(value.description, "完整描述与标签");
    assert.equal(value.authorName, "作者");
    assert.equal(value.authorSecUid, detail.author.sec_uid);
    assert.equal(value.authorUid, detail.author.uid);
    assert.equal(value.durationSec, 13);
    assert.equal(value.publishedAt, "2023-11-14T22:13:20.000Z");
    assert.ok(Number.isFinite(Date.parse(value.collectedAt)));
    assert.deepEqual(value.metrics, { plays: 0, likes: 0, comments: 32, favorites: null, shares: null });
    assert.deepEqual(value.coverUrls, [cover]);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls[0].pathname.endsWith("/fetch_one_video_v2"));
  assert.equal(calls[0].searchParams.get("aweme_id"), workId);
  assert.ok(calls[2].pathname.endsWith("/fetch_one_video_by_share_url"));
  assert.equal(calls[2].searchParams.get("share_url"), "https://v.douyin.com/abc/");
});

test("author-only lookup reads the work publisher once per work and preserves exact UID tokens", async t => {
  const { fetchTikHubWorkAuthor } = provider(t);
  const calls = [];
  for (const id of [workId, otherId]) {
    const value = await fetchTikHubWorkAuthor({ ...input, sourceUrl: "https://v.douyin.com/example/", platformWorkId: id }, async url => {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ code: 200, data: { aweme_detail: {
        ...detail, aweme_id: id, author: { ...detail.author, nickname: id === workId ? "旧名称" : "新名称" },
      } } }).replace('"uid":"' + detail.author.uid + '"', '"uid":' + detail.author.uid));
    });
    assert.equal(value.platformWorkId, id);
    assert.equal(value.authorSecUid, detail.author.sec_uid);
    assert.equal(value.authorUid, detail.author.uid);
  }
  assert.deepEqual(calls, Array(2).fill("/api/v1/douyin/app/v3/fetch_one_video_v2"));
});

test("missing author identifiers are never inferred from handles, nicknames or another user's identity", async t => {
  const { fetchTikHubWorkAuthor } = provider(t);
  for (const uid of ["0", "9.1", "-1", null, detail.author.uid]) {
    const result = await fetchTikHubWorkAuthor(input, async () => envelope({
      author: detail.author,
      aweme_detail: { ...detail, author: { nickname: "同名", unique_id: "user_handle", uid, sec_uid: "0" } },
    }));
    assert.equal(result.authorSecUid, null);
    assert.equal(result.authorUid, uid === detail.author.uid ? uid : null);
  }
});

test("mismatched IDs and non-Douyin URLs cannot trigger enrichment for a different work", async t => {
  const { fetchTikHubMetadata } = provider(t);
  let calls = 0;
  const wrongWork = async () => { calls++; return envelope({ aweme_list: [{ ...detail, aweme_id: otherId }] }); };
  await assert.rejects(fetchTikHubMetadata({ ...input, sourceUrl: "https://www.douyin.com/video/" + otherId }, wrongWork), /不一致/);
  await assert.rejects(fetchTikHubMetadata({ ...input, sourceUrl: "https://127.0.0.1/" }, wrongWork), /抖音作品链接/);
  assert.equal(calls, 0);
  await assert.rejects(fetchTikHubMetadata(input, wrongWork), /匹配/);
  assert.equal(calls, 1);
});

test("inaccessible play stats or an unrelated ID keep plays unknown and preserve detail metrics", async t => {
  const { fetchTikHubMetadata } = provider(t);
  for (const reply of [new Response(null, { status: 429 }), envelope({ aweme_id: workId, is_available: false, play_count: 0 }),
    envelope({ aweme_id: otherId, is_available: true, play_count: 245 })]) {
    const value = await fetchTikHubMetadata(input, async url => url.includes("fetch_video_play_count") ? reply : envelope({ aweme_detail: detail }));
    assert.equal(value.metrics.plays, null);
    assert.equal(value.metrics.likes, 0);
    assert.equal(value.metrics.comments, 32);
  }
});

test("known plays or a known image post avoid an extra billed call", async t => {
  const { fetchTikHubMetadata } = provider(t);
  for (const [work, expected] of [[{ ...detail, statistics: { play_count: 8 } }, 8], [{ ...detail, images: [{}] }, null]]) {
    let calls = 0;
    const result = await fetchTikHubMetadata(input, async () => { calls++; return envelope({ aweme_list: [work] }); });
    assert.equal(calls, 1);
    assert.equal(result.metrics.plays, expected);
  }
});

test("service failures expose only a fixed message without third-party payloads or tokens", async t => {
  const { fetchTikHubMetadata } = provider(t);
  await assert.rejects(fetchTikHubMetadata(input, async () => { throw Error("secret API header"); }),
    { message: "TikHub 请求失败或返回无效数据，请稍后再试。" });
  await assert.rejects(fetchTikHubMetadata(input, async () => new Response("secret", { status: 401 })), /TikHub 鉴权失败/);
});

test("original cover fetch restricts origin, size, MIME and magic; secrets never reach the CDN", async t => {
  const { fetchTikHubCover } = provider(t);
  // A complete 1x1 PNG.
  const raw = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const seen = [];
  const value = await fetchTikHubCover(["https://douyinpic.com.invalid/private", "https://user:pass@p3.douyinpic.com/private",
    cover + "?large", cover + "?invalid", cover + "?wrong-type", cover], async (url, init) => {
    seen.push(url);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(init.redirect, "manual");
    if (url.endsWith("?large")) return new Response(null, { headers: { "content-length": String(6 * 1024 * 1024) } });
    if (url.endsWith("?invalid")) return new Response("<html/>", { headers: { "content-type": "image/png" } });
    return new Response(raw, { headers: { "content-type": url.endsWith("?wrong-type") ? "image/jpeg" : "image/png" } });
  });
  assert.deepEqual(seen, [cover + "?large", cover + "?invalid", cover + "?wrong-type", cover]);
  assert.equal(value.contentType, "image/png");
  assert.equal(value.extension, "png");
  assert.deepEqual(Buffer.from(value.bytes), raw);
});

test("Web comments preserve the first ten unique top-level IDs in the default first page order", async t => {
  const { fetchTikHubWebComments } = provider(t);
  const first = { cid: "7512762229444985651", aweme_id: workId, reply_id: "0", reply_to_reply_id: "0",
    text: "", image_list: [{ uri: "media" }], digg_count: 0, reply_comment_total: "15", create_time: 1700000000 };
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...first, cid: String(BigInt(first.cid) + BigInt(i + 1)), text: "样本" + i, image_list: null, digg_count: 9000 - i,
  }));
  let calls = 0;
  const result = await fetchTikHubWebComments(input, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.tikhub.io/api/v1/douyin/web/fetch_video_comments?aweme_id=" + workId + "&cursor=0&count=20");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(init.redirect, "manual");
    const comments = [first, { ...rows[0], reply_id: first.cid }, { ...rows[1], reply_to_reply_id: first.cid },
      { ...rows[2], aweme_id: otherId }, first, null, ...rows];
    const body = JSON.stringify({ code: 200, data: { status_code: 0, comments, has_more: 1 } })
      .replace(/"(cid|aweme_id|reply_id|reply_to_reply_id)":"(\d+)"/g, '"$1":$2');
    return new Response(body);
  });
  assert.equal(calls, 1);
  assert.equal(result.platformWorkId, workId);
  assert.ok(Number.isFinite(Date.parse(result.collectedAt)));
  assert.deepEqual(result.comments.map(c => c.comment_id), [first, ...rows.slice(0, 9)].map(c => c.cid));
  assert.deepEqual(result.comments[0], { comment_id: first.cid, text: "", like_count: 0, reply_count: 15,
    published_at: "2023-11-14T22:13:20.000Z", has_image: true });
  assert.equal(result.comments[1].has_image, false);
});

test("Web comments distinguish a confirmed empty or short sample from an unusable response", async t => {
  const { fetchTikHubWebComments, TikHubError } = provider(t);
  const comment = { aweme_id: workId, cid: "7512762229444985651", text: "原文" };
  for (const data of [{ status_code: 0, comments: [] }, { status_code: 0, comments: null, total: 0, has_more: 0 }]) {
    const result = await fetchTikHubWebComments(input, async () => envelope(data));
    assert.deepEqual(result.comments, []);
  }
  const result = await fetchTikHubWebComments(input, async () => envelope({ comments: [comment] }));
  assert.deepEqual(result.comments, [{ comment_id: comment.cid, text: "原文", like_count: null,
    reply_count: null, published_at: null, has_image: false }]);
  for (const data of [{}, { comments: null }, { status_code: 1, comments: [] }, { comments: [], total: 4 },
    { comments: [], has_more: 1 }, { comments: [{}] }, { aweme_id: otherId, comments: [comment] },
    { comments: [{ ...comment, aweme_id: otherId }] }, { comments: [{ ...comment, reply_id: "123" }] }]) {
    await assert.rejects(fetchTikHubWebComments(input, async () => envelope(data)), TikHubError);
  }
  await assert.rejects(fetchTikHubWebComments(input, async () => new Response(null, { status: 429 })), /受限/);
  await assert.rejects(fetchTikHubWebComments(input, async () => new Response(null, { headers: { "content-length": "9000000" } })), /无效/);
  let calls = 0;
  for (const invalid of [{ ...input, platformWorkId: "" }, { ...input, apiKey: " " }]) {
    await assert.rejects(fetchTikHubWebComments(invalid, async () => { calls++; return envelope({}); }), TikHubError);
  }
  assert.equal(calls, 0);
});

test("Web comments follow new cursors only until ten eligible records and deduplicate across pages", async t => {
  const { fetchTikHubWebComments } = provider(t);
  const items = Array.from({ length: 15 }, (_, i) => ({ cid: String(i + 1), aweme_id: workId, text: String(i) }));
  const cursors = [];
  const result = await fetchTikHubWebComments(input, async url => {
    const cursor = new URL(url).searchParams.get("cursor");
    cursors.push(cursor);
    if (cursor === "0") return envelope({ comments: [items[0], { ...items[1], reply_id: "123" }], has_more: 1, cursor: 20 });
    if (cursor === "20") return envelope({ comments: [items[0], ...items.slice(2)], has_more: true, cursor: 40 });
    throw Error("unexpected page");
  });
  assert.deepEqual(cursors, ["0", "20"]);
  assert.deepEqual(result.comments.map(c => c.comment_id), [items[0], ...items.slice(2, 11)].map(c => c.cid));
});

test("Web comments stop on invalid or repeated cursors or three pages and reject a failed follow-up", async t => {
  const { fetchTikHubWebComments } = provider(t);
  const row = { cid: "18", aweme_id: workId, text: "原文" };
  for (const [cursors, expected] of [[[20, 20], 2], [[null], 1], [["abc"], 1], [[0], 1], [[20, 40, 60], 3]]) {
    let calls = 0;
    const result = await fetchTikHubWebComments(input, async () => envelope({ comments: [row], has_more: 1, cursor: cursors[calls++] }));
    assert.equal(calls, expected);
    assert.deepEqual(result.comments.map(c => c.comment_id), ["18"]);
  }
  let calls = 0;
  await assert.rejects(fetchTikHubWebComments(input, async () => {
    if (calls++ === 0) return envelope({ comments: [row], has_more: 1, cursor: 20 });
    return new Response(null, { status: 429 });
  }), /受限/);
  assert.equal(calls, 2);
  await assert.rejects(fetchTikHubWebComments(input, async () => envelope({ comments: [{ ...row, text: "x".repeat(8193) }] })), /作品评论/);
});
