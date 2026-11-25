import { extractDouyinUrl } from "./douyin-url";
import { readBoundedResponseBytes } from "./bounded-response";
import { MAX_PLATFORM_COMMENT_LENGTH, MAX_PLATFORM_COMMENTS, type PlatformComment } from "./video-platform-comments";

type Fetcher = (url: string, options: RequestInit) => Promise<Response>;
type Input = { platformWorkId: string | null; sourceUrl: string; apiKey: string };
type RecordValue = Record<string, unknown>;
const API_BASE = "https://api.tikhub.io/api/v1/douyin/";
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const WORK_ID = /^[1-9][0-9]{5,24}$/;
const COMMENT_ID = /^[1-9][0-9]{0,24}$/;
const AUTHOR_UID = /^[1-9][0-9]{0,24}$/;
const AUTHOR_SEC_UID = /^[A-Za-z][A-Za-z0-9_-]{7,253}={0,2}$/;

export function isDouyinAuthorUid(value: unknown): value is string {
  return typeof value === "string" && AUTHOR_UID.test(value);
}

export function isDouyinAuthorSecUid(value: unknown): value is string {
  return typeof value === "string" && value !== "undefined" && AUTHOR_SEC_UID.test(value);
}

const EXACT_INTEGER_FIELDS = new Set(["aweme_id", "uid", "cid", "reply_id", "reply_to_reply_id", "cursor"]);
const MAX_COMMENT_PAGES = 3;
const IMAGE_DOMAINS = ["douyinpic.com", "byteimg.com", "douyincdn.com", "douyinstatic.com", "bytedance.net"];

