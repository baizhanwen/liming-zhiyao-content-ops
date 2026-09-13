import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { splitSql } from "./sql-statements.mjs";

// Isolated built Worker, real D1 and browser. Never loads .dev.vars or touches
// business storage. These synthetic assets are not real-SKU business acceptance.
const root = fileURLToPath(new URL("..", import.meta.url));
const runDir = path.join(root, ".local", `ecqa-${Date.now().toString(36)}`);
mkdirSync(runDir, { recursive: true });
const modulePath = process.env.ECOMMERCE_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(modulePath).href);
const server = path.join(root, "dist/server"), config = JSON.parse(readFileSync(path.join(server, "wrangler.json"), "utf8"));
const moduleNames = ["index.js", ...readdirSync(server, { recursive: true }).filter(p => p !== "index.js" && /\.m?js$/.test(p))];
const password = randomBytes(18).toString("base64url");
const errors = [], failedRequests = [], checks = [];
let browser, page;
const mf = new Miniflare({
  host: "127.0.0.1", port: 0,
  modules: moduleNames.map(p => ({ type: "ESModule", path: path.join(server, p) })), modulesRoot: server,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: { DB: "ecommerce-browser-fixture" }, d1Persist: path.join(runDir, "d1"),
  r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, "r2"),
  assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
  outboundService: () => new Response("External access disabled in ecommerce browser test", { status: 502 }),
  bindings: { DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0" },
});
try {
  const origin = String(await mf.ready), db = await mf.getD1Database("DB");
  for (const file of readdirSync(path.join(root, "drizzle")).filter(f => f.endsWith(".sql")).sort()) {
    for (const sql of splitSql(readFileSync(path.join(root, "drizzle", file), "utf8"))) await db.prepare(sql).run();
  }
  const now = new Date().toISOString(), salt = randomBytes(16);
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  await run("INSERT INTO installation_settings (key,value,updated_at) VALUES ('setup_completed','1',?)", now);
  await run("INSERT INTO users (id,auth_subject,email,display_name,status,created_at,updated_at) VALUES ('ec-admin','ec-admin','ecommerce@example.invalid','合成验收管理员','active',?,?)", now, now);
  await run("INSERT INTO local_credentials (user_id,password_salt,password_hash,iterations,created_at,updated_at) VALUES ('ec-admin',?,?,210000,?,?)", salt.toString("base64url"), pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("base64url"), now, now);
  await run("INSERT INTO organizations (id,name,slug,created_by,created_at,updated_at) VALUES ('ec-org','合成测试企业','ec-org','ec-admin',?,?)", now, now);
  await run("INSERT INTO organization_members (id,organization_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES ('ec-member','ec-org','ec-admin','admin','active','ec-admin','ec-admin',?,?)", now, now);
  for (const [id, name] of [["ec-project", "合成商品空间"], ["ec-other", "另一个空间"]]) await run("INSERT INTO projects (id,organization_id,name,client_name,status,created_by,updated_by,created_at,updated_at) VALUES (?,'ec-org',?,'合成测试','active','ec-admin','ec-admin',?,?)", id, name, now, now);

  browser = await chromium.launch({ headless: true, executablePath: process.env.ECOMMERCE_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.stack || e.message));
  page.on("requestfailed", r => { if (!r.failure()?.errorText.includes("ERR_ABORTED")) failedRequests.push({ path: new URL(r.url()).pathname, message: r.failure()?.errorText }); });
  const target = "/content/ecommerce?organizationId=ec-org&projectId=ec-project";
  await page.goto(new URL(`/login?returnTo=${encodeURIComponent(target)}`, origin).href);
  await page.locator('input[name="email"]').fill("ecommerce@example.invalid"); await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL("**/content/ecommerce?**");
  await page.getByText("电商素材未启用", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("商品名称 *", { exact: true }).isDisabled(), true);
  await page.getByText("空间设置", { exact: true }).click();
  await page.getByLabel("启用当前空间电商素材").check(); await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("电商素材已启用", { exact: true }).waitFor(); checks.push("默认关闭及管理员启用");

  await page.getByLabel("商品名称 *", { exact: true }).fill("合成验收杯（非真实商品）");
  await page.getByLabel("SKU *", { exact: true }).fill("SYNTHETIC-BROWSER");
  await page.getByLabel("商品品类", { exact: true }).fill("日用品");
  await page.getByLabel("规格", { exact: true }).fill("容量350毫升");
  await page.getByLabel("谁使用", { exact: true }).fill("日常喝水的人");
  await page.getByLabel("谁决定购买", { exact: true }).fill("使用者本人");
  await page.getByLabel("商品使用场景", { exact: true }).fill("日常桌面喝水");
  await page.getByLabel("不能说的内容", { exact: true }).fill("不宣称保温、防漏或健康功效");
  await page.getByRole("button", { name: "保存商品草稿", exact: true }).click();
  await page.getByRole("button", { name: "保存商品新版本", exact: true }).waitFor();
  checks.push("保存商品草稿");
  await page.getByText("＋ 添加证据", { exact: true }).click();
  await page.getByLabel("证据标题 *", { exact: true }).fill("合成规格说明");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "素材组件", exact: true }).click();
  assert.equal(await page.getByLabel("证据标题 *", { exact: true }).inputValue(), "合成规格说明");
  await page.getByRole("button", { name: "保存商品新版本", exact: true }).click();
  await page.getByText("请先保存或清空下方证据草稿，再保存商品。", { exact: true }).waitFor();
  checks.push("未保存证据不会被切页或商品保存静默丢弃");
  await page.getByLabel("原始证据正文 *", { exact: true }).fill("合成验收杯容量350毫升。此资料仅用于软件测试。");
  await page.getByLabel("来源与精确位置 *", { exact: true }).fill("合成测试说明第1条，无真实业务含义");
  await page.getByRole("button", { name: "保存证据草稿", exact: true }).click();
  const evidence = page.locator("details.ec-inset").filter({ has: page.locator("summary", { hasText: "合成规格说明" }) });
  await evidence.locator("summary").click(); await evidence.getByRole("button", { name: "确认此证据", exact: true }).click();
  await evidence.getByText("已确认", { exact: true }).waitFor(); checks.push("证据保存与人工确认");

  await page.getByRole("button", { name: "＋ 添加卖点", exact: true }).click();
  await page.getByLabel("卖点表述 *", { exact: true }).fill("容量350毫升");
  await page.getByLabel("允许使用的表达范围 *", { exact: true }).fill("仅可描述容量350毫升");
  await page.getByRole("checkbox", { name: "合成规格说明（已确认）", exact: true }).check();
  await page.getByLabel("卖点确认状态", { exact: true }).selectOption("confirmed");
  await page.getByLabel("保存为", { exact: true }).selectOption("confirmed");
  await page.getByRole("button", { name: "保存商品新版本", exact: true }).click();
  await page.locator(".ec-list-item.selected").getByText("已确认", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(runDir, "products-desktop.png"), fullPage: true }); checks.push("关联证据后确认商品新版本");

  await page.getByRole("button", { name: "素材组件", exact: true }).click();
  await page.getByRole("button", { name: "查看基础方法", exact: true }).click();
  await page.getByRole("button", { name: "确认并导入 12 张", exact: true }).click();
  await page.locator(".ec-list-item").filter({ hasText: "使用场景提问" }).click();
  assert.match(await page.getByLabel("操作规则 *", { exact: true }).inputValue(), /具体使用场景/);
  await page.getByLabel("方法名称 *", { exact: true }).fill("本空间场景提问");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.locator(".ec-list-item.selected").getByText("本空间场景提问", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看基础方法", exact: true }).click(); await page.getByRole("button", { name: "确认并导入 12 张", exact: true }).click();
  await page.getByText("导入完成；已经存在的方法保留当前空间的修改。", { exact: true }).waitFor();
  assert.equal(await page.locator(".ec-list-item").count(), 12); checks.push("基础方法导入、编辑与重复导入保留修改");
  await page.screenshot({ path: path.join(runDir, "methods-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(runDir, "methods-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, "移动端不应横向溢出"); checks.push("移动端布局无横向溢出");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-other");
  await page.getByText("电商素材未启用", { exact: true }).waitFor();
  assert.equal(await page.locator(".ec-list-item").count(), 0); checks.push("切换空间清除商品与方法资料");
  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-project");
  await page.getByText("电商素材已启用", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回普通内容", exact: true }).click();
  await page.getByRole("navigation", { name: "内容任务类型", exact: true }).getByRole("link", { name: "电商素材", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/content"); checks.push("返回普通内容保留空间入口");
  assert.deepEqual(errors, [], "浏览器未处理异常"); assert.deepEqual(failedRequests, [], "浏览器请求失败");
  const result = { syntheticOnly: true, checks, errors, failedRequests, screenshots: ["products-desktop.png", "methods-desktop.png", "methods-mobile.png"] };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: checks.length, runDir }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, "failure.png"), fullPage: true }).catch(() => {});
  writeFileSync(path.join(runDir, "failure.json"), JSON.stringify({ checks, errors, failedRequests, error: error.message }, null, 2));
  console.error(`Ecommerce browser check failed: ${error.message}\nArtifacts: ${runDir}`); process.exitCode = 1;
} finally { await browser?.close(); await mf.dispose(); }
