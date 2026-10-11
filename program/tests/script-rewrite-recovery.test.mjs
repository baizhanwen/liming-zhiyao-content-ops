import test from "node:test";
import assert from "node:assert/strict";
import * as rewrite from "../lib/script-rewrite.ts";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

test("spoken IP ratings compare as complete identifiers without hiding a changed rating", () => {
  assert.deepEqual(rewrite.semanticRewriteFacts("支持IP六八防水防尘。"), rewrite.semanticRewriteFacts("支持IP68防水防尘。"));
  const units = rewrite.buildScriptUnits("这台手机支持IP六八防水防尘，裸机可以在六米深的水中停留三十分钟。");
  const card = rating => [{ factId: "f-001", kind: "fact", statement: `手机支持${rating}防水防尘，裸机能够在6米水深停留30分钟。`, sourceParagraphIds: ["p-0001"], immutableFacts: [] }];
  assert.equal(rewrite.validateRewriteFactCards(units, card("IP68")).passed, true);
  assert.ok(rewrite.validateRewriteFactCards(units, card("IP67")).missingImmutableFacts.includes("ip68"));
  assert.ok(rewrite.immutableRewriteFacts(units[0].text).includes("ip"));
  assert.ok(!rewrite.semanticRewriteFacts("像三 DS 一样的游戏机。").includes("ds1"));
});

test("explicit lowercase immutable identifiers survive extraction without weakening missing-number checks", () => {
  const units = rewrite.buildScriptUnits("Team提出屏幕像素如何透光的问题，需要观察显示层的排列，测试持续30分钟。");
  const fact = { factId: "f-001", kind: "fact", statement: "需要观察屏幕显示层与像素排列，解释光线穿过该区域的方式，测试持续30分钟。", sourceParagraphIds: ["p-0001"], immutableFacts: ["team"] };
  assert.equal(rewrite.validateRewriteFactCards(units, [fact]).passed, true);
  assert.ok(rewrite.validateRewriteFactCards(units, [{ ...fact, immutableFacts: [] }]).missingImmutableFacts.includes("team"));
  const changed = { ...fact, statement: fact.statement.replace("30", "60") };
  assert.ok(rewrite.validateRewriteFactCards(units, [changed]).missingImmutableFacts.includes("30"));
});

test("technical units, percent ranges and scaled camera pixels compare by value", () => {
  const source = "三千尼特、一百二十赫兹，五点四英寸、四百六十PPI，十二 GB，一百一十二克、二百四十九克，五十三瓦，百分之三十到四十，四千八百万像素，从零充到一百。";
  const candidate = "3000尼特、120赫兹，5.4英寸、460PPI，12 GB，112克、249克，53瓦，30%到40%，4800万像素，从0充到100。";
  assert.deepEqual(rewrite.semanticRewriteFacts(candidate), rewrite.semanticRewriteFacts(source));
  assert.ok(rewrite.semanticRewriteFacts(source).includes("48000000"));
  assert.ok(!rewrite.semanticRewriteFacts(candidate).includes("10000"));
  assert.ok(!rewrite.semanticRewriteFacts(candidate.replace("53瓦", "54瓦")).includes("53"));
  assert.ok(rewrite.semanticRewriteFacts(candidate.replace("53瓦", "54瓦")).includes("54"));
});

test("quoted interjections and repeated vocatives do not become business facts while real names remain protected", () => {
  assert.deepEqual(rewrite.semanticRewriteFacts("Team team，怎么做到的？Yeah，继续看。"), []);
  assert.ok(rewrite.semanticRewriteFacts("Team提出设计问题。").includes("team"));
  assert.deepEqual(rewrite.immutableRewriteFacts("You want a Stylus."), ["stylus", "you"]);
});

