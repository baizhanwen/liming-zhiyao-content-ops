import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
export * from "./ecommerce-schema";

const id = () => text("id").primaryKey();
const timestamps = { createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() };

export const users = sqliteTable("users", {
  id: id(), authSubject: text("auth_subject").notNull(), email: text("email").notNull(), displayName: text("display_name"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"), ...timestamps,
}, (table) => [uniqueIndex("idx_users_auth_subject").on(table.authSubject), uniqueIndex("idx_users_email").on(table.email)]);

export const localCredentials = sqliteTable("local_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id),
  passwordSalt: text("password_salt").notNull(), passwordHash: text("password_hash").notNull(), iterations: integer("iterations").notNull().default(210000),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const localSessions = sqliteTable("local_sessions", {
  id: id(), userId: text("user_id").notNull().references(() => users.id), tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_local_sessions_token_hash").on(table.tokenHash), index("idx_local_sessions_user_expiry").on(table.userId, table.expiresAt)]);

export const localLoginAttempts = sqliteTable("local_login_attempts", {
  email: text("email").primaryKey(), failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: text("locked_until"), updatedAt: text("updated_at").notNull(),
  }, (table) => [index("idx_local_login_attempts_lock").on(table.lockedUntil)]);

export const installationSettings = sqliteTable("installation_settings", {
  key: text("key").primaryKey(), value: text("value").notNull(), updatedAt: text("updated_at").notNull(),
});

export const organizations = sqliteTable("organizations", {
  id: id(), name: text("name").notNull(), slug: text("slug").notNull(), status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_organizations_slug").on(table.slug)]);

export const organizationModelSettings = sqliteTable("organization_model_settings", {
  organizationId: text("organization_id").primaryKey().references(() => organizations.id),
  version: integer("version").notNull().default(1), settingsJson: text("settings_json").notNull(),
  updatedBy: text("updated_by").notNull().references(() => users.id), updatedAt: text("updated_at").notNull(),
});

export const organizationSettings = sqliteTable("organization_settings", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  planCode: text("plan_code", { enum: ["starter", "team", "scale"] }).notNull().default("team"),
  projectQuota: integer("project_quota").notNull().default(20), memberQuota: integer("member_quota").notNull().default(50),
  monthlyAnalysisQuota: integer("monthly_analysis_quota").notNull().default(500), monthlyModelCallQuota: integer("monthly_model_call_quota").notNull().default(2000),
  storageQuotaBytes: integer("storage_quota_bytes").notNull().default(21474836480), retentionDays: integer("retention_days").notNull().default(365),
  failedJobAlertThreshold: integer("failed_job_alert_threshold").notNull().default(3), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_organization_settings_org").on(table.organizationId)]);

export const organizationMembers = sqliteTable("organization_members", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["admin", "member"] }).notNull(), status: text("status", { enum: ["active", "suspended", "removed"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_organization_members_org_user").on(table.organizationId, table.userId), index("idx_organization_members_org_status").on(table.organizationId, table.status)]);

export const projects = sqliteTable("projects", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), name: text("name").notNull(), clientName: text("client_name").notNull(),
  status: text("status", { enum: ["draft", "active", "paused", "archived"] }).notNull().default("draft"), serviceStartsAt: text("service_starts_at"), serviceEndsAt: text("service_ends_at"),
  contentTarget: integer("content_target").notNull().default(0), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_projects_org_status").on(table.organizationId, table.status)]);

export const projectMembers = sqliteTable("project_members", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  userId: text("user_id").notNull().references(() => users.id), role: text("role", { enum: ["member"] }).notNull(),
  status: text("status", { enum: ["active", "removed"] }).notNull().default("active"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_project_members_project_user").on(table.projectId, table.userId), index("idx_project_members_org_project").on(table.organizationId, table.projectId)]);

export const invitations = sqliteTable("invitations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id), email: text("email").notNull(),
  organizationRole: text("organization_role", { enum: ["admin", "member"] }).notNull(), projectRole: text("project_role", { enum: ["member"] }),
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
  analysisJobId: text("analysis_job_id"),
  kind: text("kind", { enum: ["source_video", "source_audio", "keyframe", "subtitle", "report"] }).notNull(), r2Key: text("r2_key").notNull(), isCover: integer("is_cover").notNull().default(0), qualityScore: integer("quality_score"),
  filename: text("filename").notNull(), contentType: text("content_type").notNull(), sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(),
  status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("idx_media_assets_r2_key").on(table.r2Key),
  index("idx_media_assets_project_kind").on(table.organizationId, table.projectId, table.kind),
  index("media_assets_org_status_size_idx").on(table.organizationId, table.status, table.sizeBytes),
  index("idx_media_assets_video_kind").on(table.organizationId, table.projectId, table.videoId, table.kind),
  index("idx_media_assets_analysis_job_kind").on(table.analysisJobId, table.kind, table.status),
]);

export const videos = sqliteTable("videos", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  socialAccountId: text("social_account_id").references(() => socialAccounts.id), mediaAssetId: text("media_asset_id").references(() => mediaAssets.id),
  platform: text("platform", { enum: ["douyin", "upload"] }).notNull(), sourceType: text("source_type", { enum: ["url", "upload"] }).notNull(), sourceUrl: text("source_url"), sourceHash: text("source_hash"),
  platformWorkId: text("platform_work_id"), title: text("title"), authorName: text("author_name"), publishedAt: text("published_at"), durationSec: integer("duration_sec"),
  status: text("status", { enum: ["pending", "processing", "ready", "failed", "archived"] }).notNull().default("pending"), errorMessage: text("error_message"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [uniqueIndex("idx_videos_project_source_hash").on(table.organizationId, table.projectId, table.sourceHash), index("idx_videos_project_status_created").on(table.organizationId, table.projectId, table.status, table.createdAt)]);

export const videoLibraryEntries = sqliteTable("video_library_entries", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), sourceVideoId: text("source_video_id").notNull().references(() => videos.id),
  category: text("category", { enum: ["published", "benchmark", "industry", "case", "trend", "creative", "other"] }).notNull().default("other"),
  tagsJson: text("tags_json").notNull().default("[]"), notes: text("notes"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("idx_video_library_org_source").on(table.organizationId, table.sourceVideoId),
  index("idx_video_library_org_category_updated").on(table.organizationId, table.category, table.updatedAt),
]);

export const projectVideoReferences = sqliteTable("project_video_references", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  libraryEntryId: text("library_entry_id").notNull().references(() => videoLibraryEntries.id), purpose: text("purpose", { enum: ["analysis", "benchmark"] }).notNull().default("benchmark"),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
  revokedBy: text("revoked_by").references(() => users.id), revokedAt: text("revoked_at"), revokeReason: text("revoke_reason"),
}, (table) => [
  uniqueIndex("idx_project_video_refs_unique").on(table.projectId, table.libraryEntryId, table.purpose),
  index("idx_project_video_refs_project_purpose_status_created").on(table.organizationId, table.projectId, table.purpose, table.status, table.createdAt),
  index("idx_project_video_refs_library").on(table.organizationId, table.libraryEntryId),
]);

export const videoKnowledgeAtoms = sqliteTable("video_knowledge_atoms", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), libraryEntryId: text("library_entry_id").notNull().references(() => videoLibraryEntries.id), analysisId: text("analysis_id").notNull().references(() => videoAnalyses.id),
  atomKey: text("atom_key").notNull(), atomType: text("atom_type").notNull(), title: text("title").notNull(), content: text("content").notNull(), structuredJson: text("structured_json").notNull().default("{}"), sourceLocatorJson: text("source_locator_json").notNull().default("{}"), confidence: integer("confidence"), reportHash: text("report_hash").notNull(), extractorVersion: text("extractor_version").notNull(), status: text("status", { enum: ["active", "superseded", "unsupported"] }).notNull().default("active"), supersededBy: text("superseded_by"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_video_atoms_analysis_key").on(table.analysisId, table.atomKey), index("idx_video_atoms_org_library_status").on(table.organizationId, table.libraryEntryId, table.status), index("idx_video_atoms_org_type").on(table.organizationId, table.atomType)]);

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
  analysisJobId: text("analysis_job_id"),
  schemaVersion: text("schema_version").notNull(), reportJson: text("report_json").notNull(), confidence: integer("confidence"), modelProvider: text("model_provider"), modelName: text("model_name"), promptVersion: text("prompt_version"),
  createdBy: text("created_by").notNull(), ...timestamps,
}, (table) => [index("idx_video_analyses_video_created").on(table.organizationId, table.projectId, table.videoId, table.createdAt), index("idx_video_analyses_analysis_job").on(table.analysisJobId)]);

export const analysisJobs = sqliteTable("analysis_jobs", {
  queueUserId: text("queue_user_id").references(() => users.id), enqueuedAt: text("enqueued_at"), recoveryAttemptCount: integer("recovery_attempt_count").notNull().default(0),
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  videoId: text("video_id").references(() => videos.id),
  inputTranscriptId: text("input_transcript_id").references(() => videoTranscripts.id),
  sourceType: text("source_type", { enum: ["url", "upload"] }).notNull(), sourceRef: text("source_ref").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "completed", "partial", "failed", "cancelled"] }).notNull().default("pending"),
  analysisProfile: text("analysis_profile", { enum: ["max", "economy", "standard", "deep"] }).notNull().default("standard"),
  progress: integer("progress").notNull().default(0), currentStage: text("current_stage"), errorCode: text("error_code"), errorMessage: text("error_message"), retryCount: integer("retry_count").notNull().default(0),
  leaseOwner: text("lease_owner"), leaseExpiresAt: text("lease_expires_at"), lastHeartbeatAt: text("last_heartbeat_at"), attemptCount: integer("attempt_count").notNull().default(0), version: integer("version").notNull().default(0), resultKey: text("result_key"),
  startedAt: text("started_at"), stageStartedAt: text("stage_started_at"), lastProgressAt: text("last_progress_at"), progressJson: text("progress_json"),
  checkpointStage: text("checkpoint_stage"), checkpointJson: text("checkpoint_json"), checkpointUpdatedAt: text("checkpoint_updated_at"), resumeCount: integer("resume_count").notNull().default(0),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), completedAt: text("completed_at"), ...timestamps,
}, (table) => [
  uniqueIndex("idx_analysis_jobs_org_idempotency").on(table.organizationId, table.idempotencyKey),
  index("idx_analysis_jobs_project_status_created").on(table.organizationId, table.projectId, table.status, table.createdAt),
  index("analysis_jobs_org_created_idx").on(table.organizationId, table.createdAt),
  index("idx_analysis_jobs_claimable").on(table.status, table.leaseExpiresAt, table.createdAt),
]);

export const analyzerWorkers = sqliteTable("analyzer_workers", {
  workerId: text("worker_id").primaryKey(), status: text("status", { enum: ["online", "stopped", "error"] }).notNull().default("online"),
  startedAt: text("started_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), lastError: text("last_error"),
  browserAuthStatus: text("browser_auth_status", { enum: ["unknown", "logged_in", "not_logged_in", "unavailable", "disabled"] }).notNull().default("unknown"),
  browserAuthBrowser: text("browser_auth_browser"), browserAuthCheckedAt: text("browser_auth_checked_at"), browserAuthMessage: text("browser_auth_message"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_analyzer_workers_last_seen").on(table.lastSeenAt)]);

export const analysisModelCalls = sqliteTable("analysis_model_calls", {
  id: id(), jobId: text("job_id").notNull().references(() => analysisJobs.id), attempt: integer("attempt").notNull(),
  task: text("task").notNull(), status: text("status", { enum: ["started", "completed", "failed"] }).notNull(), outputBudget: integer("output_budget").notNull(),
  inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"), totalTokens: integer("total_tokens"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("analysis_model_calls_job_idx").on(table.jobId, table.createdAt)]);

export const analysisJobEvents = sqliteTable("analysis_job_events", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  jobId: text("job_id").notNull().references(() => analysisJobs.id), videoId: text("video_id").references(() => videos.id),
  eventType: text("event_type", { enum: ["claimed", "heartbeat", "stage_changed", "completed", "partial", "failed", "lease_expired"] }).notNull(),
  fromStatus: text("from_status"), toStatus: text("to_status"), progress: integer("progress"), workerId: text("worker_id"), detailsJson: text("details_json"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_analysis_job_events_job_created").on(table.jobId, table.createdAt), index("idx_analysis_job_events_tenant_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const knowledgeItems = sqliteTable("knowledge_items", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  category: text("category", { enum: ["brand_story", "founder", "case_study", "customer_question", "sales_script", "high_performing_copy", "industry_term", "compliance", "brand_voice", "client_preference", "other"] }).notNull(),
  title: text("title").notNull(), status: text("status", { enum: ["draft", "confirmed", "archived"] }).notNull().default("draft"), currentVersion: integer("current_version").notNull().default(1),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), confirmedBy: text("confirmed_by"), confirmedAt: text("confirmed_at"), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_knowledge_items_project_status_category").on(table.organizationId, table.projectId, table.status, table.category), index("idx_knowledge_items_project_updated").on(table.organizationId, table.projectId, table.updatedAt)]);

export const projectMemoryItems = sqliteTable("project_memory_items", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), canonicalKey: text("canonical_key").notNull(), category: text("category").notNull().default("memory"), kind: text("kind").notNull().default("soft"), status: text("status", { enum: ["candidate", "confirmed", "rejected", "superseded", "expired"] }).notNull().default("candidate"), title: text("title").notNull(), content: text("content").notNull(), valueJson: text("value_json").notNull().default("{}"), sourceType: text("source_type").notNull(), sourceId: text("source_id"), revision: integer("revision").notNull().default(1), contentHash: text("content_hash").notNull(), createdBy: text("created_by").notNull().references(() => users.id), confirmedBy: text("confirmed_by").references(() => users.id), confirmedAt: text("confirmed_at"), rejectedBy: text("rejected_by").references(() => users.id), rejectedAt: text("rejected_at"), supersededBy: text("superseded_by"), expiresAt: text("expires_at"), ...timestamps,
}, (table) => [uniqueIndex("idx_project_memory_canonical_revision").on(table.organizationId, table.projectId, table.canonicalKey, table.revision), index("idx_project_memory_scope_status_kind").on(table.organizationId, table.projectId, table.status, table.kind), index("idx_project_memory_scope_status_category").on(table.organizationId, table.projectId, table.status, table.category), index("idx_project_memory_scope_key").on(table.organizationId, table.projectId, table.canonicalKey)]);

export const projectMemoryEvidence = sqliteTable("project_memory_evidence", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), memoryItemId: text("memory_item_id").notNull().references(() => projectMemoryItems.id), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), quote: text("quote"), relevance: integer("relevance"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_memory_evidence_item").on(table.memoryItemId), index("idx_memory_evidence_scope").on(table.organizationId, table.projectId, table.createdAt)]);

export const projectMemorySnapshots = sqliteTable("project_memory_snapshots", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), purpose: text("purpose").notNull(), query: text("query"), snapshotHash: text("snapshot_hash").notNull(), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_memory_snapshots_scope_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const projectInspirationCards = sqliteTable("project_inspiration_cards", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), canonicalKey: text("canonical_key").notNull(), version: integer("version").notNull().default(1), status: text("status").notNull().default("candidate"), title: text("title").notNull(), coreInsight: text("core_insight").notNull(), applicableScenariosJson: text("applicable_scenarios_json").notNull().default("[]"), excludedScenariosJson: text("excluded_scenarios_json").notNull().default("[]"), evidenceJson: text("evidence_json").notNull().default("[]"), sourceType: text("source_type").notNull(), sourceId: text("source_id"), tagsJson: text("tags_json").notNull().default("[]"), confidence: integer("confidence"), contentHash: text("content_hash").notNull(), createdBy: text("created_by").notNull().references(() => users.id), confirmedBy: text("confirmed_by").references(() => users.id), confirmedAt: text("confirmed_at"), rejectedBy: text("rejected_by").references(() => users.id), rejectedAt: text("rejected_at"), supersededBy: text("superseded_by"), expiresAt: text("expires_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_inspiration_cards_scope_key_version").on(table.organizationId, table.projectId, table.canonicalKey, table.version), index("idx_inspiration_cards_scope_status_updated").on(table.organizationId, table.projectId, table.status, table.updatedAt), index("idx_inspiration_cards_source").on(table.organizationId, table.sourceType, table.sourceId)]);

export const projectMemoryEvents = sqliteTable("project_memory_events", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  eventType: text("event_type").notNull(), sourceType: text("source_type").notNull(), sourceId: text("source_id"), dedupeKey: text("dedupe_key").notNull(), payloadJson: text("payload_json").notNull().default("{}"), payloadHash: text("payload_hash").notNull(),
  status: text("status", { enum: ["pending", "processing", "completed", "blocked", "failed"] }).notNull().default("pending"), operationSummaryJson: text("operation_summary_json").notNull().default("[]"), attemptCount: integer("attempt_count").notNull().default(0),
  errorCode: text("error_code"), errorMessage: text("error_message"), modelProvider: text("model_provider"), modelName: text("model_name"), promptVersion: text("prompt_version"), createdBy: text("created_by").notNull().references(() => users.id), processedAt: text("processed_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_project_memory_events_dedupe").on(table.organizationId, table.projectId, table.dedupeKey), index("idx_project_memory_events_scope_status").on(table.organizationId, table.projectId, table.status, table.createdAt)]);

export const projectAssistantConversations = sqliteTable("project_assistant_conversations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), title: text("title").notNull(), status: text("status", { enum: ["active", "archived"] }).notNull().default("active"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_project_assistant_conversations_scope_updated").on(table.organizationId, table.projectId, table.status, table.updatedAt)]);

export const projectAssistantMessages = sqliteTable("project_assistant_messages", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), conversationId: text("conversation_id").notNull().references(() => projectAssistantConversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(), status: text("status", { enum: ["completed", "failed"] }).notNull().default("completed"), content: text("content").notNull(), suggestionsJson: text("suggestions_json").notNull().default("[]"), citationsJson: text("citations_json").notNull().default("[]"), memoryOperationsJson: text("memory_operations_json").notNull().default("[]"),
  modelProvider: text("model_provider"), modelName: text("model_name"), promptVersion: text("prompt_version"), errorCode: text("error_code"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_project_assistant_messages_conversation_created").on(table.conversationId, table.createdAt), index("idx_project_assistant_messages_scope_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const projectInspirationCardSources = sqliteTable("project_inspiration_card_sources", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), cardId: text("card_id").notNull().references(() => projectInspirationCards.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").references(() => projectAssistantConversations.id), messageId: text("message_id").references(() => projectAssistantMessages.id), memoryItemId: text("memory_item_id").references(() => projectMemoryItems.id), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_inspiration_card_sources_unique").on(table.cardId, table.messageId, table.memoryItemId), index("idx_inspiration_card_sources_scope").on(table.organizationId, table.projectId, table.cardId)]);
export const projectMemorySnapshotItems = sqliteTable("project_memory_snapshot_items", {
  id: id(), snapshotId: text("snapshot_id").notNull().references(() => projectMemorySnapshots.id, { onDelete: "cascade" }), memoryItemId: text("memory_item_id").notNull().references(() => projectMemoryItems.id), revision: integer("revision").notNull(), rank: integer("rank").notNull(), contentHash: text("content_hash").notNull(),
}, (table) => [uniqueIndex("idx_memory_snapshot_items_unique").on(table.snapshotId, table.memoryItemId), index("idx_memory_snapshot_items_item").on(table.memoryItemId)]);

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
  title: text("title").notNull(), angle: text("angle"), sourceType: text("source_type", { enum: ["knowledge", "video_analysis", "performance", "trend", "comment", "manual", "project_assistant"] }).notNull(), sourceRef: text("source_ref"),
  pillar: text("pillar"), audience: text("audience"), objective: text("objective"), hook: text("hook"), rationale: text("rationale"), priority: integer("priority").notNull().default(50),
  selectedKnowledgeIdsJson: text("selected_knowledge_ids_json").notNull().default("[]"),
  sourceManifestJson: text("source_manifest_json").notNull().default("[]"), missingContextJson: text("missing_context_json").notNull().default("[]"), riskNotesJson: text("risk_notes_json").notNull().default("[]"), contextSnapshotId: text("context_snapshot_id"),
  status: text("status", { enum: ["idea", "selected", "drafting", "archived"] }).notNull().default("idea"), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [index("idx_topic_ideas_project_status_priority").on(table.organizationId, table.projectId, table.status, table.priority), index("idx_topic_ideas_project_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const topicCitations = sqliteTable("topic_citations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), topicId: text("topic_id").notNull().references(() => topicIdeas.id),
  citationType: text("citation_type", { enum: ["knowledge", "video_analysis", "memory", "video_atom", "inspiration", "strategy", "method_knowledge", "metric", "external", "benchmark"] }).notNull(), citationId: text("citation_id").notNull(), quote: text("quote"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_topic_citations_topic_source").on(table.topicId, table.citationType, table.citationId), index("idx_topic_citations_tenant_topic").on(table.organizationId, table.projectId, table.topicId)]);

export const promptTemplates = sqliteTable("prompt_templates", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  taskType: text("task_type", { enum: ["content_draft"] }).notNull(), version: text("version").notNull(), name: text("name").notNull(), status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
  systemPrompt: text("system_prompt").notNull(), outputSchemaJson: text("output_schema_json").notNull(), createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("idx_prompt_templates_project_task_version").on(table.projectId, table.taskType, table.version),
  uniqueIndex("idx_prompt_templates_one_active").on(table.organizationId, table.projectId, table.taskType).where(sql`${table.status} = 'active'`),
]);

export const modelCalls = sqliteTable("model_calls", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), topicId: text("topic_id").references(() => topicIdeas.id),
  promptTemplateId: text("prompt_template_id").references(() => promptTemplates.id), taskType: text("task_type").notNull(), provider: text("provider").notNull(), modelName: text("model_name").notNull(), modelProfile: text("model_profile").notNull(), promptVersion: text("prompt_version").notNull(),
  status: text("status", { enum: ["started", "completed", "failed"] }).notNull(), inputHash: text("input_hash").notNull(), inputJson: text("input_json").notNull(), outputJson: text("output_json"), latencyMs: integer("latency_ms"), errorCode: text("error_code"), errorMessage: text("error_message"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
}, (table) => [index("idx_model_calls_project_created").on(table.organizationId, table.projectId, table.createdAt), index("idx_model_calls_topic_created").on(table.topicId, table.createdAt)]);

export const scriptRewriteWorkspaces = sqliteTable("script_rewrite_workspaces", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(), sourceType: text("source_type", { enum: ["pasted", "video"] }).notNull(), sourceVideoId: text("source_video_id").references(() => videos.id),
  sourceTranscriptId: text("source_transcript_id").references(() => videoTranscripts.id), sourceTranscriptVersion: integer("source_transcript_version"), sourceAnalysisId: text("source_analysis_id").references(() => videoAnalyses.id),
  sourceLabel: text("source_label").notNull(), sourceText: text("source_text").notNull(), sourceHash: text("source_hash").notNull(), sourceCharacterCount: integer("source_character_count").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"), createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), ...timestamps,
}, (table) => [index("idx_script_rewrites_scope_updated").on(table.organizationId, table.projectId, table.status, table.updatedAt), index("idx_script_rewrites_video").on(table.organizationId, table.projectId, table.sourceVideoId)]);

export const scriptRewriteRuns = sqliteTable("script_rewrite_runs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), workspaceId: text("workspace_id").notNull().references(() => scriptRewriteWorkspaces.id, { onDelete: "cascade" }),
  variant: text("variant", { enum: ["light_rewrite", "restructured"] }).notNull(), status: text("status", { enum: ["started", "completed", "failed"] }).notNull().default("started"), sourceVersionId: text("source_version_id").notNull(), resultVersionId: text("result_version_id"), retryOfRunId: text("retry_of_run_id"),
  estimatedCallCount: integer("estimated_call_count").notNull(), estimatedInputTokens: integer("estimated_input_tokens").notNull(), maximumOutputTokens: integer("maximum_output_tokens").notNull(), actualInputTokens: integer("actual_input_tokens").notNull().default(0), actualOutputTokens: integer("actual_output_tokens").notNull().default(0), actualTotalTokens: integer("actual_total_tokens").notNull().default(0),
  modelCallId: text("model_call_id").references(() => modelCalls.id), promptVersion: text("prompt_version").notNull(), validationJson: text("validation_json").notNull().default("{}"), errorCode: text("error_code"), errorMessage: text("error_message"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
}, (table) => [index("idx_script_rewrite_runs_workspace_created").on(table.organizationId, table.projectId, table.workspaceId, table.createdAt), index("idx_script_rewrite_runs_status_created").on(table.status, table.createdAt)]);

export const scriptRewriteVersions = sqliteTable("script_rewrite_versions", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), workspaceId: text("workspace_id").notNull().references(() => scriptRewriteWorkspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull(), variant: text("variant", { enum: ["source", "light_rewrite", "restructured", "manual"] }).notNull(), parentVersionId: text("parent_version_id"), runId: text("run_id").references(() => scriptRewriteRuns.id), text: text("text").notNull(), paragraphsJson: text("paragraphs_json").notNull().default("[]"), sourceMappingJson: text("source_mapping_json").notNull().default("[]"), outlineJson: text("outline_json").notNull().default("[]"), validationJson: text("validation_json").notNull().default("{}"),
  modelProvider: text("model_provider"), modelName: text("model_name"), promptVersion: text("prompt_version"), modelCallId: text("model_call_id").references(() => modelCalls.id), changeSummary: text("change_summary"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_script_rewrite_versions_workspace_version").on(table.workspaceId, table.version), index("idx_script_rewrite_versions_scope_workspace").on(table.organizationId, table.projectId, table.workspaceId, table.createdAt)]);

export const generationSourceManifests = sqliteTable("generation_source_manifests", {
  id: id(), traceId: text("trace_id").notNull(), userId: text("user_id").notNull().references(() => users.id), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  capability: text("capability").notNull(), modelProvider: text("model_provider"), modelName: text("model_name"), sourceManifestJson: text("source_manifest_json").notNull(), promptHash: text("prompt_hash"),
  status: text("status", { enum: ["started", "completed", "failed", "blocked"] }).notNull().default("started"), errorCode: text("error_code"), createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
}, (table) => [uniqueIndex("idx_generation_source_manifests_trace").on(table.traceId), index("idx_generation_source_manifests_project_created").on(table.organizationId, table.projectId, table.createdAt), index("idx_generation_source_manifests_status_created").on(table.status, table.createdAt)]);

export const capabilityPolicies = sqliteTable("capability_policies", {
  id: text("id").primaryKey(), analysisProfile: text("analysis_profile").notNull(), contentModelProfile: text("content_model_profile").notNull(), keyframePolicy: text("keyframe_policy").notNull(), contractVersion: text("contract_version").notNull(), updatedAt: text("updated_at").notNull(),
});

export const contentItems = sqliteTable("content_items", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), topicId: text("topic_id").notNull().references(() => topicIdeas.id),
  title: text("title").notNull(), status: text("status", { enum: ["draft", "internal_revision", "internal_review", "client_review", "publish_ready", "published", "reviewed", "archived"] }).notNull().default("draft"), currentVersion: integer("current_version").notNull().default(1), assigneeUserId: text("assignee_user_id").references(() => users.id), dueAt: text("due_at"),
  createdBy: text("created_by").notNull(), updatedBy: text("updated_by").notNull(), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [uniqueIndex("idx_content_items_topic").on(table.topicId), index("idx_content_items_project_status_updated").on(table.organizationId, table.projectId, table.status, table.updatedAt)]);

export const contentVersions = sqliteTable("content_versions", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id),
  version: integer("version").notNull(), generationMode: text("generation_mode", { enum: ["scaffold", "ai", "manual"] }).notNull(), packJson: text("pack_json").notNull(), fullScript: text("full_script").notNull(), shortScript: text("short_script").notNull(), changeSummary: text("change_summary"), promptVersion: text("prompt_version"), modelCallId: text("model_call_id").references(() => modelCalls.id), inputSnapshotJson: text("input_snapshot_json"), inputSnapshotHash: text("input_snapshot_hash"), sourceManifestJson: text("source_manifest_json").notNull().default("[]"), contextSnapshotId: text("context_snapshot_id"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_content_versions_item_version").on(table.contentItemId, table.version), index("idx_content_versions_tenant_item").on(table.organizationId, table.projectId, table.contentItemId)]);

export const contentCitations = sqliteTable("content_citations", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), contentVersionId: text("content_version_id").notNull().references(() => contentVersions.id),
  citationType: text("citation_type", { enum: ["topic", "memory", "knowledge", "video_atom", "inspiration", "video_analysis", "strategy", "benchmark", "method_knowledge", "historical_copy"] }).notNull(), citationId: text("citation_id").notNull(), quote: text("quote"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_content_citations_version_source").on(table.contentVersionId, table.citationType, table.citationId), index("idx_content_citations_tenant_item").on(table.organizationId, table.projectId, table.contentItemId)]);

export const authorizedKnowledgeSources = sqliteTable("authorized_knowledge_sources", {
  id: id(), name: text("name").notNull(), revision: text("revision").notNull(), itemCount: integer("item_count").notNull().default(0), syncedAt: text("synced_at").notNull(),
});

export const authorizedKnowledgeAtoms = sqliteTable("authorized_knowledge_atoms", {
  id: id(), sourceId: text("source_id").notNull().references(() => authorizedKnowledgeSources.id, { onDelete: "cascade" }),
  knowledge: text("knowledge").notNull(), original: text("original").notNull(), url: text("url"), publishedAt: text("published_at"),
  topicsJson: text("topics_json").notNull().default("[]"), skillsJson: text("skills_json").notNull().default("[]"), atomType: text("atom_type").notNull(), confidence: text("confidence").notNull(),
}, (table) => [index("idx_authorized_atoms_source_confidence").on(table.sourceId, table.confidence), index("idx_authorized_atoms_type_date").on(table.atomType, table.publishedAt)]);

export const contentReviews = sqliteTable("content_reviews", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), contentVersionId: text("content_version_id").notNull().references(() => contentVersions.id),
  reviewStage: text("review_stage", { enum: ["internal", "client"] }).notNull(), round: integer("round").notNull(), decision: text("decision", { enum: ["pending", "approved", "changes_requested", "cancelled"] }).notNull().default("pending"), note: text("note"), requestedBy: text("requested_by").notNull().references(() => users.id), decidedBy: text("decided_by").references(() => users.id), requestedAt: text("requested_at").notNull(), decidedAt: text("decided_at"),
}, (table) => [uniqueIndex("idx_content_reviews_item_stage_round").on(table.contentItemId, table.reviewStage, table.round), index("idx_content_reviews_project_decision_requested").on(table.organizationId, table.projectId, table.decision, table.requestedAt)]);

export const contentComments = sqliteTable("content_comments", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), contentVersionId: text("content_version_id").notNull().references(() => contentVersions.id),
  authorUserId: text("author_user_id").notNull().references(() => users.id), visibility: text("visibility", { enum: ["internal", "client"] }).notNull(), body: text("body").notNull(), anchorJson: text("anchor_json"), resolvedBy: text("resolved_by").references(() => users.id), resolvedAt: text("resolved_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), deletedAt: text("deleted_at"),
}, (table) => [index("idx_content_comments_item_version_created").on(table.contentItemId, table.contentVersionId, table.createdAt), index("idx_content_comments_project_visibility_created").on(table.organizationId, table.projectId, table.visibility, table.createdAt)]);

export const contentSchedules = sqliteTable("content_schedules", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), contentVersionId: text("content_version_id").notNull().references(() => contentVersions.id),
  platform: text("platform", { enum: ["douyin", "xiaohongshu", "wechat_channels", "bilibili", "other"] }).notNull(), scheduledAt: text("scheduled_at").notNull(), timezone: text("timezone").notNull().default("Asia/Shanghai"), status: text("status", { enum: ["planned", "ready", "cancelled", "published"] }).notNull().default("planned"), notes: text("notes"), createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), ...timestamps,
}, (table) => [uniqueIndex("idx_content_schedules_active_item").on(table.contentItemId).where(sql`${table.status} != 'cancelled'`), index("idx_content_schedules_project_time").on(table.organizationId, table.projectId, table.scheduledAt)]);

export const publicationRecords = sqliteTable("publication_records", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), contentVersionId: text("content_version_id").notNull().references(() => contentVersions.id), scheduleId: text("schedule_id").references(() => contentSchedules.id),
  platform: text("platform", { enum: ["douyin", "xiaohongshu", "wechat_channels", "bilibili", "other"] }).notNull(), status: text("status", { enum: ["scheduled", "publishing", "published", "failed", "cancelled"] }).notNull().default("scheduled"), externalId: text("external_id"), externalUrl: text("external_url"), publishedAt: text("published_at"), errorMessage: text("error_message"), createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), ...timestamps,
}, (table) => [index("idx_publication_records_project_status_updated").on(table.organizationId, table.projectId, table.status, table.updatedAt), index("idx_publication_records_item_created").on(table.contentItemId, table.createdAt)]);

