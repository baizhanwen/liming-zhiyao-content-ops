import { douyinLookupTarget } from "./tikhub-metadata";
import { videoCoverJoin } from "./video-cover";

export type AnalyzedWork = {
  videoId: string;
  platformWorkId: string | null;
  title: string;
  coverUrl: string | null;
  coverSource: "platform" | "keyframe" | null;
  publishedAt: string | null;
  durationSec: number | null;
  transcriptChars: number | null;
  cutCount: number | null;
  analyzedAt: string;
  collectedAt: string | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  canIdentify: boolean;
};

export type AnalyzedAccount = {
  accountKey: string;
  name: string;
  workCount: number;
  lastAnalyzedAt: string;
  works: AnalyzedWork[];
};
export type AnalyzedAccountsData = { accounts: AnalyzedAccount[]; canWrite: boolean };

type WorkRow = Pick<AnalyzedWork, "videoId" | "platformWorkId" | "analyzedAt" | "publishedAt" | "durationSec" | "transcriptChars" | "cutCount" | "collectedAt" | "plays" | "likes" | "comments" | "favorites" | "shares"> & {
  title: string | null;
  secUid: string | null;
  uid: string | null;
  nickname: string | null;
  metadataAt: string | null;
  sourceUrl: string | null;
  sourceType: string;
  coverId: string | null;
  coverKind: string | null;
};

const pending = "unidentified";
export const hasSavedReport = `CASE WHEN json_valid(report.report_json) THEN json_type(report.report_json) = 'object'
  AND EXISTS (SELECT 1 FROM json_each(report.report_json) LIMIT 1) ELSE 0 END`;

// Read only the measured scalar from the report, never the full transcript or shot list.
function reportMetric(section: string, field: string, status: string) {
  const path = "$.content_analysis.metrics." + section;
  return `CASE WHEN json_extract(a.report_json,'${path}.status')='${status}'
    AND json_type(a.report_json,'${path}.${field}') IN ('integer','real')
    THEN json_extract(a.report_json,'${path}.${field}') END`;
}

