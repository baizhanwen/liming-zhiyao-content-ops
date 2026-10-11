import type { ContentStatus } from "./content-workflow";
import { projectWriteAccessBindings, projectWriteAccessCondition } from "./project-write-access";

export type ContentVersionWrite = {
  contentId: string; organizationId: string; projectId: string;
  previousVersion: number; previousStatus: ContentStatus;
  versionId: string; userId: string; now: string;
};

// Insert the request's unique version first. A stale snapshot selects no rows;
// all other writes in the same D1 transaction depend on that exact new ID.
export const contentVersionSourceSql = `FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ? AND status = ? AND deleted_at IS NULL AND ${projectWriteAccessCondition}`;
export function contentVersionSourceBindings(input: ContentVersionWrite) {
  return [input.contentId, input.organizationId, input.projectId, input.previousVersion, input.previousStatus, ...projectWriteAccessBindings(input)] as const;
}
export const contentVersionWrittenSql = "EXISTS (SELECT 1 FROM content_versions WHERE id = ? AND content_item_id = ? AND organization_id = ? AND project_id = ?)";
export function contentVersionWrittenBindings(input: ContentVersionWrite) {
  return [input.versionId, input.contentId, input.organizationId, input.projectId] as const;
}
export function statusAfterContentRevision(status: ContentStatus): ContentStatus {
  return status === "draft" ? "draft" : "internal_revision";
}
export function contentVersionFollowupStatements(db: D1Database, input: ContentVersionWrite) {
  return [
    db.prepare(`UPDATE content_items SET current_version = ?, status = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ? AND status = ? AND deleted_at IS NULL AND ${projectWriteAccessCondition} AND ${contentVersionWrittenSql}`)
      .bind(input.previousVersion + 1, statusAfterContentRevision(input.previousStatus), input.userId, input.now, ...contentVersionSourceBindings(input), ...contentVersionWrittenBindings(input)),
    db.prepare(`UPDATE content_reviews SET decision = 'cancelled', note = COALESCE(note || char(10), '') || '稿件已更新，需要重新提交审核。', decided_by = ?, decided_at = ?
      WHERE content_item_id = ? AND organization_id = ? AND project_id = ? AND decision = 'pending' AND ${contentVersionWrittenSql}`)
      .bind(input.userId, input.now, input.contentId, input.organizationId, input.projectId, ...contentVersionWrittenBindings(input)),
  ];
}