export const publishedCopyRecords = sqliteTable("published_copy_records", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  contentItemId: text("content_item_id").references(() => contentItems.id), contentVersionId: text("content_version_id").references(() => contentVersions.id), publicationId: text("publication_id").references(() => publicationRecords.id),
  sourceType: text("source_type", { enum: ["manual", "publication", "csv_import"] }).notNull(), title: text("title").notNull(), body: text("body").notNull(),
  platform: text("platform", { enum: ["douyin", "xiaohongshu", "wechat_official", "wechat_channels", "bilibili", "other"] }).notNull(), contentFormat: text("content_format", { enum: ["spoken_script", "article", "caption", "newsletter", "other"] }).notNull(),
  publishedAt: text("published_at"), externalUrl: text("external_url"), characterCount: integer("character_count").notNull(), paragraphCount: integer("paragraph_count").notNull(),
  monetizationTypesJson: text("monetization_types_json").notNull().default("[]"), monetizationDetail: text("monetization_detail"), analysisJson: text("analysis_json").notNull(), performanceJson: text("performance_json").notNull().default("{}"),
  createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), deletedAt: text("deleted_at"), ...timestamps,
}, (table) => [
  uniqueIndex("idx_published_copy_publication").on(table.publicationId),
  index("idx_published_copy_project_published").on(table.organizationId, table.projectId, table.publishedAt),
  index("idx_published_copy_project_platform").on(table.organizationId, table.projectId, table.platform, table.updatedAt),
]);