export type TikHubWorkAuthor = {
  platformWorkId: string; authorName: string | null; authorSecUid: string | null; authorUid: string | null;
};
export type TikHubMetadata = TikHubWorkAuthor & {
  title: string | null; description: string | null;
  publishedAt: string | null; durationSec: number | null; collectedAt: string;
  metrics: { plays: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null };
  coverUrls: string[];
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function count(value: unknown) {
  const number = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function publishedTime(value: unknown) {
  const seconds = count(value);
  // Douyin create_time and the Web endpoint's publish_time are Unix seconds.
  return seconds && seconds < 253402300800 ? new Date(seconds * 1000).toISOString() : null;
}

function idString(value: unknown) {
  return typeof value === "string" && WORK_ID.test(value) ? value : null;
}

export function douyinLookupTarget(input: Pick<Input, "sourceUrl" | "platformWorkId">) {
  let id = idString(input.platformWorkId);
  if (input.platformWorkId && !id) throw new TikHubError("workIdInvalid");
  if (!input.sourceUrl && id) return { id, shareUrl: null };
  const extracted = extractDouyinUrl(input.sourceUrl);
  if (!extracted) throw new TikHubError("linkInvalid");
  const url = new URL(extracted);
  if (url.username || url.password || url.port) throw new TikHubError("linkInvalid");
  const pathId = /^\/(?:share\/)?(?:video|note)\/(\d+)\/?$/.exec(url.pathname)?.[1];
  const ids = [pathId, ...url.searchParams.getAll("modal_id"), ...url.searchParams.getAll("aweme_id")];
  for (const candidate of ids) {
    if (!candidate) continue;
    if (!idString(candidate) || (id && candidate !== id)) throw new TikHubError("workMismatch");
    id = candidate;
  }
  if (id) return { id, shareUrl: null };
  if (url.hostname !== "v.douyin.com" || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new TikHubError("linkInvalid");
  }
  return { id: null, shareUrl: url.origin + url.pathname };
}

const errorMessages = {
  workIdInvalid: "已保存的抖音作品 ID 无效。",
  linkInvalid: "请提供有效的抖音作品链接。",
  workMismatch: "抖音链接与作品 ID 不一致。",
  workUnavailable: "TikHub 未返回与此链接匹配的公开作品。",
  keyMissing: "请先配置 TikHub API Key。",
  auth: "TikHub 鉴权失败，请检查 API Key 和接口权限。",
  balance: "TikHub 账户余额不足。",
  rateLimit: "TikHub 请求受限，请稍后再试。",
  unavailable: "TikHub 暂时无法提供该作品的数据。",
  invalidResponse: "TikHub 请求失败或返回无效数据，请稍后再试。",
  invalidComments: "TikHub 未返回可确认的作品评论，请稍后再试。",
} as const;

export class TikHubError extends Error {
  constructor(code: keyof typeof errorMessages) { super(errorMessages[code]); }
}

function apiFailure(status: number) {
  if (status === 401 || status === 403) return new TikHubError("auth");
  if (status === 402) return new TikHubError("balance");
  if (status === 429) return new TikHubError("rateLimit");
  return new TikHubError("unavailable");
}

async function apiData(endpoint: string, params: Record<string, string>, apiKey: string, fetcher: Fetcher, timeoutMs = 10_000) {
  try {
    const response = await fetcher(API_BASE + endpoint + "?" + new URLSearchParams(params), {
      method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + apiKey },
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw apiFailure(response.status);
    }
    const bytes = await readBoundedResponseBytes(response, MAX_API_BYTES, "平台数据超过读取上限。");
    // Preserve exact JSON tokens for work/author IDs, comment relationships and cursors.
    const parsed = JSON.parse(new TextDecoder().decode(bytes), (key: string, value: unknown, context?: { source?: string }) => {
      if (EXACT_INTEGER_FIELDS.has(key) && typeof value === "number") {
        return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null);
      }
      return value;
    });
    const envelope = record(parsed);
    if (envelope.code !== 200) throw apiFailure(Number(envelope.code));
    return record(envelope.data);
  } catch (error) {
    if (error instanceof TikHubError) throw error;
    throw new TikHubError("invalidResponse");
  }
}

export type TikHubWebComment = PlatformComment;

function addWebComments(rows: unknown[], platformWorkId: string, comments: Map<string, TikHubWebComment>) {
  for (const value of rows) {
    const row = record(value);
    if (row.aweme_id !== platformWorkId || typeof row.cid !== "string" || !COMMENT_ID.test(row.cid) || comments.has(row.cid)) continue;
    if ((row.reply_id !== undefined && row.reply_id !== "0")
        || (row.reply_to_reply_id !== undefined && row.reply_to_reply_id !== "0")) continue;
    const content = typeof row.text === "string" ? row.text : "";
    if (content.length > MAX_PLATFORM_COMMENT_LENGTH) throw new TikHubError("invalidComments");
    const images = Array.isArray(row.image_list) && row.image_list.length > 0;
    const stickers = Array.isArray(row.stickers) ? row.stickers.length > 0 : Object.keys(record(row.stickers)).length > 0;
    comments.set(row.cid, {
      comment_id: row.cid, text: content,
      like_count: count(row.digg_count), reply_count: count(row.reply_comment_total),
      published_at: publishedTime(row.create_time), has_image: images || stickers,
    });
    if (comments.size === MAX_PLATFORM_COMMENTS) break;
  }
}

export async function fetchTikHubWebComments(
  input: { platformWorkId: string; apiKey: string }, fetcher: Fetcher = fetch,
): Promise<{ platformWorkId: string; collectedAt: string; comments: TikHubWebComment[] }> {
  const platformWorkId = idString(input.platformWorkId);
  if (!platformWorkId) throw new TikHubError("workIdInvalid");
  const key = input.apiKey.trim();
  if (!key) throw new TikHubError("keyMissing");
  const deadline = Date.now() + 12_000;
  const comments = new Map<string, TikHubWebComment>();
  const visited = new Set<string>();
  let cursor = "0";
  let confirmedEmpty = false;
  while (visited.size < MAX_COMMENT_PAGES && !visited.has(cursor)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TikHubError("unavailable");
    visited.add(cursor);
    const data = await apiData("web/fetch_video_comments", { aweme_id: platformWorkId, cursor, count: "20" },
      key, fetcher, Math.min(remaining, 10_000));
    if ((data.status_code !== undefined && data.status_code !== 0)
        || (data.aweme_id !== undefined && data.aweme_id !== platformWorkId)) throw new TikHubError("invalidComments");
    const total = count(data.total);
    const more = typeof data.has_more === "boolean" ? Number(data.has_more) : count(data.has_more);
    if (data.has_more != null && more !== 0 && more !== 1) throw new TikHubError("invalidComments");
    // Some empty first pages use null rather than an empty list.
    const rows = data.comments === null && total === 0 && more === 0 ? [] : data.comments;
    if (!Array.isArray(rows)) throw new TikHubError("invalidComments");
    confirmedEmpty = cursor === "0" && rows.length === 0 && more !== 1 && (total === null || total === 0);
    addWebComments(rows, platformWorkId, comments);
    if (comments.size === MAX_PLATFORM_COMMENTS || more !== 1) break;
    if (typeof data.cursor !== "string" || !/^[1-9]\d{0,24}$/.test(data.cursor)) break;
    cursor = data.cursor;
  }
  if (comments.size === 0 && !confirmedEmpty) throw new TikHubError("invalidComments");
  return { platformWorkId, collectedAt: new Date().toISOString(), comments: Array.from(comments.values()) };
}

function coverUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const allowedHost = IMAGE_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost) return null;
    return url.href;
  } catch {
    return null;
  }
}

function coverCandidates(video: RecordValue) {
  const urls = new Set<string>();
  for (const field of [video.origin_cover, video.cover]) {
    const list = record(field).url_list;
    if (!Array.isArray(list)) continue;
    // App clients sometimes receive HEIC alongside a browser-compatible rendition.
    const usable = list.map(coverUrl).filter((url): url is string => url !== null);
    usable.sort((a, b) => Number(/\.heic(?:\?|$)/i.test(a)) - Number(/\.heic(?:\?|$)/i.test(b)));
    for (const url of usable.slice(0, 3)) urls.add(url);
  }
  return Array.from(urls);
}