function measuredCount(value: number | null) {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function loadAnalyzedAccounts(db: Pick<D1Database, "prepare">, organizationId: string, projectId: string, canWrite: boolean): Promise<AnalyzedAccountsData> {
  const { results } = await db.prepare(`
    SELECT v.id AS videoId, v.platform_work_id AS platformWorkId, v.platform_author_sec_uid AS secUid,
      v.platform_author_uid AS uid, v.author_name AS nickname, v.metadata_collected_at AS metadataAt,
      v.source_url AS sourceUrl, v.source_type AS sourceType, COALESCE(NULLIF(v.platform_title,''), v.title) AS title,
      v.published_at AS publishedAt, a.created_at AS analyzedAt, m.collected_at AS collectedAt,
      CASE WHEN typeof(v.duration_sec) IN ('integer','real') AND v.duration_sec >= 0 THEN v.duration_sec
        ELSE ${reportMetric("media", "duration_seconds", "measured")} END AS durationSec,
      ${reportMetric("transcript_statistics", "character_count", "estimated")} AS transcriptChars,
      ${reportMetric("shot_detection", "detected_cut_count", "measured")} AS cutCount,
      m.plays, m.likes, m.comments, m.favorites, m.shares, cover.id AS coverId, cover.kind AS coverKind
    FROM videos v
    INNER JOIN video_analyses a ON a.id = (
      SELECT report.id FROM video_analyses report
      WHERE report.organization_id=v.organization_id AND report.project_id=v.project_id AND report.video_id=v.id
        AND ${hasSavedReport}
      ORDER BY report.created_at DESC, report.rowid DESC LIMIT 1
    )
    LEFT JOIN video_metric_snapshots m ON m.id = (
      SELECT s.id FROM video_metric_snapshots s
      WHERE s.organization_id=v.organization_id AND s.project_id=v.project_id AND s.video_id=v.id
      ORDER BY s.collected_at DESC, s.rowid DESC LIMIT 1
    )
    ${videoCoverJoin}
    WHERE v.organization_id=? AND v.project_id=? AND v.deleted_at IS NULL AND v.platform='douyin'
    ORDER BY a.created_at DESC, v.id
  `).bind(organizationId, projectId).all<WorkRow>();

  // An older capture may have only a uid. Bridge it only when this space has observed
  // the same uid paired with exactly one sec_uid; nicknames never join accounts.
  const secByUid = new Map<string, Set<string>>();
  const copiesByWork = new Map<string, WorkRow[]>();
  for (const row of results) {
    if (row.uid && row.secUid) {
      const secIds = secByUid.get(row.uid) ?? new Set<string>();
      secIds.add(row.secUid);
      secByUid.set(row.uid, secIds);
    }
    let key = row.platformWorkId ? "work:" + row.platformWorkId : "video:" + row.videoId;
    if (row.sourceType === "url" && row.sourceUrl) {
      try {
        const { id, shareUrl } = douyinLookupTarget({ platformWorkId: row.platformWorkId, sourceUrl: row.sourceUrl });
        if (id) { row.platformWorkId = id; key = "work:" + id; }
        else if (shareUrl) key = "share:" + shareUrl;
      } catch { row.sourceUrl = null; }
    }
    const copies = copiesByWork.get(key);
    if (copies) copies.push(row);
    else copiesByWork.set(key, [row]);
  }

  const scope = new URLSearchParams({ organizationId, projectId });
  const accounts = new Map<string, AnalyzedAccount>();
  const latestNames = new Map<string, string>();
  for (const copies of copiesByWork.values()) {
    // SQL ordered by report time, so the first copy opens the latest saved report.
    const latest = copies[0];
    const keys = new Set<string>();
    let ambiguous = false;
    let cover: WorkRow | undefined;
    let observation: WorkRow | undefined;
    let author: WorkRow | undefined;
    let title = "";
    let publishedAt: string | null = null;
    let durationSec: number | null = null;
    for (const row of copies) {
      if (row.secUid) keys.add("sec:" + row.secUid);
      else if (row.uid) {
        const secIds = secByUid.get(row.uid);
        if (secIds && secIds.size > 1) ambiguous = true;
        else keys.add(secIds?.size ? "sec:" + [...secIds][0] : "uid:" + row.uid);
      }
      if (row.coverId && (!cover || (row.coverKind === "platform_cover" && cover.coverKind !== "platform_cover"))) cover = row;
      if (row.collectedAt && (!observation || row.collectedAt > observation.collectedAt!)) observation = row;
      if ((row.uid || row.secUid) && row.nickname && (!author || (row.metadataAt || "") > (author.metadataAt || ""))) author = row;
      title ||= row.title || "";
      publishedAt ??= row.publishedAt;
      if (row.durationSec !== null && Number.isFinite(row.durationSec) && row.durationSec >= 0) durationSec ??= row.durationSec;
    }
    const conflict = ambiguous || keys.size > 1;
    const accountKey = !conflict && keys.size ? [...keys][0] : pending;
    const work: AnalyzedWork = {
      videoId: latest.videoId, platformWorkId: latest.platformWorkId,
      title: title || "未命名作品", publishedAt, durationSec, analyzedAt: latest.analyzedAt,
      transcriptChars: measuredCount(latest.transcriptChars), cutCount: measuredCount(latest.cutCount),
      coverUrl: cover ? `/api/videos/${encodeURIComponent(cover.videoId)}/assets/${encodeURIComponent(cover.coverId!)}?${scope}` : null,
      coverSource: cover ? (cover.coverKind === "platform_cover" ? "platform" : "keyframe") : null,
      collectedAt: observation?.collectedAt ?? null, plays: observation?.plays ?? null, likes: observation?.likes ?? null,
      comments: observation?.comments ?? null, favorites: observation?.favorites ?? null, shares: observation?.shares ?? null,
      canIdentify: canWrite && accountKey === pending && !conflict && latest.sourceType === "url" && !!latest.sourceUrl,
    };
    const account = accounts.get(accountKey) ?? {
      accountKey, name: accountKey === pending ? "待识别账号" : "昵称未获取",
      workCount: 0, lastAnalyzedAt: latest.analyzedAt, works: [],
    } satisfies AnalyzedAccount;
    if (accountKey !== pending && author?.nickname && (!latestNames.has(accountKey) || (author.metadataAt || "") > latestNames.get(accountKey)!)) {
      account.name = author.nickname;
      latestNames.set(accountKey, author.metadataAt || "");
    }
    account.workCount++;
    account.works.push(work);
    accounts.set(accountKey, account);
  }
  const ordered = [...accounts.values()].sort((a, b) => Number(a.accountKey === pending) - Number(b.accountKey === pending) ||
    b.lastAnalyzedAt.localeCompare(a.lastAnalyzedAt) || a.accountKey.localeCompare(b.accountKey));
  return { accounts: ordered, canWrite };
}
