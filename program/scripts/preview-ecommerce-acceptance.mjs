import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { splitSql } from "./sql-statements.mjs";

// Render an already generated real-provider result in the actual built app.
// Everything here is isolated example data. No business DB, .dev.vars, provider
// credentials or external network are read or used by this preview server.
const root = fileURLToPath(new URL("..", import.meta.url));
const inputPath = process.argv[2];
assert.ok(inputPath && !inputPath.startsWith("--"), "Usage: node scripts/preview-ecommerce-acceptance.mjs /absolute/path/to/result.json [--port 0]");
const sourcePath = path.resolve(inputPath);
const result = JSON.parse(readFileSync(sourcePath, "utf8"));
assert.equal(result.syntheticOnly, true, "Preview accepts explicitly labelled example product data only");
assert.equal(result.realModel, true, "Preview requires a real-model result rather than a synthetic model response");
assert.equal(result.status, 201, "The imported generation must have completed successfully");
assert.ok(result.snapshot?.product && result.body?.version?.pack && result.validation, "Result must include the saved snapshot, pack and validation");
const snapshot = structuredClone(result.snapshot), pack = structuredClone(result.body.version.pack);
assert.equal(snapshot.task?.brief?.referenceMode, "method", "This preview expects the direct methodology generation path");
assert.equal(snapshot.cases?.length ?? 0, 0, "Reference assets must not be silently omitted from a preview");
assert.equal(snapshot.candidates?.length ?? 0, 0, "Private method cards must not be silently omitted from a preview");
const portIndex = process.argv.indexOf("--port"), port = portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]);
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid loopback port");
const server = path.join(root, "dist/server");
assert.ok(existsSync(path.join(server, "index.js")), "Build the current app with npm run build first");
const config = JSON.parse(readFileSync(path.join(server, "wrangler.json"), "utf8"));
const modules = ["index.js", ...readdirSync(server, { recursive: true }).filter(name => name !== "index.js" && /\.m?js$/u.test(name))];
const runDir = path.join(root, ".local", `ec-acceptance-preview-${Date.now().toString(36)}`);
mkdirSync(runDir, { recursive: true });
const userId = "preview-owner", organizationId = "ecommerce-acceptance-org", projectId = "ecommerce-acceptance-project";
const now = new Date().toISOString(), durationMs = (result.stages ?? []).reduce((total, stage) => total + (Number(stage.latencyMs) || 0), 0);
const startedAt = new Date(Date.now() - durationMs).toISOString();
const productId = snapshot.product.id, productVersionId = snapshot.product.versionId;
const taskId = snapshot.task.id, versionId = result.body.version.id || randomUUID(), generationRunId = randomUUID();
assert.ok(productId && productVersionId && taskId, "Saved source IDs are required");
const productName = snapshot.product.name || "文案验收示例商品";
const taskTitle = `${productName} · 真实生成效果`;
snapshot.task.title = taskTitle;
const brief = snapshot.task.brief;
const publicData = {
  category: snapshot.product.category || "", specification: snapshot.product.specification || "", sellingPoints: snapshot.product.sellingPoints || "",
  copyFacts: { content: "", usage: "", difference: "", delivery: "", limitations: "", speakerExperience: "", ...snapshot.product.copyFacts },
  audience: { user: "", buyer: "", situation: "", trigger: "", alternative: "", barrier: "", concerns: "", viewingContext: "", source: "", status: "hypothesis", ...brief.audience },
  scenarios: brief.scene || "", claims: [], prohibited: snapshot.product.prohibited || "不编造示例资料之外的事实", purchaseConcerns: snapshot.product.purchaseConcerns || brief.barrier || "",
  priceCents: snapshot.product.price?.amountCents ?? null, currency: snapshot.product.price?.currency || "CNY",
  offer: snapshot.product.offer?.offer || "", offerValidUntil: snapshot.product.offer?.validUntil || null, landingUrl: "",
};
const internalData = { costCents: null, marginNotes: "", stock: null, stockObservedAt: null, refundReasons: "", negativeReviews: "" };
const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const manifest = (snapshot.sources ?? []).map(source => ({ sourceType: source.type, sourceId: source.id, version: source.version, contentHash: digest(source.text), organizationId, projectId }));
let mf;
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  if (mf) await mf.dispose();
}
try {
  mf = new Miniflare({
    host: "127.0.0.1", port,
    modules: modules.map(name => ({ type: "ESModule", path: path.join(server, name) })), modulesRoot: server,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: "ecommerce-acceptance-isolated" }, d1Persist: path.join(runDir, "d1"),
    r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, "r2"),
    assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
    outboundService: () => new Response("External network is disabled in this isolated acceptance preview", { status: 403 }),
    bindings: { DELIVERY_MODE: "0", LOCAL_DEV_AUTH: "1", LOCAL_DEV_USER_ID: userId, LOCAL_DEV_USER_EMAIL: "preview-owner@example.invalid", LOCAL_DEV_USER_NAME: "文案效果验收管理员", TRUST_FORWARDED_IDENTITY: "0", LAN_MODE: "0" },
  });
  const origin = String(await mf.ready), db = await mf.getD1Database("DB");
  for (const file of readdirSync(path.join(root, "drizzle")).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of splitSql(readFileSync(path.join(root, "drizzle", file), "utf8"))) await db.prepare(sql).run();
  }
  const columns = new Map();
  const seed = async (table, values) => {
    if (!columns.has(table)) columns.set(table, new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(column => column.name)));
    const known = columns.get(table);
    const row = Object.fromEntries(Object.entries({ id: randomUUID(), organization_id: organizationId, project_id: projectId, created_by: userId, updated_by: userId, created_at: now, updated_at: now, ...values }).filter(([key, value]) => known.has(key) && value !== undefined));
    await db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).bind(...Object.values(row)).run();
    return row.id;
  };
  await seed("installation_settings", { key: "setup_completed", value: "1" });
  await seed("users", { id: userId, auth_subject: userId, email: "preview-owner@example.invalid", display_name: "文案效果验收管理员", status: "active" });
  await seed("organizations", { id: organizationId, name: "文案效果验收·示例资料", slug: "ecommerce-acceptance-preview", status: "active" });
  await seed("organization_members", { user_id: userId, role: "admin", status: "active" });
  await seed("projects", { id: projectId, name: "文案效果验收·示例资料", client_name: "示例商品，仅用于效果验收", status: "active" });
  await seed("ecommerce_project_settings", { enabled: 1, revision: 1, max_concurrent: 1, monthly_call_limit: 5 });
  await seed("ecommerce_products", { id: productId, sku: "ACCEPTANCE-EXAMPLE-ONLY", name: productName, status: "confirmed", revision: snapshot.product.revision || 1, current_version: 1 });
  await seed("ecommerce_product_versions", { id: productVersionId, product_id: productId, version: 1, sku: "ACCEPTANCE-EXAMPLE-ONLY", name: productName, public_json: JSON.stringify(publicData), internal_json: JSON.stringify(internalData), confirmed_by: userId, confirmed_at: now });
  await seed("ecommerce_tasks", { id: taskId, product_id: productId, product_version_id: productVersionId, title: taskTitle, brief_json: JSON.stringify(brief), revision: snapshot.taskRevision || snapshot.task.revision || 1, current_version: result.body.version.version || 1, status: "draft" });
  await seed("ecommerce_generation_runs", { id: generationRunId, task_id: taskId, idempotency_key: "imported-real-model-acceptance", input_hash: digest(snapshot), base_version: 0, task_revision: snapshot.taskRevision || snapshot.task.revision || 1, operation: "generate", status: "completed", call_count: Math.min(5, result.stages?.length || 0), result_version_id: versionId, created_at: startedAt, completed_at: now });
  await seed("ecommerce_versions", { id: versionId, task_id: taskId, product_id: productId, product_version_id: productVersionId, version: result.body.version.version || 1, parent_version_id: null, run_id: generationRunId, mode: "ai", pack_json: JSON.stringify(pack), input_snapshot_json: JSON.stringify(snapshot), input_hash: digest(snapshot), source_manifest_json: JSON.stringify(manifest), validation_json: JSON.stringify(result.validation), change_summary: "真实模型生成结果 · 示例商品资料", prompt_version: "acceptance-imported-real-model" });

  // Verify the same routes the UI uses, without automating or opening a browser.
  const scope = new URLSearchParams({ organizationId, projectId });
  const healthResponse = await mf.dispatchFetch(new URL("/api/health", origin));
  assert.equal(healthResponse.status, 200, "Preview health route failed");
  const tasksResponse = await mf.dispatchFetch(new URL(`/api/ecommerce/tasks?${scope}&taskId=${encodeURIComponent(taskId)}`, origin));
  assert.equal(tasksResponse.status, 200, `Preview task route failed: ${await tasksResponse.clone().text()}`);
  const imported = await tasksResponse.json();
  assert.equal(imported.versions[0]?.id, versionId, "The saved actual model version is missing");
  assert.equal(JSON.parse(imported.versions[0].pack_json).title, pack.title, "Preview must render the original generated copy");
  const url = new URL(`/content/ecommerce?${scope}`, origin).href;
  const metadata = { url, origin, runDir, sourcePath, organizationId, projectId, taskId, versionId, syntheticProduct: true, realModel: true, networkDisabled: true, taskTitle, instructions: "进入文案任务，点击唯一一条真实生成效果任务。此页面使用隔离示例资料，不连接业务数据库或模型服务。" };
  writeFileSync(path.join(runDir, "preview.json"), JSON.stringify(metadata, null, 2));
  writeFileSync(path.join(runDir, "generated-copy.txt"), `${pack.title}\n\n${pack.segments.map(segment => segment.script).join("\n\n")}\n`);
  console.log(JSON.stringify(metadata));
  await new Promise(resolve => {
    const finish = () => { void stop().finally(resolve); };
    process.once("SIGINT", finish); process.once("SIGTERM", finish);
  });
} catch (error) {
  await stop();
  console.error(error instanceof Error ? error.message : "Preview failed");
  process.exitCode = 1;
}