async function fetchTikHubWork(input: Input, fetcher: Fetcher) {
  const { id, shareUrl } = douyinLookupTarget(input);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new TikHubError("keyMissing");
  const data = id
    ? await apiData("app/v3/fetch_one_video_v2", { aweme_id: id }, apiKey, fetcher)
    : await apiData("app/v3/fetch_one_video_by_share_url", { share_url: shareUrl! }, apiKey, fetcher);
  if (data.status_code !== undefined && data.status_code !== 0) throw apiFailure(404);
  const candidates = Array.isArray(data.aweme_list) ? data.aweme_list
    : Array.isArray(data.aweme_details) ? data.aweme_details : [data.aweme_detail ?? data];
  const works = candidates.map(record).filter(item => idString(item.aweme_id));
  const work = id ? works.find(item => item.aweme_id === id) : works.length === 1 ? works[0] : null;
  if (!work) throw new TikHubError("workUnavailable");
  const author = record(work.author);
  const authorSecUid = isDouyinAuthorSecUid(author.sec_uid) ? author.sec_uid : null;
  const authorUid = isDouyinAuthorUid(author.uid) ? author.uid : null;
  return { work, identity: { platformWorkId: work.aweme_id as string, authorName: text(author.nickname, 300), authorSecUid, authorUid } };
}

export async function fetchTikHubWorkAuthor(input: Input, fetcher: Fetcher = fetch): Promise<TikHubWorkAuthor> {
  return (await fetchTikHubWork(input, fetcher)).identity;
}

export async function fetchTikHubMetadata(input: Input, fetcher: Fetcher = fetch): Promise<TikHubMetadata> {
  // Reserve time in the background task for the cover, comment sample and database writes.
  const detailDeadline = Date.now() + 16_000;
  const { work, identity } = await fetchTikHubWork(input, fetcher);
  const { platformWorkId } = identity;
  const stats = record(work.statistics);
  const video = record(work.video);
  const durationMs = count(video.duration ?? work.duration);
  const description = text(work.desc, 10_000);
  let publishedAt = publishedTime(work.create_time);
  let likes = count(stats.digg_count);
  // Detail endpoints often return a placeholder zero for unavailable play counts.
  let plays = count(stats.play_count) || null;
  if (plays === null && !(Array.isArray(work.images) && work.images.length > 0)) {
    try {
      const remaining = Math.max(1, Math.min(10_000, detailDeadline - Date.now()));
      const extra = await apiData("web/fetch_video_play_count", { aweme_id: platformWorkId }, input.apiKey.trim(), fetcher, remaining);
      if (extra.aweme_id === platformWorkId && extra.is_available === true) {
        plays = count(extra.play_count);
        likes ??= count(extra.digg_count);
        publishedAt ??= publishedTime(extra.publish_time);
      }
    } catch {
      // The optional plays lookup must not discard the already observed fields.
    }
  }
  return {
    ...identity, description, title: text(work.item_title, 500) ?? text(description, 500), publishedAt,
    durationSec: durationMs !== null && durationMs <= 86_400_000 ? Math.round(durationMs / 1000) : null,
    metrics: { plays, likes, comments: count(stats.comment_count), favorites: count(stats.collect_count), shares: count(stats.share_count) },
    coverUrls: coverCandidates(video), collectedAt: new Date().toISOString(),
  };
}

function coverFormat(bytes: Uint8Array) {
  const match = (offset: number, signature: number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (bytes.length >= 4 && match(0, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 24 && match(0, [137, 80, 78, 71, 13, 10, 26, 10]) && match(12, [73, 72, 68, 82])) return { contentType: "image/png", extension: "png" };
  if (bytes.length >= 20 && match(0, [82, 73, 70, 70]) && match(8, [87, 69, 66, 80])) return { contentType: "image/webp", extension: "webp" };
  if (bytes.length >= 20 && match(4, [102, 116, 121, 112]) && match(8, [97, 118, 105, 102])) return { contentType: "image/avif", extension: "avif" };
  return null;
}

export async function fetchTikHubCover(urls: string[], fetcher: Fetcher = fetch) {
  const deadline = Date.now() + 12_000;
  for (const candidate of new Set(urls.slice(0, 6))) {
    const url = coverUrl(candidate);
    if (!url) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetcher(url, {
        headers: { Accept: "image/jpeg,image/png,image/webp,image/avif" }, credentials: "omit", redirect: "manual",
        signal: AbortSignal.timeout(Math.min(remaining, 4000)),
      });
      const declaredType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || declaredType && declaredType !== "application/octet-stream" && !declaredType.startsWith("image/")) {
        await response.body?.cancel();
        continue;
      }
      const content = await readBoundedResponseBytes(response, MAX_COVER_BYTES, "封面图片超过读取上限。");
      const format = coverFormat(content);
      if (format && (!declaredType || declaredType === "application/octet-stream" || declaredType === format.contentType)) {
        return { ...format, bytes: content.buffer };
      }
    } catch {
      // Signed CDN URLs can expire independently. Try the next source for this cover.
    }
  }
  return null;
}