test("fact repair narrows to missing identifiers and preserves connected multi-source claims", () => {
  const units = rewrite.buildScriptUnits("Team提出屏幕像素如何透光的问题，需要观察显示层的排列。\n\n显微镜可以放大像素，帮助解释显示层的结构。\n\n接下来介绍手机握持的手感与折叠阻尼。");
  const facts = [
    { factId: "f-001", kind: "fact", statement: "关于屏幕像素透光的提问，通过显微镜观察排列来解释。", sourceParagraphIds: ["p-0001", "p-0002"], immutableFacts: [] },
    { factId: "f-002", kind: "fact", statement: "手机的握持体验和折叠阻尼也需要介绍。", sourceParagraphIds: ["p-0003"], immutableFacts: [] },
  ];
  const scope = rewrite.buildRewriteFactRepairScope(units, facts);
  assert.deepEqual(scope.units.map(unit => unit.paragraphId), ["p-0001", "p-0002"]);
  assert.deepEqual(scope.retainedFacts, [facts[1]]);
  assert.deepEqual(scope.targetFacts, [facts[0]]);
});

test("copied-sentence patches preserve exact untouched bytes and handle protected identifiers", () => {
  const source = "今年这款手机通过了IP68防水测试，可以放到六米深的水里停留三十分钟，整个过程都没有发生损坏。";
  const units = [{ paragraphId: "p-0001", text: source }];
  const prefix = "  我们接着来看实测结果。";
  const suffix = "另外，握持感受也能放在一起观察。  ";
  const rows = [{ paragraphId: "p-0001", text: prefix + source + suffix }];
  const windows = rewrite.buildRewriteCopyRepairWindows(units, rows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].text, source);
  const replacement = "在这次防水实测中，手机达到IP68标准，在六米水深持续放置三十分钟，期间没有受到损坏。";
  const patched = rewrite.applyRewriteCopyRepairs(rows, windows, [{ paragraphId: windows[0].targetId, text: replacement }]);
  assert.equal(patched[0].text, prefix + replacement + suffix);
  assert.deepEqual(rewrite.applyRewriteCopyRepairs(rows, windows, [{ paragraphId: "foreign", text: replacement }]), rows);
  assert.deepEqual(rewrite.applyRewriteCopyRepairs(rows, windows, []), rows);
});

test("a repair accepts improvements per paragraph and cannot regress an already valid paragraph", () => {
  const units = rewrite.buildScriptUnits("因为企业在2027年要让AI增长7.1%，所以必须先记录真实数据。\n\n然后团队每天复盘结果，最后再决定下一步怎么调整。");
  const good = { paragraphId: "p-0001", text: "由于企业在2027年要让AI增长7.1%，因此务必先记录真实数据。" };
  const rows = [good, { paragraphId: "p-0002", text: units[1].text }];
  const next = rewrite.mergeImprovedRewriteParagraphRows(units, rows, [
    { paragraphId: "p-0001", text: "数据很好。" },
    { paragraphId: "p-0002", text: "接着团队每天复盘结果，最终再决定下一步如何调整。" },
  ]);
  assert.deepEqual(next[0], good);
  assert.equal(rewrite.validateLightRewrite(units, next).passed, true);
});

test("oversized internal pieces never bisect a technical identifier and retain the complete source", () => {
  const source = "文".repeat(795) + "iPhone18Pro2027" + "内容".repeat(800);
  const plan = rewrite.buildMicroRewritePlan([{ paragraphId: "p-0001", text: source }]);
  assert.ok(plan.workingUnits.length > 1);
  assert.equal(plan.workingUnits.map(unit => unit.text).join(""), source);
  assert.ok(plan.workingUnits.some(unit => unit.text.includes("iPhone18Pro2027")));
  assert.deepEqual(plan.paragraphParts.map(paragraph => paragraph.paragraphId), ["p-0001"]);
  assert.deepEqual(rewrite.mergeMicroRewriteParts(plan, plan.workingUnits.slice(1)), []);
});

