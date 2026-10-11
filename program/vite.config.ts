import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// Opt into polling on restricted filesystems where native watch events are unavailable.
const usePolling = process.env.VITE_USE_POLLING === "1";
const ignoredWatchPaths = [
  "**/.git/**",
  "**/.vinext/**",
  "**/.wrangler/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/outputs/**",
  "**/services/analyzer/.venv/**",
  "**/services/analyzer/model-cache/**",
];

const lanMode = process.env.LAN_MODE === "1";
const lanAccessOrigin = process.env.LAN_ACCESS_ORIGIN?.trim() ?? "";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "liming-zhiyao-d1",
          database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "liming-zhiyao-media",
        },
        {
          binding: "MEDIA_LEGACY",
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
  ...(lanMode || lanAccessOrigin ? { vars: { LAN_MODE: lanMode ? "1" : "0", LAN_ACCESS_ORIGIN: lanAccessOrigin } } : {}),
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      // Normal local mode remains loopback-only. start-lan.bat opts into LAN
      // listening; remote visitors still need a database-backed login session.
      host: lanMode ? "0.0.0.0" : "127.0.0.1",
      watch: usePolling
        ? { useFsEvents: false, usePolling: true, ignored: ignoredWatchPaths }
        : { ignored: ignoredWatchPaths },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
