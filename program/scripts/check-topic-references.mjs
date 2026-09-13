import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// Isolated UI fixture: API responses are mocked, no customer data or paid model calls.
const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = path.join(root, ".local/topic-reference-check");
await mkdir(fixtureRoot, { recursive: true });
await writeFile(path.join(fixtureRoot, "index.html"), '<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixtureRoot, "entry.tsx"), 'import React from "react"; import {createRoot} from "react-dom/client"; import {TopicWorkspace} from "../../components/TopicWorkspace"; import "../../app/globals.css"; createRoot(document.getElementById("root")!).render(<main style={{padding:20}}><TopicWorkspace initialOrganizationId="org" initialProjectId="project" /></main>);');
if (!process.env.LAN_TEST_PLAYWRIGHT_MODULE) throw new Error("Set LAN_TEST_PLAYWRIGHT_MODULE to the installed Playwright entry point.");
const { chromium } = await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE).href);
const server = await createServer({ configFile: false, root: fixtureRoot, plugins: [react()], server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.LAN_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], calls = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === "/api/organizations") body = { organizations: [{ id: "org", name: "演示公司" }] };
    else if (url.pathname === "/api/projects") body = { projects: [{ id: "project", name: "当前空间" }, { id: "second", name: "另一个空间" }] };
    else if (url.pathname === "/api/knowledge") body = { items: [{ id: "case", title: "案例｜两次 AI 代码测试与验收能力", category: "case_study", status: "confirmed" }] };
    else if (url.pathname === "/api/topics/references") body = { query: url.searchParams.get("query"), recommendations: [{ id: "case", title: "案例｜两次 AI 代码测试与验收能力", category: "case_study", matchedTerms: ["ai"] }] };
    else if (url.pathname === "/api/topics/generate") {
      const payload = route.request().postDataJSON(); calls.push(payload);
      const generated = Object.fromEntries(payload.targets.map(field => [field, field === "priority" ? 72 : "建议开展一次新的比较实验"]));
      body = { generated, sourcesUsed: [{ sourceType: "topic", sourceId: "draft", title: payload.draft.title, text: JSON.stringify(payload.draft), characterCount: JSON.stringify(payload.draft).length }, { sourceType: "method_knowledge", sourceId: "method", title: "本次确定性选题方法计划", text: "围绕标题策划，区分实验计划与真实经历。", characterCount: 21 }, ...payload.sourceKnowledgeItemIds.map(id => ({ sourceType: "knowledge", sourceId: id, title: "案例｜两次 AI 代码测试与验收能力", text: "主动选择的实验记录", characterCount: 9 }))] };
    } else if (url.pathname === "/api/topics") body = { topics: [], citations: [], canWrite: true, canDelete: true, accountBackground: { id: "strategy", name: "账号定位", positioning: "记录学习与实践", targetAudience: "计算机专业学生", styleNotes: "自然交流，短句表达" } };
    else throw new Error(`Unexpected API: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(origin);
  await page.getByLabel("选题标题", { exact: true }).fill("AI 发展有多快");
  assert.equal(await page.getByRole("checkbox", { name: "使用账号背景" }).isChecked(), false);
  await page.getByRole("button", { name: "一键补全空白内容", exact: true }).click();
  await page.getByText("已补全 7 项空白内容", { exact: false }).waitFor();
  assert.deepEqual(calls[0].sourceKnowledgeItemIds, []);
  assert.equal(calls[0].includeAccountBackground, false);
  await page.getByRole("button", { name: "按标题推荐参考" }).click();
  await page.getByRole("button", { name: "加入参考", exact: true }).waitFor();
  assert.equal(calls.length, 1);
  assert.equal(await page.locator('input[name="sourceKnowledgeItemIds"]').isChecked(), false);
  await page.getByRole("button", { name: "加入参考", exact: true }).click();
  assert.equal(await page.locator('input[name="sourceKnowledgeItemIds"]').isChecked(), true);
  await page.getByText("上次生成实际使用的来源（2 项）", { exact: true }).click();
  await page.locator('[name="hook"]').fill("用户修改后的开场");
  await page.getByRole("button", { name: "清空未手动修改的补全内容" }).click();
  assert.equal(await page.locator('[name="angle"]').inputValue(), "");
  assert.equal(await page.locator('[name="hook"]').inputValue(), "用户修改后的开场");
  await page.getByRole("button", { name: "一键补全空白内容", exact: true }).click();
  await page.getByText("已补全 6 项空白内容", { exact: false }).waitFor();
  assert.deepEqual(calls[1].sourceKnowledgeItemIds, ["case"]);
  assert.equal(calls[1].draft.hook, "用户修改后的开场");
  await page.getByText("上次生成实际使用的来源（3 项）", { exact: true }).click();
  await page.locator(".topic-create").screenshot({ path: path.join(fixtureRoot, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator(".topic-create").screenshot({ path: path.join(fixtureRoot, "mobile.png") });
  await page.getByRole("checkbox", { name: "使用账号背景" }).check();
  await page.getByRole("combobox", { name: "企业空间", exact: true }).selectOption("second");
  await page.waitForFunction(() => document.querySelector('[name="title"]')?.value === "");
  assert.equal(await page.locator('input[name="sourceKnowledgeItemIds"]').isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "使用账号背景" }).isChecked(), false);
  assert.equal(await page.locator(".topic-actual-sources").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, modelCallsMocked: calls.length, checks: ["zero selection", "recommendation opt-in", "source preview", "preserve manual edits", "project reset", "mobile overflow"], screenshots: fixtureRoot }));
} finally {
  await browser?.close();
  await server.close();
}
