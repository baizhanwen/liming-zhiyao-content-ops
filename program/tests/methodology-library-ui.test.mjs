import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("knowledge workspace hides the authorized methodology UI without removing its internal implementation", async () => {
  const workspace = await readFile(new URL("../components/KnowledgeWorkspace.tsx", import.meta.url), "utf8");

  assert.match(workspace, /const AUTHORIZED_METHOD_LIBRARY_VISIBLE = false/);
  assert.match(workspace, /AUTHORIZED_METHOD_LIBRARY_VISIBLE && <button[^>]*>[\s\S]*?授权方法论<\/button>/);
  assert.match(workspace, /AUTHORIZED_METHOD_LIBRARY_VISIBLE && tab === "method"/);
  assert.match(workspace, /AUTHORIZED_METHOD_LIBRARY_VISIBLE \? scopedFetch\(`\/api\/authorized-knowledge/);
  assert.match(workspace, /AUTHORIZED_METHOD_LIBRARY_VISIBLE \? scopedFetch\(`\/api\/authorized-methodology/);
  assert.match(workspace, /\/api\/authorized-methodology\?/);
  assert.match(workspace, /metadataOnly=1/);
  assert.match(workspace, /授权方法论/);
  assert.match(workspace, /系统按任务选择方法，不把整库塞给模型/);
  assert.match(workspace, /选题规划/);
  assert.match(workspace, /内容生成/);
  assert.match(workspace, /视频诊断/);
  assert.match(workspace, /查看证据要求与来源/);
  assert.match(workspace, /来源追溯与底层授权方法库/);
  assert.match(workspace, /className="panel methodology-source-vault"/);
  assert.match(workspace, /查看授权原文与来源/);
  assert.match(workspace, /导出方法库/);
  assert.match(workspace, /导入方法库/);
});

test("methodology view has responsive, task-oriented presentation styles", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.methodology-flow-map/);
  assert.match(css, /\.methodology-track/);
  assert.match(css, /\.methodology-card\.kind-core_playbook/);
  assert.match(css, /\.methodology-framework-grid/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.methodology-card-grid/);
});
