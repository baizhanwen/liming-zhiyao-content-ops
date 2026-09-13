import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTHORIZED_METHODOLOGY_FILTERS,
  buildAuthorizedMethodologyCatalog,
} from "../lib/authorized-methodology-catalog.ts";
import {
  AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
  AUTHORIZED_METHODOLOGY_ENTRIES,
} from "../lib/authorized-methodology-router.ts";

test("methodology catalog exposes curated methods and deterministic plan previews", () => {
  const first = buildAuthorizedMethodologyCatalog();
  const second = buildAuthorizedMethodologyCatalog();

  assert.equal(first.catalog.name, "利明智耀授权方法论");
  assert.equal(first.catalog.version, AUTHORIZED_METHODOLOGY_CATALOG_VERSION);
  assert.equal(first.catalog.readOnly, true);
  assert.equal(first.catalog.entryCount, AUTHORIZED_METHODOLOGY_ENTRIES.length);
  assert.equal(first.resultCount, AUTHORIZED_METHODOLOGY_ENTRIES.length);
  assert.equal(first.catalog.frameworks.contentStrategyFamilies.length, 10);
  assert.equal(first.catalog.frameworks.contentHookTypes.length, 18);
  assert.equal(first.catalog.frameworks.analysisRubricDimensions.length, 9);
  assert.deepEqual(first.catalog.frameworks.contentStrategyFamilies[0], {
    id: "explicit-pain",
    name: "显性痛点攻坚",
    use: "从受众已明确感知的问题切入，再给出有依据的解决路径。",
  });
  assert.deepEqual(first.groups.map((group) => group.task), ["topic", "content", "analysis"]);
  assert.deepEqual(first.plans, second.plans);
  assert.equal(first.plans.length, 3);
  assert.ok(first.plans.every((plan) => plan.selectedIds.length >= 5));
  assert.ok(first.entries.every((entry) => !Object.hasOwn(entry, "original") && !Object.hasOwn(entry, "knowledge")));
});

test("methodology catalog filters methods without leaking unrelated task entries", () => {
  const result = buildAuthorizedMethodologyCatalog({
    task: "content",
    kind: "rule",
    q: "事实",
    mode: "benchmark-structure",
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].task, "content");
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].mode, "benchmark-structure");
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.every((entry) => entry.task === "content" && entry.kind === "rule"));
  assert.ok(result.entries.every((entry) => JSON.stringify(entry).includes("事实")));
});

test("methodology API keeps project access boundary and validates supported filters", async () => {
  const route = await readFile(new URL("../app/api/authorized-methodology/route.ts", import.meta.url), "utf8");

  assert.match(route, /readRequestIdentity\(request\)/);
  assert.match(route, /getProjectAccess\(identity\.authSubject, organizationId, projectId\)/);
  assert.match(route, /PROJECT_SCOPE_REQUIRED/);
  assert.match(route, /PROJECT_ACCESS_REQUIRED/);
  assert.match(route, /INVALID_METHODOLOGY_FILTER/);
  assert.match(route, /buildAuthorizedMethodologyCatalog\(query\)/);
  assert.match(route, /private, no-store/);
  assert.deepEqual(AUTHORIZED_METHODOLOGY_FILTERS.tasks, ["topic", "content", "analysis"]);
});
