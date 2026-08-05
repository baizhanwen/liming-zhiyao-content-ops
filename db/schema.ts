import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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

export const socialAccounts = sqliteTable("social_accounts", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  platform: text("platform", { enum: ["douyin"] }).notNull().default("douyin"), accountType: text("account_type", { enum: ["owned", "benchmark"] }).notNull(),
  displayName: text("display_name").notNull(), handle: text("handle"), profileUrl: text("profile_url"), status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [index("idx_social_accounts_project_type").on(table.organizationId, table.projectId, table.accountType)]);

export const mediaAssets = sqliteTable("media_assets", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  videoId: text("video_id").references((): AnySQLiteColumn => videos.id),
  kind: text("kind", { enum: ["source_video", "source_audio", "keyframe", "subtitle", "report"] }).notNull(), r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(), contentType: text("content_type").notNull(), sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(),
  status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("idx_media_assets_r2_key").on(table.r2Key),
  index("idx_media_assets_project_kind").on(table.organizationId, table.projectId, table.kind),
  index("idx_media_assets_video_kind").on(table.organizationId, table.projectId, table.videoId, table.kind),
]);

export const videos = sqliteTable("videos", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  socialAccountId: text("social_account_id").references(() => socialAccounts.id), mediaAssetId: text("media_asset_id").references(() => mediaAssets.id),
  platform: text("platform", { enum: ["douyin", "upload"] }).notNull(), sourceType: text("source_type", { enum: ["url", "upload"] }).notNull(), sourceUrl: text("source_url"), sourceHash: text("source_hash"),
  platformWorkId: text("platform_work_id"), title: text("title"), authorName: text("author_name"), publishedAt: text("published_at"), durationSec: integer("duration_sec"),
  status: text("status", { enum: ["pending", "processing", "ready", "failed", "archived"] }).notNull().default("pending"), errorMessage: text("error_message"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [uniqueIndex("idx_videos_project_source_hash").on(table.organizationId, table.projectId, table.sourceHash), index("idx_videos_project_status_created").on(table.organizationId, table.projectId, table.status, table.createdAt)]);

export const videoMetricSnapshots = sqliteTable("video_metric_snapshots", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), videoId: text("video_id").notNull().references(() => videos.id),
  source: text("source", { enum: ["public", "client_backend", "manual"] }).notNull(), plays: integer("plays"), likes: integer("likes"), comments: integer("comments"), favorites: integer("favorites"), shares: integer("shares"), followersGained: integer("followers_gained"),
  collectedAt: text("collected_at").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_video_metrics_video_collected").on(table.organizationId, table.projectId, table.videoId, table.collectedAt)]);

export const videoTranscripts = sqliteTable("video_transcripts", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), videoId: text("video_id").notNull().references(() => videos.id),
  version: integer("version").notNull().default(1), language: text("language").notNull().default("zh-CN"), source: text("source", { enum: ["asr", "manual"] }).notNull(), fullText: text("full_text").notNull(), segmentsJson: text("segments_json").notNull(), confidence: integer("confidence"),
  createdBy: text("created_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_video_transcripts_video_version").on(table.videoId, table.version), index("idx_video_transcripts_project_video").on(table.organizationId, table.projectId, table.videoId)]);

export const videoAnalyses = sqliteTable("video_analyses", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), videoId: text("video_id").notNull().references(() => videos.id),
  schemaVersion: text("schema_version").notNull(), reportJson: text("report_json").notNull(), confidence: integer("confidence"), modelProvider: text("model_provider"), modelName: text("model_name"), promptVersion: text("prompt_version"),
  createdBy: text("created_by").notNull(), ...timestamps,
}, (table) => [index("idx_video_analyses_video_created").on(table.organizationId, table.projectId, table.videoId, table.createdAt)]);

export const analysisJobs = sqliteTable("analysis_jobs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  videoId: text("video_id").references(() => videos.id),
  sourceType: text("source_type", { enum: ["url", "upload"] }).notNull(), sourceRef: text("source_ref").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "completed", "failed", "cancelled"] }).notNull().default("pending"),
  progress: integer("progress").notNull().default(0), currentStage: text("current_stage"), errorCode: text("error_code"), errorMessage: text("error_message"), retryCount: integer("retry_count").notNull().default(0),
  leaseOwner: text("lease_owner"), leaseExpiresAt: text("lease_expires_at"), lastHeartbeatAt: text("last_heartbeat_at"), attemptCount: integer("attempt_count").notNull().default(0), version: integer("version").notNull().default(0), resultKey: text("result_key"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), completedAt: text("completed_at"), ...timestamps,
}, (table) => [
  uniqueIndex("idx_analysis_jobs_org_idempotency").on(table.organizationId, table.idempotencyKey),
  index("idx_analysis_jobs_project_status_created").on(table.organizationId, table.projectId, table.status, table.createdAt),
  index("idx_analysis_jobs_claimable").on(table.status, table.leaseExpiresAt, table.createdAt),
]);

