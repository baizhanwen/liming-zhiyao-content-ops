import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyDeliveryDocumentation, customerDocuments } from "./delivery-documentation.mjs";

// Explicit isolated customer package only. No application login, state, secrets
// or model calls. File navigation is exercised with network offline in Edge.
const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(process.argv[2], "Provide the isolated verified customer directory");
const packageRoot = path.resolve(process.argv[2]);
const runDir = path.join(root, ".local/doc", randomBytes(4).toString("hex"));
mkdirSync(runDir, { recursive: true });
const checks = [], errors = [], remoteRequests = [];
const waitForHeading = (page, id) => page.waitForFunction(id => {
  const rect = document.getElementById(id)?.getBoundingClientRect();
  return rect && rect.top >= 0 && rect.top < 150 && rect.bottom > 0;
}, id);
let browser;
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const report = { packageRoot, startedAt: new Date().toISOString(), checks, errors, remoteRequests,
  boundary: "Actual customer HTML opened locally in offline browser; excludes application UI and real business, with no model calls." };
try {
  await check("reviewed-documents-and-local-links", async () => { report.links = verifyDeliveryDocumentation(packageRoot, root); });
  const { chromium } = await import(pathToFileURL(process.env.DOCUMENT_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs")).href);
  browser = await chromium.launch({ headless: true, executablePath: process.env.DOCUMENT_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
  context.on("request", request => { if (/^https?:/i.test(request.url())) remoteRequests.push(request.url()); });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const manual = pathToFileURL(path.join(packageRoot, customerDocuments[0])).href;
  await check("desktop-offline-layout-and-navigation", async () => {
    await page.goto(manual); await page.getByRole("heading", { name: "2. 打开系统与登录", exact: true }).waitFor();
    assert.equal(await page.locator("h2").count(), 16);
    await page.locator("aside > nav").getByRole("link", { name: "2. 打开系统与登录", exact: true }).click();
    assert.equal(decodeURIComponent(new URL(page.url()).hash), "#打开系统与登录");
    await waitForHeading(page, "打开系统与登录");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(runDir, "desktop-install.png") });
    await page.locator("aside > nav").getByRole("link", { name: "14. 管理员操作与数据备份", exact: true }).click();
    await waitForHeading(page, "管理员操作与数据备份");
    assert.equal(await page.locator('a[href="operations/备份恢复与升级操作.md"]').count(), 1);
    await page.screenshot({ path: path.join(runDir, "desktop-backup.png") });
  });
  await check("offline-text-opening-matches-package", async () => {
    await page.getByRole("link", { name: "打开文字版", exact: true }).click();
    await page.waitForURL(pathToFileURL(path.join(packageRoot, customerDocuments[1])).href);
    const expected = readFileSync(path.join(packageRoot, customerDocuments[1]), "utf8").replaceAll("\r\n", "\n").trim();
    assert.equal((await page.locator("body").innerText()).replaceAll("\r\n", "\n").trim(), expected);
  });
  await check("mobile-offline-menu-and-layout", async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(manual);
    await page.locator("details.mobile-toc summary").click();
    await page.locator("details.mobile-toc").getByRole("link", { name: "14. 管理员操作与数据备份", exact: true }).click();
    assert.equal(decodeURIComponent(new URL(page.url()).hash), "#管理员操作与数据备份");
    await waitForHeading(page, "管理员操作与数据备份");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(runDir, "mobile-backup.png") });
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("aside").isVisible(), false);
  });
  await check("offline-recovery-guide-opens-with-complete-commands", async () => {
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("link", { name: "备份恢复与升级操作", exact: true }).click();
    await page.waitForURL(pathToFileURL(path.join(packageRoot, customerDocuments[2])).href);
    const expected = readFileSync(path.join(packageRoot, customerDocuments[2]), "utf8").replaceAll("\r\n", "\n").trim();
    assert.equal((await page.locator("body").innerText()).replaceAll("\r\n", "\n").trim(), expected);
    assert.ok(expected.includes(".dev.vars") && expected.includes("RESTORE") && expected.includes("仅源码"));
  });
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  report.hashes = Object.fromEntries(customerDocuments.map(document => [document, createHash("sha256").update(readFileSync(path.join(packageRoot, document))).digest("hex")]));
  writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, evidence: path.join(runDir, "report.json") }));
}
