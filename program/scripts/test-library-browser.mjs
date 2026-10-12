import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { zipSync, strToU8 } from "fflate";

// Real browser/component, synthetic intercepted API only. No business state.
const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = path.join(root, ".local/library-browser", Date.now().toString());
await mkdir(fixtureRoot, { recursive: true });
await writeFile(path.join(fixtureRoot, "index.html"), '<html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixtureRoot, "entry.tsx"), 'import React from "react";import {createRoot} from "react-dom/client";import {VideoLibraryWorkspace} from "../../../components/VideoLibraryWorkspace";import "../../../app/globals.css";createRoot(document.getElementById("root")!).render(<VideoLibraryWorkspace mode="assets"/>);');
await writeFile(path.join(fixtureRoot, "link.tsx"), 'import React from "react";export default function Link(props){return <a {...props}/>;}');
const { chromium } = await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE || path.join(root, ".local/ecommerce-browser/node_modules/playwright/index.mjs")).href);
const server = await createServer({ configFile: false, root: fixtureRoot, plugins: [react()], resolve: { alias: { "next/link": path.join(fixtureRoot, "link.tsx") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } } });
let browser, releaseSave;
const checks = [], requests = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
  let canManage = true, conflict = true, transfers = 0;
  let entry = { id: "entry", video_id: "video", category: "other", tags: ["existing"], notes: null, updated_at: "2026-10-12T01:00:00.000Z", title: "合成素材", platform: "douyin", source_type: "url", status: "ready", source_project_name: "合成项目", reference_count: 0 };
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), method = route.request().method(); let body, status = 200;
    if (url.pathname === "/api/organizations") body = { organizations: [{ id: "org", name: "合成公司" }] };
    else if (url.pathname === "/api/projects") body = { projects: [{ id: "project", name: "合成项目" }] };
    else if (url.pathname === "/api/video-library" && method === "GET") body = { entries: [entry], canManage };
    else if (url.pathname === "/api/video-library" && method === "PATCH") {
      const input = route.request().postDataJSON(); requests.push(input);
      if (conflict) { await new Promise(resolve => { releaseSave = resolve; }); status = 409; body = { error: { code: "LIBRARY_VERSION_CONFLICT", message: "其他成员已修改这条素材，本次未覆盖。请先复制当前标签，再刷新核对后保存。" } }; }
      else { assert.equal(input.expectedUpdatedAt, entry.updated_at); entry = { ...entry, tags: input.tags, category: input.category, updated_at: "2026-10-12T01:00:00.002Z" }; body = { entry }; }
    } else if (url.pathname === "/api/video-library/references" && method === "POST") { status = 404; body = { error: { code: "LIBRARY_ENTRY_NOT_FOUND", message: "所选素材已删除，本批未导入。请刷新后重新选择。" } }; }
    else if (url.pathname === "/api/video-library/transfer" && method === "POST") {
      transfers += 1;
      status = transfers === 1 ? 500 : 503;
      body = { error: { code: transfers === 1 ? "INTERNAL_ERROR" : "MATERIAL_IMPORT_STATUS_UNKNOWN", message: transfers === 1 ? "合成第二条保存失败" : "素材保存结果暂时无法核对，文件已保留。请恢复数据服务并刷新核对后再决定重试。" }, progress: { imported: transfers === 1 ? 1 : 0, skipped: 0, failedEntry: transfers === 1 ? 2 : 1, remaining: transfers === 1 ? 1 : 2 } };
    }
    else throw new Error(`Unexpected fixture API: ${method} ${url.pathname}`);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(server.resolvedUrls.local[0]); await page.getByRole("heading", { name: "合成素材" }).waitFor();
  await check("version-submission-and-controls-disabled-during-save", async () => {
    await page.getByRole("textbox", { name: "素材标签" }).fill("保留的输入"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="素材分类"]').disabled);
    assert.equal(requests.length, 1); assert.equal(requests[0].expectedUpdatedAt, entry.updated_at);
    assert.equal(await page.getByRole("textbox", { name: "素材标签" }).isDisabled(), true);
  });
  await check("conflict-keeps-input-and-requires-explicit-refresh", async () => {
    releaseSave(); await page.getByRole("alert").filter({ hasText: "其他成员已修改" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "素材标签" }).inputValue(), "保留的输入"); assert.equal(requests.length, 1);
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isEnabled(), true);
    await page.screenshot({ path: path.join(fixtureRoot, "conflict.png") });
  });
  await check("refresh-and-reapply-use-latest-version", async () => {
    conflict = false; entry = { ...entry, tags: ["同事已保存"], updated_at: "2026-10-12T01:00:00.001Z" };
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="素材标签"]')?.value === "同事已保存");
    await page.getByRole("textbox", { name: "素材标签" }).fill("核对后重新填写"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "素材分类与标签已保存" }).waitFor(); assert.equal(requests[1].expectedUpdatedAt, "2026-10-12T01:00:00.001Z");
  });
  await check("failed-import-retains-selection-and-no-success-notice", async () => {
    await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "导入项目（1）", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "本批未导入" }).waitFor(); assert.equal(await page.getByRole("checkbox").isChecked(), true);
    assert.equal(await page.getByRole("status").count(), 0);
  });
  await check("read-only-library-hides-metadata-controls", async () => {
    canManage = false; await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("textbox", { name: "素材标签" }).waitFor({ state: "hidden" }); assert.equal(requests.length, 2); assert.deepEqual(errors, []);
  });
  const importZip = zipSync({ "manifest.json": strToU8(JSON.stringify({ format: "liming-video-library-package", version: 1, entries: [{ assets: [] }, { assets: [] }] })) });
  await check("partial-material-import-displays-saved-count-and-no-automatic-retry", async () => {
    canManage = true; await page.getByRole("button", { name: "刷新", exact: true }).click(); await page.getByRole("textbox", { name: "素材标签" }).waitFor();
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-material.zip", mimeType: "application/zip", buffer: Buffer.from(importZip) });
    await page.getByRole("alert").filter({ hasText: "合成第二条保存失败" }).waitFor();
    await page.getByRole("status").filter({ hasText: "本次已导入 1 条" }).waitFor(); assert.equal(transfers, 1);
    assert.match(await page.getByRole("status").innerText(), /从第 2 条起还有 1 条/);
  });
  await check("unknown-material-result-explains-preserved-files-and-reconciliation", async () => {
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-material.zip", mimeType: "application/zip", buffer: Buffer.from(importZip) });
    await page.getByRole("alert").filter({ hasText: "文件已保留" }).waitFor();
    assert.match(await page.getByRole("status").innerText(), /本次已导入 0 条/); assert.equal(transfers, 2); assert.deepEqual(errors, []);
  });
} catch (error) { process.exitCode = 1; console.error(error.stack); }
finally {
  releaseSave?.(); if (browser) await browser.close(); await server.close();
  await writeFile(path.join(fixtureRoot, "report.json"), JSON.stringify({ passed: !process.exitCode, checks, submittedVersions: requests.map(r => r.expectedUpdatedAt), synthetic: true, boundary: "Actual Edge and component; intercepted APIs, no real database, accounts or model calls" }, null, 2));
  console.log(`Evidence: ${fixtureRoot}`);
}
