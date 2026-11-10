import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync, createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { splitSql } from "./sql-statements.mjs";
import { createEcommerceTestModel } from "./ecommerce-test-model.mjs";

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
const errors = [], failedRequests = [], checks = [], apiFailures = [];
const model = createEcommerceTestModel();
const cpuStart = process.cpuUsage(), startedAt = new Date().toISOString(), directRequests = [];
let providerResponseHook, providerMode = "valid";
let browser, page;
const mf = new Miniflare({
  host: "127.0.0.1", port: 0,
  modules: moduleNames.map(p => ({ type: "ESModule", path: path.join(server, p) })), modulesRoot: server,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: { DB: "ecommerce-browser-fixture" }, d1Persist: path.join(runDir, "d1"),
  r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, "r2"),
  assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
  outboundService: async request => {
    const response = await model.respond(request);
    if (providerResponseHook) await providerResponseHook();
    if (providerMode === "valid") return response;
    const body = await response.json(); body.choices[0].message.content = "synthetic invalid JSON";
    if (providerMode === "invalid-unknown") delete body.usage;
    return Response.json(body);
  },
  bindings: { DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0", CONTENT_MODEL_API_KEY: "synthetic-not-a-secret", CONTENT_MODEL_BASE_URL: "https://model.example.invalid", CONTENT_MODEL_NAME: "synthetic-test", CONTENT_MODEL_PROVIDER: "synthetic-test" },
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

  await run("INSERT INTO content_strategies (id,organization_id,project_id,version,name,status,positioning,target_audience,pain_points_json,pillars_json,topic_mix_json,style_notes,objectives_json,created_by,updated_by,created_at,updated_at) VALUES ('ec-strategy','ec-org','ec-project',1,'合成商品策略','active','日常商品规格说明','日常使用者','[]','[\"不可注入的内容支柱\"]','{}','自然口语','[]','ec-admin','ec-admin',?,?)", now, now);


  await run("INSERT INTO videos (id,organization_id,project_id,platform,source_type,title,status,created_by,updated_by,created_at,updated_at) VALUES ('ec-video','ec-org','ec-project','douyin','url','合成参考视频','ready','ec-admin','ec-admin',?,?)", now, now);
  await run("INSERT INTO video_library_entries (id,organization_id,source_video_id,category,created_by,updated_by,created_at,updated_at) VALUES ('ec-library','ec-org','ec-video','benchmark','ec-admin','ec-admin',?,?)", now, now);
  await run("INSERT INTO project_video_references (id,organization_id,project_id,library_entry_id,purpose,created_by,created_at) VALUES ('ec-reference','ec-org','ec-project','ec-library','benchmark','ec-admin',?)", now);
  await run("INSERT INTO video_analyses (id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES ('ec-analysis','ec-org','ec-project','ec-video','synthetic',?,'ec-admin',?,?)", JSON.stringify({ structure: "先展示商品规格，再引导查看商品卡。", note: "合成分析，仅用于软件测试" }), now, now);

  browser = await chromium.launch({ headless: true, executablePath: process.env.ECOMMERCE_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("response", async r => { if (r.url().includes("/api/ecommerce/") && r.status() >= 400) apiFailures.push({ url: r.url(), status: r.status(), body: await r.text().catch(() => "") }); });
  page.on("pageerror", e => errors.push(e.stack || e.message));
  page.on("requestfailed", r => { if (!r.failure()?.errorText.includes("ERR_ABORTED")) failedRequests.push({ path: new URL(r.url()).pathname, message: r.failure()?.errorText }); });
  const target = "/content/ecommerce?organizationId=ec-org&projectId=ec-project";
  await page.goto(new URL(`/login?returnTo=${encodeURIComponent(target)}`, origin).href);
  await page.locator('input[name="email"]').fill("ecommerce@example.invalid"); await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL("**/content/ecommerce?**");
  const fillProductAnswer = async (label, value) => {
    await page.getByLabel(label, { exact: true }).selectOption({ label: "自行填写具体内容" });
    await page.getByLabel(`${label}具体内容`, { exact: true }).fill(value);
  };
  const fillTaskAnswer = async (label, value) => {
    const question = page.getByRole("group", { name: label, exact: true });
    await question.getByRole("radio", { name: "自行填写", exact: true }).check();
    await question.getByLabel(`填写${label}`, { exact: true }).fill(value);
  };
  await page.getByText("电商文案未启用", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "制作第一条视频", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "发布与复盘", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "启用文案功能", exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "商品资料", exact: true }).getAttribute("aria-current"), "page");
  await page.getByLabel("商品名称 *", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("商品名称 *", { exact: true }).isDisabled(), true);
  await page.getByText("空间设置", { exact: true }).click();
  await page.getByLabel("启用当前空间文案功能").check(); await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("电商文案已启用", { exact: true }).waitFor(); checks.push("默认关闭及管理员启用");

  await page.getByLabel("商品名称 *", { exact: true }).fill("合成验收杯（非真实商品）");
  assert.equal(await page.getByLabel("SKU *", { exact: true }).count(), 0);
  await page.getByLabel("价格（元）", { exact: true }).fill("35.00");
  await fillProductAnswer("商品品类", "日用品");
  await page.getByLabel("规格", { exact: true }).fill("容量350毫升");
  await fillProductAnswer("谁使用", "日常喝水的人");
  await page.getByLabel("谁决定购买", { exact: true }).selectOption({ label: "使用者本人" });
  await fillProductAnswer("商品使用场景", "日常桌面喝水");
  await page.getByLabel("不能说的内容", { exact: true }).fill("不宣称保温、防漏或健康功效");
  await page.getByLabel("保存为", { exact: true }).selectOption("confirmed");
  await page.getByRole("button", { name: "保存商品草稿", exact: true }).click();
  await page.getByRole("button", { name: "保存商品新版本", exact: true }).waitFor();
  await page.locator(".ec-list-item.selected").getByText("已确认", { exact: true }).waitFor();
  const savedProduct = await db.prepare("SELECT p.*,v.id AS version_id,v.public_json,v.internal_json FROM ecommerce_products p JOIN ecommerce_product_versions v ON v.product_id=p.id AND v.version=p.current_version WHERE p.project_id='ec-project'").first();
  assert.match(savedProduct.sku, /^AUTO-/);
  assert.equal(JSON.parse(savedProduct.public_json).priceCents, 3500);
  assert.deepEqual(JSON.parse(savedProduct.public_json).claims, []);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").first()).n, 0);
  // Preserve a private legacy field through the real synthetic API. Immutable
  // product versions are never patched directly, even by this test harness.
  const privateVersion = await context.request.post(new URL("/api/ecommerce/products", origin).href, { data: { organizationId: "ec-org", projectId: "ec-project", id: savedProduct.id, revision: savedProduct.revision, name: savedProduct.name, sku: savedProduct.sku, status: "confirmed", publicData: JSON.parse(savedProduct.public_json), internalData: { ...JSON.parse(savedProduct.internal_json), marginNotes: "PRIVATE_BROWSER_MARGIN" } } });
  assert.equal(privateVersion.status(), 200, await privateVersion.text());
  checks.push("商品信息与价格可直接确认，不需要手工卖点或证据记录；历史内部字段仍保存为独立版本");
  await page.screenshot({ path: path.join(runDir, "products-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "文案任务", exact: true }).click();
  await page.getByLabel("任务名称 *", { exact: true }).fill("合成杯规格浏览器验收");
  const productVersion = await page.getByLabel("选择商品 *", { exact: true }).locator("option").filter({ hasText: "v2（当前）" }).getAttribute("value");
  await page.getByLabel("选择商品 *", { exact: true }).selectOption(productVersion);
  assert.equal(await page.getByRole("radio", { name: /^不参考视频，按方法论生成/ }).count(), 0);
  await page.getByLabel("选择一个对标带货视频 *", { exact: true }).selectOption("reference:ec-reference:ec-analysis");
  await page.getByRole("button", { name: "保存并进入生成", exact: true }).waitFor();
  const audienceDetails = page.locator("details").filter({ has: page.locator("summary", { hasText: "调整人群与使用场景" }) });
  if (await audienceDetails.getAttribute("open") === null) await audienceDetails.locator("summary").first().click();
  await fillTaskAnswer("主要购买障碍", "不清楚容量规格");
  assert.equal(await page.getByLabel("主要介绍的卖点（可选）", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("group", { name: "本次采用的卖点证据（最多 5 条）", exact: true }).count(), 0);
  await page.getByRole("group", { name: "目标时长", exact: true }).getByRole("radio", { name: "30 秒 · 推荐起步", exact: true }).check();
  await fillTaskAnswer("承接位置与动作", "当前商品卡查看规格");
  assert.equal(await page.getByRole("group", { name: "实际拍摄条件（可多选）", exact: true }).count(), 0);
  await page.getByRole("button", { name: "保存并进入生成", exact: true }).click();
  const generateButton = page.getByRole("button", { name: "生成文案", exact: true });
  await generateButton.waitFor();
  await run("UPDATE ecommerce_project_settings SET enabled=0 WHERE project_id='ec-project'");
  await generateButton.click();
  await page.getByRole("alert").filter({ hasText: "当前空间尚未启用电商素材" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "核对原请求", exact: true }).count(), 0);
  await run("UPDATE ecommerce_project_settings SET enabled=1 WHERE project_id='ec-project'");
  await generateButton.click();
  checks.push("明确拒绝的生成请求可修正后重新发起，不陷入核对循环");
  await page.getByLabel("查看文案版本", { exact: true }).waitFor({ timeout: 60000 });
  assert.deepEqual(model.calls.map(c => c.stage), ["plan", "draft", "review"]);
  const task = await db.prepare("SELECT * FROM ecommerce_tasks WHERE project_id='ec-project'").first();
  const versions = async () => (await db.prepare("SELECT * FROM ecommerce_versions WHERE task_id=? ORDER BY version").bind(task.id).all()).results;
  let history = await versions(); assert.equal(history.length, 1);
  const initialPack = JSON.parse(history[0].pack_json);
  assert.equal(initialPack.applications.filter(a => a.used).length, 3);
  assert.ok(initialPack.applications.every(application => application.used));
  assert.ok(initialPack.applications.some(application => application.sourceType === "case" && application.sourceId === "ec-reference" && application.notTransferred));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ecommerce_components").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").first()).n, 0);
  assert.ok(!JSON.stringify(model.calls).includes("不可注入的内容支柱"));
  assert.ok(!JSON.stringify(model.calls).includes("PRIVATE_BROWSER_MARGIN"));
  assert.ok(initialPack.segments.every(segment => segment.visual === ""));
  assert.deepEqual(initialPack.filmingChecklist, []);
  assert.equal(model.calls.some(call => "filming" in call.payload.context.task.brief), false);
  assert.ok(model.calls.every(call => call.payload.context.cases.length === 1 && call.payload.context.cases[0].id === "ec-reference"));
  assert.ok(model.calls.every(call => call.payload.context.task.brief.referenceMode === "benchmark"));
  assert.equal(model.calls.some(call => call.payload.context.candidates.some(candidate => !["hook", "structure"].includes(candidate.card.kind))), false);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出文案", exact: true }).click();
  await (await downloading).saveAs(path.join(runDir, "synthetic-script.txt"));
  assert.doesNotMatch(readFileSync(path.join(runDir, "synthetic-script.txt"), "utf8"), /PRIVATE_BROWSER_MARGIN|拍摄清单|画面：/);
  checks.push("只选择商品与对标视频即可HTTP生成文案；商品事实来自不可变版本，未创建手工卖点、证据或方法卡");
  for (const [role, label] of [["hook", "只替换开头"], ["evidence", "只替换依据段"], ["cta", "只替换行动引导"]]) {
    const before = JSON.parse(history.at(-1).pack_json), expected = history.length + 1;
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(n => document.querySelectorAll('.ec-panel select option').length > 0 && Array.from(document.querySelectorAll('option')).some(o => o.textContent === 'v' + n + ' · 局部替换'), expected);
    history = await versions(); assert.equal(history.length, expected);
    const after = JSON.parse(history.at(-1).pack_json);
    assert.deepEqual(after.segments.filter(s => s.role !== role), before.segments.filter(s => s.role !== role));
    assert.notEqual(after.segments.find(s => s.role === role).script, before.segments.find(s => s.role === role).script);
  }
  checks.push("开头、证据、CTA分别替换且其他段落逐字段保持一致");
  await page.getByRole("button", { name: "编辑文案", exact: true }).click();
  await page.getByLabel("第 1 段文案", { exact: true }).fill("桌面喝水选杯子，先核对容量规格，再考虑自己的日常需要。");
  assert.equal(await page.getByRole("button", { name: "导出文案", exact: true }).isDisabled(), true);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "商品资料", exact: true }).click();
  assert.equal(await page.getByLabel("第 1 段文案", { exact: true }).inputValue(), "桌面喝水选杯子，先核对容量规格，再考虑自己的日常需要。");
  await page.getByLabel("本次修改说明 *", { exact: true }).fill("合成验收：人工调整开头措辞");
  await page.getByRole("button", { name: "保存文案新版本", exact: true }).click();
  await page.getByLabel("查看文案版本", { exact: true }).locator("option").filter({ hasText: "v5 · 人工修改" }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  for (const label of ["商品事实与证据一致", "行动引导与承接位置正确"]) await page.getByRole("checkbox", { name: label, exact: true }).check();
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  assert.equal(await page.getByText("登记自有账号", { exact: true }).count(), 0);
  assert.equal(await page.getByText("拍摄清单", { exact: true }).count(), 0);
  checks.push("只生成文案，人工修改保护与两项事实/承接审核；不显示拍摄或发布表单");

  // Preserve historical publication/metric API coverage with synthetic requests.
  // These endpoints support existing records; the simplified UI has no entry.
  const legacyScope = { organizationId: "ec-org", projectId: "ec-project" };
  const legacyPost = async (resource, data, expected = 201) => {
    const response = await context.request.post(new URL(`/api/ecommerce/${resource}`, origin).href, { data: { ...legacyScope, ...data } });
    const body = await response.json(); assert.equal(response.status(), expected, JSON.stringify(body)); return body;
  };
  const account = (await legacyPost("accounts", { displayName: "合成验收账号", handle: "synthetic-browser-account", platform: "douyin", confirmOwned: true })).account;
  history = await versions();
  const publication = (await legacyPost(`tasks/${task.id}/publications`, { versionId: history[4].id, accountId: account.id, platform: "douyin", externalUrl: "https://example.invalid/synthetic-video", publishedAt: new Date(Date.now() - 120 * 60000).toISOString(), traffic: "organic" })).publication;
  const zeroInput = { publicationId: publication.id, observedAt: new Date(Date.now() - 5 * 60000).toISOString(), periodStart: new Date(Date.now() - 120 * 60000).toISOString(), periodEnd: new Date(Date.now() - 10 * 60000).toISOString(), attributionWindow: "合成观测：发布后累计", source: "合成测试，无真实后台数据", scope: "video", methodology: "仅用于软件链路测试，不代表业务成绩", views: 0, orders: 0 };
  await legacyPost("metrics", zeroInput);
  let metrics = (await db.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE publication_id=? ORDER BY created_at").bind(publication.id).all()).results;
  assert.equal(metrics.length, 1); const zero = JSON.parse(metrics[0].body_json);
  assert.equal(zero.views, 0); assert.equal(zero.orders, 0); assert.equal(zero.productClicks, null);
  await legacyPost("metrics", { ...zeroInput, replacesId: metrics[0].id, views: 10 });
  metrics = (await db.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE publication_id=? ORDER BY created_at").bind(publication.id).all()).results;
  assert.equal(metrics.length, 2); assert.equal(JSON.parse(metrics[0].body_json).views, 0); assert.equal(JSON.parse(metrics[1].body_json).views, 10);
  assert.equal(metrics[1].replaces_id, metrics[0].id);
  checks.push("历史发布API保留版本绑定，旧数据真实零与未采集区别和追加修正历史");
  await page.getByRole("button", { name: "生成新版本", exact: true }).click();
  await page.getByLabel("查看文案版本", { exact: true }).locator("option").filter({ hasText: "v6 · AI 生成" }).waitFor({ state: "attached" });
  const originalPublication = await db.prepare("SELECT * FROM ecommerce_publications WHERE id=?").bind(publication.id).first();
  assert.equal(originalPublication.version_id, history[4].id);
  assert.equal((await db.prepare("SELECT status FROM ecommerce_tasks WHERE id=?").bind(task.id).first()).status, "draft");
  checks.push("新稿重新审核，旧发布与观测保持绑定原版本");

  const held = model.holdNext();
  await page.getByRole("button", { name: "生成新版本", exact: true }).click();
  await Promise.race([held.started, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("等待测试模型开始超时")), 15000); timer.unref(); })]);
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await page.getByText("已请求取消，已有稿件保留。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "生成新版本", exact: true }).isDisabled(), true);
  held.release();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent === '生成新版本' && !b.disabled));
  assert.equal((await versions()).length, 6);
  const cancelled = await db.prepare("SELECT * FROM ecommerce_generation_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").bind(task.id).first();
  assert.equal(cancelled.status, "failed"); assert.equal(cancelled.error_code, "RUN_CANCELLED");
  checks.push("浏览器取消正在生成的请求，迟到结果不保存且调用结束前不可重复生成");

  await page.screenshot({ path: path.join(runDir, "assembly-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "文案任务手机布局不应溢出");
  await page.screenshot({ path: path.join(runDir, "assembly-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.getByRole("button", { name: "制作第一条视频", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "发布与复盘", exact: true }).count(), 0);
  checks.push("简化导航始终不显示首条向导或发布复盘入口");

  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-other");
  await page.getByText("电商文案未启用", { exact: true }).waitFor();
  assert.equal(await page.locator(".ec-list-item").count(), 0); checks.push("切换空间清除商品与方法资料");
  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-project");
  await page.getByText("电商文案已启用", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回普通内容", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "主导航", exact: true });
  const ecommerceLink = sidebar.getByRole("link", { name: "电商中心", exact: true });
  await ecommerceLink.waitFor();
  assert.equal(new URL(page.url()).pathname, "/content");
  assert.equal(await page.getByRole("navigation", { name: "内容任务类型", exact: true }).count(), 0);
  assert.equal(await sidebar.getByRole("link", { name: "内容生产", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await ecommerceLink.evaluate(el => el.previousElementSibling?.textContent), "内容生产");
  // This isolated Worker has no client RSC router; actual Link clicks are covered by test-navigation-browser.mjs.
  await page.goto(new URL(await ecommerceLink.getAttribute("href"), page.url()).href);
  await page.getByText("电商文案已启用", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/content/ecommerce");
  assert.equal(new URL(page.url()).searchParams.get("projectId"), "ec-project");
  assert.equal(await ecommerceLink.getAttribute("aria-current"), "page");
  assert.equal(await sidebar.getByRole("link", { name: "内容生产", exact: true }).getAttribute("aria-current"), null);
  checks.push("电商中心位于内容生产下方，跳转保留空间且独立高亮，页内重复入口已移除");
  const ledger = async () => (await db.prepare("SELECT id,status,error_code,output_json FROM model_calls WHERE task_type LIKE 'ecommerce.%' ORDER BY rowid").all()).results;
  let rows = await ledger(); assert.equal(rows.length, model.calls.length);
  assert.ok(rows.every(row => JSON.parse(row.output_json).modelRequests[0].totalTokens === 200));
  checks.push("实际生成、局部修改和取消的所有供应商请求均保留合成 Token 回执");
  const api = async (route, data, method = "post") => {
    const start = performance.now(), response = await context.request[method](new URL(route, origin).href, { data, timeout: 30000 });
    const body = await response.json(); directRequests.push({ route, status: response.status(), ms: Math.round(performance.now() - start) });
    return { status: response.status(), body };
  };
  const assertStatus = (response, status) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
  const scope = { organizationId: "ec-org", projectId: "ec-project" };
  const generate = async (key, taskId = task.id) => {
    const current = await db.prepare("SELECT revision,current_version FROM ecommerce_tasks WHERE id=?").bind(taskId).first();
    return api(`/api/ecommerce/tasks/${taskId}/generate`, { ...scope, revision: current.revision, baseVersion: current.current_version, idempotencyKey: key });
  };
  const quota = extra => run("INSERT INTO organization_settings(id,organization_id,monthly_model_call_quota,created_by,updated_by,created_at,updated_at) VALUES('ec-budget','ec-org',(SELECT COUNT(*) FROM model_calls WHERE organization_id='ec-org')+?,'ec-admin','ec-admin',?,?) ON CONFLICT(organization_id) DO UPDATE SET monthly_model_call_quota=excluded.monthly_model_call_quota", extra, now, now);
  const charged = async (action, expected) => {
    const before = model.calls.length; assertStatus(await action(), expected); assert.equal(model.calls.length - before, 1);
    const last = (await ledger()).at(-1); assert.equal(JSON.parse(last.output_json).modelRequests[0].totalTokens, 200); assert.equal((await versions()).length, 6);
    return last;
  };
  providerMode = "invalid";
  await charged(() => generate("fees-invalid-json"), 502); providerMode = "valid";
  checks.push("真实 HTTP 解析失败保留已收到的用量，不保存新稿");
  providerMode = "invalid-unknown";
  const unknownBefore = model.calls.length; assertStatus(await generate("fees-unknown-json"), 502); providerMode = "valid";
  assert.equal(model.calls.length - unknownBefore, 1); const unknown = JSON.parse((await ledger()).at(-1).output_json).modelRequests[0];
  assert.equal(unknown.usageKnown, false); assert.equal(unknown.totalTokens, null);
  checks.push("供应商无用量回执时显示未知，未伪造零 Token");
  providerResponseHook = async () => { providerResponseHook = undefined; await run("UPDATE organization_members SET status='inactive' WHERE user_id='ec-admin'"); };
  await charged(() => generate("fees-revoked"), 403); await run("UPDATE organization_members SET status='active' WHERE user_id='ec-admin'");
  checks.push("实际成员撤权后拒绝结果和后续请求，仍记录首个收费请求");
  await run("CREATE TRIGGER fail_ecommerce_receipt BEFORE UPDATE OF output_json ON model_calls WHEN NEW.status='started' AND NEW.task_type LIKE 'ecommerce.%' BEGIN SELECT RAISE(ABORT,'Synthetic receipt failure'); END");
  await charged(() => generate("fees-receipt-failed"), 502); await run("DROP TRIGGER fail_ecommerce_receipt");
  checks.push("实际 D1 回执写入失败时补存已知用量，停止生成且旧稿不变");
  await quota(10);
  providerResponseHook = async () => { providerResponseHook = undefined; await quota(0); };
  await charged(() => generate("fees-lowered"), 429);
  checks.push("响应期间下调公司额度阻止第二次请求");
  await quota(10); await run("UPDATE ecommerce_project_settings SET max_concurrent=2 WHERE project_id='ec-project'");
  const sourceTask = await db.prepare("SELECT * FROM ecommerce_tasks WHERE id=?").bind(task.id).first();
  const newTask = assertStatus(await api("/api/ecommerce/tasks", { ...scope, title: "合成预算竞争任务", productId: sourceTask.product_id, productVersionId: sourceTask.product_version_id, brief: JSON.parse(sourceTask.brief_json) }), 201).task;
  await quota(1); const concurrentBefore = model.calls.length;
  const competing = await Promise.all([generate("fees-concurrent-old"), generate("fees-concurrent-new", newTask.id)]);
  for (const result of competing) assertStatus(result, 429);
  assert.equal(model.calls.length - concurrentBefore, 1); assert.equal((await versions()).length, 6);
  assert.equal((await db.prepare("SELECT current_version FROM ecommerce_tasks WHERE id=?").bind(newTask.id).first()).current_version, 0);
  checks.push("两个任务共享公司最后一个请求名额，D1 原子预占不超额");
  await quota(10);
  providerResponseHook = async () => { providerResponseHook = undefined; await run("DELETE FROM local_sessions WHERE user_id='ec-admin'"); };
  await charged(() => generate("fees-session-deleted"), 401);
  assertStatus(await api("/api/auth/session", { email: "ecommerce@example.invalid", password }), 200);
  checks.push("实际登录会话删除后终止请求，原用量保留且重新登录可用");
  await run("CREATE TRIGGER reject_ecommerce_fee BEFORE INSERT ON model_calls WHEN NEW.task_type LIKE 'ecommerce.%' BEGIN SELECT RAISE(ABORT,'Synthetic registration failure'); END");
  const beforeRegistry = model.calls.length; assertStatus(await generate("fees-register-failed"), 500); assert.equal(model.calls.length, beforeRegistry);
  assert.equal((await db.prepare("SELECT call_count FROM ecommerce_generation_runs WHERE idempotency_key='fees-register-failed'").first()).call_count, 0);
  await run("DROP TRIGGER reject_ecommerce_fee"); checks.push("真实 D1 登记事务失败回滚计数，未派发供应商请求");
  const mutationCallsBefore = model.calls.length;
  const metricInput = (offset, views = 10) => {
    const observedAt = new Date(Date.now() - offset).toISOString();
    return { ...scope, publicationId: publication.id, observedAt, periodStart: originalPublication.published_at, periodEnd: observedAt, attributionWindow: "合成观察首小时", source: "合成后台快照", scope: "video", methodology: "累计快照；仅用于软件验收", views, orders: 0 };
  };
  const metricRows = async () => (await db.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE publication_id=? ORDER BY rowid").bind(publication.id).all()).results;
  const metricAuditCount = async () => (await db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ecommerce.metrics.saved'").first()).n;
  const auditBeforeMetrics = await metricAuditCount();
  const conflictInput = metricInput(5000), conflictBefore = (await metricRows()).length;
  const different = await Promise.all([api("/api/ecommerce/metrics", conflictInput), api("/api/ecommerce/metrics", { ...conflictInput, views: 20 })]);
  assert.deepEqual(different.map(r => r.status).sort(), [201, 409]); assert.equal((await metricRows()).length, conflictBefore + 1);
  assert.equal(await metricAuditCount(), auditBeforeMetrics + 1);
  checks.push("真实并发 HTTP 的不同观察数据只保存一份，另一份提示刷新并追加修正");
  const replayInput = metricInput(4000), replayBefore = (await metricRows()).length;
  const replays = await Promise.all([api("/api/ecommerce/metrics", replayInput), api("/api/ecommerce/metrics", replayInput)]);
  assert.deepEqual(replays.map(r => r.status).sort(), [200, 201]); assert.equal(replays[0].body.snapshot.id, replays[1].body.snapshot.id); assert.equal((await metricRows()).length, replayBefore + 1);
  assert.equal(await metricAuditCount(), auditBeforeMetrics + 2);
  checks.push("真实并发 HTTP 的相同观察数据返回同一快照，不重复记审计");
  const originalMetric = (await metricRows()).find(row => row.id === replays[0].body.snapshot.id);
  const correctionInput = { ...replayInput, replacesId: originalMetric.id, views: 30 };
  const corrections = await Promise.all([api("/api/ecommerce/metrics", correctionInput), api("/api/ecommerce/metrics", { ...correctionInput, views: 40 })]);
  assert.deepEqual(corrections.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual((await metricRows()).find(row => row.id === originalMetric.id), originalMetric);
  assert.equal((await metricRows()).filter(row => row.replaces_id === originalMetric.id).length, 1);
  assert.equal(await metricAuditCount(), auditBeforeMetrics + 3);
  checks.push("真实并发修正保留原快照，不同修正只接受一个后继");
  const sameCorrection = { ...conflictInput, replacesId: different.find(r => r.status === 201).body.snapshot.id, views: 50 };
  const correctionReplay = await Promise.all([api("/api/ecommerce/metrics", sameCorrection), api("/api/ecommerce/metrics", sameCorrection)]);
  assert.deepEqual(correctionReplay.map(r => r.status).sort(), [200, 201]); assert.equal(correctionReplay[0].body.snapshot.id, correctionReplay[1].body.snapshot.id);
  assert.equal(await metricAuditCount(), auditBeforeMetrics + 4);
  checks.push("真实并发相同修正返回同一后继快照");
  const mutationSnapshot = async () => {
    const snapshot = {};
    for (const table of ["ecommerce_tasks", "ecommerce_products", "ecommerce_versions", "ecommerce_reviews", "ecommerce_publications", "ecommerce_metric_snapshots", "ecommerce_components", "ecommerce_component_versions", "ecommerce_project_settings", "audit_logs"]) snapshot[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    return snapshot;
  };
  const guardedMetric = metricInput(3000), beforeRevocation = await mutationSnapshot();
  await run("UPDATE organization_members SET status='inactive' WHERE user_id='ec-admin'");
  for (const [route, data] of [["/api/ecommerce/metrics", guardedMetric], ["/api/ecommerce/tasks", { ...scope, title: "合成撤权新任务", productId: sourceTask.product_id, productVersionId: sourceTask.product_version_id, brief: JSON.parse(sourceTask.brief_json) }]]) assertStatus(await api(route, data), 403);
  assert.deepEqual(await mutationSnapshot(), beforeRevocation);
  await run("UPDATE organization_members SET status='active' WHERE user_id='ec-admin'");
  checks.push("真实成员撤权后任务和复盘写入返回403，业务与审计保持不变");
  const starterKey = (await (await context.request.get(new URL(`/api/ecommerce/components/starter?${new URLSearchParams(scope)}`, origin).href)).json()).cards[0].key;
  await run("INSERT INTO project_members(id,organization_id,project_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('ec-assignment','ec-org','ec-project','ec-admin','member','active','ec-admin','ec-admin',?,?)", now, now);
  await run("UPDATE organization_members SET role='employee' WHERE user_id='ec-admin'");
  const beforeDemotion = await mutationSnapshot();
  assertStatus(await api("/api/ecommerce/components/starter", { ...scope, keys: [starterKey], confirm: true }), 403);
  const settingBefore = beforeDemotion.ecommerce_project_settings.find(row => row.project_id === "ec-project");
  assertStatus(await api("/api/ecommerce/settings", { ...scope, enabled: true, revision: settingBefore.revision }, "put"), 403);
  assert.deepEqual(await mutationSnapshot(), beforeDemotion);
  assertStatus(await api("/api/ecommerce/metrics", guardedMetric), 201);
  await run("UPDATE organization_members SET role='admin' WHERE user_id='ec-admin'");
  checks.push("实际管理员降为员工后设置和导入被拒绝，获分配员工仍可回填数据");
  const beforeWriteFailure = await mutationSnapshot(), currentTask = await db.prepare("SELECT * FROM ecommerce_tasks WHERE id=?").bind(task.id).first(), currentVersion = (await versions()).at(-1);
  await run("CREATE TRIGGER reject_manual_version BEFORE INSERT ON ecommerce_versions WHEN NEW.mode='manual' BEGIN SELECT RAISE(ABORT,'Synthetic manual version failure'); END");
  assertStatus(await api(`/api/ecommerce/tasks/${task.id}/versions`, { ...scope, revision: currentTask.revision, baseVersion: currentTask.current_version, pack: JSON.parse(currentVersion.pack_json), changeSummary: "合成人工保存故障" }), 500);
  assert.deepEqual(await mutationSnapshot(), beforeWriteFailure); await run("DROP TRIGGER reject_manual_version");
  checks.push("实际 D1 人工版本写入失败时任务版本指针和审计整批回滚");
  assert.equal(model.calls.length, mutationCallsBefore, "人工写入与复盘不调用模型");
  rows = await ledger(); assert.equal(rows.length, model.calls.length);
  const receipts = rows.map(row => JSON.parse(row.output_json).modelRequests[0]);
  assert.equal(receipts.filter(receipt => !receipt.usageKnown).length, 1);
  assert.deepEqual(errors, [], "浏览器未处理异常"); assert.deepEqual(failedRequests, [], "浏览器请求失败");
  const times = directRequests.map(request => request.ms).sort((a, b) => a - b);
  const result = { passed: true, syntheticOnly: true, startedAt, finishedAt: new Date().toISOString(), checks, errors, failedRequests, apiFailures, modelStages: model.calls.map(c => c.stage), directRequests,
    buildSha256: createHash("sha256").update(readFileSync(path.join(root, "dist/server/index.js"))).digest("hex"),
    modelAccounting: { requests: model.calls.length, ledgerRows: rows.length, knownRequests: receipts.filter(r => r.usageKnown).length, unknownRequests: receipts.filter(r => !r.usageKnown).length, syntheticTokens: receipts.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0) },
    metrics: { directHttpRequests: times.length, directP50Ms: times[Math.floor(times.length * .5)], directP95Ms: times[Math.floor(times.length * .95)], directMaxMs: times.at(-1), harnessRssBytes: process.memoryUsage().rss, harnessCpuMicroseconds: process.cpuUsage(cpuStart), boundary: "Direct HTTP timings only, excludes browser page requests; Node harness resources exclude browser/workerd/supplier. All accounts, materials and provider usage are synthetic; not real business acceptance." },
    screenshots: ["products-desktop.png", "assembly-desktop.png", "assembly-mobile.png"] };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: checks.length, runDir }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, "failure.png"), fullPage: true }).catch(() => {});
  writeFileSync(path.join(runDir, "failure.json"), JSON.stringify({ checks, errors, failedRequests, apiFailures, modelStages: model.calls.map(c => c.stage), error: error.message }, null, 2));
  console.error(`Ecommerce browser check failed: ${error.message}\nArtifacts: ${runDir}`); process.exitCode = 1;
} finally { await browser?.close(); await mf.dispose(); }
