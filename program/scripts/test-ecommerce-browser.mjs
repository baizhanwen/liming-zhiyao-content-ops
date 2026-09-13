import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync } from "node:crypto";
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
let browser, page;
const mf = new Miniflare({
  host: "127.0.0.1", port: 0,
  modules: moduleNames.map(p => ({ type: "ESModule", path: path.join(server, p) })), modulesRoot: server,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: { DB: "ecommerce-browser-fixture" }, d1Persist: path.join(runDir, "d1"),
  r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, "r2"),
  assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
  outboundService: request => model.respond(request),
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
  await page.getByText("内部经营资料", { exact: true }).click();
  await page.getByLabel("毛利说明", { exact: true }).fill("PRIVATE_BROWSER_MARGIN");
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


  await page.getByRole("button", { name: "参考案例", exact: true }).click();
  await page.getByLabel("选择当前空间的对标分析 *", { exact: true }).selectOption("ec-reference:ec-analysis");
  await page.getByLabel("参考分析与转写原文", { exact: true }).waitFor();
  assert.match(await page.getByLabel("参考分析与转写原文", { exact: true }).inputValue(), /先展示商品规格/);
  await page.getByLabel("案例名称 *", { exact: true }).fill("合成规格结构案例");
  const caseValues = { "目标人群 *": "日常商品使用者", "钩子机制 *": "使用场景提问", "段落结构与卖点出场位置 *": "先展示商品规格，再引导查看商品卡。", "原视频如何呈现证据 *": "对照规格标注", "原视频承接动作 *": "查看商品卡", "可以迁移的结构或方法 *": "规格说明结构", "不能迁移的身份、经历、销量或效果 *": "不迁移原作者身份与销量", "引用的来源原句 *": "先展示商品规格，再引导查看商品卡。" };
  for (const [label, value] of Object.entries(caseValues)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "保存案例草稿", exact: true }).click();
  const caseDetails = page.locator("details.ec-inset").filter({ has: page.locator("summary", { hasText: "合成规格结构案例" }) });
  await caseDetails.locator("summary").click(); await caseDetails.getByRole("button", { name: "确认案例", exact: true }).click();
  await caseDetails.getByText("已确认", { exact: true }).waitFor();
  await caseDetails.getByRole("button", { name: "编辑案例", exact: true }).click();
  await page.getByLabel("案例名称 *", { exact: true }).fill("修订规格结构案例");
  await page.getByRole("button", { name: "保存案例修改", exact: true }).click();
  const editedCase = page.locator("details.ec-inset").filter({ has: page.locator("summary", { hasText: "修订规格结构案例" }) });
  await editedCase.getByText("草稿", { exact: true }).waitFor();
  await editedCase.getByRole("button", { name: "确认案例", exact: true }).click();
  await editedCase.getByText("已确认", { exact: true }).waitFor();
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM videos").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ecommerce_case_profiles").first()).n, 1);
  checks.push("关联已有分析原文、确认与编辑案例，修改后重新确认且不复制原视频");

  await page.getByRole("button", { name: "任务与装配", exact: true }).click();
  await page.getByLabel("任务名称 *", { exact: true }).fill("合成杯规格浏览器验收");
  const productVersion = await page.getByLabel("商品版本 *", { exact: true }).locator("option").filter({ hasText: "v2（当前）" }).getAttribute("value");
  await page.getByLabel("商品版本 *", { exact: true }).selectOption(productVersion);
  await page.getByLabel("主要购买障碍", { exact: true }).fill("不清楚容量规格");
  await page.getByLabel("本次只讲一个卖点", { exact: true }).selectOption({ label: "容量350毫升" });
  await page.getByRole("checkbox", { name: "合成规格说明", exact: true }).check();
  await page.getByLabel("目标时长（秒）", { exact: true }).fill("30");
  await page.getByLabel("承接位置与动作", { exact: true }).fill("当前商品卡查看规格");
  await page.getByRole("checkbox", { name: "可拍实物", exact: true }).check();
  await page.getByRole("button", { name: "保存任务草稿", exact: true }).click();
  const generateButton = page.getByRole("button", { name: "生成电商素材", exact: true });
  await generateButton.waitFor();
  await run("UPDATE ecommerce_project_settings SET enabled=0 WHERE project_id='ec-project'");
  await generateButton.click();
  await page.getByRole("alert").filter({ hasText: "当前空间尚未启用电商素材" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "核对原请求", exact: true }).count(), 0);
  await run("UPDATE ecommerce_project_settings SET enabled=1 WHERE project_id='ec-project'");
  await generateButton.click();
  checks.push("明确拒绝的生成请求可修正后重新发起，不陷入核对循环");
  await page.getByLabel("查看稿件版本", { exact: true }).waitFor({ timeout: 60000 });
  assert.deepEqual(model.calls.map(c => c.stage), ["plan", "draft", "review"]);
  const task = await db.prepare("SELECT * FROM ecommerce_tasks WHERE project_id='ec-project'").first();
  const versions = async () => (await db.prepare("SELECT * FROM ecommerce_versions WHERE task_id=? ORDER BY version").bind(task.id).all()).results;
  let history = await versions(); assert.equal(history.length, 1);
  const initialPack = JSON.parse(history[0].pack_json);
  assert.equal(initialPack.applications.filter(a => a.used).length, 6);
  assert.ok(initialPack.applications.some(a => !a.used));
  assert.ok(!JSON.stringify(model.calls).includes("不可注入的内容支柱"));
  assert.ok(!JSON.stringify(model.calls).includes("PRIVATE_BROWSER_MARGIN"));
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出口播与拍摄清单", exact: true }).click();
  await (await downloading).saveAs(path.join(runDir, "synthetic-script.txt"));
  assert.doesNotMatch(readFileSync(path.join(runDir, "synthetic-script.txt"), "utf8"), /PRIVATE_BROWSER_MARGIN/);
  checks.push("任务选择商品事实、推荐方法、HTTP生成与来源采用及未采用报告");
  for (const [role, label] of [["hook", "只替换开头"], ["evidence", "只替换证据段"], ["cta", "只替换CTA"]]) {
    const before = JSON.parse(history.at(-1).pack_json), expected = history.length + 1;
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(n => document.querySelectorAll('.ec-panel select option').length > 0 && Array.from(document.querySelectorAll('option')).some(o => o.textContent === 'v' + n + ' · 局部替换'), expected);
    history = await versions(); assert.equal(history.length, expected);
    const after = JSON.parse(history.at(-1).pack_json);
    assert.deepEqual(after.segments.filter(s => s.role !== role), before.segments.filter(s => s.role !== role));
    assert.notEqual(after.segments.find(s => s.role === role).script, before.segments.find(s => s.role === role).script);
  }
  checks.push("开头、证据、CTA分别替换且其他段落逐字段保持一致");
  await page.getByRole("button", { name: "编辑稿件", exact: true }).click();
  await page.getByLabel("第 1 段口播", { exact: true }).fill("桌面喝水选杯子，先核对容量规格，再考虑自己的日常需要。");
  assert.equal(await page.getByRole("button", { name: "导出口播与拍摄清单", exact: true }).isDisabled(), true);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "发布与复盘", exact: true }).click();
  assert.equal(await page.getByLabel("第 1 段口播", { exact: true }).inputValue(), "桌面喝水选杯子，先核对容量规格，再考虑自己的日常需要。");
  await page.getByLabel("本次修改说明 *", { exact: true }).fill("合成验收：人工调整开头措辞");
  await page.getByRole("button", { name: "保存稿件新版本", exact: true }).click();
  await page.getByLabel("查看稿件版本", { exact: true }).locator("option").filter({ hasText: "v5 · 人工修改" }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  for (const label of ["商品事实与证据一致", "镜头可按实际条件拍摄", "CTA 与承接位置正确"]) await page.getByRole("checkbox", { name: label, exact: true }).check();
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await page.getByText("登记自有账号", { exact: true }).click();
  await page.getByLabel("账号名称 *", { exact: true }).fill("合成验收账号");
  await page.getByLabel("抖音号 *", { exact: true }).fill("synthetic-browser-account");
  await page.getByRole("checkbox", { name: "确认这是当前企业可管理的自有账号", exact: true }).check();
  await page.getByRole("button", { name: "保存账号标识", exact: true }).click();
  await page.getByText("账号标识已登记。", { exact: true }).waitFor();
  await page.getByLabel("实际发布账号 *", { exact: true }).selectOption({ label: "合成验收账号 · synthetic-browser-account" });
  const datetime = minutes => { const d = new Date(Date.now() - minutes * 60000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  await page.getByLabel("实际发布时间 *", { exact: true }).fill(datetime(120));
  await page.getByLabel("作品链接 *", { exact: true }).fill("https://example.invalid/synthetic-video");
  await page.getByRole("button", { name: "登记发布作品", exact: true }).click();
  await page.getByRole("heading", { name: "观测快照", exact: true }).waitFor();
  checks.push("人工修改保护、版本审核、自有账号与实际作品登记");
  const publication = await db.prepare("SELECT * FROM ecommerce_publications WHERE task_id=?").bind(task.id).first();
  history = await versions(); assert.equal(publication.version_id, history[4].id);
  await page.getByLabel("观察时间 *", { exact: true }).fill(datetime(5));
  await page.getByLabel("统计结束 *", { exact: true }).fill(datetime(10));
  await page.getByLabel("播放", { exact: true }).fill("0");
  await page.getByLabel("成交订单", { exact: true }).fill("0");
  await page.getByLabel("归因窗口 *", { exact: true }).fill("合成观测：发布后累计");
  await page.getByLabel("数据来源与位置 *", { exact: true }).fill("合成测试，无真实后台数据");
  await page.getByLabel("统计口径说明 *", { exact: true }).fill("仅用于软件链路测试，不代表业务成绩");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "商品资料", exact: true }).click();
  assert.equal(await page.getByLabel("播放", { exact: true }).inputValue(), "0");
  await page.getByRole("button", { name: "保存观测快照", exact: true }).click();
  await page.getByText("观测快照已保存，历史记录保留。", { exact: true }).waitFor();
  let metrics = (await db.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE publication_id=? ORDER BY created_at").bind(publication.id).all()).results;
  assert.equal(metrics.length, 1); const zero = JSON.parse(metrics[0].body_json);
  assert.equal(zero.views, 0); assert.equal(zero.orders, 0); assert.equal(zero.productClicks, null);
  await page.getByRole("button", { name: "修正", exact: true }).click();
  await page.getByLabel("播放", { exact: true }).fill("10");
  await page.getByRole("button", { name: "保存修正快照", exact: true }).click();
  await page.getByText("已被修正", { exact: true }).waitFor();
  metrics = (await db.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE publication_id=? ORDER BY created_at").bind(publication.id).all()).results;
  assert.equal(metrics.length, 2); assert.equal(JSON.parse(metrics[0].body_json).views, 0); assert.equal(JSON.parse(metrics[1].body_json).views, 10);
  assert.equal(metrics[1].replaces_id, metrics[0].id);
  checks.push("发布快照保留真实零与未采集区别、未保存保护和追加修正历史");
  await page.getByRole("button", { name: "生成新版本", exact: true }).click();
  await page.getByLabel("查看稿件版本", { exact: true }).locator("option").filter({ hasText: "v6 · AI 生成" }).waitFor({ state: "attached" });
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
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "装配与回填手机布局不应溢出");
  await page.screenshot({ path: path.join(runDir, "assembly-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "发布与复盘", exact: true }).click();
  await page.getByLabel("选择已发布作品", { exact: true }).selectOption(publication.id);
  await page.getByText("已被修正", { exact: true }).waitFor();
  await page.getByText("追溯发布版本与实际采用来源", { exact: true }).click();
  await page.getByRole("heading", { name: "合成验收杯的容量说明 · v5", exact: true }).waitFor();
  checks.push("跨任务复盘入口可查看对应商品、作品、历史快照及实际采用来源");

  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-other");
  await page.getByText("电商素材未启用", { exact: true }).waitFor();
  assert.equal(await page.locator(".ec-list-item").count(), 0); checks.push("切换空间清除商品与方法资料");
  await page.getByLabel("企业空间", { exact: true }).selectOption("ec-project");
  await page.getByText("电商素材已启用", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回普通内容", exact: true }).click();
  await page.getByRole("navigation", { name: "内容任务类型", exact: true }).getByRole("link", { name: "电商素材", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/content"); checks.push("返回普通内容保留空间入口");
  assert.deepEqual(errors, [], "浏览器未处理异常"); assert.deepEqual(failedRequests, [], "浏览器请求失败");
  const result = { syntheticOnly: true, checks, errors, failedRequests, apiFailures, modelStages: model.calls.map(c => c.stage), screenshots: ["products-desktop.png", "methods-desktop.png", "methods-mobile.png", "assembly-desktop.png", "assembly-mobile.png"] };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: checks.length, runDir }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runDir, "failure.png"), fullPage: true }).catch(() => {});
  writeFileSync(path.join(runDir, "failure.json"), JSON.stringify({ checks, errors, failedRequests, apiFailures, modelStages: model.calls.map(c => c.stage), error: error.message }, null, 2));
  console.error(`Ecommerce browser check failed: ${error.message}\nArtifacts: ${runDir}`); process.exitCode = 1;
} finally { await browser?.close(); await mf.dispose(); }
