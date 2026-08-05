import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const timestamps = { createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() };

export const users = sqliteTable("users", {
  id: id(), authSubject: text("auth_subject").notNull(), email: text("email").notNull(), displayName: text("display_name"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"), ...timestamps,
}, (table) => [uniqueIndex("idx_users_auth_subject").on(table.authSubject), uniqueIndex("idx_users_email").on(table.email)]);

export const organizations = sqliteTable("organizations", {
  id: id(), name: text("name").notNull(), slug: text("slug").notNull(), status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_organizations_slug").on(table.slug)]);

export const organizationMembers = sqliteTable("organization_members", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["admin", "member", "readonly"] }).notNull(), status: text("status", { enum: ["active", "suspended", "removed"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_organization_members_org_user").on(table.organizationId, table.userId), index("idx_organization_members_org_status").on(table.organizationId, table.status)]);

export const projects = sqliteTable("projects", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), name: text("name").notNull(), clientName: text("client_name").notNull(),
  status: text("status", { enum: ["draft", "active", "paused", "archived"] }).notNull().default("draft"), serviceStartsAt: text("service_starts_at"), serviceEndsAt: text("service_ends_at"),
  contentTarget: integer("content_target").notNull().default(0), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_projects_org_status").on(table.organizationId, table.status)]);

export const projectMembers = sqliteTable("project_members", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  userId: text("user_id").notNull().references(() => users.id), role: text("role", { enum: ["owner", "planner", "creator", "reviewer", "client", "readonly"] }).notNull(),
  status: text("status", { enum: ["active", "removed"] }).notNull().default("active"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_project_members_project_user").on(table.projectId, table.userId), index("idx_project_members_org_project").on(table.organizationId, table.projectId)]);

export const invitations = sqliteTable("invitations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id), email: text("email").notNull(),
  organizationRole: text("organization_role", { enum: ["admin", "member", "readonly"] }).notNull(), projectRole: text("project_role", { enum: ["owner", "planner", "creator", "reviewer", "client", "readonly"] }),
  tokenHash: text("token_hash").notNull(), status: text("status", { enum: ["pending", "accepted", "declined", "revoked", "expired"] }).notNull().default("pending"), expiresAt: text("expires_at").notNull(),
  acceptedAt: text("accepted_at"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_invitations_token_hash").on(table.tokenHash), index("idx_invitations_org_status").on(table.organizationId, table.status)]);

export const analysisJobs = sqliteTable("analysis_jobs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  sourceType: text("source_type", { enum: ["url", "upload"] }).notNull(), sourceRef: text("source_ref").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "completed", "failed", "cancelled"] }).notNull().default("pending"),
  progress: integer("progress").notNull().default(0), currentStage: text("current_stage"), errorCode: text("error_code"), errorMessage: text("error_message"), retryCount: integer("retry_count").notNull().default(0),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), completedAt: text("completed_at"), ...timestamps,
}, (table) => [uniqueIndex("idx_analysis_jobs_org_idempotency").on(table.organizationId, table.idempotencyKey), index("idx_analysis_jobs_project_status_created").on(table.organizationId, table.projectId, table.status, table.createdAt)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id), action: text("action").notNull(), targetType: text("target_type").notNull(), targetId: text("target_id").notNull(),
  metadataJson: text("metadata_json"), ipHash: text("ip_hash"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_logs_org_project_created").on(table.organizationId, table.projectId, table.createdAt), index("idx_audit_logs_actor_created").on(table.actorUserId, table.createdAt)]);
