import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { expectedDeliveryScripts, verifyDeliveryScripts } from "../scripts/delivery-script-policy.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

test("all customer plans retain complete install, startup and maintenance entry points", () => {
  for (const videoAnalysis of [false, true]) {
    const names = expectedDeliveryScripts({ videoAnalysis });
    for (const name of ["install-node22.ps1", "prepare-local-web.ps1", "prepare-login-startup.mjs", "run-local-migrations.mjs", "run-migration-guard.ps1", "sql-statements.mjs", "run-startup-guard.ps1", "run-web-guard.ps1", "local-web-identity.ps1", "analyzer-instance-lock.ps1", "local-state-maintenance.ps1", "verify-state-databases.mjs", "backup-local.ps1", "restore-local.ps1", "recover-performance-imports.ps1", "recover-performance-imports.mjs", "start-lan.ps1", "stop-local.ps1", "sync-authorized-knowledge.mjs"])
      assert.ok(names.includes("scripts/" + name), "Missing operational entry: " + name);
    for (const filename of names) assert.ok(existsSync(path.join(root, filename)), filename);
  }
});

test("video plans retain media installers, supervisor, diagnostics and recovery dependencies", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const filename of ["analyzer-source-runtime.ps1", "analyzer-media-runtime.ps1", "run-analyzer-supervisor.ps1", "start-analyzer-background.ps1", "install-python311.ps1", "install-ffmpeg.ps1", "install-vcredist.ps1", "check-analyzer.ps1", "repair-analyzer-models.ps1", "refresh-douyin-cookies.ps1", "repair-media-buckets.mjs"]) assert.ok(names.includes("scripts/" + filename), filename);
  assert.equal(verifyDeliveryScripts(names, { videoAnalysis: true }).approvedScripts, names.length);
});

test("starter plan rejects video-specific maintenance tools", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: false });
  assert.throws(() => verifyDeliveryScripts([...names, "scripts/repair-media-buckets.mjs"], { videoAnalysis: false }), /runtime inventory/);
});

test("missing startup or backup dependency makes package verification fail", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const dependency of ["scripts/verify-state-databases.mjs", "scripts/local-state-maintenance.ps1", "scripts/analyzer-source-runtime.ps1", "scripts/sql-statements.mjs", "scripts/recover-performance-imports.mjs"])
    assert.throws(() => verifyDeliveryScripts(names.filter(name => name !== dependency), { videoAnalysis: true }), /runtime inventory/);
});

test("unapproved future files and nested developer tools fail package verification", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const filename of ["scripts/new-diagnostic.mjs", "scripts/test-new-feature.mjs", "scripts/dev/future.mjs", "scripts/README.md", "scripts/delivery-script-policy.mjs", "Scripts/backup-local.ps1"])
    assert.throws(() => verifyDeliveryScripts([...names, filename], { videoAnalysis: true }), /runtime inventory/);
});

test("existing browser and synthetic acceptance helpers are excluded regardless of naming", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const filename of readdirSync(path.join(root, "scripts")).filter(name => name.startsWith("test-"))) assert.equal(names.includes("scripts/" + filename), false);
  for (const filename of ["check-topic-references.mjs", "content-lifecycle-checks.mjs", "verify-local-media-assets.py", "lan-worker-check.py", "lan-browser-checks.mjs", "ecommerce-test-model.mjs"]) assert.equal(names.includes("scripts/" + filename), false);
});

test("approved runtime scripts do not import a removed local script", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const filename of names.filter(name => name.endsWith(".mjs"))) {
    const source = readFileSync(path.join(root, filename), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])(\.\/[a-z0-9_-]+\.mjs)\1/g)) assert.ok(names.includes("scripts/" + match[2].slice(2)), `${filename}: ${match[2]}`);
  }
});


test("download packages retain the complete environment settings startup chain", () => {
  const names = expectedDeliveryScripts({ videoAnalysis: true });
  for (const dependency of ["start-web-with-environment.mjs", "prepare-runtime-configuration.mjs", "analyzer-environment-bridge.mjs", "analyzer_local_runtime.py", "prepare_analyzer_models.py", "install-collector.ps1", "analyzer-collector-runtime.ps1"])
    assert.ok(names.includes("scripts/" + dependency), `Missing environment dependency: ${dependency}`);
  for (const dependency of ["scripts/analyzer_local_runtime.py", "scripts/prepare_analyzer_models.py", "scripts/install-collector.ps1"])
    assert.throws(() => verifyDeliveryScripts(names.filter(name => name !== dependency), { videoAnalysis: true }), /runtime inventory/);
  const modelPreparer = readFileSync(path.join(root, "scripts/prepare_analyzer_models.py"), "utf8");
  for (const match of modelPreparer.matchAll(/^from ([a-z0-9_]+) import/gm)) {
    const localFile = "scripts/" + match[1] + ".py";
    if (existsSync(path.join(root, localFile))) assert.ok(names.includes(localFile), localFile);
  }
});
