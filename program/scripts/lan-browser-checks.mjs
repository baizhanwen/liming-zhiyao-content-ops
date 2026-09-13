import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

export async function runBrowserChecks({ origin, users, password, runDir, nextUrl, requests }) {
  const { chromium } = await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LAN_TEST_BROWSER || undefined });
  const contexts = [], errors = [], failedRequests = [];
  try {
    const pages = await Promise.all(users.slice(0, 10).map(async (user, index) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", error => errors.push({ index, message: error.message }));
      page.on("requestfailed", request => failedRequests.push({ index, url: new URL(request.url()).pathname, message: request.failure()?.errorText }));
      page.on("response", response => { if (response.url().startsWith(origin) && new URL(response.url()).pathname.startsWith("/api/")) requests.push({ scenario: "10 个独立浏览器会话", method: response.request().method(), route: new URL(response.url()).pathname, status: response.status(), ms: Math.max(0, Math.round(response.request().timing().responseStart)) }); });
      await page.goto(new URL("/login?returnTo=/analysis", origin).href);
      await page.locator('input[name="email"]').fill(user.email);
      await page.locator('input[name="password"]').fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/analysis", { timeout: 20000 });
      const textarea = page.locator('textarea[name="url"]'); await textarea.waitFor();
      const title = `浏览器并发测试-${index}`;
      await textarea.fill(nextUrl()); await page.locator('input[name="title"]').fill(title);
      return { page, user, index, title };
    }));
    // Real browser connection reuse: rejection followed by another POST.
    await Promise.all(pages.map(async ({ page }) => {
      const rejected = await page.evaluate(async () => (await fetch("/api/internal/analysis-jobs/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: "unauthorized-browser" }) })).status);
      assert.equal(rejected, 401);
    }));
    await Promise.all(pages.map(async ({ page, title }) => {
      const response = page.waitForResponse(r => r.url().endsWith("/api/videos/from-url") && r.request().method() === "POST");
      await page.locator('form:has(textarea[name="url"]) button').click();
      assert.equal((await response).status(), 202);
      await page.locator(".analysis-row").filter({ hasText: title }).waitFor();
    }));
    await pages[0].page.screenshot({ path: path.join(runDir, "browser-analysis.png"), fullPage: true });
    await Promise.all(pages.map(async ({ page, title }) => {
      await page.reload();
      const row = page.locator(".analysis-row").filter({ hasText: title }); await row.waitFor();
      await row.getByRole("button", { name: "取消", exact: true }).click();
      await row.getByRole("button", { name: "重试", exact: true }).waitFor();
    }));

    // Exercise the shared initialization hook with two accessible projects.
    // These reads use only synthetic data; no model or real business state is involved.
    const workspaceChecks = [
      ["/knowledge", "/api/knowledge"], ["/topics", "/api/topics"],
      ["/content", "/api/content-items"], ["/workflow", "/api/workflow"],
      ["/memory", "/api/project-memory"], ["/inspiration", "/api/inspiration-cards"],
      ["/insights", "/api/analytics"],
    ];
    const workspacePage = pages[0].page;
    for (const [route, endpoint] of workspaceChecks) {
      const initial = workspacePage.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === "GET");
      await workspacePage.goto(new URL(`${route}?organizationId=org-team&projectId=project-a`, origin).href);
      assert.equal((await initial).status(), 200, `${route} initializes`);
      const projectSelect = workspacePage.locator("select").filter({ has: workspacePage.locator('option[value="project-b"]') }).first();
      await projectSelect.waitFor();
      for (const projectId of ["project-b", "project-a"]) {
        const changed = workspacePage.waitForResponse(r => new URL(r.url()).pathname === endpoint && new URL(r.url()).searchParams.get("projectId") === projectId && r.request().method() === "GET");
        await projectSelect.selectOption(projectId);
        assert.equal((await changed).status(), 200, `${route} switches to ${projectId}`);
      }
    }
    assert.deepEqual(errors, [], "浏览器未处理异常");
    assert.deepEqual(failedRequests.filter(r => !r.message?.includes("ERR_ABORTED")), [], "浏览器网络请求失败");

    // A recoverable login network error must restore the form, not leave it busy.
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage();
    const loginErrors = []; page.on("pageerror", error => loginErrors.push(error.message));
    await page.goto(new URL("/login", origin).href);
    await page.locator('input[name="email"]').fill(users[0].email);
    await page.locator('input[name="password"]').fill(password);
    await page.route("**/api/auth/session", route => route.request().method() === "POST" ? route.abort("connectionreset") : route.continue());
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("alert").waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("button", { name: "登录", exact: true }).isEnabled(), true);
    assert.deepEqual(loginErrors, [], "登录断网后应显示错误并允许重试");
    await page.screenshot({ path: path.join(runDir, "browser-login-recovery.png") });
    await page.unroute("**/api/auth/session");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(origin, { timeout: 20000 });
    return { contexts: 11, workspaceInitializationChecks: workspaceChecks.length, projectSwitchChecks: workspaceChecks.length * 2, unhandledErrors: errors.length + loginErrors.length, artifacts: ["browser-analysis.png", "browser-login-recovery.png"] };
  } catch (error) {
    writeFileSync(path.join(runDir, "browser-errors.json"), JSON.stringify({ errors, failedRequests, failure: error.message }, null, 2));
    const page = contexts.at(-1)?.pages()[0];
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(runDir, "browser-failure.png") }).catch(() => {});
      writeFileSync(path.join(runDir, "browser-failure.html"), await page.content().catch(() => ""));
    }
    throw error;
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close();
  }
}