test("historical failures collapse only after a later fully accepted run for the same source and variant", () => {
  const failed = (id, variant, source, date) => ({ id, variant, status: "failed", sourceVersionId: source, createdAt: date });
  const runs = [
    failed("resolved", "light_rewrite", "source-a", "2026-10-10T01:00:00Z"),
    failed("review-required", "restructured", "source-a", "2026-10-10T01:00:00Z"),
    failed("other-source", "light_rewrite", "source-b", "2026-10-10T01:00:00Z"),
    failed("new-failure", "light_rewrite", "source-a", "2026-10-10T03:00:00Z"),
    { id: "passed", variant: "light_rewrite", status: "completed", sourceVersionId: "source-a", createdAt: "2026-10-10T02:00:00Z", validation: { passed: true } },
    { id: "review", variant: "restructured", status: "completed", sourceVersionId: "source-a", createdAt: "2026-10-10T02:00:00Z", validation: { passed: false } },
  ];
  const result = rewrite.partitionScriptRewriteFailures(runs);
  assert.deepEqual(result.historical.map(run => run.id), ["resolved"]);
  assert.deepEqual(result.unresolved.map(run => run.id), ["review-required", "other-source", "new-failure"]);
});

test("spoken numbered pairs and approximations retain both bounds without inventing 342", () => {
  for (const source of ["三四两个池塘，东区有三四食堂。", "三、四两个池塘，东区有三、四食堂。"]) {
    assert.deepEqual(rewrite.semanticRewriteFacts(source), rewrite.semanticRewriteFacts("3、4两个池塘，东区有3、4食堂。"));
    assert.ok(!rewrite.semanticRewriteFacts(source).includes("342"));
  }
  assert.deepEqual(rewrite.semanticRewriteFacts("四五百人左右。"), rewrite.semanticRewriteFacts("400到500人左右。"));
  assert.ok(rewrite.semanticRewriteFacts("四百五十人。").includes("450"));
  const corrected = "每年招收五五六百人。对，四五百人哦，四五百人。";
  assert.deepEqual(rewrite.semanticRewriteFacts(corrected), rewrite.semanticRewriteFacts("每年招收四五百人。"));
  assert.ok(rewrite.semanticRewriteFacts("第一组五六百人，第二组四五百人。").includes("600"), "Separate estimates are not self-corrections");
});

test("discourse OK is omitted while substantive identifiers and spoken fractions remain protected", () => {
  assert.deepEqual(rewrite.semanticRewriteFacts("好，OK，各位看这里。OK，接着看下一处。"), []);
  assert.ok(rewrite.semanticRewriteFacts("产品叫OK，检测状态为OK。").includes("ok"));
  assert.ok(rewrite.semanticRewriteFacts("使用OKR流程。").includes("okr"));
  assert.deepEqual(rewrite.semanticRewriteFacts("其中二分之一会继续深造。"), rewrite.semanticRewriteFacts("其中一半会继续深造。"));
  assert.deepEqual(rewrite.semanticRewriteFacts("录取前千分之一。"), rewrite.semanticRewriteFacts("录取前0.1%。"));
  assert.deepEqual(rewrite.semanticRewriteFacts("离市区六十公里，七月六号开放。"), rewrite.semanticRewriteFacts("离市区60公里，7月6号开放。"));
});

test("missing-fact sources include just original evidence sentences and keep their provenance", () => {
  const units = [{ paragraphId: "p-1", text: "我们先介绍校园风景。公交票价30元。学校的环境很好。" }, { paragraphId: "p-2", text: "讲座每周举行，参加的人很多。" }];
  assert.deepEqual(rewrite.buildMissingRewriteFactSources(units, ["30"]), [{ paragraphId: "p-1", text: "公交票价30元。" }]);
  assert.deepEqual(rewrite.buildMissingRewriteFactSources(units, ["342"]), []);
});

test("spoken counts, clock minutes and bare quoted prices match their written values", () => {
  assert.deepEqual(rewrite.semanticRewriteFacts("三万多博士，三万多硕士。"), rewrite.semanticRewriteFacts("三万多名博士，三万多名硕士。"));
  assert.ok(rewrite.semanticRewriteFacts("三万多博士。").includes("30000"));
  assert.deepEqual(rewrite.semanticRewriteFacts("早上六点四十开门。"), rewrite.semanticRewriteFacts("早上6点40分开门。"));
  assert.deepEqual(rewrite.semanticRewriteFacts("十六哦，那也很好。"), rewrite.semanticRewriteFacts("16元，那也很好。"));
  assert.deepEqual(rewrite.semanticRewriteFacts("十十块出头。"), rewrite.semanticRewriteFacts("十块出头。"));
  assert.deepEqual(rewrite.semanticRewriteFacts("够了，OK，接着看。百分之二十。"), ["20", "20%"]);
  assert.deepEqual(rewrite.semanticRewriteFacts("百分之三十到四十。"), ["30", "30%", "40", "40%"]);
});