export const performanceImportBatches = sqliteTable("performance_import_batches", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  source: text("source", { enum: ["csv", "manual"] }).notNull(), sourceHash: text("source_hash").notNull(), originalFilename: text("original_filename"), status: text("status", { enum: ["processing", "completed", "failed"] }).notNull().default("processing"), rowCount: integer("row_count").notNull(), acceptedCount: integer("accepted_count").notNull().default(0), rejectedCount: integer("rejected_count").notNull().default(0), errorsJson: text("errors_json"), importedBy: text("imported_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
}, (table) => [uniqueIndex("idx_performance_imports_project_hash").on(table.projectId, table.sourceHash), index("idx_performance_imports_project_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const publicationMetricSnapshots = sqliteTable("publication_metric_snapshots", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), publicationId: text("publication_id").notNull().references(() => publicationRecords.id), contentItemId: text("content_item_id").notNull().references(() => contentItems.id), importBatchId: text("import_batch_id").references(() => performanceImportBatches.id),
  observedAt: text("observed_at").notNull(), views: integer("views").notNull().default(0), likes: integer("likes").notNull().default(0), comments: integer("comments").notNull().default(0), shares: integer("shares").notNull().default(0), saves: integer("saves").notNull().default(0), followersGained: integer("followers_gained").notNull().default(0), leads: integer("leads").notNull().default(0), averageWatchSeconds: integer("average_watch_seconds"), completionRateBps: integer("completion_rate_bps"), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_publication_metrics_publication_observed").on(table.publicationId, table.observedAt), index("idx_publication_metrics_project_observed").on(table.organizationId, table.projectId, table.observedAt), index("idx_publication_metrics_content_observed").on(table.contentItemId, table.observedAt)]);

export const platformWorks = sqliteTable("platform_works", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), platform: text("platform").notNull().default("douyin"), platformWorkId: text("platform_work_id"), title: text("title").notNull(), titleNormalized: text("title_normalized").notNull(), publishedAt: text("published_at").notNull(), genre: text("genre"), reviewStatusRaw: text("review_status_raw"), reviewStatus: text("review_status"), contentItemId: text("content_item_id").references(() => contentItems.id), publicationId: text("publication_id").references(() => publicationRecords.id), videoId: text("video_id").references(() => videos.id), matchStatus: text("match_status").notNull().default("unmatched"), matchConfidence: integer("match_confidence"), matchMethod: text("match_method"), matchedBy: text("matched_by").references(() => users.id), matchedAt: text("matched_at"), createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), ...timestamps,
}, (table) => [index("idx_platform_works_project_lookup").on(table.organizationId, table.projectId, table.titleNormalized, table.publishedAt, table.genre), uniqueIndex("idx_platform_works_project_platform_id").on(table.projectId, table.platform, table.platformWorkId).where(sql`${table.platformWorkId} IS NOT NULL`), uniqueIndex("idx_platform_works_project_video").on(table.projectId, table.videoId).where(sql`${table.videoId} IS NOT NULL`)]);

