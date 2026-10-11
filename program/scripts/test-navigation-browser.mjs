import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Read-only check against the running app: client routing requires its real RSC runtime,
// which the isolated ecommerce Miniflare harness does not initialize.
const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.ECOMMERCE_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs")).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.ECOMMERCE_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
let page;
try {
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.NAVIGATION_TEST_URL || "http://127.0.0.1:3000/content");
  const sidebar = page.getByRole("complementary", { name: "主导航", exact: true });
  const ecommerceLink = sidebar.getByRole("link", { name: "电商中心", exact: true });
  await ecommerceLink.waitFor();
  await page.waitForLoadState("networkidle");
  const originalHref = await ecommerceLink.getAttribute("href");
  const documentNavigations = [];
  page.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations.push(request.url());
  });
  const delayedApi = async route => {
    if (["/api/organizations", "/api/projects", "/api/ecommerce/settings"].includes(new URL(route.request().url()).pathname)) await new Promise(resolve => setTimeout(resolve, 1000));
    try { await route.continue(); }
    catch (error) {
      // Workspace scope initialization can cancel a request while it is delayed.
      if (!error.message.includes("Route is already handled")) throw error;
    }
  };
  await page.route("**/api/**", delayedApi);
  await page.evaluate(() => {
    window.__ecommerceNavGaps = [];
    window.__ecommerceNavObserver = new MutationObserver(() => {
      const sidebar = document.querySelector("aside.sidebar");
      if (sidebar && !Array.from(sidebar.querySelectorAll("a")).some(a => a.textContent === "电商中心")) window.__ecommerceNavGaps.push(location.pathname);
    });
    window.__ecommerceNavObserver.observe(document.body, { childList: true, subtree: true });
  });
  for (const [label, pathname] of [["选题中心", "/topics"], ["品牌知识库", "/knowledge"], ["电商中心", "/content/ecommerce"], ["电商中心", "/content/ecommerce"], ["内容生产", "/content"], ["电商中心", "/content/ecommerce"]]) {
    await sidebar.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL(url => url.pathname === pathname);
    // Cover the serial organization/project/settings refresh, not just the route commit.
    await page.waitForTimeout(3500);
    await page.waitForLoadState("networkidle");
    assert.equal(await ecommerceLink.getAttribute("href"), originalHref);
    assert.deepEqual(documentNavigations, [], "包括重复点击电商中心在内，导航不能触发整页刷新");
    if (pathname === "/content/ecommerce") {
      assert.equal(await ecommerceLink.getAttribute("aria-current"), "page");
      assert.equal(new URL(page.url()).search, new URL(originalHref, page.url()).search);
      await page.getByRole("navigation", { name: "电商素材工作区", exact: true }).waitFor();
    }
  }
  assert.deepEqual(await page.evaluate(() => { window.__ecommerceNavObserver.disconnect(); return window.__ecommerceNavGaps; }), [], "慢接口下跨模块切换期间入口不能消失");
  await page.unroute("**/api/**", delayedApi);

  // Mock only this browser's response; do not change actual permissions or business data.
  await page.route("**/api/ecommerce/settings?**", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "合成权限撤销" }) }));
  await sidebar.getByRole("link", { name: "选题中心", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/topics");
  await ecommerceLink.waitFor({ state: "hidden" });
  await page.unroute("**/api/ecommerce/settings?**");
  await sidebar.getByRole("link", { name: "内容生产", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/content");
  await ecommerceLink.waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: slow navigation, entering and re-clicking ecommerce preserve the document, entry and scope; permission revalidation hides and restores it.");
} finally { await page?.unrouteAll({ behavior: "wait" }); await browser.close(); }