async function fixture(t, source, respond) {
  const f = runtimeFixture(t), installation = await f.initialize();
  f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, projectId = "rewrite-project", workspaceId = "rewrite-workspace";
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z", ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: projectId, name: "Rewrite project", client_name: "Test client" });
  seed("script_rewrite_workspaces", { id: workspaceId, title: "Long script", source_type: "pasted", source_label: "Synthetic script", source_text: source, source_hash: "synthetic-source-hash", source_character_count: source.length });
  seed("script_rewrite_versions", { id: "rewrite-source", workspace_id: workspaceId, version: 1, variant: "source", text: source });
  f.runtime.getProjectAccess = async (_subject, org, project) => org === organizationId && project === projectId ? { projectRole: "admin" } : null;
  f.runtime.canWriteProjectAccess = Boolean;
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true }) });
  const calls = [];
  const config = { provider: "fixture", model: "fixture" };
  f.mock("lib/model-adapter.ts", {
    ModelConfigurationError: class extends Error {},
    ModelRequestError: class extends Error {},
    readContentModelConfig: () => config,
    invokeContentModel: async input => {
      const payload = JSON.parse(input.user); calls.push(payload);
      return { content: JSON.stringify(await respond(payload)), provider: config.provider, model: config.model, latencyMs: 1, raw: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
    },
  });
  const route = f.load("app/api/script-rewrites/[rewriteId]/generate/route.ts");
  const generate = (variants, retryOfRunId = "") => route.POST(new Request("http://localhost/api/script-rewrites/test/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, variants, retryOfRunId }) }), { params: Promise.resolve({ rewriteId: workspaceId }) });
  return { ...f, seed, generate, calls, config, organizationId, projectId, workspaceId };
}

const sourceLine = "企业在2027年要让AI增长7.1%，我们会先把每次测试的过程记录下来，然后逐项核对结果，最后才决定怎样调整。";
const rewrittenLine = "面向2027年AI增长7.1%的目标，我们先留下每轮测试的过程记录，核验各项结果以后，再据此安排后续调整。";
const audit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };

test("a second copy repair changes only sentence windows and reaches full acceptance", async t => {
  const source = sourceLine.repeat(4);
  const f = await fixture(t, source, payload => {
    if (payload.task === "audit_micro_homomorphic_script") return audit;
    if (payload.task === "repair_only_copied_sentences") {
      assert.ok(payload.source_paragraphs.every(row => row.paragraph_id.includes("-copy-") && row.text === sourceLine));
      assert.equal(payload.rejected_draft, undefined);
      return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewrittenLine })) };
    }
    return { paragraphs: payload.source_paragraphs };
  });
  const response = await f.generate(["light_rewrite"]);
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()).results[0];
  assert.equal(result.validation.passed, true);
  assert.equal(f.calls.filter(call => call.task === "repair_only_copied_sentences").length, 1);
  assert.equal(f.sqlite.prepare("SELECT text FROM script_rewrite_versions WHERE id = ?").get(result.versionId).text, rewrittenLine.repeat(4));
});

test("a four-character length deficit cannot suppress copy repair in another paragraph", async t => {
  const sourceParagraph = sourceLine.repeat(12), good = rewrittenLine.repeat(12);
  let short = good;
  const minimum = Math.ceil(rewrite.normalizeRewriteText(sourceParagraph).length * 0.9);
  while (rewrite.normalizeRewriteText(short).length > minimum - 4) short = short.slice(0, -1);
  const f = await fixture(t, sourceParagraph + "\n\n" + sourceParagraph, payload => {
    if (payload.task === "audit_micro_homomorphic_script") return audit;
    if (payload.task === "repair_only_copied_sentences") {
      assert.ok(payload.source_paragraphs.every(row => row.paragraph_id.startsWith("p-0002-copy-")));
      return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewrittenLine })) };
    }
    return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id,
      text: payload.submitted_attempt >= 3 ? good : row.paragraph_id === "p-0001" ? short : row.text })) };
  });
  const response = await f.generate(["light_rewrite"]);
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()).results[0];
  assert.equal(result.validation.passed, true);
  assert.equal(f.calls.filter(call => call.task === "repair_only_copied_sentences").length, 1);
  assert.deepEqual(f.calls.find(call => call.submitted_attempt === 3).source_paragraphs.map(row => row.paragraph_id), ["p-0001"]);
});

