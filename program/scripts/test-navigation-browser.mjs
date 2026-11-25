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
  await page.goto(process.env.NAVIGATION_TEST_URL || "http://127.0.0.1:3000/studio?view=drafts");
  const sidebar = page.getByRole("complementary", { name: "主导航", exact: true });
  const ecommerceLink = sidebar.getByRole("link", { name: "电商中心", exact: true });
  await ecommerceLink.waitFor();
  await page.waitForLoadState("networkidle");
  const originalHref = await ecommerceLink.getAttribute("href");
  const documentNavigations = [];
  page.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations.push(request.url());
  });
  // Hold the first destination on the network while the user chooses a second module.
  let releaseSpace;
  const spaceResponseGate = new Promise(resolve => { releaseSpace = resolve; });
  const spaceRoute = /\/space(?:\.rsc)?(?:\?|$)/;
  const delaySpace = async route => {
    await spaceResponseGate;
    await route.continue().catch(() => { /* Superseded requests may already be aborted. */ });
  };
  await page.route(spaceRoute, delaySpace);
  try {
    const spaceLink = sidebar.getByRole("link", { name: "空间资料", exact: true });
    await spaceLink.click();
    await spaceLink.and(page.locator(".active[aria-busy=true]")).waitFor();
    await ecommerceLink.click();
    await page.waitForURL(url => url.pathname === "/ecommerce");
  } finally {
    releaseSpace();
    await page.unroute(spaceRoute, delaySpace);
  }
  await page.waitForLoadState("networkidle");
  assert.equal(new URL(page.url()).pathname, "/ecommerce");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "电商中心");
  assert.equal(await sidebar.locator(".nav-item.active").innerText(), "电商中心");
  assert.deepEqual(documentNavigations, []);
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
  for (const [label, pathname] of [["空间资料", "/space"], ["电商中心", "/ecommerce"], ["电商中心", "/ecommerce"], ["创作中心", "/studio"], ["电商中心", "/ecommerce"]]) {
    await sidebar.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL(url => url.pathname === pathname);
    // Cover the serial organization/project/settings refresh, not just the route commit.
    await page.waitForTimeout(3500);
    await page.waitForLoadState("networkidle");
    assert.equal(await ecommerceLink.getAttribute("href"), originalHref);
    assert.deepEqual(documentNavigations, [], "包括重复点击电商中心在内，导航不能触发整页刷新");
    assert.equal(await sidebar.getByRole("link", { name: label, exact: true }).getAttribute("aria-current"), "page");
    if (pathname === "/ecommerce") {
      assert.equal(await ecommerceLink.getAttribute("aria-current"), "page");
      assert.equal(new URL(page.url()).search, new URL(originalHref, page.url()).search);
      await page.getByRole("navigation", { name: "电商素材工作区", exact: true }).waitFor();
    } else if (pathname === "/space") {
      const tabs = page.getByRole("navigation", { name: "空间资料视图" });
      for (const [tab, name] of [["knowledge", "品牌知识"], ["strategy", "内容策略"], ["overview", "空间概览"]]) {
        await tabs.getByRole("link", { name, exact: true }).click();
        await page.waitForURL(url => url.pathname === "/space" && url.searchParams.get("tab") === tab);
        const current = new URL(page.url());
        const expectedScope = new URL(originalHref, current);
        assert.equal(current.searchParams.get("organizationId"), expectedScope.searchParams.get("organizationId"));
        assert.equal(current.searchParams.get("projectId"), expectedScope.searchParams.get("projectId"));
        assert.equal(await tabs.getByRole("link", { name, exact: true }).getAttribute("aria-current"), "page");
        assert.deepEqual(documentNavigations, [], "空间资料页签切换不能触发整页刷新");
      }
    }
  }
  assert.deepEqual(await page.evaluate(() => { window.__ecommerceNavObserver.disconnect(); return window.__ecommerceNavGaps; }), [], "慢接口下跨模块切换期间入口不能消失");
  await page.unroute("**/api/**", delayedApi);

  // Mock only this browser's response; do not change actual permissions or business data.
  await page.route("**/api/ecommerce/settings?**", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "合成权限撤销" }) }));
  await sidebar.getByRole("link", { name: "空间资料", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/space");
  await ecommerceLink.waitFor({ state: "hidden" });
  await page.unroute("**/api/ecommerce/settings?**");
  await sidebar.getByRole("link", { name: "创作中心", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/studio");
  await ecommerceLink.waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: slow navigation, entering and re-clicking ecommerce preserve the document, entry and scope; permission revalidation hides and restores it.");
} finally { await page?.unrouteAll({ behavior: "wait" }); await browser.close(); }
