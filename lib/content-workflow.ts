import { z } from "zod";
import type { ProjectAccess } from "../db/runtime";

const identifier = z.string().trim().min(1).max(100);
const scope = { organizationId: identifier, projectId: identifier };

export const contentStatuses = ["draft", "internal_revision", "internal_review", "client_review", "shooting_ready", "shot", "editing", "publish_ready", "published", "reviewed", "archived"] as const;
export type ContentStatus = (typeof contentStatuses)[number];

export const contentStatusLabels: Record<ContentStatus, string> = {
  draft: "草稿",
  internal_revision: "内部修改",
  internal_review: "内部审核",
  client_review: "客户审核",
  shooting_ready: "待拍摄",
  shot: "已拍摄",
  editing: "剪辑中",
  publish_ready: "待发布",
  published: "已发布",
  reviewed: "已复盘",
  archived: "已归档",
};

export const workflowTransitionSchema = z.object({
  ...scope,
  toStatus: z.enum(contentStatuses),
  note: z.string().trim().max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.toStatus === "internal_revision" && !value.note) context.addIssue({ code: "custom", path: ["note"], message: "退回修改时必须填写原因" });
});

export const createContentCommentSchema = z.object({
  ...scope,
  visibility: z.enum(["internal", "client"]),
  body: z.string().trim().min(1).max(4_000),
  anchor: z.object({ field: z.enum(["fullScript", "shortScript", "storyboard", "productionPack"]), quote: z.string().trim().max(500).optional() }).strict().optional(),
}).strict();

export const resolveContentCommentSchema = z.object({ ...scope, resolved: z.boolean() }).strict();

export const scheduleContentSchema = z.object({
  ...scope,
  platform: z.enum(["douyin", "xiaohongshu", "wechat_channels", "bilibili", "other"]),
  scheduledAt: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(80).default("Asia/Shanghai"),
  status: z.enum(["planned", "ready", "cancelled"]).default("planned"),
  notes: z.string().trim().max(1_000).optional(),
}).strict();

export const publicationRecordSchema = z.object({
  ...scope,
  publicationId: identifier.optional(),
  platform: z.enum(["douyin", "xiaohongshu", "wechat_channels", "bilibili", "other"]),
  status: z.enum(["scheduled", "publishing", "published", "failed", "cancelled"]),
  externalId: z.string().trim().max(300).optional(),
  externalUrl: z.union([z.url().max(2_000), z.literal("")]).optional(),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  errorMessage: z.string().trim().max(1_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "published" && !value.externalUrl) context.addIssue({ code: "custom", path: ["externalUrl"], message: "标记已发布时必须填写作品链接" });
  if (value.status === "failed" && !value.errorMessage) context.addIssue({ code: "custom", path: ["errorMessage"], message: "发布失败时必须填写原因" });
});

function isAdmin(access: ProjectAccess) { return access.organizationRole === "admin"; }
function hasProjectRole(access: ProjectAccess, roles: readonly string[]) { return access.projectRole !== null && roles.includes(access.projectRole); }

export function canSubmitContent(access: ProjectAccess) {
  return isAdmin(access) || (access.organizationRole !== "readonly" && hasProjectRole(access, ["owner", "planner", "creator"]));
}

export function canInternalReview(access: ProjectAccess) {
  return isAdmin(access) || hasProjectRole(access, ["owner", "reviewer"]);
}

export function canClientReview(access: ProjectAccess) {
  return isAdmin(access) || hasProjectRole(access, ["owner", "client"]);
}

export function canCommentOnContent(access: ProjectAccess, visibility: "internal" | "client") {
  if (access.organizationRole === "readonly" || access.projectRole === "readonly") return false;
  if (hasProjectRole(access, ["client"])) return visibility === "client";
  return isAdmin(access) || access.projectRole !== null;
}

export function canManagePublishing(access: ProjectAccess) {
  return isAdmin(access) || (access.organizationRole !== "readonly" && hasProjectRole(access, ["owner", "planner", "creator"]));
}

export function allowedWorkflowTransition(access: ProjectAccess, from: ContentStatus, to: ContentStatus) {
  if (from === to || from === "archived" || from === "reviewed") return false;
  if (to === "archived") return isAdmin(access) || hasProjectRole(access, ["owner"]);
  if ((from === "draft" || from === "internal_revision") && to === "internal_review") return canSubmitContent(access);
  if (from === "internal_review" && (to === "client_review" || to === "internal_revision")) return canInternalReview(access);
  if (from === "client_review" && (to === "shooting_ready" || to === "internal_revision")) return canClientReview(access);
  if (from === "shooting_ready" && to === "shot") return canManagePublishing(access);
  if (from === "shot" && to === "editing") return canManagePublishing(access);
  if (from === "editing" && to === "publish_ready") return canManagePublishing(access);
  if (from === "publish_ready" && to === "published") return canManagePublishing(access);
  return false;
}