export const platformMetricImportBatches = sqliteTable("platform_metric_import_batches", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), platform: text("platform").notNull().default("douyin"), asOfAt: text("as_of_at").notNull(), sourceHash: text("source_hash").notNull(), originalFilename: text("original_filename"), status: text("status").notNull().default("processing"), rowCount: integer("row_count").notNull(), acceptedCount: integer("accepted_count").notNull().default(0), rejectedCount: integer("rejected_count").notNull().default(0), errorsJson: text("errors_json"), importedBy: text("imported_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(), completedAt: text("completed_at"),
}, (table) => [uniqueIndex("idx_platform_metric_imports_project_hash_asof").on(table.projectId, table.sourceHash, table.asOfAt), index("idx_platform_metric_imports_project_created").on(table.organizationId, table.projectId, table.createdAt)]);

export const platformMetricSnapshots = sqliteTable("platform_metric_snapshots", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), platform: text("platform").notNull().default("douyin"), workId: text("work_id").notNull().references(() => platformWorks.id), importBatchId: text("import_batch_id").notNull().references(() => platformMetricImportBatches.id), asOfAt: text("as_of_at").notNull(), views: integer("views").notNull().default(0), completionRateBps: integer("completion_rate_bps"), fiveSecondCompletionRateBps: integer("five_second_completion_rate_bps"), coverCtrBps: integer("cover_ctr_bps"), twoSecondBounceRateBps: integer("two_second_bounce_rate_bps"), avgWatchMs: integer("avg_watch_ms"), likes: integer("likes").notNull().default(0), shares: integer("shares").notNull().default(0), comments: integer("comments").notNull().default(0), saves: integer("saves").notNull().default(0), homepageVisits: integer("homepage_visits").notNull().default(0), followerDelta: integer("follower_delta").notNull().default(0), createdBy: text("created_by").notNull().references(() => users.id), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_platform_metric_snapshots_work_asof").on(table.workId, table.asOfAt), index("idx_platform_metric_snapshots_project_asof").on(table.organizationId, table.projectId, table.asOfAt)]);

