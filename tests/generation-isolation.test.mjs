import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all current generation routes pass through the project context firewall", async () => {
  const [topic, content, context] = await Promise.all([
    readFile(new URL("../app/api/topics/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/project-generation-context.ts", import.meta.url), "utf8"),
  ]);
  for (const route of [topic, content]) {
    assert.match(route, /buildProjectGenerationContext/);
    assert.match(route, /assertProjectGenerationContext/);
    assert.match(route, /insertGenerationSourceManifest/);
    assert.match(route, /finishGenerationSourceManifest/);
    assert.doesNotMatch(route, /authorizedKnowledge|retrieveAuthorizedKnowledge|\.original/);
  }
  assert.match(context, /GENERATION_P0_FREEZE/);
  assert.match(context, /PROJECT_CONTEXT_INCOMPLETE/);
  assert.match(context, /organizationId/);
  assert.match(context, /projectId/);
  assert.match(context, /contentHash/);
  assert.match(context, /untrustedReferencePrompt/);
});

test("generation audit migration stores manifests without customer prompt bodies", async () => {
  const [migration, health] = await Promise.all([
    readFile(new URL("../drizzle/0019_generation_source_manifests.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /generation_source_manifests/);
  assert.match(migration, /source_manifest_json/);
  assert.match(migration, /prompt_hash/);
  assert.doesNotMatch(migration, /input_json|prompt_text|customer_content/);
  assert.match(health, /buildInfo/);
});
