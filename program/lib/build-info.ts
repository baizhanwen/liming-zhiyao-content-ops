import { env } from "cloudflare:workers";

type BuildEnv = typeof env & {
  BUILD_ID?: string;
  DATABASE_MIGRATION_VERSION?: string;
  ANALYSIS_CONTRACT_VERSION?: string;
};

const runtime = env as BuildEnv;

export const buildInfo = {
  buildId: runtime.BUILD_ID?.trim() || "codex-gate6-20260820",
  databaseMigrationVersion: runtime.DATABASE_MIGRATION_VERSION?.trim() || "0028_project_assistant_memory_chat",
  analysisContractVersion: runtime.ANALYSIS_CONTRACT_VERSION?.trim() || "analysis.v7",
} as const;