test("failed long rewrites resume saved batches, repair only failed content, and count only new tokens", async t => {
  const paragraph = sourceLine.repeat(20), rewritten = rewrittenLine.repeat(20);
  const source = paragraph + "\n\n" + paragraph;
  let retry = false;
  const f = await fixture(t, source, payload => {
    if (payload.task === "audit_micro_homomorphic_script") return audit;
    return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: payload.batch.index === 1 || retry ? rewritten : row.text })) };
  });
  const first = await f.generate(["light_rewrite"]);
  assert.equal(first.status, 207, await first.clone().text());
  const failed = (await first.json()).results[0];
  assert.equal(failed.error.code, "LIGHT_VALIDATION_FAILED");
  assert.equal(f.calls.filter(call => call.task === "write_micro_homomorphic_script_batch").length, 2);
  retry = true;
  const before = f.calls.length;
  const response = await f.generate(["light_rewrite"], failed.runId);
  assert.equal(response.status, 201, await response.clone().text());
  const completed = (await response.json()).results[0];
  assert.equal(completed.reusedCallCount, 2);
  assert.ok(f.calls.slice(before).every(call => call.task !== "write_micro_homomorphic_script_batch"));
  assert.equal(completed.usage.totalTokens, (f.calls.length - before) * 15);
  const run = f.sqlite.prepare("SELECT actual_total_tokens, retry_of_run_id FROM script_rewrite_runs WHERE id = ?").get(completed.runId);
  assert.equal(run.actual_total_tokens, completed.usage.totalTokens);
  assert.equal(run.retry_of_run_id, failed.runId);
  const saved = f.sqlite.prepare("SELECT text, validation_json FROM script_rewrite_versions WHERE id = ?").get(completed.versionId);
  assert.equal(saved.text, rewritten + "\n\n" + rewritten);
  assert.equal(JSON.parse(saved.validation_json).passed, true);
});

test("an eleven-thousand-character single paragraph uses bounded calls and saves exactly one paragraph", async t => {
  const source = sourceLine.repeat(200);
  const replacements = [
    ["企业在2027年要让AI增长7.1%", "面向2027年AI增长7.1%的目标"],
    ["我们会先把每次测试的过程记录下来", "我们先留下每轮测试的过程记录"],
    ["然后逐项核对结果", "核验各项结果以后"],
    ["最后才决定怎样调整", "再据此安排后续调整"],
  ];
  const f = await fixture(t, source, payload => {
    if (payload.task === "audit_micro_homomorphic_script") return audit;
    assert.equal(payload.task, "write_micro_homomorphic_script_batch");
    assert.ok(payload.source_paragraphs.reduce((sum, row) => sum + row.text.length, 0) <= rewrite.SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS);
    return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: replacements.reduce((text, [before, after]) => text.replaceAll(before, after), row.text) })) };
  });
  const response = await f.generate(["light_rewrite"]);
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()).results[0];
  assert.equal(result.validation.passed, true);
  const saved = f.sqlite.prepare("SELECT paragraphs_json, source_mapping_json FROM script_rewrite_versions WHERE id = ?").get(result.versionId);
  assert.equal(JSON.parse(saved.paragraphs_json).length, 1);
  assert.deepEqual(JSON.parse(saved.source_mapping_json), ["p-0001"]);
  assert.ok(f.calls.filter(call => call.task === "write_micro_homomorphic_script_batch").length > 1);
  assert.equal(rewrite.estimateRewriteUsage(source, ["light_rewrite"]).callCount, f.calls.length);
});