export const analysisJobEvents = sqliteTable("analysis_job_events", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  jobId: text("job_id").notNull().references(() => analysisJobs.id), videoId: text("video_id").references(() => videos.id),
  eventType: text("event_type", { enum: ["claimed", "heartbeat", "stage_changed", "completed", "failed", "lease_expired"] }).notNull(),
  fromStatus: text("from_status"), toStatus: text("to_status"), progress: integer("progress"), workerId: text("worker_id"), detailsJson: text("details_json"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_analysis_job_events_job_created").on(table.jobId, table.createdAt), index("idx_analysis_job_events_tenant_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const knowledgeItems = sqliteTable("knowledge_items", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  category: text("category", { enum: ["brand_story", "founder", "case_study", "customer_question", "sales_script", "high_performing_copy", "industry_term", "compliance", "brand_voice", "client_preference", "other"] }).notNull(),
  title: text("title").notNull(), status: text("status", { enum: ["draft", "confirmed", "archived"] }).notNull().default("draft"), currentVersion: integer("current_version").notNull().default(1),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), confirmedBy: text("confirmed_by"), confirmedAt: text("confirmed_at"), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_knowledge_items_project_status_category").on(table.organizationId, table.projectId, table.status, table.category), index("idx_knowledge_items_project_updated").on(table.organizationId, table.projectId, table.updatedAt)]);

export const knowledgeItemVersions = sqliteTable("knowledge_item_versions", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), itemId: text("item_id").notNull().references(() => knowledgeItems.id),
  version: integer("version").notNull(), body: text("body").notNull(), sourceType: text("source_type", { enum: ["manual", "document", "url", "client_feedback", "analysis"] }).notNull(), sourceRef: text("source_ref"), changeSummary: text("change_summary"),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_knowledge_versions_item_version").on(table.itemId, table.version), index("idx_knowledge_versions_tenant_item").on(table.organizationId, table.projectId, table.itemId)]);

export const contentStrategies = sqliteTable("content_strategies", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  version: integer("version").notNull(), name: text("name").notNull(), status: text("status", { enum: ["draft", "active", "retired"] }).notNull().default("draft"),
  positioning: text("positioning").notNull(), persona: text("persona"), targetAudience: text("target_audience").notNull(), painPointsJson: text("pain_points_json").notNull(), pillarsJson: text("pillars_json").notNull(), topicMixJson: text("topic_mix_json").notNull(),
  styleNotes: text("style_notes"), cadence: text("cadence"), conversionPath: text("conversion_path"), objectivesJson: text("objectives_json").notNull(), effectiveFrom: text("effective_from"), effectiveTo: text("effective_to"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("idx_content_strategies_project_version").on(table.projectId, table.version),
  uniqueIndex("idx_content_strategies_one_active").on(table.organizationId, table.projectId).where(sql`${table.status} = 'active'`),
  index("idx_content_strategies_project_status").on(table.organizationId, table.projectId, table.status),
]);

export const topicIdeas = sqliteTable("topic_ideas", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(), angle: text("angle"), sourceType: text("source_type", { enum: ["knowledge", "video_analysis", "performance", "trend", "comment", "manual"] }).notNull(), sourceRef: text("source_ref"),
  pillar: text("pillar"), audience: text("audience"), objective: text("objective"), hook: text("hook"), rationale: text("rationale"), priority: integer("priority").notNull().default(50),
  status: text("status", { enum: ["idea", "selected", "drafting", "archived"] }).notNull().default("idea"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_topic_ideas_project_status_priority").on(table.organizationId, table.projectId, table.status, table.priority), index("idx_topic_ideas_project_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const topicCitations = sqliteTable("topic_citations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), topicId: text("topic_id").notNull().references(() => topicIdeas.id),
  citationType: text("citation_type", { enum: ["knowledge", "video_analysis", "metric", "external"] }).notNull(), citationId: text("citation_id").notNull(), quote: text("quote"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_topic_citations_topic_source").on(table.topicId, table.citationType, table.citationId), index("idx_topic_citations_tenant_topic").on(table.organizationId, table.projectId, table.topicId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id), action: text("action").notNull(), targetType: text("target_type").notNull(), targetId: text("target_id").notNull(),
  metadataJson: text("metadata_json"), ipHash: text("ip_hash"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_logs_org_project_created").on(table.organizationId, table.projectId, table.createdAt), index("idx_audit_logs_actor_created").on(table.actorUserId, table.createdAt)]);
