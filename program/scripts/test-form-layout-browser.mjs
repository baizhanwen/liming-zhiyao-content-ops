import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const modulePath = process.env.LAN_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs");
const { chromium, webkit } = await import(pathToFileURL(modulePath).href);
const origin = process.env.FORM_LAYOUT_TEST_URL || "http://127.0.0.1:3000";
const project = { id: "layout-project", name: "测试空间", status: "active" };
const company = { id: "layout-org", name: "测试公司", role: "admin" };
const user = { id: "layout-user", displayName: "测试成员", email: "forms@example.invalid" };
const profile = {
  id: "layout-profile", category: "brand_story", title: "测试账号 · 账号资料", status: "draft", current_version: 1,
  body: "测试正文", source_type: "manual", source_ref: null, confirmed_at: null, updated_at: "2026-01-02T00:00:00.000Z",
  form: { kind: "profile", answers: { accountName: "测试账号", subject: "个人" } },
};
const api = {
  "/api/organizations": { organizations: [company], currentUser: user },
  "/api/projects": { projects: [project], organizationRole: "admin" },
  "/api/knowledge": { items: [profile], canWrite: true, canManage: true },
  "/api/strategies": { strategies: [], canWrite: true, canManage: true },
  "/api/ecommerce/settings": { settings: { enabled: 1, revision: 0 }, canManage: true },
  "/api/ecommerce/products": { products: Array.from({ length: 24 }, (_, i) => ({
    id: `layout-product-${i}`, name: `测试商品 ${i + 1}`, status: "draft", current_version: 1, facts_json: "{}",
  })) },
  "/api/inspiration-cards": { cards: [], canWrite: true, canManage: true },
  "/api/project-assistant/conversations": { conversations: [], canWrite: true },
  "/api/project-assistant/status": { configuration: { configured: true, model: "layout-test" } },
  "/api/studio/ideas": { ideas: [], canWrite: true, canDelete: false, hasMore: false },
};

function approximately(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 0.5, `${label}: expected ${expected}px, got ${actual}px`);
}

async function measure(locator, expectedHeight) {
  await locator.waitFor();
  const rect = await locator.boundingBox();
  assert.ok(rect);
  approximately(rect.height, expectedHeight, await locator.getAttribute("aria-label") || locator.toString());
  return rect;
}

async function assertPageFits(page, width) {
  const actual = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(actual <= width + 1, `${new URL(page.url()).pathname} extends to ${actual}px in ${width}px viewport`);
}

async function assertQuestionsStack(form, selectors) {
  const boxes = await form.evaluate((element, selectors) => selectors.map(selector => {
    const box = element.querySelector(selector)?.getBoundingClientRect();
    return box && { x: box.x, y: box.y, width: box.width, bottom: box.bottom };
  }), selectors);
  for (const [index, box] of boxes.entries()) {
    assert.ok(box && box.width > 0, `Question is visible: ${selectors[index]}`);
    approximately(box.x, boxes[0].x, `Left edge of ${selectors[index]}`);
    if (index) assert.ok(box.y > boxes[index - 1].bottom, `${selectors[index]} starts below ${selectors[index - 1]}`);
  }
}