test("fact repair preserves unrelated cards and does not rewrite a complete long ledger", async t => {
  const source = "Team提出屏幕像素如何透光的问题，需要观察显示层的排列。\n\n显微镜可以放大像素，帮助解释显示层的结构。";
  const untouched = "显微镜观察像素排列，能够解释显示层为什么可以透光。";
  const f = await fixture(t, source, payload => {
    if (payload.task === "extract_equivalent_content_facts") return { facts: [
      { fact_id: "f-001", kind: "claim", statement: "关于屏幕透光问题，需要观察显示层的结构与像素排列。", source_paragraph_ids: ["p-0001"], immutable_facts: [] },
      { fact_id: "f-002", kind: "reason", statement: untouched, source_paragraph_ids: ["p-0002"], immutable_facts: [] },
    ] };
    if (payload.task === "repair_semantic_fact_ledger") {
      assert.deepEqual(payload.source_paragraphs.map(row => row.paragraph_id), ["p-0001"]);
      assert.deepEqual(payload.missing_immutable_facts, ["team"]);
      return { facts: [{ fact_id: "f-001", kind: "claim", statement: "Team询问屏幕像素如何透光，需要观察显示层的结构与像素排列。", source_paragraph_ids: ["p-0001"], immutable_facts: ["Team"] }] };
    }
    if (payload.task === "design_new_narrative_architecture") {
      assert.ok(payload.facts.some(fact => fact.statement === untouched));
      throw new Error("Synthetic stop after verifying repaired ledger");
    }
    throw new Error("Synthetic stop before body generation");
  });
  await f.generate(["restructured"]);
  assert.equal(f.calls.filter(call => call.task === "repair_semantic_fact_ledger").length, 1);
  assert.equal(f.calls.filter(call => call.task === "design_new_narrative_architecture").length, 1);
  const run = f.sqlite.prepare("SELECT error_code FROM script_rewrite_runs ORDER BY created_at DESC LIMIT 1").get();
  assert.notEqual(run.error_code, "RESTRUCTURE_FACTS_INVALID");
});

