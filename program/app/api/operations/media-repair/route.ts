import { z } from "zod";
import {
  ensureUser,
  getD1,
  getLegacyMediaBucket,
  getMediaBucket,
  getOrganizationAccess,
} from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { migrateMediaObjectToPrimary, type MediaMigrationStatus } from "../../../../lib/media-object-store";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  organizationId: z.string().uuid(),
  cursor: z.string().trim().max(100).optional().default(""),
  limit: z.number().int().min(1).max(50).optional().default(25),
  dryRun: z.boolean().optional().default(true),
});

type AssetRow = {
  id: string;
  kind: "keyframe" | "subtitle";
  r2_key: string;
  size_bytes: number;
  sha256: string | null;
};

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再检查素材存储。", 401);

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_MEDIA_REPAIR_REQUEST", "素材修复参数无效。", 400);
    const { organizationId, cursor, limit, dryRun } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") {
      return apiError("ADMIN_REQUIRED", "只有公司管理员可以检查或修复素材存储。", 403);
    }

    const db = getD1();
    const primary = getMediaBucket();
    const legacy = getLegacyMediaBucket();
    const rows = await db.prepare(`
      SELECT id, kind, r2_key, size_bytes, sha256
      FROM media_assets
      WHERE organization_id = ?
        AND status = 'active'
        AND kind IN ('keyframe', 'subtitle')
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).bind(organizationId, cursor, limit).all<AssetRow>();

    const results = [];
    const summary: Partial<Record<MediaMigrationStatus, number>> = {};
    for (const row of rows.results) {
      const result = await migrateMediaObjectToPrimary({
        primary,
        legacy,
        key: row.r2_key,
        dryRun,
        expectedSize: row.size_bytes,
        expectedSha256: row.sha256,
        maximumBytes: row.kind === "keyframe" ? 10 * 1024 * 1024 : 2 * 1024 * 1024,
      });
      results.push({ assetId: row.id, kind: row.kind, ...result });
      summary[result.status] = (summary[result.status] ?? 0) + 1;
    }

    const nextCursor = rows.results.at(-1)?.id ?? null;
    const done = rows.results.length < limit;
    const copied = summary.copied ?? 0;
    if (!dryRun && copied > 0) {
      const user = await ensureUser(identity);
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO audit_logs
          (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
        VALUES (?, ?, NULL, ?, 'media_storage.repaired', 'organization', ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        organizationId,
        user.id,
        organizationId,
        JSON.stringify({ copied, cursor: cursor || null, nextCursor, summary }),
        now,
      ).run();
    }

    return Response.json({
      version: "media-bucket-repair.v1",
      dryRun,
      legacyBindingAvailable: Boolean(legacy),
      processed: rows.results.length,
      nextCursor: done ? null : nextCursor,
      done,
      summary,
      results,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