export const platformMetricImportErrors = sqliteTable("platform_metric_import_errors", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id), importBatchId: text("import_batch_id").notNull().references(() => platformMetricImportBatches.id), rowNumber: integer("row_number").notNull(), errorCode: text("error_code").notNull(), message: text("message").notNull(), rawJson: text("raw_json"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_platform_metric_errors_batch").on(table.importBatchId, table.rowNumber)]);

export const performanceReports = sqliteTable("performance_reports", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  reportType: text("report_type", { enum: ["weekly", "monthly", "custom"] }).notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), title: text("title").notNull(), status: text("status", { enum: ["draft", "final"] }).notNull().default("draft"), summary: text("summary").notNull(), metricsJson: text("metrics_json").notNull(), highlightsJson: text("highlights_json").notNull(), recommendationsJson: text("recommendations_json").notNull(), generatedBy: text("generated_by").notNull().references(() => users.id), generatedAt: text("generated_at").notNull(), finalizedBy: text("finalized_by").references(() => users.id), finalizedAt: text("finalized_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_performance_reports_project_period_type").on(table.projectId, table.periodStart, table.periodEnd, table.reportType), index("idx_performance_reports_project_status_generated").on(table.organizationId, table.projectId, table.status, table.generatedAt)]);

export const employeeWorkReports = sqliteTable("employee_work_reports", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").notNull().references(() => projects.id),
  employeeUserId: text("employee_user_id").notNull().references(() => users.id), reportType: text("report_type", { enum: ["weekly", "monthly", "custom"] }).notNull(),
  periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), title: text("title").notNull(), snapshotJson: text("snapshot_json").notNull(),
  generatedBy: text("generated_by").notNull().references(() => users.id), generatedAt: text("generated_at").notNull(), ...timestamps,
}, (table) => [uniqueIndex("idx_employee_work_reports_scope_period").on(table.projectId, table.employeeUserId, table.periodStart, table.periodEnd, table.reportType), index("idx_employee_work_reports_scope_generated").on(table.organizationId, table.projectId, table.employeeUserId, table.generatedAt)]);