for (const completes of [true, false]) test(`additive fact repairs preserve locked cards, reject fake evidence and stop after two calls (${completes})`, async t => {
  const source = "Team提出屏幕像素如何透光的问题，需要观察显示层的排列，测试持续30分钟。\n\n显微镜可以放大像素，帮助解释显示层的结构。";
  const retained = { fact_id: "f-002", kind: "reason", statement: "显微镜观察像素排列，能够解释显示层为什么可以透光。", source_paragraph_ids: ["p-0002"], immutable_facts: [] };
  const incomplete = { fact_id: "f-001", kind: "claim", statement: "需要观察屏幕显示层与像素的排列结构，解释光线穿过该区域的方式。", source_paragraph_ids: ["p-0001"], immutable_facts: [] };
  const f = await fixture(t, source, payload => {
    if (payload.task === "extract_equivalent_content_facts") return { facts: [incomplete, retained] };
    if (payload.task === "repair_semantic_fact_ledger") return { facts: [incomplete] };
    if (payload.task === "supplement_missing_semantic_facts") {
      assert.deepEqual(payload.source_paragraphs.map(row => row.paragraph_id), ["p-0001"]);
      assert.equal(payload.rejected_facts, undefined, "Locked ledger is not regenerated");
      if (payload.submitted_attempt === 2) assert.deepEqual(payload.missing_immutable_facts, ["30"], "Metadata cannot hide an unstated missing number");
      if (completes && payload.submitted_attempt === 2) return { facts: [{ ...incomplete, statement: "Team提出屏幕透光问题，需要观察显示层与像素排列，测试持续30分钟。", immutable_facts: ["Team", "30"] }] };
      return { facts: [
        { ...incomplete, statement: "光线穿过显示区域需要观察排列结构。", immutable_facts: ["Team", "30"] },
        { ...incomplete, fact_id: "foreign", statement: "Team的测试持续30分钟。", source_paragraph_ids: ["foreign-source"] },
        { ...incomplete, fact_id: "invented", statement: "Team的测试持续30分钟，成本100元。" },
        { ...incomplete, fact_id: "partial", statement: "Team提出屏幕透光问题，需要观察显示层与像素排列。", immutable_facts: ["Team", "30"] },
      ] };
    }
    if (payload.task === "design_new_narrative_architecture") {
      assert.equal(completes, true);
      assert.ok(payload.facts.some(fact => fact.statement === retained.statement));
      assert.ok(payload.facts.some(fact => fact.statement === incomplete.statement));
    }
    throw new Error("Stop after ledger verification");
  });
  await f.generate(["restructured"]);
  assert.equal(f.calls.filter(call => call.task === "supplement_missing_semantic_facts").length, 2);
  const run = f.sqlite.prepare("SELECT error_code FROM script_rewrite_runs ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(run.error_code === "RESTRUCTURE_FACTS_INVALID", !completes);
});

test("a retry ID belonging to a different workspace cannot expose checkpoints or invoke a model", async t => {
  const f = await fixture(t, sourceLine, () => { throw new Error("Must not invoke model"); });
  f.seed("script_rewrite_workspaces", { id: "foreign-workspace", title: "Foreign", source_type: "pasted", source_label: "Synthetic", source_text: sourceLine, source_hash: "foreign", source_character_count: sourceLine.length });
  f.seed("script_rewrite_runs", { id: "foreign-run", workspace_id: "foreign-workspace", variant: "light_rewrite", status: "failed", source_version_id: "rewrite-source", estimated_call_count: 1, estimated_input_tokens: 0, maximum_output_tokens: 0, prompt_version: "synthetic" });
  const response = await f.generate(["light_rewrite"], "foreign-run");
  assert.equal(response.status, 404);
  assert.equal(f.calls.length, 0);
});

for (const mismatch of ["provider", "damaged_checkpoint"]) test(`retry regenerates foundation steps after ${mismatch}`, async t => {
  let retry = false;
  const f = await fixture(t, sourceLine, payload => {
    if (payload.task === "audit_micro_homomorphic_script") return audit;
    return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: retry ? rewrittenLine : row.text })) };
  });
  const failed = (await (await f.generate(["light_rewrite"])).json()).results[0];
  assert.equal(failed.status, "failed");
  retry = true;
  if (mismatch === "provider") f.config.provider = "changed-provider";
  else f.sqlite.prepare("UPDATE model_calls SET output_json = ? WHERE task_type = 'script_rewrite_micro_homomorphic_body_batch'").run("invalid JSON");
  const before = f.calls.length;
  const response = await f.generate(["light_rewrite"], failed.runId);
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()).results[0];
  assert.equal(result.reusedCallCount, 0);
  assert.equal(f.calls.slice(before).filter(call => call.task === "write_micro_homomorphic_script_batch").length, 1);
});

