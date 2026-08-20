import { env } from "cloudflare:workers";

type BuildEnv = typeof env & {
  BUILD_ID?: string;
  DATABASE_MIGRATION_VERSION?: string;
  ANALYSIS_CONTRACT_VERSION?: string;
};

const runtime = env as BuildEnv;

export const buildInfo = {
  buildId: runtime.BUILD_ID?.trim() || "codex-gate1-20260820",
  databaseMigrationVersion: runtime.DATABASE_MIGRATION_VERSION?.trim() || "0019_generation_source_manifests",
  analysisContractVersion: runtime.ANALYSIS_CONTRACT_VERSION?.trim() || "analysis.v6",
} as const;