export const workTasks = sqliteTable("work_tasks", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id),
  assigneeUserId: text("assignee_user_id").notNull().references(() => users.id), taskType: text("task_type", { enum: ["video_analysis", "topic", "content", "review", "publish", "custom"] }).notNull(),
  title: text("title").notNull(), description: text("description"), targetCount: integer("target_count").notNull().default(1), completedCount: integer("completed_count").notNull().default(0),
  priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"), status: text("status", { enum: ["pending", "in_progress", "completed", "cancelled"] }).notNull().default("pending"),
  startsAt: text("starts_at").notNull(), dueAt: text("due_at").notNull(), createdBy: text("created_by").notNull().references(() => users.id), updatedBy: text("updated_by").notNull().references(() => users.id), ...timestamps,
}, (table) => [index("idx_work_tasks_assignee_due").on(table.organizationId, table.assigneeUserId, table.status, table.dueAt), index("idx_work_tasks_admin_due").on(table.organizationId, table.status, table.dueAt), index("idx_work_tasks_project_type").on(table.organizationId, table.projectId, table.taskType, table.createdAt)]);

export const personalMemos = sqliteTable("personal_memos", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id), content: text("content").notNull(),
  sourceType: text("source_type", { enum: ["manual", "performance_report"] }).notNull().default("manual"), sourceId: text("source_id"), sourceLocator: text("source_locator"),
  status: text("status", { enum: ["active", "completed", "archived"] }).notNull().default("active"), completedAt: text("completed_at"), ...timestamps,
}, (table) => [index("idx_personal_memos_owner_status").on(table.organizationId, table.ownerUserId, table.status, table.updatedAt), uniqueIndex("idx_personal_memos_source_once").on(table.ownerUserId, table.sourceType, table.sourceId, table.sourceLocator)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: id(), organizationId: text("organization_id").notNull().references(() => organizations.id), projectId: text("project_id").references(() => projects.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id), action: text("action").notNull(), targetType: text("target_type").notNull(), targetId: text("target_id").notNull(),
  metadataJson: text("metadata_json"), ipHash: text("ip_hash"), createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_logs_org_project_created").on(table.organizationId, table.projectId, table.createdAt), index("idx_audit_logs_actor_created").on(table.actorUserId, table.createdAt)]);