for (const mode of ["copy", "facts", "stubborn_facts"]) test(`a saved body resumes without rebuilding its ledger and keeps untouched paragraphs (${mode})`, async t => {
  const second = "然后团队每天复盘结果，最后再决定下一步怎么调整。";
  const cleanSecond = "接着团队每天复盘结果，最终再决定下一步如何调整。";
  const savedParagraphs = mode === "copy" ? [second, sourceLine] : [cleanSecond, rewrittenLine + "此外，团队还拿到了985次奖励。"];
  const source = sourceLine + "\n\n" + second;
  const macroAudit = { missing_fact_ids: [], added_claims: [], core_information_retention: 100, purpose_preserved: true, conclusion_preserved: true, style_aligned: true, production_notes_preserved: true, logic_coherent: true, risk_expanded: false, structure_rebuilt: true, copy_risk: "low", notes: [] };
  const f = await fixture(t, source, payload => {
    if (payload.task === "audit_equivalent_restructure") return macroAudit;
    if (mode !== "copy") {
      assert.equal(payload.task, "repair_only_fact_value_paragraphs", "Must not redo facts, plan or body");
      assert.deepEqual(payload.unexpected_immutable_facts, ["985"]);
      assert.equal(payload.candidate_paragraphs.length, 1);
      assert.equal(payload.candidate_paragraphs[0].paragraph_id, "result-2");
      if (payload.submitted_attempt === 1 || mode === "stubborn_facts") return { paragraphs: payload.candidate_paragraphs };
      return { paragraphs: [{ paragraph_id: "result-2", text: rewrittenLine }] };
    }
    assert.equal(payload.task, "repair_only_copied_sentences", "Must not redo facts, plan or body");
    return { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: row.text === sourceLine ? rewrittenLine : "接着团队每天复盘结果，最终再决定下一步如何调整。" })) };
  });
  const originalFacts = [
    { fact_id: "f-001", kind: "claim", statement: sourceLine, source_paragraph_ids: ["p-0001"], immutable_facts: ["2027", "AI", "7.1%"] },
    { fact_id: "f-002", kind: "action", statement: second, source_paragraph_ids: ["p-0002"], immutable_facts: [] },
  ];
  const outline = [
    { sectionId: "s-01", title: "先复盘", role: "hook", factIds: ["f-002"], sourceParagraphIds: ["p-0002"] },
    { sectionId: "s-02", title: "再谈记录", role: "reason", factIds: ["f-001"], sourceParagraphIds: ["p-0001"] },
  ];
  const text = savedParagraphs.join("\n\n");
  f.seed("script_rewrite_runs", { id: "saved-run", workspace_id: f.workspaceId, variant: "restructured", status: "completed", source_version_id: "rewrite-source", result_version_id: "saved-review-version", estimated_call_count: 6, estimated_input_tokens: 999, maximum_output_tokens: 999, actual_total_tokens: 999, prompt_version: "legacy" });
  f.seed("model_calls", { id: "saved-facts", task_type: mode === "copy" ? "script_rewrite_restructure_facts_batch" : "script_rewrite_restructure_missing_facts", provider: "fixture", model_name: "fixture", model_profile: "max", prompt_version: "legacy", status: "completed", input_hash: "unused", input_json: JSON.stringify({ runId: "saved-run", payload: {} }), output_json: JSON.stringify({ response: { facts: originalFacts } }) });
  f.seed("model_calls", { id: "saved-audit", task_type: "script_rewrite_restructure_audit", provider: "fixture", model_name: "fixture", model_profile: "max", prompt_version: "legacy", status: "completed", input_hash: "unused", input_json: JSON.stringify({ runId: "saved-run", payload: { candidate_text: text, source_profile: {}, fact_ledger: originalFacts.map(fact => ({ fact_id: fact.fact_id, kind: fact.kind, statement: fact.statement, immutable_facts: fact.immutable_facts })) } }), output_json: JSON.stringify({ response: macroAudit }) });
  f.seed("script_rewrite_versions", { id: "saved-review-version", workspace_id: f.workspaceId, version: 2, variant: "restructured", parent_version_id: "rewrite-source", run_id: "saved-run", text, paragraphs_json: JSON.stringify(savedParagraphs), source_mapping_json: JSON.stringify(["f-002", "f-001"]), outline_json: JSON.stringify(outline), validation_json: '{"passed":false}', model_provider: "fixture", model_name: "fixture" });
  const response = await f.generate(["restructured"], "saved-run");
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()).results[0];
  assert.equal(result.validation.passed, mode !== "stubborn_facts", "An optimistic auditor cannot override deterministic fact violations");
  assert.equal(result.reusedCallCount, 1);
  assert.equal(result.usage.totalTokens, mode === "copy" ? 30 : 45);
  assert.deepEqual(f.calls.map(call => call.task), mode === "copy" ? ["repair_only_copied_sentences", "audit_equivalent_restructure"] : ["repair_only_fact_value_paragraphs", "repair_only_fact_value_paragraphs", "audit_equivalent_restructure"]);
  if (mode !== "copy") {
    const saved = f.sqlite.prepare("SELECT paragraphs_json FROM script_rewrite_versions WHERE id = ?").get(result.versionId);
    assert.equal(JSON.parse(saved.paragraphs_json)[0], cleanSecond);
    assert.equal(JSON.parse(saved.paragraphs_json)[1], mode === "stubborn_facts" ? savedParagraphs[1] : rewrittenLine);
  }
  const auditPayload = f.calls.at(-1);
  assert.ok(auditPayload.fact_ledger.every(fact => fact.source_paragraph_ids.length));
});