async function verifyLayout(browser) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const issues = [];
  const fixtures = { ...api };
  try {
    // Only the real page shell and its assets are fetched. Business API reads are fixtures, writes are rejected.
    await context.route("**/api/**", async route => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();
      if (method !== "GET" || !Object.hasOwn(fixtures, pathname)) {
        issues.push(`Unexpected API request: ${method} ${pathname}`);
        await route.abort();
        return;
      }
      await route.fulfill({ json: fixtures[pathname] });
    });
    const page = await context.newPage();
    page.on("pageerror", error => issues.push(error.message));
    page.setDefaultTimeout(6000);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL("/space?tab=knowledge", origin).href);
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.locator("#knowledge-editor");
      const account = await measure(editor.getByLabel("对外名称", { exact: true }), 42);
      const subject = editor.getByLabel("账号主体", { exact: true });
      const choice = await measure(subject, 42);
      approximately(account.width, choice.width, "Account name and subject widths");

      await subject.focus();
      const focused = await measure(subject, 42);
      approximately(focused.width, choice.width, "Focused account subject width");
      await subject.selectOption("__custom");
      await measure(editor.getByLabel("自定义账号主体", { exact: true }), 42);
      assert.ok((await editor.locator("textarea[name=background]").boundingBox()).height > account.height);
      await editor.getByText("代表作品与公开边界", { exact: true }).click();
      await assertQuestionsStack(editor, [
        "[name=accountName]", "[name=subject]", "[name=subjectCustom]", "[name=background]",
        "[name=sample]", "fieldset:has(> div input[name=sampleUse])", "[name=boundary]",
      ]);
      await page.getByRole("button", { name: "填写品牌知识", exact: true }).click();
      const intake = page.locator("#knowledge-entry-manual");
      const choiceOfMaterial = intake.getByRole("checkbox", { name: "经历、人物与访谈", exact: true });
      await choiceOfMaterial.check();
      const material = intake.locator("form.guided-material:visible");
      await material.getByLabel("谁在什么场景经历了什么？").fill("访谈记录");
      await material.getByLabel("哪些内容可以对外讲？").selectOption("匿名后可公开");
      await material.getByLabel("有数字或量化比较").check();
      await material.getByLabel("需要定期复核").check();
      await assertQuestionsStack(material, [
        "[name=answer0]", "[name=answer1]", "[name=answer2]", "[name=title]", "[name=nature]",
        "fieldset.guided-options", "[name=evidenceType]", "[name=source]", "[name=publication]",
        "[name=publicSummary]", "[name=metric]", "[name=basis]", "[name=review]",
      ]);
      await choiceOfMaterial.uncheck();
      await choiceOfMaterial.check();
      assert.equal(await material.locator("[name=answer0]").inputValue(), "访谈记录");
      await intake.getByText("直接填写已有知识正文", { exact: true }).click();
      await assertQuestionsStack(intake.locator("details.guided-extra form"), [
        "[name=title]", "[name=category]", "[name=sourceType]", "[name=body]", "[name=sourceRef]",
      ]);
      await assertPageFits(page, width);

      await page.goto(new URL("/space?tab=strategy", origin).href);
      const strategy = page.locator("#strategy-entry");
      await strategy.getByLabel("主要观众", { exact: true }).waitFor();
      await strategy.getByText("呈现方式、表达习惯与栏目要求", { exact: true }).click();
      await assertQuestionsStack(strategy, [
        "[name=audience]", "[name=audienceDetail]", "[name=themes]", "fieldset:has(> div input[name=formats])",
        "[name=goal]", "[name=ending]", "[name=series]", "[name=cadence]", "[name=conversionPath]",
      ]);
      await assertPageFits(page, width);

      await page.goto(new URL("/ecommerce", origin).href);
      const scope = page.locator(".ec-scope");
      const companyBox = await measure(scope.getByLabel("公司", { exact: true }), 36);
      const projectBox = await measure(scope.getByLabel("企业空间", { exact: true }), 36);
      approximately(companyBox.width, projectBox.width, "Scope selector widths");
      if (width === 1440) approximately(companyBox.y, projectBox.y, "Scope row top edges");
      else approximately(companyBox.x, projectBox.x, "Stacked scope selectors");
      const product = page.getByLabel("商品品类", { exact: true });
      await measure(page.getByLabel("价格（元）", { exact: true }), 42);
      const category = await measure(product, 42);
      const specification = await measure(page.getByLabel("规格", { exact: true }), 42);
      if (width === 1440) {
        const list = page.locator(".record-sidebar-items");
        const form = page.locator(".ec-split > .ec-panel");
        const rightTop = await form.evaluate(el => el.scrollTop);
        const rightY = (await form.boundingBox()).y;
        await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
        const last = await list.getByRole("button").last().boundingBox();
        const paper = await page.locator(".shell-paper").boundingBox();
        assert.ok(await list.evaluate(el => el.scrollTop > 0), "Long product lists scroll");
        assert.ok(last.y + last.height <= paper.y + paper.height + 1, "Last product fits in the visible workspace");
        assert.equal(await form.evaluate(el => el.scrollTop), rightTop);
        approximately((await form.boundingBox()).y, rightY, "Form position while scrolling the list");
      }
      if (width === 1440) approximately(category.y, specification.y, "Product category and specification");
      await product.selectOption("__custom__");
      await measure(page.getByLabel("商品品类具体内容", { exact: true }), 42);
      const status = page.getByLabel("保存为", { exact: true });
      const save = page.getByRole("button", { name: "保存商品草稿", exact: true });
      await status.scrollIntoViewIfNeeded();
      const statusBox = await measure(status, 42);
      const saveBox = await measure(save, 42);
      if (width === 1440) approximately(statusBox.y, saveBox.y, "Product status and save action");
      await assertPageFits(page, width);
      assert.deepEqual(issues, []);
      console.log(`PASS ${browser.browserType().name()} ${width}px: single-column knowledge and strategy forms, conditional answers, ecommerce grid, filters, save row, page width`);
    }

    fixtures["/api/ecommerce/settings"] = { settings: { enabled: 0, revision: 0 }, canManage: true };
    await page.reload();
    const disabled = page.getByLabel("商品名称 *", { exact: true });
    await measure(disabled, 42);
    assert.ok(await disabled.isDisabled());
    assert.equal(await disabled.evaluate(element => getComputedStyle(element).cursor), "not-allowed");

    for (const viewport of [{ width: 1440, height: 786 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(viewport);
      await page.goto(new URL("/studio?view=inspiration", origin).href);
      const welcome = page.locator(".assistant-thread-empty");
      await welcome.waitFor();
      const threadBox = await page.locator(".assistant-thread").boundingBox();
      const welcomeBox = await welcome.boundingBox();
      assert.ok(welcomeBox.y >= threadBox.y && welcomeBox.y + welcomeBox.height <= threadBox.y + threadBox.height + 1, "The entire welcome must fit above the composer");
      const sendBox = await page.getByRole("button", { name: "发送问题" }).boundingBox();
      assert.ok(sendBox.y + sendBox.height <= viewport.height, "Send must be visible on entry");
      const starters = welcome.getByRole("button");
      assert.equal(await starters.count(), 4);
      await starters.last().click();
      const input = page.getByRole("textbox", { name: "灵感对话内容" });
      assert.ok((await input.inputValue()).includes("内容机会"));
      assert.ok(await input.evaluate(element => element === document.activeElement));

      const library = page.getByRole("region", { name: "已存灵感" });
      const search = await measure(library.locator(".studio-idea-search"), 36);
      const modes = await library.getByRole("group", { name: "灵感状态" }).boundingBox();
      const note = await measure(library.getByRole("textbox", { name: "一句话灵感" }), 42);
      const save = await measure(library.getByRole("button", { name: "保存灵感" }), 42);
      approximately(note.y, save.y, "Saved idea input and action alignment");
      assert.ok(note.y >= search.y + search.height);
      if (viewport.width === 1440) {
        approximately(search.y + search.height / 2, modes.y + modes.height / 2, "Saved idea search and filter alignment");
      } else {
        assert.ok(search.y >= modes.y + modes.height);
        approximately(search.x, note.x, "Stacked search and note left edges");
        approximately(search.x + search.width, save.x + save.width, "Stacked search and save right edges");
      }
      await assertPageFits(page, viewport.width);
    }
    assert.deepEqual(issues, []);
  } finally {
    await context.close();
  }
}

const engines = { chromium, webkit };
for (const name of (process.env.FORM_LAYOUT_BROWSERS || "chromium,webkit").split(",")) {
  assert.ok(Object.hasOwn(engines, name), `Unsupported browser: ${name}`);
  const executablePath = name === "chromium" ? process.env.LAN_TEST_BROWSER : process.env.FORM_LAYOUT_WEBKIT;
  const browser = await engines[name].launch({ headless: true, executablePath });
  try {
    await verifyLayout(browser);
  } finally {
    await browser.close();
  }
}
