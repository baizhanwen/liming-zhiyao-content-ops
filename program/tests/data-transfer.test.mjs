import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("authorized method library is Liming branded and transferable by administrators", async () => {
  const [atoms, methodology, sync, provider, route, transfer, workspace] = await Promise.all([
    read("resources/authorized/dbskill/atoms.jsonl"), read("lib/authorized-content-methodology.ts"),
    read("scripts/sync-authorized-knowledge.mjs"), read("services/analyzer/liming_analyzer/providers.py"),
    read("app/api/authorized-knowledge/route.ts"),
    read("app/api/authorized-knowledge/transfer/route.ts"), read("components/KnowledgeWorkspace.tsx"),
  ]);
  for (const content of [atoms, methodology, sync, provider]) assert.doesNotMatch(content, /dontbesilent/i);
  assert.match(methodology, /利明智耀授权方法库/);
  assert.match(sync, /does not include a built-in method library/);
  assert.match(route, /canTransfer/);
  assert.match(transfer, /liming-authorized-method-library/);
  assert.match(transfer, /AUTHORIZED_KNOWLEDGE_SOURCE_ID/);
  assert.match(transfer, /normalizeAuthorizedKnowledgeSkillTags/);
  assert.match(transfer, /organizationRole !== "admin"/);
  assert.match(transfer, /authorized_knowledge_atoms/);
  assert.doesNotMatch(route, /source_id\s*=\s*'dbskill'/);
  assert.match(route, /AUTHORIZED_KNOWLEDGE_SOURCE_ID/);
  assert.match(workspace, /导出方法库/);
  assert.match(workspace, /导入方法库/);
});

test("material center exports and imports portable archives with media integrity checks", async () => {
  const [route, workspace, pkg] = await Promise.all([
    read("app/api/video-library/transfer/route.ts"), read("components/VideoLibraryWorkspace.tsx"), read("package.json"),
  ]);
  assert.match(route, /liming-video-library-package/);
  assert.match(route, /video_transcripts/);
  assert.match(route, /video_analyses/);
  assert.match(route, /video_metric_snapshots/);
  assert.match(route, /sha256Hex/);
  assert.match(route, /getMediaBucket/);
  assert.match(route, /video_library\.imported/);
  assert.match(workspace, /zipSync/);
  assert.match(workspace, /readMaterialArchive/);
  assert.match(workspace, /导入迁移包/);
  assert.match(workspace, /导出所选/);
  assert.equal(JSON.parse(pkg).dependencies.fflate, "^0.7.4");
});

test("full delivery always bundles the transferable method library and retains old identifiers", async () => {
  const [launcher, delivery] = await Promise.all([read("prepare-delivery.bat"), read("scripts/prepare-delivery.ps1")]);
  assert.doesNotMatch(launcher, /Authorized method library \[Y\/N|METHOD_LIBRARY_MODE/);
  assert.match(delivery, /\$includeAuthorizedKnowledge = \$true/);
  assert.doesNotMatch(delivery, /Remove-PackagePath "resources\\authorized"|AUTHORIZED_METHODOLOGY_ENABLED = false/);
  assert.doesNotMatch(delivery, /LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS = \[\]|const LEGACY_SOURCE_IDS = \[\]/);
  assert.match(delivery, /resources\\authorized\\liming-zhiyao/);
  assert.match(delivery, /"liming-method-/);
  assert.match(delivery, /importSupported = \$true/);
});
